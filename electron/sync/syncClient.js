import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import WebSocket from 'ws'
import {
  appendOp,
  recordConflict,
  appendBulkReplaceOp,
  applyBulkReplaceProjection,
  isBulkReplaceOp,
  latestScopeOpSeq,
  coerceOpValue,
  detectUniqueFieldCollision,
  DELETE_FIELD,
} from '../ops/operations.js'
import { PROJECTIONS, applyProjection } from '../ops/projections.js'
import { broadcastOps } from './syncServer.js'
import { insertPendingWrite, deletePendingWrite, listPendingWrites } from './pendingWrites.js'
import {
  insertPendingRestore,
  deletePendingRestore,
  listPendingRestores,
  recordRestoreError,
} from './pendingRestores.js'
import { RESTORABLE_ENTITIES } from '../ops/restore.js'
import { DOMAIN_SNAPSHOT_ORDER } from '../ops/campScopedEntities.js'

const DEFAULT_RESOLVER_TIMEOUT_MS = 10000

// T88: the camp-scoped entity set + FK-safe apply order for the extended
// full_sync snapshot (design doc §2.1/§2.2) is single-sourced in
// electron/ops/campScopedEntities.js and imported here, so this file cannot
// silently omit a table electron/sync/syncServer.js's send side ships (the
// week_location_exclusions drift T88 fixes). See that module for the FK
// reasoning per table and what is deliberately excluded.
const DOMAIN_SNAPSHOT_TABLES = DOMAIN_SNAPSHOT_ORDER

// Full column list per table, matching schema.sql's authoritative column set
// (including columns added later via localDb.js's guarded ALTER TABLE
// migrations) — deliberately NOT derived from PROJECTIONS
// (electron/ops/projections.js), which excludes non-synced/internal columns
// for some tables (design doc §2.2).
const DOMAIN_TABLE_COLUMNS = {
  cohorts: ['id', 'camp_id', 'name', 'session_week_start', 'session_week_end', 'capacity_source', 'anchor_model', 'sort_order'],
  days_of_operation: ['id', 'camp_id', 'label', 'day_of_week', 'sort_order'],
  groups: ['id', 'camp_id', 'name', 'tier_id', 'availability'],
  tiers: ['id', 'camp_id', 'name', 'sort_order', 'cohort_id'],
  time_blocks: ['id', 'camp_id', 'cohort_id', 'name', 'start_time', 'end_time', 'part_of_day', 'sort_order'],
  activities: [
    'id', 'camp_id', 'name', 'priority', 'is_locked', 'span_blocks', 'location', 'is_outdoor',
    'max_groups_per_slot', 'min_per_week', 'max_per_week', 'same_tier_only', 'eligible_tier_ids',
    'eligible_group_ids', 'prefer_before_day', 'prefer_before_day_min', 'weather_alternative_id', 'notes',
    'location_id', // v32 — the migration sets this as a side effect (no op), so it must travel in the snapshot or a first-pairing Client's activities land unbound from their place.
  ],
  anchor_activities: ['id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks', 'is_all_groups', 'group_ids', 'notes'],
  locations: ['id', 'camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry'],
  camp_maps: ['id', 'camp_id', 'image_data', 'image_mime', 'image_width', 'image_height'],
  schedule_weeks: ['id', 'camp_id', 'name', 'sort_order', 'is_archived'], // T88 — required so week_*_exclusions' NOT NULL FK to schedule_weeks.id can be satisfied
  schedule_templates: ['id', 'camp_id', 'name', 'kind', 'week_id'],
  day_override_templates: ['id', 'camp_id', 'cohort_id', 'name', 'frequency_mode'],
  template_slots: ['id', 'template_id', 'group_id', 'activity_id', 'day_id', 'time_block_id', 'flags', 'is_released', 'is_span_head', 'anchor_id', 'is_anchor', 'elective_set_id'],
  template_overlays: ['id', 'template_id', 'unit_id', 'day_id', 'from_block_order', 'to_block_order', 'label'],
  day_override_template_slots: ['id', 'day_override_template_id', 'time_block_id', 'activity_id'],
  week_activity_exclusions: ['id', 'week_id', 'activity_id'],
  week_group_exclusions: ['id', 'week_id', 'group_id'],
  week_location_exclusions: ['id', 'week_id', 'location_id'], // T88 — closes the manifest drift (see DOMAIN_SNAPSHOT_ORDER)
  // T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md)
  special_days: ['id', 'camp_id', 'name', 'sort_order'],
  special_day_time_blocks: ['id', 'special_day_id', 'name', 'sort_order', 'start_time', 'end_time'],
  special_day_slots: ['id', 'special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id'],
  // T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md)
  elective_sets: ['id', 'camp_id', 'name', 'sort_order'],
  elective_set_activities: ['id', 'elective_set_id', 'activity_id'],
}

// T88 review follow-up (Code Reviewer LOW-MED): DOMAIN_TABLE_COLUMNS is a
// third hand-maintained map alongside DOMAIN_SNAPSHOT_ORDER. A table added to
// the shared order without a matching entry here would make
// insertSnapshotRows's `columns.map(...)` throw a cryptic "cannot read
// properties of undefined" mid-apply-transaction the next time a first-pairing
// Client connects, instead of failing loudly at import time. Assert the
// parity up front (exported so campScopedEntities/syncClient tests can
// exercise the throw path directly with synthetic input) so the failure is
// immediate and names the offending table.
export function assertColumnCoverage(snapshotOrder, tableColumns) {
  for (const table of snapshotOrder) {
    if (!tableColumns[table]) {
      throw new Error(
        `syncClient: DOMAIN_TABLE_COLUMNS is missing an entry for '${table}' (listed in DOMAIN_SNAPSHOT_ORDER) — insertSnapshotRows would fail applying it.`
      )
    }
  }
}

assertColumnCoverage(DOMAIN_SNAPSHOT_TABLES, DOMAIN_TABLE_COLUMNS)

// Loose, intentionally-not-a-full-schema-check row validator (design doc
// §2.3): these rows come from a real `SELECT *` on the Host (already-
// materialized SQLite values — string/number/null only, per better-sqlite3's
// own type mapping), so the only realistic failure mode for an individual
// row is a fabricated/malformed message from a non-genuine peer.
function isValidSnapshotRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.id !== 'string' || row.id.length === 0) return false
  for (const value of Object.values(row)) {
    if (typeof value === 'boolean') return false
    if (value !== null && typeof value === 'object') return false
  }
  return true
}

// Validates every row of every domain table BEFORE any DB access. Correction
// vs. an earlier draft of this design: a per-row skip-and-continue is not
// safe here — under foreign_keys=ON, in one shared transaction, a skipped
// row that is itself the FK target of a later table's row (e.g. a skipped
// schedule_templates row a valid template_overlays row references via a
// NOT NULL FK) makes that later INSERT throw, aborting the whole transaction
// anyway. Validating everything up front and applying all-or-nothing is the
// deliberately conservative choice this design settled on (see design doc
// §2.3 Consequences) — it is safe specifically because the caller only
// acknowledges (and the Host only latches last_synced_at) once this
// succeeds; a rejected batch simply retries whole on the next reconnect.
function isValidDomainSnapshotBatch(msg) {
  for (const key of DOMAIN_SNAPSHOT_TABLES) {
    const rows = Array.isArray(msg[key]) ? msg[key] : null
    if (rows === null) return false
    if (!rows.every(isValidSnapshotRow)) return false
  }
  return true
}

function insertSnapshotRows(db, table, columns, rows) {
  const placeholders = columns.map(() => '?').join(', ')
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
  for (const row of rows) {
    stmt.run(...columns.map((col) => (row[col] !== undefined ? row[col] : null)))
  }
}

export function createSyncClient(
  db,
  {
    device_id,
    author_user_id,
    serverUrl,
    token: initialToken,
    device_name,
    lockTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS,
    submitTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS,
    // T85 Part 3: only ever passed by the Host's own no-serverUrl client
    // (main.js), so its interactive local writes reach connected Clients
    // live instead of only at next full_sync. Never read outside the
    // no-serverUrl branch below.
    wss = null,
  }
) {
  const opAppliedListeners = []
  const opConflictListeners = []
  // D3/D4 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
  // mirrors opConflictListeners exactly. Needed independently of the
  // synchronous return value performWrite/the host-local write() already
  // give their own caller — the offline-queue case (D4) has no live caller
  // left waiting by the time flushQueue discovers the rejection, so this is
  // the only way the director ever finds out.
  const opRejectedListeners = []
  const pairingApprovedListeners = []
  const pairingDeniedListeners = []
  const tokenRenewedListeners = []
  // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 3): fired when
  // the Host authoritatively rejects a token this client just sent
  // (`authenticate` closed with 4401-4404). Mirrors pairingDeniedListeners
  // exactly.
  const authRejectedListeners = []
  const fullSyncAppliedListeners = []
  const queue = []
  let token = initialToken

  function notifyOpApplied(op) {
    for (const listener of opAppliedListeners) listener(op)
  }

  function notifyOpConflict(msg) {
    for (const listener of opConflictListeners) listener(msg)
  }

  function notifyOpRejected(msg) {
    for (const listener of opRejectedListeners) listener(msg)
  }

  // Shared shape for the collision payload handed to a caller/listener —
  // matches D3's wire shape exactly (`existing: { id, name, capacity, notes }`),
  // used by both the host-local direct-write branch below and the WS
  // op_rejected case further down, so a caller sees the same shape regardless
  // of which path produced it.
  function pickExistingLocation(row) {
    return { id: row.id, name: row.name, capacity: row.capacity, notes: row.notes }
  }

  function notifyFullSyncApplied() {
    for (const listener of fullSyncAppliedListeners) listener()
  }

  if (!serverUrl) {
    return {
      // T22: `author_user_id` MUST be a parameter. It used to be absent here,
      // so the value main.js supplies per call (`:509`, the signed-in user)
      // was silently discarded and the closure's value — `null`, fixed at
      // construction before anyone has logged in (`main.js:228`) — was written
      // instead. Every op through this path recorded no author, which is why
      // Trash and record history said "Unknown" for almost everything.
      // The closure value remains the fallback for callers with no user, such
      // as bootstrap and pairing, which are honestly unattributed.
      async write({ entity, entity_id, field, value, parent_op_id = null, author_user_id: opAuthor, source = 'human' }) {
        // D2/D3 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
        // check BEFORE appendOp, same as handleSubmitOp's Host-side check —
        // this is the Host operator's OWN interactive write, so without this
        // it would hit appendOp's transaction, throw a raw
        // SQLITE_CONSTRAINT_UNIQUE, and propagate unhandled through main.js's
        // write() IPC handler straight to the renderer instead of a clean,
        // typed rejection through the normal IPC promise.
        const collision = detectUniqueFieldCollision(db, { entity, entity_id, field, value })
        if (collision) {
          const rejection = { status: 'rejected', reason: 'unique_field', existing: pickExistingLocation(collision) }
          notifyOpRejected(rejection)
          return rejection
        }
        const op = appendOp(db, {
          entity,
          entity_id,
          field,
          value,
          author_user_id: opAuthor ?? author_user_id,
          device_id,
          parent_op_id,
          // S2a: this is an interactive edit seam — DEFAULTS to human provenance
          // so a hand-edit is protected on re-import even though NULL would also
          // decode to human (ADR §2). S2b R1: a `stale`-accept resolution passes
          // source:'import' so the director's acceptance of an import value is
          // recorded import-owned and future re-imports update it quietly (§3a).
          // This is a HOST-LOCAL write (no-serverUrl client), so stamping
          // 'import' here is legitimate — the Host owns import provenance.
          source,
        })
        notifyOpApplied(op)
        // T85 Part 3: the Host's own interactive edit, broadcast to every
        // connected Client exactly like a submit_op from a peer would be —
        // this no-serverUrl write() otherwise never touches wss.clients at
        // all, so a Host-authored edit previously reached Clients only at
        // their next full_sync.
        if (wss) broadcastOps(wss, [op])
        return { status: 'applied', op }
      },
      // Same omission as write() above, same consequence.
      async writeBulkReplace({ entity, scope_id, rows, author_user_id: opAuthor }) {
        const op = appendBulkReplaceOp(db, {
          entity,
          scope_id,
          rows,
          author_user_id: opAuthor ?? author_user_id,
          device_id,
          client_write_id: randomUUID(),
        })
        notifyOpApplied(op)
        // T85 Part 3: same reasoning as write() above.
        if (wss) broadcastOps(wss, [op])
        return { status: 'applied', op }
      },
      onOpApplied(callback) {
        opAppliedListeners.push(callback)
      },
      onOpConflict(callback) {
        opConflictListeners.push(callback)
      },
      onOpRejected(callback) {
        opRejectedListeners.push(callback)
      },
      onFullSyncApplied(callback) {
        fullSyncAppliedListeners.push(callback)
      },
      // T27. This is the offline/no-op client (no serverUrl), so it is never
      // connected to anything and never will be — say so plainly rather than
      // leaving the renderer to infer it.
      isConnected() {
        return false
      },
      onConnectionChange() {
        return () => {}
      },
      getQueuedOps() {
        return []
      },
      // A Host never queues a restore: it performs one directly (main.js's
      // restoreEntity handler), so there is no hop to fail. The table exists
      // on every device and stays empty here.
      getPendingRestores() {
        return []
      },
      async drainPendingRestores() {},
      async flushQueue() {},
      async waitUntilConnected() {},
      close() {},
    }
  }

  let ws = null
  let connected = false
  // T27: listeners for connection state, so the renderer can show whether this
  // device can currently reach the main computer instead of guessing.
  const connectionListeners = new Set()
  function announceConnection() {
    for (const cb of connectionListeners) {
      try { cb({ connected, authenticated }) } catch { /* a listener must not break sync */ }
    }
  }
  let renewalTimer = null
  // Set to true when the consumer explicitly calls close() so the auto-reconnect
  // loop does not restart a deliberately-closed client.
  let closedIntentionally = false
  // Delay between automatic reconnect attempts (ms).  Short enough to feel
  // responsive; long enough not to hammer a temporarily-down host.  The Host's
  // pairing_request rate-limit (PAIRING_RATE_MS = 5 s) will close the connection
  // if a mid-pairing reconnect re-sends pairing_request too soon, but that is
  // fine: the close triggers the next reconnect attempt, and eventually (once
  // the 5-s window has passed) the request is accepted.
  const RECONNECT_DELAY_MS = 1500
  // Distinct from `connected`: `connected` only means the WebSocket is open.
  // `authenticated` means we have actually SENT an `authenticate` message on
  // this connection (either because a token existed at connect() time, or
  // because loginRemote() just succeeded and sent one). The server currently
  // sends no ack for `authenticate` (see syncServer.js's handleAuthenticate),
  // so "authenticated" here means "we sent authenticate with what we believe
  // is a valid token" — not "the server confirmed it". That is an accepted,
  // known limitation, not a hidden one; a real ack protocol is out of scope
  // for this fix.
  let authenticated = false
  let connectedResolve
  let connectedPromise = new Promise((resolve) => {
    connectedResolve = resolve
  })
  const lockResolvers = []
  const submitResolvers = []
  const loginResolvers = []
  // Keyed by request_id rather than FIFO like the resolver arrays above: a
  // restore's reply may overtake another's (they are independent Host-side
  // reads), and mis-pairing two replies would report one restore's outcome
  // for the other.
  const restoreResolvers = new Map()
  // Same keyed-by-request_id reasoning as restoreResolvers above.
  const deleteResolvers = new Map()
  // Same keyed-by-request_id reasoning as restoreResolvers above (M3c merge).
  const mergeResolvers = new Map()
  // Single registry settlePendingOnDisconnect iterates over so a new keyed
  // resolver map (restore/delete/merge, or a future 4th) can never be added
  // to the code above without also being drained on disconnect below.
  const keyedResolverMaps = [restoreResolvers, deleteResolvers, mergeResolvers]
  // Holds the in-flight drain rather than a bare boolean, so a second caller
  // awaits the pass already running instead of returning as if the queue had
  // been dealt with. The reconnect trigger and an explicit call routinely
  // overlap.
  let drainingPromise = null

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0
  }

  function scheduleRenewal(tok) {
    if (renewalTimer) clearTimeout(renewalTimer)
    if (!tok) return
    try {
      const parts = tok.split('.')
      if (parts.length !== 2) return
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
      if (typeof payload.exp !== 'number') return
      const renewAt = payload.exp - 4 * 60 * 60 * 1000  // renew 4h before exp
      const delay = renewAt - Date.now()
      if (delay <= 0) return
      renewalTimer = setTimeout(() => {
        if (ws && ws.readyState === ws.OPEN && token) {
          ws.send(JSON.stringify({ type: 'renew_token', token }))
        }
      }, delay)
    } catch { /* ignore */ }
  }

  function isValidFullSyncUser(user) {
    if (user === null || typeof user !== 'object' || Array.isArray(user)) return false
    if (!isNonEmptyString(user.id)) return false
    if (!(user.camp_id === null || isNonEmptyString(user.camp_id))) return false
    if (!isNonEmptyString(user.name)) return false
    if (!isNonEmptyString(user.pin_hash)) return false
    if (!isNonEmptyString(user.pin_salt)) return false
    if (user.role !== 'admin' && user.role !== 'staff') return false
    return true
  }

  function isValidFullSyncCamp(camp) {
    if (camp === null || typeof camp !== 'object' || Array.isArray(camp)) return false
    if (!isNonEmptyString(camp.id)) return false
    if (!isNonEmptyString(camp.name)) return false
    // A Host that has passed through the signing-secret migration/bootstrap
    // ALWAYS has a real, non-null signing_secret to send. A null/missing/empty
    // value here would only mask a bug elsewhere (e.g. a not-yet-migrated
    // Host row), so reject the whole camp entry rather than silently writing
    // a null/garbage secret that a Client would then try to sign/verify with.
    if (!isNonEmptyString(camp.signing_secret)) return false
    // signing_public_key (Ed25519, docs/adr/2026-07-25-device-trust-revocation.md)
    // is intentionally NOT required here the way signing_secret is above: a
    // camp bootstrapped before this migration has no host_signing_key row to
    // derive one from yet, and this slice does not add migration tooling for
    // pre-existing camps (see that design doc's non-goals). Accepted as
    // either a non-empty string or absent/null; only rejected if present but
    // not a string at all (a malformed value from a compromised/buggy peer).
    if (camp.signing_public_key != null && typeof camp.signing_public_key !== 'string') return false
    return true
  }

  function applyFullSync(msg) {
    const users = Array.isArray(msg.users) ? msg.users : []
    const camps = Array.isArray(msg.camps) ? msg.camps : []

    // Validate the ENTIRE domain-table batch before touching the DB at all
    // (design doc §2.3). A per-row skip-and-continue (what camps/users still
    // do, below) is not safe for these tables: under foreign_keys=ON, in one
    // shared transaction, a skipped row that is itself the FK target of a
    // later table's row would make that later INSERT throw anyway, aborting
    // everything regardless. So instead: fail the whole message up front, do
    // not open a transaction, and throw — the caller (the `full_sync`
    // message handler below) does not send full_sync_applied on a throw, so
    // the Host retries the entire snapshot on the next reconnect. Camps/users
    // keep their existing independent per-row `continue` behavior: they are
    // not FK targets of anything else in this batch, so a bad row among them
    // was already safe to skip on its own.
    if (!isValidDomainSnapshotBatch(msg)) {
      throw new Error('full_sync: invalid or missing domain snapshot table(s)')
    }

    // Wrap the whole batch — camps, users, AND every domain table, in
    // FK-respecting order — in a single transaction: a genuine mid-loop DB
    // failure (e.g. a real constraint violation on some row that passed
    // per-row validation) rolls back the ENTIRE batch instead of leaving it
    // partially populated. It also collapses many auto-committing statements
    // into one transaction for performance.
    const applyBatch = db.transaction(() => {
      for (const camp of camps) {
        if (!isValidFullSyncCamp(camp)) continue
        db.prepare(
          'INSERT OR REPLACE INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)'
        ).run(camp.id, camp.name, camp.signing_secret ?? null, camp.signing_public_key ?? null)
      }

      for (const user of users) {
        if (!isValidFullSyncUser(user)) continue
        db.prepare(
          'INSERT OR REPLACE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(user.id, user.camp_id, user.name, user.pin_hash, user.pin_salt, user.role)
      }

      for (const table of DOMAIN_SNAPSHOT_TABLES) {
        insertSnapshotRows(db, table, DOMAIN_TABLE_COLUMNS[table], msg[table])
      }

      // Part 4.1: fold this device's "first sync complete" flag into the
      // SAME transaction as the domain-table inserts, so a rollback of the
      // batch also rolls back this flag — if the apply fails, the gate must
      // stay closed. device_identity is this install's own per-device
      // singleton row (getOrCreateDeviceId), always exactly one row by the
      // time a syncClient exists.
      db.prepare(
        'UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)'
      ).run(new Date().toISOString())
    })
    applyBatch()
  }

  function isValidRemoteOp(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) return false
    if (!isNonEmptyString(op.id)) return false
    if (!isNonEmptyString(op.entity)) return false
    if (!isNonEmptyString(op.entity_id)) return false
    if (!isNonEmptyString(op.field)) return false
    if (!isNonEmptyString(op.device_id)) return false
    if (!isNonEmptyString(op.timestamp)) return false
    if (!(Number.isInteger(op.seq) && op.seq >= 0)) return false
    if (!('value' in op)) return false
    if (typeof op.value === 'object' && op.value !== null) return false
    if (!(op.parent_op_id === null || isNonEmptyString(op.parent_op_id))) return false
    return true
  }

  function applyRemoteOp(op) {
    // The op-log insert must be durable regardless of projection outcome: the
    // server already accepted and broadcast this op as canonical, so this
    // client's local materialization of it (the projection) hitting a snag
    // must not erase the log entry. Keep the insert in its own transaction.
    // Capture whether the insert actually inserted a NEW row (changes > 0) vs.
    // no-opped on a replayed/duplicate op id (ON CONFLICT DO NOTHING) - only a
    // genuinely new op should be projected, otherwise a replay with a mutated
    // field/value could overwrite the projected table with spoofed values.
    const insert = db.transaction(() => {
      // T85 Part 1 (docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md):
      // `devices` is never replicated between peers, but operations.device_id
      // is a NOT NULL FK to it with foreign_keys=ON — so an op authored by a
      // device this receiver has never seen would otherwise throw
      // SQLITE_CONSTRAINT_FOREIGNKEY on the INSERT below and silently vanish
      // (the throw is caught and swallowed by the op_applied handler further
      // down this file). Seed a minimal, secret-free stub row from the op's
      // own device_id, in the SAME transaction, before the op-log insert, so
      // the FK is always satisfiable regardless of message arrival order.
      // 'unknown' is a deliberate FIFTH pairing_status value, outside the
      // four real ones ('pending'|'authorized'|'denied'|'revoked'), chosen so
      // this row can never be mistaken for a real, awaiting-review pairing
      // candidate anywhere pairing_status is read. INSERT OR IGNORE: a
      // real row (this device's own self-registration, or a later real
      // pairing) is never overwritten by a stub.
      db.prepare(
        "INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'unknown')"
      ).run(op.device_id, `Device ${op.device_id.slice(0, 8)}`)

      const result = db
        .prepare(
          `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id, host_seq, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        // S2a: PRESERVE the replicated op's stored source (§4) — this is copying
        // an already-committed op's provenance, not stamping a new write. A
        // 'human' op replicates as 'human', an 'import' op as 'import'.
        .run(op.id, op.entity, op.entity_id, op.field, op.value, op.author_user_id ?? null, op.device_id, op.timestamp, op.parent_op_id ?? null, op.client_write_id ?? null, op.seq, op.source ?? null)
      return result.changes
    })
    const changes = insert()
    if (changes === 0) {
      // Replay of a previously-seen op id: the original op's projection
      // already ran when it was first received. Skip re-projecting.
      return
    }

    try {
      if (isBulkReplaceOp(op)) {
        // Extend applyRemoteOp for the new bulk_replace op shape: instead of
        // a single-field UPDATE (applyProjection), replay the same
        // delete-all-then-reinsert this op represents, atomically, from the
        // row set carried in op.value. This is what makes a bulk_replace
        // applied on the Host replicate correctly to a Client - the op-log
        // insert above already made it durable/canonical; this materializes
        // it into the projected template_slots table.
        applyBulkReplaceProjection(db, op)
      } else {
        // T89 follow-up (Red Hat): applyProjection can issue MULTIPLE inserts
        // for a single op — e.g. ensureWeekJoinRow's schedule_weeks stub-seed
        // followed by the week_*_exclusions row insert. On the appendOp path
        // those share appendOp's own transaction, but here the op-log insert
        // transaction already closed at line ~518 (deliberately, so op
        // durability doesn't depend on projection success) and applyProjection
        // runs un-transacted. Without this wrapper, a projection that fails on
        // its SECOND insert (e.g. the exclusion row's OTHER FK, activity_id/
        // group_id, also unseen) leaves the FIRST insert's effect committed —
        // a permanent phantom schedule_weeks stub with no exclusion to show
        // for it, worse than the pre-fix silent no-op. Wrapping only this
        // branch in its own (non-nested) transaction makes the whole
        // projection atomic: any throw rolls back every partial insert, and
        // still propagates to the catch below exactly as before.
        const projectOnce = db.transaction(() => applyProjection(db, op))
        projectOnce()
      }
    } catch (err) {
      // A failed DELETE is the one swallow that leaves this device visibly
      // wrong forever: the row stays alive here while every other device has
      // removed it, with nothing anywhere to say so. It happens when this
      // device holds a child row the Host never knew about — a write queued
      // while offline, or a row created here and not yet submitted — so its
      // own foreign_keys = ON refuses the parent delete.
      //
      // Pre-existing for every delete, but deleting a record a schedule USES
      // is what makes peers likely to disagree about the row set
      // (docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md), so it moves
      // from theoretical to reachable. Logged rather than swallowed, so the
      // divergence is at least discoverable. Deliberately NOT "fixed" by
      // cascading locally: re-deriving child effects on each peer is exactly
      // the property the op-log design rejects. The log stays authoritative.
      if (op.field === DELETE_FIELD && err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        console.error(
          `applyRemoteOp: this device could not delete ${op.entity}/${op.entity_id} — something here still refers to it, and every other device has removed it. This device is now out of step for that record.`
        )
        return
      }
      // D5 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
      // every OTHER projection failure on an already-logged, already-canonical
      // op used to be a pure swallow — no log line, no signal anywhere. D1-D4
      // structurally prevent a locations name collision from ever reaching
      // here (it's rejected before appendOp on the submitting side), so this
      // is defense-in-depth for the wider class of "a canonical op still
      // fails to project on some receiver" bugs this catch was built to
      // absorb — extending the exact pattern the branch above already uses.
      // The op-log entry itself remains authoritative either way; this only
      // makes the resulting local divergence discoverable instead of silent.
      else {
        console.error(
          `applyRemoteOp: projection failed for ${op.entity}/${op.entity_id}.${op.field} — op is logged but not materialized on this device`,
          err
        )
      }
    }
  }

  function connect() {
    ws = new WebSocket(serverUrl)

    ws.on('open', () => {
      if (token) {
        ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
        authenticated = true
        // Trigger 1 of 3 for the restore queue, and the one that makes
        // "queued while the main computer was off, delivered when it came
        // back" actually true. App start is deliberately NOT a separate
        // trigger — startup goes through this same open/authenticate path, so
        // a second call would only duplicate this one.
        drainPendingRestores()
      } else if (device_name) {
        ws.send(JSON.stringify({ type: 'pairing_request', device_id, device_name }))
      }
      connected = true
      connectedResolve()
      announceConnection()
    })

    ws.on('message', (data) => {
      try {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }

        if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
          return
        }

        if (msg.type === 'full_sync') {
          // Corrected mechanism (design doc §2.4): applyFullSync throws on
          // any validation/DB failure — no partial commit, per the
          // transaction above. Only send full_sync_applied, and only notify
          // listeners, once that has genuinely succeeded. On failure: do NOT
          // ack. The Host's wait times out, does not latch last_synced_at,
          // and the next reconnect retries the entire snapshot from scratch
          // — safe, every insert is INSERT OR REPLACE. No new
          // logging/observability is added here, matching this file's
          // existing convention for swallowed projection failures
          // (applyRemoteOp's own catch, above).
          try {
            applyFullSync(msg)
            notifyFullSyncApplied()
            if (ws && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'full_sync_applied' }))
            }
          } catch {
            // Apply failed (bad batch, genuine DB error) or the ack send
            // itself failed (connection already going bad) — either way, no ack.
          }
          return
        }

        if (msg.type === 'pairing_approved') {
          if (isNonEmptyString(msg.device_secret_identifier)) {
            db.prepare(
              "UPDATE devices SET device_secret_identifier = ?, pairing_status = 'authorized', authorized_at = ? WHERE id = ?"
            ).run(msg.device_secret_identifier, new Date().toISOString(), device_id)
          }
          for (const cb of pairingApprovedListeners) cb(msg)
          return
        }

        if (msg.type === 'pairing_denied') {
          // Stop the auto-reconnect loop: denial is terminal.  The WS will be
          // closed by the Host after this message; without this flag the close
          // handler would schedule a reconnect that re-sends pairing_request,
          // undoing the denial in an infinite retry storm.  The consumer can
          // create a fresh syncClient if they want to re-initiate pairing.
          closedIntentionally = true
          for (const cb of pairingDeniedListeners) cb(msg)
          return
        }

        if (msg.type === 'token_renewed') {
          if (isNonEmptyString(msg.token)) {
            token = msg.token
            scheduleRenewal(token)
            for (const cb of tokenRenewedListeners) cb(msg.token)
          }
          return
        }

        if (msg.type === 'token_renewal_failed') {
          return
        }

        if (msg.type === 'restore_result') {
          const resolve = restoreResolvers.get(msg.request_id)
          if (resolve) {
            restoreResolvers.delete(msg.request_id)
            resolve(msg)
          }
          return
        }

        if (msg.type === 'delete_record_result') {
          const resolve = deleteResolvers.get(msg.request_id)
          if (resolve) {
            deleteResolvers.delete(msg.request_id)
            resolve(msg)
          }
          return
        }

        if (msg.type === 'merge_location_result') {
          const resolve = mergeResolvers.get(msg.request_id)
          if (resolve) {
            mergeResolvers.delete(msg.request_id)
            resolve(msg)
          }
          return
        }

        if (msg.type === 'lock_result') {
          const resolve = lockResolvers.shift()
          if (resolve) resolve(msg)
          return
        }

        if (msg.type === 'login_ok' || msg.type === 'login_failed') {
          const resolve = loginResolvers.shift()
          if (resolve) resolve(msg)
          return
        }

        if (msg.type === 'op_applied') {
          if (!isValidRemoteOp(msg.op)) {
            // Belt-and-suspenders: full validation failed, but if we can still
            // trust that device_id points at THIS device (a lightweight,
            // separate check from full op validity), drain this device's
            // pending submitResolvers now with a fast { status: 'error' }
            // instead of silently discarding the message and relying solely
            // on the timeout safety net to eventually unstick the caller.
            const op = msg.op
            if (
              op !== null &&
              typeof op === 'object' &&
              !Array.isArray(op) &&
              typeof op.device_id === 'string' &&
              op.device_id.length > 0 &&
              op.device_id === device_id
            ) {
              const resolve = submitResolvers.shift()
              if (resolve) resolve({ status: 'error' })
            }
            return
          }

          // Structural guarantee: resolver-draining for this device's own op
          // MUST happen no matter what throws inside this block (a bad field,
          // a projection error, a listener exception, anything). The try/finally
          // is the mechanism - there is no code path here that can skip the
          // finally block, unlike the previous version where draining only ran
          // if execution reached a specific line.
          let opError = null
          try {
            applyRemoteOp(msg.op)
            notifyOpApplied(msg.op)
          } catch (err) {
            opError = err
          } finally {
            if (msg.op.device_id === device_id) {
              const resolve = submitResolvers.shift()
              if (resolve) resolve(opError ? { status: 'error', op: msg.op, error: opError } : msg)
            }
          }
          // T85 Part 2: ack genuine receiver-apply, not transport delivery,
          // so the Host's reconnect-catch-up watermark (sendMissedOps) can
          // gate on receiver truth. opError is non-null ONLY when
          // applyRemoteOp's own op-log INSERT threw — a projection failure
          // does not set it (applyRemoteOp's own internal catch already
          // swallows and logs those). "Applied" therefore means "the op-log
          // row durably exists on this device", which is true for both a
          // genuinely-new insert and a deduplicated replay (changes === 0).
          if (!opError && ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'op_applied_ack', op_id: msg.op.id }))
          }
          return
        }

        if (msg.type === 'op_conflict') {
          // Persist locally too — this device (not just the host) needs the
          // conflict to survive its own restart, e.g. if the user closes the
          // app before resolving it. Best-effort: never let a persistence
          // failure block delivering the conflict to the caller/listeners.
          try {
            if (msg.incomingOp && msg.existingOp) {
              recordConflict(db, { incomingOp: msg.incomingOp, existingOp: msg.existingOp })
            }
          } catch {
            // ignore — see comment above
          }
          notifyOpConflict(msg)
          const resolve = submitResolvers.shift()
          if (resolve) resolve(msg)
        }

        // D3 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
        // mirrors op_conflict's handling exactly, EXCEPT no recordConflict —
        // there is nothing to persist, since the rejected write never became
        // canonical (unlike a conflict, which records two REAL competing ops).
        //
        // Finding F (addendum, accepted, no code fix): there is no protocol-
        // version or capability handshake anywhere in this file or
        // syncServer.js. An OLD client talking to a NEW Host that sends
        // op_rejected has no `case` for it here — the message is silently
        // ignored, and that client's pending submission can only resolve via
        // the 10s resolver timeout, indistinguishable from a dead connection,
        // identical to this whole ADR's PRE-fix behavior. op_conflict had the
        // exact same exposure when it was introduced and still has it today;
        // this is an accepted, known gap during any rolling-upgrade window,
        // not a regression this fix introduces — a real fix is a
        // protocol-wide versioning primitive, its own architectural decision,
        // not something to retrofit for one message type as a side effect.
        if (msg.type === 'op_rejected') {
          notifyOpRejected(msg)
          const resolve = submitResolvers.shift()
          if (resolve) resolve(msg)
        }
      } catch {
        // defense-in-depth: never let a malformed/unexpected message crash the process
      }
    })

    ws.on('error', () => {
      // connection failures surface via 'close'; swallow here to avoid an unhandled error event
      settlePendingOnDisconnect()
    })

    function settlePendingOnDisconnect() {
      while (lockResolvers.length) {
        const resolve = lockResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (submitResolvers.length) {
        const resolve = submitResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (loginResolvers.length) {
        const resolve = loginResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      for (const resolverMap of keyedResolverMaps) {
        for (const [requestId, resolve] of [...resolverMap]) {
          resolverMap.delete(requestId)
          resolve({ status: 'disconnected' })
        }
      }
    }

    ws.on('close', (code) => {
      connected = false
      authenticated = false
      announceConnection()
      connectedPromise = new Promise((resolve) => {
        connectedResolve = resolve
      })
      settlePendingOnDisconnect()
      // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 3): the
      // Host has authoritatively rejected this token (invalid, wrong type,
      // device not authorized, or revoked — syncServer.js's
      // handleAuthenticate). Clear it so the NEXT auto-reconnect below takes
      // the `else if (device_name)` branch and sends pairing_request instead
      // of silently re-sending a token the Host will only reject again,
      // forever.
      if (code === 4401 || code === 4402 || code === 4403 || code === 4404) {
        token = null
        for (const cb of authRejectedListeners) cb(code)
      }
      // Auto-reconnect unless close() was called explicitly.
      //
      // On reconnect the existing open handler re-enters the correct state:
      //   • token present              → sends authenticate (already-paired device)
      //   • no token, device_name set  → sends pairing_request (mid-pairing device)
      //
      // This means a Client that sent pairing_request and is waiting for approval
      // will automatically re-send pairing_request after the drop.  The Host
      // re-delivers pairing_approved for already-approved devices (idempotent),
      // and fires onPairingRequest again for still-pending ones.
      if (!closedIntentionally) {
        setTimeout(() => {
          if (!closedIntentionally) connect()
        }, RECONNECT_DELAY_MS)
      }
    })
  }

  // Task 10 round-5 Fix 1: reload any writes that were queued (and durably
  // persisted via insertPendingWrite) before this process last exited, so a
  // restart/crash before flushQueue synced them does not lose the write or
  // the resolution choice it represents. Loaded before connect() so a
  // flushQueue triggered by the initial connection picks these up too.
  for (const item of listPendingWrites(db)) {
    queue.push(item)
  }

  connect()

  // Structural safety net: wrap a resolver-array push with a bounded timeout so
  // that ANY current-or-future gap in draining (a missed message type, an early
  // return before a drain point, a server that never replies) degrades to a
  // bounded delay instead of hanging the caller's promise forever. If the
  // timeout fires while our exact resolver is still sitting in the array
  // (nothing else has drained it), we remove it ourselves and resolve with
  // { status: 'timeout' }. If something else drains it first (normal response
  // or an error-path drain), the timeout is cleared and never fires.
  function withResolverTimeout(resolversArray, timeoutMs, sendFn) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const wrappedResolve = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      timer = setTimeout(() => {
        const idx = resolversArray.indexOf(wrappedResolve)
        if (idx !== -1) {
          resolversArray.splice(idx, 1)
          wrappedResolve({ status: 'timeout' })
        }
      }, timeoutMs)
      resolversArray.push(wrappedResolve)
      sendFn()
    })
  }

  function acquireLockRemote(entity, entity_id, field) {
    return withResolverTimeout(lockResolvers, lockTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'acquire_lock', entity, entity_id, field }))
    })
  }

  function submitOpRemote(op) {
    return withResolverTimeout(submitResolvers, submitTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'submit_op', op }))
    })
  }

  function submitBulkReplaceOpRemote(op) {
    return withResolverTimeout(submitResolvers, submitTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'submit_bulk_replace_op', op }))
    })
  }

  // Round 2: real conflict-detection wiring. based_on_seq is derived here,
  // automatically, from THIS client's own local op-log right before
  // submitting — the caller-facing writeBulkReplace API stays unchanged
  // ({entity, scope_id, rows}); the client doesn't need to know or track
  // "what state am I based on" itself. latestScopeOpSeq reads this
  // client's own (possibly stale, if offline/behind) view of the scope,
  // which is exactly the semantics detectBulkReplaceConflict on the Host
  // expects: "the highest op I had actually observed for this scope."
  function computeBasedOnSeq(entity, scope_id) {
    return latestScopeOpSeq(db, entity, scope_id)
  }

  function sendLoginRemote({ name, pin }) {
    return withResolverTimeout(loginResolvers, lockTimeoutMs, () => {
      const deviceRow = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(device_id)
      ws.send(JSON.stringify({ type: 'login', device_id, name, pin, device_secret_identifier: deviceRow?.device_secret_identifier ?? null }))
    })
  }

  // T22: the remote path dropped the caller's author for the same reason the
  // local one did — it was never a parameter.
  async function performWrite({ entity, entity_id, field, value, parent_op_id = null, client_write_id = null, author_user_id: opAuthor, source = 'human' }) {
    const lockResult = await acquireLockRemote(entity, entity_id, field)
    if (lockResult.status === 'disconnected' || lockResult.status === 'timeout') {
      return { status: lockResult.status }
    }
    if (!lockResult.granted) {
      // Task 10 round-5 Fix 2: lock contention (another device currently
      // holds the lock) is distinct from a genuine op-conflict — submitOpRemote
      // never even runs here, so no op_conflict message fires and nothing
      // surfaces this any other way. Previously this returned the same
      // { status: 'conflict' } as a real op-conflict, so flushQueue could not
      // tell the two apart and silently dropped a transiently-contended
      // queued write instead of retrying it. Use a distinctly-named status so
      // callers (flushQueue in particular) can't misclassify it.
      return { status: 'lock_contention', holder_device_id: lockResult.holder_device_id }
    }

    // S2a: interactive edit seam — DEFAULTS to human provenance. The Host also
    // FORCES 'human' in handleSubmitOp (Security V1) and never trusts a
    // submitted source, so a client can never forge 'import' over the wire; this
    // is the legible intent, not the trust boundary. (S2b R1's import-provenance
    // resolution only matters on the host-local no-serverUrl path above, where
    // import ownership is genuinely stamped.)
    const op = { entity, entity_id, field, value, author_user_id: opAuthor ?? author_user_id, parent_op_id, client_write_id, source }
    const submitResult = await submitOpRemote(op)
    if (submitResult.status === 'disconnected' || submitResult.status === 'timeout' || submitResult.status === 'error') {
      return submitResult
    }
    if (submitResult.type === 'op_conflict') {
      return { status: 'conflict', existingOp: submitResult.existingOp }
    }
    // D3: terminal, same tier as 'conflict' — the Host has already decided
    // and will never apply this write. reason/existing carry through so a
    // caller (or flushQueue, for the offline path — D4) can act on the
    // rejection instead of retrying a doomed write forever.
    if (submitResult.type === 'op_rejected') {
      return { status: 'rejected', reason: submitResult.reason, existing: submitResult.existing }
    }
    return { status: 'applied', op: submitResult.op }
  }

  // No lock-acquisition step here, unlike performWrite - bulk_replace is a
  // wholesale scope replacement rather than a single-field edit, so the
  // per-field lock manager (designed around entity/entity_id/field
  // contention) doesn't map onto it; see the conflict-detection reasoning in
  // operations.js (BULK_REPLACE_FIELD comment) for why this op bypasses that
  // machinery by design rather than by omission.
  async function performBulkReplaceWrite({ entity, scope_id, rows, client_write_id }) {
    const based_on_seq = computeBasedOnSeq(entity, scope_id)
    const submitResult = await submitBulkReplaceOpRemote({ entity, scope_id, rows, client_write_id, based_on_seq })
    if (submitResult.status === 'disconnected' || submitResult.status === 'timeout' || submitResult.status === 'error') {
      return submitResult
    }
    // Round 2 fix: round 1 fell through to `{ status: 'applied', op:
    // submitResult.op }` here unconditionally, even when the Host replied
    // with an `op_conflict` (whose message shape has no `.op` at all — it
    // has `incomingOp`/`existingOp`). That silently reported a genuine
    // conflict as a successful apply. Mirror performWrite's existing
    // op_conflict branch: surface it as a real conflict instead.
    if (submitResult.type === 'op_conflict') {
      return { status: 'conflict', existingOp: submitResult.existingOp }
    }
    return { status: 'applied', op: submitResult.op }
  }

  // --- Restore requests ----------------------------------------------------
  // docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §5.
  //
  // There is no protocol-version or capability handshake anywhere in this
  // file or syncServer.js, so a pre-v25 Host receiving restore_request falls
  // off the end of its dispatch chain and replies with NOTHING — silence, not
  // an error. The resolver timeout below is what turns that indefinite wait
  // into a bounded { status: 'timeout' }, and a timeout is indistinguishable
  // from a slow link, so it is treated as not-yet-delivered: the request stays
  // queued. Nothing was performed, so that is safe, and it matches the ADR's
  // "delayed is the worst case".
  //
  // Shared by restore/delete/merge — all three are the same shape: a single
  // request keyed by its own request_id (unlike lock/submit/login, which are
  // FIFO), because replies for these are independent Host-side reads that can
  // arrive out of order. Draining on disconnect is handled uniformly for
  // whichever map is passed in, via `keyedResolverMaps` in
  // settlePendingOnDisconnect above — a new caller of this helper only needs
  // to add its map to that array to be covered.
  function withKeyedResolverTimeout(resolverMap, request_id, timeoutMs, sendFn) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const wrapped = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolverMap.delete(request_id)
        resolve(result)
      }
      timer = setTimeout(() => wrapped({ status: 'timeout' }), timeoutMs)
      resolverMap.set(request_id, wrapped)
      try {
        sendFn()
      } catch {
        wrapped({ status: 'disconnected' })
      }
    })
  }

  function sendRestoreRequest({ entity, entity_id }) {
    const request_id = randomUUID()
    return withKeyedResolverTimeout(restoreResolvers, request_id, submitTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'restore_request', request_id, entity, entity_id }))
    })
  }

  function sendDeleteRecordRequest({ entity, entity_id, expected_slot_count }) {
    const request_id = randomUUID()
    return withKeyedResolverTimeout(deleteResolvers, request_id, submitTimeoutMs, () => {
      ws.send(
        JSON.stringify({ type: 'delete_record_request', request_id, entity, entity_id, expected_slot_count })
      )
    })
  }

  // M3c merge: mirrors sendDeleteRecordRequest exactly — same never-queued,
  // resolver-keyed-by-request_id shape. docs/adr/2026-08-15-locations-merge-
  // and-delete-rehome.md D1 Open Q1.
  function sendMergeLocationRequest({ loser_id, winner_id, winner_capacity, expected_ref_count }) {
    const request_id = randomUUID()
    return withKeyedResolverTimeout(mergeResolvers, request_id, submitTimeoutMs, () => {
      ws.send(
        JSON.stringify({
          type: 'merge_location_request',
          request_id,
          loser_id,
          winner_id,
          winner_capacity,
          expected_ref_count,
        })
      )
    })
  }

  // Trigger 2 (app start) is subsumed by trigger 1: startup goes through the
  // same open/authenticate path. A third "drain immediately after insert"
  // trigger is deliberately NOT wired here: this function is only ever
  // reached when the socket is closed or a send has just failed, so an
  // immediate re-drain would either no-op or re-time-out against the same
  // dead link. Reconnect is the honest moment to retry.
  function queueRestore({ entity, entity_id, requested_by }) {
    insertPendingRestore(db, { entity, entity_id, requested_by })
    return { queued: true }
  }

  // Does this device still believe the record is deleted? Answered from the
  // MATERIALIZED row, not the op log, precisely because a Client may not hold
  // the history. If the row is back, another device already restored it and
  // the ops replicated here.
  function stillDeletedLocally(entity, entity_id) {
    const projection = PROJECTIONS[entity]
    if (!projection) return false
    const row = db
      .prepare(`SELECT 1 AS present FROM ${projection.table} WHERE ${projection.key} = ?`)
      .get(entity_id)
    return !row
  }

  // Trigger 3: fire-and-forget straight after an insert, so a momentary blip
  // resolves in seconds rather than at the next reconnect. Must never block
  // the IPC response — the director is told it is waiting, and the screen
  // updates when the result lands.
  function drainPendingRestores() {
    if (!drainingPromise) {
      drainingPromise = runDrainPass().finally(() => {
        drainingPromise = null
      })
    }
    return drainingPromise
  }

  async function runDrainPass() {
    for (const item of listPendingRestores(db)) {
      if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) break

      // Already done by another device (or by an earlier attempt of this
      // one): the outcome the director asked for has happened. Answered from
      // the materialized row, not the op log, precisely because a Client may
      // not hold the history.
      if (!stillDeletedLocally(item.entity, item.entity_id)) {
        deletePendingRestore(db, item.pendingId)
        continue
      }

      // An upgrade narrowed the allowlist under a queued request. Do not send
      // it, and do NOT delete it either — a queued restore that can no longer
      // succeed must fail visibly, not vanish.
      if (!RESTORABLE_ENTITIES.has(item.entity)) {
        recordRestoreError(db, item.pendingId, 'not-restorable')
        continue
      }

      const reply = await sendRestoreRequest(item)

      if (reply.ok) {
        deletePendingRestore(db, item.pendingId)
        continue
      }
      if (reply.error === 'not-deleted') {
        // Success, not an error: the record is back. Treating this as a
        // failure would leave a permanent row for work already done.
        deletePendingRestore(db, item.pendingId)
        continue
      }
      if (reply.error) {
        // 'not-restorable' | 'no-history' | 'forbidden' — terminal, and the
        // director has to see it. Keep the row.
        recordRestoreError(db, item.pendingId, reply.error)
        continue
      }
      // timeout / disconnected: nothing was performed. Leave the row
      // untouched and stop the pass; the next trigger retries it.
      break
    }
  }

  function waitForReconnect(timeoutMs = 2000) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      connectedPromise.then(finish)
      setTimeout(finish, timeoutMs)
    })
  }

  return {
    async write(request) {
      if (!authenticated) {
        // Task 10 round-5 Fix 1: persist BEFORE acknowledging 'queued' to the
        // caller. This is what makes the queue genuinely durable — if the
        // process dies before flushQueue ever runs, the row is still here on
        // next startup to be reloaded (see listPendingWrites above), so the
        // 'queued' status this returns is now honest rather than a false
        // confidence signal.
        const pendingId = randomUUID()
        // Task 10 round-5 Fix 3: generated once, here, and carried unchanged
        // through every future retry of this exact logical write (the same
        // `item` object is reused by flushQueue), so a retry after
        // timeout/disconnected is idempotent server-side.
        const client_write_id = randomUUID()
        // Coerce here, ONCE, before the item is both persisted and queued.
        // insertPendingWrite has to bind a SQLite-compatible primitive, but
        // coercing inside it would only fix the durable row and leave the
        // in-memory `item` holding the raw object/boolean — so the payload
        // flushQueue put on the wire depended on whether the app had restarted
        // in between (fresh queue = raw object, queue rebuilt from
        // pending_writes = JSON string). One coercion, one value, both paths.
        const item = { pendingId, client_write_id, ...request, value: coerceOpValue(request.value ?? null) }
        insertPendingWrite(db, item)
        queue.push(item)
        return { status: 'queued' }
      }
      return performWrite({ client_write_id: randomUUID(), ...request })
    },
    // Judgment call: unlike write(), this does NOT queue while unauthenticated
    // - offline queueing/retry for bulk_replace was not part of this task's
    // required behavior (idempotent retry, atomicity, and replication all
    // concern an already-connected submission), so it's left for a future
    // task if ScheduleScreen (Sub-plan E, the sole consumer) needs it.
    async writeBulkReplace({ entity, scope_id, rows }) {
      if (!authenticated) {
        return { status: 'not_authenticated' }
      }
      return performBulkReplaceWrite({ entity, scope_id, rows, client_write_id: randomUUID() })
    },
    onOpApplied(callback) {
      opAppliedListeners.push(callback)
    },
    onOpConflict(callback) {
      opConflictListeners.push(callback)
    },
    onOpRejected(callback) {
      opRejectedListeners.push(callback)
    },
    onFullSyncApplied(callback) {
      fullSyncAppliedListeners.push(callback)
    },
    // T27. Read-only by design: this reports what the device IS, and must never
    // become a second way to change what it is — chooseMode already does that,
    // and a status read that can reconfigure the device is a much bigger change
    // than it looks.
    isConnected() {
      return connected
    },
    // T87 Part 4 — mirrors isConnected() exactly. Distinct from `connected`:
    // see the `authenticated` variable's own comment above for why a socket
    // can be open without being authenticated.
    isAuthenticated() {
      return authenticated
    },

    onConnectionChange(callback) {
      connectionListeners.add(callback)
      return () => connectionListeners.delete(callback)
    },

    getQueuedOps() {
      return queue.slice()
    },
    // Ask the Host to restore a record. Never falls back to this device's own
    // history: a Client that paired after the record was created holds the
    // row but not the ops that made it, and would restore an empty shell.
    async requestRestore({ entity, entity_id, requested_by }) {
      if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
        return queueRestore({ entity, entity_id, requested_by })
      }

      const reply = await sendRestoreRequest({ entity, entity_id })
      if (reply.ok) {
        return {
          ok: true,
          restored_fields: reply.restored_fields,
          deleted_children: reply.deleted_children ?? [],
        }
      }
      // A terminal refusal is the Host's answer and is reported as-is —
      // including 'not-deleted', which on this path means the director asked
      // to restore something that is not deleted, not that a queued request
      // has already been satisfied. `field`/`existing` are forwarded too
      // (spread conditionally so the other four error strings stay
      // byte-identical) — T12: without them, TrashScreen could not name the
      // colliding record and fell back to a misleading "try again" message
      // for a refusal that is actually deterministic and permanent.
      if (reply.error) {
        return {
          error: reply.error,
          ...(reply.field ? { field: reply.field } : {}),
          ...(reply.existing ? { existing: reply.existing } : {}),
        }
      }

      // timeout / disconnected: undelivered, so record the intent and say it
      // is waiting rather than that it failed.
      return queueRestore({ entity, entity_id, requested_by })
    },
    // Ask the Host to delete a record a schedule uses. DELIBERATELY NOT QUEUED,
    // unlike requestRestore: the director agreed to a specific count, and a
    // request executed hours later would run against a different one.
    // docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
    async requestDelete({ entity, entity_id, expected_slot_count }) {
      if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
        return { error: 'host-unreachable' }
      }
      const reply = await sendDeleteRecordRequest({ entity, entity_id, expected_slot_count })
      if (reply.ok) {
        const { type: _type, request_id: _request_id, ...result } = reply
        return result
      }
      if (reply.error) return reply
      // timeout / disconnected: undelivered. Say so rather than implying the
      // delete happened, and never retry it silently against a stale count.
      return { error: 'host-unreachable' }
    },
    // Ask the Host to merge two locations. DELIBERATELY NOT QUEUED, same
    // reasoning as requestDelete: the director agreed to a specific
    // ref_count, and a merge executed later would run against a different
    // one. docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D1.
    async requestMerge({ loser_id, winner_id, winner_capacity, expected_ref_count }) {
      if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
        return { error: 'host-unreachable' }
      }
      const reply = await sendMergeLocationRequest({ loser_id, winner_id, winner_capacity, expected_ref_count })
      if (reply.ok) {
        const { type: _type, request_id: _request_id, ...result } = reply
        return result
      }
      if (reply.error) return reply
      // timeout / disconnected: undelivered. Say so rather than implying the
      // merge happened, and never retry it silently against a stale count.
      return { error: 'host-unreachable' }
    },
    getPendingRestores() {
      return listPendingRestores(db)
    },
    drainPendingRestores,
    async flushQueue() {
      if (!authenticated) {
        if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
          connect()
        }
        await waitForReconnect()
      }
      // Gate on `authenticated`, not just `connected`: a socket can be open
      // but not yet authenticated (fresh client before loginRemote resolves,
      // or a reconnect whose `authenticate` send hasn't happened yet).
      // Attempting acquireLockRemote/submitOpRemote against an
      // open-but-unauthenticated connection hits the same silent-ignore /
      // 10s-timeout hang this fix addresses in write(). Leave queued items
      // in place for the next flushQueue() call in that case.
      if (!authenticated) return

      // Task 10 round-4 Fix 2a: previously this discarded performWrite's
      // result entirely and unconditionally removed every queued item, so a
      // 'timeout'/'disconnected'/'error'/re-'conflict' outcome on flush was
      // silently thrown away with no retry and no signal to the caller.
      const items = queue.slice()
      for (const item of items) {
        // D4 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
        // an earlier iteration of THIS SAME pass may already have purged this
        // item as a sibling of a just-rejected entity_id (see the 'rejected'
        // branch below). It must not still be performed here — that would
        // resubmit the sibling write to the Host after the purge, recreating
        // the exact blank-name orphan D4 exists to prevent, just one
        // iteration later than the bug it's guarding against.
        if (!queue.some((q) => q.pendingId === item.pendingId)) continue

        const result = await performWrite(item)

        if (result.status === 'applied' || result.status === 'conflict') {
          // 'applied': the write genuinely succeeded — done.
          // 'conflict': not a failure to retry — submitOpRemote (inside
          // performWrite) already ran this through the normal op_conflict
          // path, which calls notifyOpConflict and persists it via
          // recordConflict on the message handler above, so it's already
          // surfaced through the existing conflict-notification mechanism.
          // Retrying the same stale write would be wrong; it's done being
          // "queued" and is now a pending conflict instead.
          const index = queue.findIndex((q) => q.pendingId === item.pendingId)
          if (index !== -1) queue.splice(index, 1)
          deletePendingWrite(db, item.pendingId)
          continue
        }

        if (result.status === 'rejected') {
          // Always drop the rejected item itself — it can never succeed as
          // written (D3: the Host has already decided and will never apply
          // it).
          const rejectedIndex = queue.findIndex((q) => q.pendingId === item.pendingId)
          if (rejectedIndex !== -1) queue.splice(rejectedIndex, 1)
          deletePendingWrite(db, item.pendingId)

          // Addendum Findings B+C (docs/adr/2026-08-15-locations-concurrent-
          // create-collision.md): the ORIGINAL D4 purge below fired for every
          // rejection unconditionally, which is correct for a CREATE but a
          // real data-loss bug for an EDIT — an offline rename batched with a
          // legitimate, unrelated field change (e.g. a capacity bump) to the
          // SAME already-existing row would silently drop the capacity write
          // too, just because it shared an entity_id with the doomed rename.
          //
          // The two cases are distinguished by whether a materialized local
          // row for (entity, entity_id) already exists at this moment — the
          // same technique stillDeletedLocally already uses, and sound for
          // the same reason: write()'s !authenticated branch (above) never
          // optimistically applies a row before Host acknowledgment, so:
          //   - CREATE: no local row exists — the whole entity_id is doomed
          //     (ensureExists would otherwise materialize a blank-name
          //     orphan the moment any sibling field reaches the Host), so
          //     every sibling queued for it must be purged too.
          //   - EDIT: a local row already exists — only the rejected field is
          //     invalid; a sibling field on the SAME real row is independent
          //     and must be allowed to proceed normally on this or the next
          //     flush pass.
          const projection = PROJECTIONS[item.entity]
          const rowExistsLocally = !!(
            projection &&
            db.prepare(`SELECT 1 FROM ${projection.table} WHERE ${projection.key} = ?`).get(item.entity_id)
          )

          if (!rowExistsLocally) {
            const siblings = queue.filter((q) => q.entity === item.entity && q.entity_id === item.entity_id)
            if (siblings.length > 0) {
              // Finding D: one transaction for the whole purge. Narrowed to
              // the create-case (Decision C) also narrows this finding's
              // blast radius — a crash mid-purge can now only leave a
              // surviving sibling of a DOOMED, never-valid entity_id (inert:
              // that row can never become real either way), never a
              // surviving sibling of a row that matters.
              const purgeSiblings = db.transaction(() => {
                for (const sibling of siblings) deletePendingWrite(db, sibling.pendingId)
              })
              purgeSiblings()
              for (const sibling of siblings) {
                const siblingIndex = queue.findIndex((q) => q.pendingId === sibling.pendingId)
                if (siblingIndex !== -1) queue.splice(siblingIndex, 1)
              }
            }
          }

          // No separate notifyOpRejected call here: performWrite got here via
          // submitOpRemote, which already ran the rejected submission through
          // the SAME op_rejected message-handler case an interactive write
          // uses (see the ws.on('message') handler above) — that already
          // called notifyOpRejected(msg) once, with the full wire shape
          // (msg.op.entity_id, reason, existing). This is precisely what
          // makes the notification reach the renderer for the offline case
          // too: there is no live caller left waiting on THIS specific write
          // (write()'s !authenticated branch already returned 'queued' and
          // moved on), but the listener registered via onOpRejected still
          // fires, because it fires on message receipt, not on a caller
          // awaiting a promise.
          continue
        }

        // Task 10 round-5 Fix 2: lock contention is transient (another
        // device merely held the lock at this instant) and, unlike a genuine
        // 'conflict', was never surfaced through submitOpRemote/op_conflict —
        // submitOpRemote never even ran. Do NOT drop the item: leave it in
        // the queue (and in the durable pending_writes table) so the next
        // flushQueue() pass retries it, exactly like 'timeout'/'disconnected'.
        // It's item-specific (the lock may already be free for the next
        // item), so keep trying the rest of this batch rather than aborting.
        if (result.status === 'lock_contention') continue

        // 'timeout' / 'disconnected' / 'error' (or any future unrecognized
        // status): do NOT silently drop the item. Leave it in the queue so
        // the next flushQueue() call retries it. A connectivity failure
        // ('timeout'/'disconnected') means every remaining item in this
        // batch will fail the same way, so stop this pass early rather than
        // hammering a dead connection with one lock/submit round-trip per
        // item; an 'error' is item-specific, so keep trying the rest.
        if (result.status === 'timeout' || result.status === 'disconnected') break
      }
    },
    async waitUntilConnected() {
      await connectedPromise
    },
    async loginRemote({ name, pin }) {
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
        return { status: 'disconnected' }
      }
      const reply = await sendLoginRemote({ name, pin })
      if (reply.status === 'disconnected' || reply.status === 'timeout') return reply
      if (reply.type === 'login_ok') {
        token = reply.token
        ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
        authenticated = true
        scheduleRenewal(token)
        return { status: 'ok', token: reply.token, userId: reply.userId, role: reply.role }
      }
      // login_failed
      return reply.locked
        ? { status: 'failed', locked: true, retryAfterMs: reply.retryAfterMs }
        : { status: 'failed' }
    },
    onPairingApproved(callback) {
      pairingApprovedListeners.push(callback)
    },
    onPairingDenied(callback) {
      pairingDeniedListeners.push(callback)
    },
    onTokenRenewed(callback) {
      tokenRenewedListeners.push(callback)
    },
    // T87 Part 3 — mirrors onPairingDenied exactly.
    onAuthRejected(callback) {
      authRejectedListeners.push(callback)
    },
    close() {
      // Signal the close handler that this is intentional so the reconnect
      // loop does not restart.
      closedIntentionally = true
      if (renewalTimer) clearTimeout(renewalTimer)
      if (ws) ws.close()
    },
    // test-only accessor: exposes the underlying ws connection so tests can
    // simulate malformed/malicious server messages or abrupt disconnects.
    __getWs() {
      return ws
    },
  }
}
