// Automerge generalization slice projector: materialize an Automerge document into SQLite, for
// every entity in DIRECT_CAMP_ENTITIES (docs/adr/2026-09-06-productionize-
// automerge-libp2p-sync.md).
//
// SQLite is DERIVED, not authoritative: this projector rebuilds it from the
// document. It does NOT re-implement the op-log's projection logic — it
// REUSES it. Each field present in the document is replayed through the
// existing `applyProjection` (electron/ops/projections.js) as a synthetic
// op, so a row projected from the document travels the exact same code path
// as a row projected op-by-op from the op-log. Parity is therefore
// structural, not a property that has to be re-proven for every input:
//   - ensureExists placeholder + per-field UPDATE: inherited, cannot drift.
//   - the camp_id tenant guard (applyProjection rejects a camp_id write whose
//     value isn't this device's camp): inherited.
//   - DELETE_FIELD row-delete semantics: inherited.
// Each entity's pass runs in its own transaction (better-sqlite3 nests these
// as savepoints when called from within an outer transaction — see
// projectAll/rebuildFromDoc below), so a throw mid-projection rolls that
// entity's pass back rather than leaving SQLite half-materialized.
//
// Scoped to DIRECT_CAMP_ENTITIES only — refuses any other entity loudly
// rather than guessing (host-only tables, parent-scoped tables, and the one
// bulk-replace entity, template_slots, are out of scope for this document
// layer; see campDocument.js).
import { applyProjection } from '../ops/projections.js'
import { DELETE_FIELD, applyBulkReplaceProjection } from '../ops/operations.js'
import { DOMAIN_SNAPSHOT_ORDER, BULK_REPLACE_ENTITIES } from '../ops/campScopedEntities.js'
import { assertNoUnrecordedConflicts } from './reconcile.js'
import { assertNoUnrecordedUniqueConflicts } from './uniqueConflicts.js'
import { listRecordIds, readRecord, hasAnyRecord } from './campDocument.js'
import { verifyAuthFields } from '../auth/authSignature.js'
import { verifyTombstone } from './tombstoneSignature.js'
import * as Automerge from '@automerge/automerge'
import { verifyAuthorityEntry } from './authorityLogSignature.js'
import { createAuthorityReplayContext, isCompleteEntry, AUTHORITY_LOG_ENTITY } from './authorityReplay.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { PROJECTIONS } from '../ops/projections.js'
import { STAGE1_ENTITY, MODELED_ENTITIES, BULK_REPLACE_MODELED_ENTITIES, DEFERRED_ENTITIES } from './campDocument.js'
import { STORE_DOCUMENT_REPLAY, boundedErrorMessage } from '../ops/documentWriteFailures.js'

// Record that one doc-replay row was dropped whole (see upsertRow below), in
// projection_failures (electron/ops/documentWriteFailures.js) under
// store='document-replay' — this failure has no op-log op (the doc-replay path writes straight to
// SQLite, never through appendOp), so op_id is a deterministic string derived from the failure
// itself rather than a real operations(id): nothing is fabricated to satisfy a foreign key. See the
// 2026-09-17 addendum to docs/adr/2026-09-04-projection-failure-detection-and-recovery.md.
// `ON CONFLICT(op_id) DO UPDATE` makes a repeated failure on the same (entity, entityId, field)
// collapse onto the same row rather than accumulate duplicates. Wrapped in its own try/catch: a
// failure to record the failure must never re-break the projection it is trying to report on.
function recordRowProjectionFailure(db, { entity, entityId, field, error }) {
  try {
    const opId = `replay:${entity}:${entityId}:${field ?? ''}`
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, store)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(op_id) DO UPDATE SET
         error_message = excluded.error_message, failed_at = excluded.failed_at, store = excluded.store`
    ).run(opId, entity, entityId, field ?? '', boundedErrorMessage(error), now, STORE_DOCUMENT_REPLAY)
  } catch (recordErr) {
    console.error(`projector: could not record a projection failure for '${entity}'/'${entityId}':`, recordErr)
  }
}

let rowSavepointCounter = 0

function assertModeled(entity) {
  if (DEFERRED_ENTITIES.has(entity)) {
    throw new Error(
      `projector: '${entity}' is deferred (see DEFERRED_ENTITIES) — its ensureExists reads the ` +
        `op-log, which the doc-replay path never writes; needs its own doc-native row-construction slice`
    )
  }
  if (!MODELED_ENTITIES.has(entity) && !BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `projector: '${entity}' is not a modeled camp-scoped entity (see MODELED_ENTITIES)`
    )
  }
}

// Parent-scoped entities slice: DOMAIN_SNAPSHOT_ORDER deliberately EXCLUDES schedule_snapshots
// (campScopedEntities.js's own comment: "unbounded historical growth over a season" — that
// exclusion is about the first-pairing full_sync WS payload, a completely different concern from
// this projector's FK-safe apply order). schedule_snapshots.template_id IS a real NOT NULL FK to
// schedule_templates(id) though, so THIS projector still needs a position for it — immediately
// after schedule_templates, its only FK target.
//
// Do not "fix" this by adding schedule_snapshots to DOMAIN_SNAPSHOT_ORDER itself. _Prior, and the
// REASON has changed: the warning was that "that array is shared with syncServer.js/syncClient.js's
// full_sync payload and changing it would reintroduce the unbounded-growth problem that exclusion
// exists to avoid." Those two files were deleted at the Stage 6c cutover, so there is no full_sync
// payload to bloat. The instruction still stands on a narrower basis: DOMAIN_SNAPSHOT_ORDER is
// asserted against DIRECT_CAMP_ENTITIES at import time (assertDirectEntityParity in
// campScopedEntities.js), and schedule_snapshots is parent-scoped, so adding it there would trip
// that parity guard. Verify the current constraint before acting on this either way rather than
// trusting the retired one._
const DOMAIN_ORDER_WITH_SNAPSHOTS = (() => {
  const idx = DOMAIN_SNAPSHOT_ORDER.indexOf('schedule_templates')
  return [
    ...DOMAIN_SNAPSHOT_ORDER.slice(0, idx + 1),
    'schedule_snapshots',
    ...DOMAIN_SNAPSHOT_ORDER.slice(idx + 1),
  ]
})()

// `camps` and `users` (Stage 6 prep): same reasoning as campDocument.js's EXTRA_MODELED_ENTITIES —
// neither is in DOMAIN_SNAPSHOT_ORDER (_prior: "that array is shared with the WS full_sync payload,
// which already has its own bespoke camps/users handling"; that payload was deleted at Stage 6c —
// the array's exclusion of camps/users remains, see campDocument.js's comment), so this projector
// needs its own position for them, not a change to the shared registry. `camps` first:
// `users.camp_id` is a (nullable) FK to `camps.id`, so camps must exist first for any FK-checked
// insert to succeed — though in practice `camps` never inserts a new row via this path at all (see
// PROJECTIONS.camps.ensureExists: it only ever matches or refuses, never creates — the singleton
// camps row is created exclusively by bootstrapCamp/the pairing flow, never by doc replay).
// `tombstones` (T233, docs/adr/2026-09-19-multi-device-erasure-propagation.md): positioned right
// after `users`, before every domain entity — it MUST project before `campers` (and the two
// elective_* participant tables it also denylist-gates), because upsertEntity's denylist check
// below reads the just-projected SQLite `tombstones` table to decide whether to skip/delete a row.
// A tombstone has no FK of its own (its id is an opaque reference to ANOTHER table's row, not a
// real foreign key), so this position is safe for every other table's FK ordering too.
// `camp_authority_log` (T331, docs/adr/2026-10-02-distributed-revocation-authority.md): positioned
// right after `tombstones` — no FK of its own (same reasoning as tombstones' position), and it has
// no SQL table to project into at all (see campDocument.js's EXTRA_MODELED_ENTITIES comment), so
// its ordering relative to every domain entity is a don't-care; grouped with the other two
// security-sensitive, bespoke-handling entities for readability.
const DOMAIN_ORDER_WITH_CAMPS_AND_USERS = ['camps', 'users', 'tombstones', 'camp_authority_log', ...DOMAIN_ORDER_WITH_SNAPSHOTS]

// FK-safe apply order, filtered to just the entities this document layer models (DOMAIN_SNAPSHOT_
// ORDER, extended above, also lists deferred entities, which are out of scope here).
// `foreign_keys = ON` (openLocalDb) makes this order load-bearing — a table must project after
// every other table whose id it references. template_slots appears once here (its DOMAIN_SNAPSHOT_
// ORDER position, after schedule_templates) and is projected via BOTH upsertEntity's flat pass
// (individual cell edits) AND upsertBulkReplaceEntity's scope pass (whole-schedule regenerate) — see
// upsertEntity/deleteReconcileEntity below.
export const MODELED_ORDER = DOMAIN_ORDER_WITH_CAMPS_AND_USERS.filter(
  (entity) => MODELED_ENTITIES.has(entity) || BULK_REPLACE_MODELED_ENTITIES.has(entity)
)

// Bulk-replace scope projection: reuses applyBulkReplaceProjection (electron/ops/operations.js)
// UNCHANGED — same reuse-not-reimplement discipline as the flat path above. Each scope's stored
// value (doc[`${entity}_scopes`][scopeId], a JSON string — see campDocument.js's applyBulkReplace)
// is exactly the `op.value` shape applyBulkReplaceProjection already expects, so a synthetic op
// object `{ entity, entity_id: scopeId, value }` replays through the SAME delete-then-insert-all
// transaction a real op-log bulk_replace op does.
function upsertBulkReplaceEntity(db, doc, entity) {
  const collectionName = `${entity}_scopes`
  const scopes = doc[collectionName] ?? {}
  for (const scopeId of Object.keys(scopes)) {
    applyBulkReplaceProjection(db, { entity, entity_id: scopeId, value: scopes[scopeId] })
  }
}

// Delete-reconcile for a bulk-replace entity: any SCOPE (not row) present in SQLite but absent from
// the document's scope collection is cleared entirely — e.g. a template whose schedule_templates row
// (and template_slots_scopes entry) were both removed from the doc together. Reuses
// applyBulkReplaceProjection with an empty row set, rather than a bespoke DELETE, for the same
// atomicity/validation guarantees a real op-log delete-via-empty-bulk-replace would get.
function deleteReconcileBulkReplaceEntity(db, doc, entity) {
  const config = BULK_REPLACE_ENTITIES[entity]
  const collectionName = `${entity}_scopes`
  const inDoc = new Set(Object.keys(doc[collectionName] ?? {}))
  const rows = db.prepare(`SELECT DISTINCT ${config.scopeColumn} AS scope_id FROM ${config.table}`).all()
  for (const { scope_id } of rows) {
    if (!inDoc.has(scope_id)) {
      applyBulkReplaceProjection(db, { entity, entity_id: scope_id, value: '[]' })
    }
  }
}

// Upsert step: replay every field present in the document for this entity
// through applyProjection. Does NOT delete-reconcile — see deleteReconcile
// below for why that has to run as a separate, later pass across ALL
// entities rather than inline here.
//
// template_slots is dual-modeled (see campDocument.js's applyBulkReplace comment): the bulk-replace
// scope pass runs FIRST (it is the authoritative baseline — every row a whole-schedule regenerate
// produced), then the ordinary flat pass runs SECOND as an OVERLAY of individual per-cell edits onto
// rows the scope pass already inserted. Order matters and mirrors real usage: a director generates a
// schedule (bulk-replace), then may tweak individual cells afterward (field-level writes) — never
// the other way around. The flat pass's per-field UPDATE matches zero rows for any id the scope pass
// didn't insert (a harmless no-op — see deleteReconcileEntity's skip below for why those can exist).
// `camps` convergence (Stage 6 prep — see docs/work/plans/2026-09-07-stage6-cutover-plan.md's
// task brief, "the camps singleton problem"): every device already has its OWN local `camps` row
// before this document layer's `camps` entity is ever projected — liveDoc.js's getCampId(db) is a
// hard gate ahead of every doc read/write (recordLocalWrite, recordLocalBulkReplace, the sync-node
// startup path all `return` immediately when `SELECT id FROM camps LIMIT 1` is empty), so this
// projection path structurally can never be how a device gets its FIRST camps row. That row comes
// from bootstrapCamp (the Host) or the pairing/join flow (a joining device receiving the camp
// identity by a mechanism outside this document — today the `camp` payload carried on the libp2p
// join flow, see electron/auth/connectionAuth.js and
// docs/adr/2026-09-08-libp2p-join-flow.md). _Prior: that mechanism was "the legacy WS full_sync's
// `INSERT OR REPLACE INTO camps` in syncClient.js; a libp2p-native equivalent is Stage 6's
// problem, not this slice's". Stage 6 shipped and connectionAuth.js's `camp` payload IS that
// equivalent — its own comment points back at this sentence._
//
// So by the time doc-projection runs, `db`'s camps row already exists and its `id` already matches
// what the rest of the camp's devices agree on — modeling `camps.name` here is about *subsequent*
// field changes (e.g. a future camp-rename feature) converging across devices that already share an
// id, not about creating that shared identity.
//
// The failure mode this guards against is a device somehow ending up with a document containing a
// DIFFERENT camp's row (id mismatch) — never expected in the supported pairing flow, but not
// impossible (a restored backup from the wrong camp, a bug, a merged `.automerge` file that
// shouldn't have been). PROJECTIONS.camps.ensureExists already refuses that case by throwing
// (camps is a true singleton — see its own comment in projections.js). Left uncaught, that throw
// would propagate out of applyProjection and abort projectAll's ONE shared transaction, rolling
// back every OTHER entity's legitimate projection along with it — a single stray foreign camps row
// in the document would then block ALL sync, camp-wide. The deterministic, testable rule
// implemented here: THIS device's own existing camp id always wins; any other id present in the
// document's `camps` collection is permanently ignored (skipped, logged, never inserted, never
// allowed to overwrite the local identity row) rather than crashing the batch.
function upsertCampsEntity(db, doc) {
  const fields = PROJECTIONS.camps.fields
  for (const id of listRecordIds(doc, 'camps')) {
    const row = readRecord(doc, 'camps', id)
    if (!row) continue
    for (const field of fields) {
      if (!(field in row)) continue
      try {
        applyProjection(db, { entity: 'camps', entity_id: id, field, value: row[field], knownRow: row })
      } catch (err) {
        // Expected refusal from PROJECTIONS.camps.ensureExists when `id` doesn't match this
        // device's own camp row (see comment above) — skip just this row, not the whole batch.
        console.error(
          `projector: skipping doc 'camps' row '${id}' — does not match this device's own camp (${err.message})`
        )
      }
    }
  }
}

// Q1 ENFORCEMENT (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md, slice 3).
// The credential fields a compromised paired device could otherwise forge on the merge path.
// `cred_version` is included so a refused change also keeps the local version (T172) — the version
// only advances together with a verified credential change, never on its own.
const CREDENTIAL_FIELDS = new Set(['role', 'pin_hash', 'pin_salt', 'cred_version'])

// Project `users`, refusing a forged credential CHANGE. The rule (see the ADR) closes the Q1 attack
// without ever locking anyone out:
//   - A CHANGE to role/pin_hash/pin_salt (differs from the current local row, or a brand-new row)
//     is applied only if the row carries a Host signature (`auth_sig`) that verifies over the full
//     {id, role, pin_hash, pin_salt} tuple. A change that fails to verify is REFUSED — the current
//     local credential values are kept (a brand-new refused row stays at the safe ensureExists
//     default: role 'staff', empty pin, which cannot authenticate). Non-credential fields still apply.
//   - An UNCHANGED credential value always applies (a no-op) regardless of signature, so a legacy
//     pre-signing row that never changes is never rejected.
//   - When this device has no `camps.signing_public_key` (e.g. freshly rebuilt from the document,
//     #401), it cannot verify, so it SKIPS an unverifiable credential change — keeps the current
//     local value (or the safe ensureExists default for a new row), NEVER accepts it (T172 finding 2:
//     accepting here let a forgery received key-less become permanent). This does not lock a normal
//     device out: `signing_public_key` is written from the authenticated login/join reply BEFORE any
//     projection (joinSession.js), and it is not a replicated doc field, so on a real sync the key is
//     already present when users project. The genuine value applies once the key is present.
function upsertUsersEntity(db, doc) {
  const pub = db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()?.signing_public_key || null
  const fields = PROJECTIONS.users.fields
  for (const id of listRecordIds(doc, 'users')) {
    const row = readRecord(doc, 'users', id)
    if (!row) continue

    const presentCred = [...CREDENTIAL_FIELDS].filter((f) => f in row)
    const current = presentCred.length
      ? db.prepare('SELECT role, pin_hash, pin_salt, cred_version FROM users WHERE id = ?').get(id)
      : null
    const credChanged = presentCred.length > 0 && (!current || presentCred.some((f) => current[f] !== row[f]))

    let acceptCred = true
    if (credChanged) {
      if (!pub) {
        // No signing key on this device (e.g. a device rebuilt from the document before it has
        // re-synced camps.signing_public_key, #401). We cannot verify, so we DO NOT apply an
        // unverifiable credential CHANGE — we keep the current local values instead of accepting a
        // possibly-forged one (T172 finding 2: accepting here made forgeries permanent). This does
        // not lock anyone out: camps projects before users in the same projectAll pass, so on any
        // real sync that carries users the key is already present; the no-key branch is only the
        // brief pre-first-sync window, where there is no legitimate credential to apply yet anyway.
        acceptCred = false
      } else {
        const verified = verifyAuthFields(
          pub,
          { id, role: row.role, pin_hash: row.pin_hash, pin_salt: row.pin_salt, cred_version: row.cred_version },
          row.auth_sig
        )
        // Monotonicity (T172 finding 1): even a genuinely Host-signed tuple is refused if its version
        // is not newer than what we already have — this defeats a REPLAY of an older signed tuple
        // (e.g. re-introducing a pre-promotion staff record to demote an admin or roll back a PIN).
        const monotonic = Number(row.cred_version ?? 0) >= Number(current?.cred_version ?? 0)
        acceptCred = verified && monotonic
      }
      if (!acceptCred && pub) {
        // Surface it — a silently-dropped credential change is exactly what "surface every failure"
        // forbids. This is the Q1 attack being blocked in the act.
        recordAuditEvent(db, {
          targetType: 'users',
          targetId: id,
          action: 'users.credential_change',
          // 'deny', NOT 'denied' — audit_events.outcome is CHECK (outcome IN ('allow','deny')).
          // The wrong value made every one of these inserts fail the constraint and get swallowed to
          // a console.warn, so the record of a BLOCKED Q1 attack silently never landed (caught by
          // app-icon-audit's review; same class of bug as #388/#414). Tested by read-back below.
          outcome: 'deny',
          reason: 'auth_sig missing or invalid on a credential change — refused on the merge path (Q1 enforcement)',
        })
        console.error(
          `projector: REFUSED an unsigned/forged credential change for user ${id} (auth_sig did not verify) — keeping current local credentials. Q1 enforcement.`
        )
      }
    }

    for (const field of fields) {
      if (!(field in row)) continue
      if (!acceptCred && CREDENTIAL_FIELDS.has(field)) continue // keep the current local credential value
      applyProjection(db, { entity: 'users', entity_id: id, field, value: row[field], knownRow: row })
    }
  }
}

// T233 ENFORCEMENT (docs/adr/2026-09-19-multi-device-erasure-propagation.md). The signed
// purge-tombstone denylist, modeled as a sibling of upsertUsersEntity's CREDENTIAL_FIELDS pattern:
// a tombstone merges into the CRDT unconditionally, and is refused at PROJECTION time (not
// mid-merge — Security F2: there is no per-op merge-time rejection seam) unless it carries a
// verifying Host signature AND a version that is not older than what this device already has.
//   - `id` IS the tombstoned target's own id — not a separately-minted tombstone id.
//   - The trust root is read from the LOCAL `camps.signing_public_key` column (Security F1) —
//     NEVER from the document; PROJECTIONS.camps.fields is ['name'] and stays that way.
//   - No signing key on this device (e.g. a fresh rebuild pre-first-sync) means it cannot verify,
//     so it SKIPS an unverifiable tombstone entirely (keep-last-known, same policy as
//     upsertUsersEntity's no-key branch) rather than either accepting or refusing it.
//   - A refusal is loud: recordAuditEvent (outcome 'deny', NOT 'denied' — see upsertUsersEntity's
//     own note on the CHECK constraint) plus a console.error, never a silent drop.
function upsertTombstonesEntity(db, doc) {
  const pub = db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()?.signing_public_key || null
  const fields = PROJECTIONS.tombstones.fields
  for (const id of listRecordIds(doc, 'tombstones')) {
    const row = readRecord(doc, 'tombstones', id)
    if (!row) continue
    // A tombstone with no entity/version/sig yet is an incomplete write in flight (fields arrive
    // one at a time on the wire in the general case) — nothing to verify yet, skip silently.
    if (!row.entity || row.version === undefined || row.version === null || !row.sig) continue

    if (!pub) {
      // No signing key on this device yet — cannot verify. Keep-last-known: never apply an
      // unverifiable tombstone (same reasoning as upsertUsersEntity's no-key branch).
      continue
    }

    const current = db.prepare('SELECT version FROM tombstones WHERE id = ?').get(id)
    const verified = verifyTombstone(pub, { id, entity: row.entity, version: Number(row.version) }, row.sig)
    // Monotonicity mirrors upsertUsersEntity's cred_version guard: `>=`, not `>`, so re-applying
    // the SAME genuinely-signed tombstone (a re-sync, a re-merge) is an idempotent no-op rather
    // than a refusal — only a version STRICTLY LOWER than what this device already has is a
    // replay of a stale tombstone and gets refused.
    const monotonic = Number(row.version) >= Number(current?.version ?? 0)

    if (!verified || !monotonic) {
      recordAuditEvent(db, {
        targetType: 'tombstones',
        targetId: id,
        action: 'tombstones.refused',
        // 'deny', NOT 'denied' — audit_events.outcome is CHECK (outcome IN ('allow','deny')).
        outcome: 'deny',
        reason: 'tombstone signature invalid or version not monotonic — refused at projection (T233 enforcement)',
      })
      console.error(
        `projector: REFUSED an unsigned/forged/stale tombstone for '${id}' (entity=${row.entity}) — T233 enforcement.`
      )
      continue
    }

    for (const field of fields) {
      if (!(field in row)) continue
      applyProjection(db, { entity: 'tombstones', entity_id: id, field, value: row[field], knownRow: row })
    }
  }
}

// T331 ENFORCEMENT (docs/adr/2026-10-02-distributed-revocation-authority.md) — the verify-and-
// replay loop producing the derived "currently admin"/"currently revoked" cache. Unlike every
// other upsert* function here, this one does NOT project into a 1:1 mirror SQL table (there is
// none — see campDocument.js's EXTRA_MODELED_ENTITIES comment); it writes two device-local,
// never-synced tables instead: `applied_authority_log` (every entry this device has verified, an
// audit trail) and `authority_cache` (the derived admin/revoked set, one row per device that has
// ever been a target). Both are FULLY RE-DERIVED on every pass — never incrementally patched —
// which is what makes purge/rebuild's "re-verify and carry forward, never reset" requirement a
// property of calling this function again, not a separate mechanism: as long as the real
// `camp_authority_log` collection in the document is untouched by a purge/rebuild (it is — purge
// operates on this device's local SQLite projection, never on the synced document), re-running
// this function reconstructs the identical derived state.
//
// Peer-id resolution for signature verification (an AUTHENTICITY gate, separate from and prior to
// the causal-ancestor/quorum MATH in authorityReplay.js): a signer's peer id is read from that
// signer's own earlier 'genesis'/'grant' entry naming it as a target — never from the mutable,
// non-trust devices.libp2p_peer_id column (see authorityLogSignature.js's module header). This is
// a practical, DOCUMENTED simplification: resolution walks entries in plain document order rather
// than strict causal order, so a signer whose own identity-establishing entry has not yet been
// seen in this pass is treated as unresolvable (entry dropped, fails closed) rather than guessed.
function resolveAuthorityPeerIds(doc) {
  const peerIdByDevice = new Map()
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!row || (row.kind !== 'genesis' && row.kind !== 'grant')) continue
    if (!row.target_device_id || !row.target_peer_id) continue
    if (!peerIdByDevice.has(row.target_device_id)) peerIdByDevice.set(row.target_device_id, row.target_peer_id)
  }
  return peerIdByDevice
}

function upsertCampAuthorityLogEntity(db, doc) {
  const peerIdByDevice = resolveAuthorityPeerIds(doc)
  const isEntryTrusted = (entry) => {
    const signerPeerId = peerIdByDevice.get(entry.signer_device_id)
    if (!signerPeerId) return false // signer's own identity never established — fail closed
    return verifyAuthorityEntry(
      signerPeerId,
      { kind: entry.kind, target_device_id: entry.target_device_id, signer_device_id: entry.signer_device_id },
      entry.signature
    )
  }

  const ctx = createAuthorityReplayContext(Automerge, doc, { isEntryTrusted })
  const { grantedSet } = ctx.currentState()

  const now = new Date().toISOString()
  db.prepare('DELETE FROM applied_authority_log').run()
  db.prepare('DELETE FROM authority_cache').run()
  const insertLog = db.prepare(
    'INSERT INTO applied_authority_log (entry_id, kind, target_device_id, signer_device_id, verified_at) VALUES (?, ?, ?, ?, ?)'
  )
  const everyTargetDeviceId = new Set(grantedSet)
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    const entry = { id, ...row }
    if (entry.target_device_id) everyTargetDeviceId.add(entry.target_device_id)
    if (entry.kind !== 'genesis' && !isEntryTrusted(entry)) continue
    insertLog.run(id, entry.kind, entry.target_device_id ?? null, entry.signer_device_id ?? null, now)
  }

  const insertCache = db.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)')
  for (const deviceId of everyTargetDeviceId) {
    insertCache.run(deviceId, grantedSet.has(deviceId) ? 'admin' : 'revoked', now)
  }
}

// The denylist: which entities are gated by a `campers` tombstone, and which column on that
// entity's own row carries the camper id to check. `campers` is gated by its own `id`;
// elective_preferences/elective_assignments are gated by their `camper_id` field — participant
// data that must vanish along with the camper it describes (ADR "Design" section).
export const TOMBSTONE_DENYLISTED_ENTITIES = {
  campers: { idField: 'id', tombstoneEntity: 'campers' },
  elective_preferences: { idField: 'camper_id', tombstoneEntity: 'campers' },
  elective_assignments: { idField: 'camper_id', tombstoneEntity: 'campers' },
  // T320 part 2 item 3 — these rows now carry a real `camper_id` (the
  // SHEET_CAMPER_WITHOUT_PREFERENCE roster kind), so without this entry a
  // purged camper's id would survive in a table the erasure sweep does not
  // touch.
  elective_run_findings: { idField: 'camper_id', tombstoneEntity: 'campers' },
  // A finalized run's per-camper, per-cell export snapshot (finalizeElectiveRun.js). `camper_id`
  // is NOT NULL, and it is baked into the row's own id
  // (deriveElectiveRunOuterSnapshotId(run_id, camper_id, day_id, time_block_id)), so without this
  // entry an erased camper's whole finalized schedule — and the camper id itself — would survive
  // in every exported run on every device.
  elective_run_outer_snapshots: { idField: 'camper_id', tombstoneEntity: 'campers' },
  // T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md) — the
  // name/external-id -> camper_id lookup row. Gated on `camper_id` like its
  // siblings above, NOT its own `id` (the id is a derived lookup key, not the
  // camper): without this entry a purged camper's mapping row — the one place
  // this app now keeps a child's name in cleartext — would survive a purge on
  // every device that receives the tombstone, defeating the whole point of the
  // ADR.
  camper_identity_keys: { idField: 'camper_id', tombstoneEntity: 'campers' },
}
// `elective_assignment_runs` (the run row itself) is deliberately ABSENT from this denylist — it
// is not camper data, so it is not supposed to vanish when a camper is purged. Its
// `snapshot_digest` field carries run-scoped sha256 hashes of camper ids
// (electiveRunSnapshotCompleteness.js's computeExpectedSnapshotDigestByCamper), never the ids
// themselves, so the run row surviving a purge carries no readable identity. That is
// guess-resistance, not erasure — see SECURITY.md's camper-record-purge section and the digest-map-
// keys amendment in docs/adr/2026-09-30-elective-run-durability.md before relying on it for more.
//
// Measured, not assumed, 2026-10-01 (T321): `camper_id` appears as a column on exactly five tables in
// electron/db/schema.sql (elective_preferences, elective_assignments, elective_run_outer_snapshots,
// elective_run_findings, camper_identity_keys), and all five are entries above, alongside `campers`
// itself. Re-run that grep rather than trusting this sentence if you add a table — the previous
// version of this comment claimed the same completeness and went stale the moment `snapshot_digest`
// started carrying ids.

// T233 round 2, finding 4: upsertEntity (below) returns early for a BULK_REPLACE_MODELED_ENTITIES
// entity, BEFORE the denylist gate below ever runs — a future bulk-replace entity added to
// TOMBSTONE_DENYLISTED_ENTITIES would silently bypass tombstone gating. No entity is in both sets
// today (harmless), but nothing enforced that. Fail loudly at module load rather than let it drift
// in silently.
for (const entity of Object.keys(TOMBSTONE_DENYLISTED_ENTITIES)) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `projector.js: '${entity}' is in both TOMBSTONE_DENYLISTED_ENTITIES and ` +
        'BULK_REPLACE_MODELED_ENTITIES. upsertEntity returns after the bulk-replace branch, ' +
        'before the tombstone denylist gate runs (T233 round 2 finding 4) — a bulk-replace ' +
        "entity would bypass tombstone gating entirely. This needs explicit projector support " +
        'before it can be added to both lists.'
    )
  }
}

// Every id VERIFIED-and-projected into SQLite's `tombstones` table for one target entity type —
// reading this back (rather than re-verifying here) is safe and cheap: upsertTombstonesEntity
// above already refused to write any row that failed signature/monotonicity, so a plain id in
// this table is, by construction, a real tombstone. Loaded once per entity per pass.
function tombstonedIds(db, tombstoneEntity) {
  const rows = db.prepare('SELECT id FROM tombstones WHERE entity = ?').all(tombstoneEntity)
  return new Set(rows.map((r) => r.id))
}

function upsertEntity(db, doc, entity, failures = null) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) upsertBulkReplaceEntity(db, doc, entity)
  if (!MODELED_ENTITIES.has(entity)) return
  if (entity === 'camps') {
    upsertCampsEntity(db, doc)
    return
  }
  if (entity === 'users') {
    upsertUsersEntity(db, doc)
    return
  }
  if (entity === 'tombstones') {
    upsertTombstonesEntity(db, doc)
    return
  }
  if (entity === AUTHORITY_LOG_ENTITY) {
    upsertCampAuthorityLogEntity(db, doc)
    return
  }
  const fields = PROJECTIONS[entity].fields
  // Loaded ONCE per entity per pass (one indexed query, not one per row) — the outstanding
  // store='projection' failures for this entity, so a successful upsertRow below can tell
  // cheaply (a Set.has, no query) whether this row even has anything to resolve. Only the rows
  // that actually match get the resolving UPDATE.
  const outstandingIds = outstandingProjectionFailureRowIds(db, entity)
  // T233: this entity's tombstone denylist, if it has one (see TOMBSTONE_DENYLISTED_ENTITIES).
  // `tombstones` itself projects earlier in MODELED_ORDER (see DOMAIN_ORDER_WITH_CAMPS_AND_USERS),
  // so this query always reflects the current pass's verified tombstones, not a stale prior one.
  const denylist = TOMBSTONE_DENYLISTED_ENTITIES[entity]
  const tombstoned = denylist ? tombstonedIds(db, denylist.tombstoneEntity) : null
  for (const id of listRecordIds(doc, entity)) {
    const row = readRecord(doc, entity, id)
    if (!row) continue
    if (denylist) {
      const gateValue = denylist.idField === 'id' ? id : row[denylist.idField]
      if (gateValue && tombstoned.has(gateValue)) {
        // Refuse to project this row AND delete it if a prior pass (or a pre-tombstone sync)
        // already put it in SQLite — this is the core of the erasure guarantee: the record is
        // never visible in the projection again, on any device, from this point forward.
        db.prepare(`DELETE FROM ${entity} WHERE id = ?`).run(id)
        continue
      }
    }
    upsertRow(db, entity, id, row, fields, outstandingIds, failures)
  }
  // T233 round 2, finding 3: sweep SQLite directly, AFTER the doc-row loop above, for any row
  // whose OWN SQLite column already names a tombstoned id. Run after (not instead of) the loop,
  // because the loop's own upsertRow calls can otherwise resurrect exactly what this is meant to
  // remove: a record whose id the doc already knows but whose camper_id field hasn't landed yet
  // (fields arrive one at a time) has gateValue undefined above and is upserted from the doc's
  // partial fields — even though its SQLite copy (written via the per-field applyProjection hot
  // path, which never consults this denylist) already carries the real camper_id. Reading
  // SQLite's own column here, after the loop, closes that window regardless of doc state.
  if (denylist && tombstoned.size > 0) {
    const column = denylist.idField
    const placeholders = [...tombstoned].map(() => '?').join(',')
    db.prepare(`DELETE FROM ${entity} WHERE ${column} IN (${placeholders})`).run(...tombstoned)
  }
}

// See recordRowProjectionFailure above for why this table and this store value. Scoped to
// resolved_at IS NULL, which idx_projection_failures_unresolved(entity, entity_id) covers.
function outstandingProjectionFailureRowIds(db, entity) {
  const rows = db
    .prepare(
      `SELECT DISTINCT entity_id FROM projection_failures
       WHERE entity = ? AND resolved_at IS NULL AND store = ?`
    )
    .all(entity, STORE_DOCUMENT_REPLAY)
  return new Set(rows.map((r) => r.entity_id))
}

// The document-aware self-heal repairProjectionForEntity cannot provide (T194 round 4, Defect
// 2b): a document-native row's real "repair" isn't a replay, it's a peer sending a corrected
// value, which arrives here as an ordinary field write and simply projects on the next pass. Once
// it does, the row has genuinely reached SQLite from the document, and any outstanding
// store='document-replay' failure for it is stale — resolve it, the same way repairProjectionForEntity
// resolves a clean op-log replay.
function resolveProjectionFailure(db, entity, entityId) {
  db.prepare(
    `UPDATE projection_failures SET resolved_at = ? WHERE entity = ? AND entity_id = ? AND resolved_at IS NULL AND store = ?`
  ).run(new Date().toISOString(), entity, entityId, STORE_DOCUMENT_REPLAY)
}

// Project one row, atomically. Contained per-ROW (T194 round 3), not per-field (round 2's gap):
// the whole field loop for this record runs inside one SAVEPOINT, so a row whose earlier fields
// succeed — creating the row via ensureExists — but whose LATER field throws (e.g. a CHECK
// violation from a corrupted or newer-version peer) is rolled all the way back rather than left
// half-written in SQLite: present, plausible-looking, with one field silently stale. `projectAll`
// already runs inside ONE shared transaction (see the file-header comment), so a plain nested
// `db.transaction` would just be another savepoint under the hood anyway — this uses SAVEPOINT/
// RELEASE/ROLLBACK TO directly so the boundary is explicit and doesn't depend on better-sqlite3's
// transaction-nesting behavior.
//
// Left uncaught, ONE unprojectable row — a constraint violation, a malformed value from a paired
// peer — propagates out of projectAll's ONE shared transaction and rolls back every OTHER
// entity's legitimate projection. The device that did nothing wrong then never projects anything
// again, because the same bad row is still in the document on the next pass: a persistent,
// camp-wide sync freeze from a single record. Skipping the row leaves SQLite missing one row
// (visible, diagnosable, self-healing once the row is fixed or removed) instead — and the drop is
// recorded in `projection_failures`, not just logged, so it is repairable rather than merely
// visible in a console nobody is watching (T194 round 3, Defect 2).
function upsertRow(db, entity, id, row, fields, outstandingIds = null, failures = null) {
  const savepoint = `row_${++rowSavepointCounter}`
  db.exec(`SAVEPOINT ${savepoint}`)
  let failedField = null
  // A `camp_id` field this doc row carries for a DIFFERENT camp than this device.
  // applyProjection's tenant guard refuses it by RETURNING false (not throwing —
  // see its comment in projections.js), so it never reaches the catch below. Left
  // unobserved it is exactly the "silent reject" board i-appendop-silent-camp-id-rejection
  // is about. We note it here and surface it through `failures` (its own crossCamp
  // shape, NOT a projection_failures row — a cross-camp write is not repairable by
  // re-projection), without altering the guard's behavior: the rejected camp_id is
  // still skipped, every OTHER field of the row still projects, and the merge stays
  // non-fatal. A boolean flag (not a value sentinel) records the rejection so that
  // a genuinely null rejected value is still caught.
  let crossCampRejected = false
  let crossCampRejectedValue
  try {
    // knownRow = row: every field the document currently holds for this id, all at once — unlike
    // op-log replay's true one-field-at-a-time arrival. Some entities' ensureExists (projections.js's
    // ensureWeekJoinRow and its hand-written equivalents for special_day_slots/
    // elective_set_activities/event_slots) reconstruct sibling NOT-NULL FK columns to
    // satisfy a multi-column INSERT; passed the full row, they resolve those siblings directly
    // instead of querying the `operations` table, which the doc-replay path never writes.
    for (const field of fields) {
      if (!(field in row)) continue
      failedField = field
      const applied = applyProjection(db, { entity, entity_id: id, field, value: row[field], knownRow: row })
      // applyProjection returns `false` for, and only for, a rejected camp_id write.
      if (applied === false && field === 'camp_id') {
        crossCampRejected = true
        crossCampRejectedValue = row[field]
      }
    }
    db.exec(`RELEASE ${savepoint}`)
    if (crossCampRejected) {
      // Surface ONLY a genuine cross-camp mismatch: this device has its own camps
      // row AND the rejected value names a different camp. applyProjection's guard
      // also returns false in the transient bootstrap window where this device has
      // no camps row yet (`!camp`) — that is a race, not a hostile write, so it
      // stays a console line (the guard already logged it) and is not raised as a
      // security surface. Non-throwing, non-repairable: handed to the caller as a
      // distinct crossCamp failure so syncNode routes it to the
      // CROSS_CAMP_WRITE_REJECTED device-health surface, not projection_failures.
      const localCamp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      if (localCamp && crossCampRejectedValue !== localCamp.id) {
        failures?.push({
          entity,
          entityId: id,
          field: 'camp_id',
          crossCamp: true,
          rejectedValue: crossCampRejectedValue,
        })
      }
    }
    if (outstandingIds?.has(id)) {
      resolveProjectionFailure(db, entity, id)
      outstandingIds.delete(id)
    }
  } catch (err) {
    db.exec(`ROLLBACK TO ${savepoint}`)
    db.exec(`RELEASE ${savepoint}`)
    // One line for the ROW, not one per field (up to 9 near-duplicates for elective_assignments
    // before this fix).
    console.error(
      `projector: skipping doc '${entity}' row '${id}' (field '${failedField}') — ${err.message}`
    )
    recordRowProjectionFailure(db, { entity, entityId: id, field: failedField, error: err })
    // Handed back to the caller (projectAll) so it can be REPORTED without projectAll itself
    // throwing — containment must stay non-fatal (T194 round 6, Defect 1: this is how syncNode's
    // onProjectionError learns about a contained row instead of only a console line nobody watches).
    failures?.push({ entity, entityId: id, field: failedField, error: err })
  }
}

// Delete-reconcile step: any SQLite row for this entity not present in the
// document is removed, so SQLite converges to exactly the document's
// contents.
//
// template_slots is deliberately EXCLUDED from the flat delete-reconcile below (it only gets the
// scope-level reconcile above). Its flat collection (doc.template_slots) holds individual-cell-edit
// overlays, not row existence — a row's existence is owned entirely by which scope's bulk-replace
// last ran. Running the flat delete-reconcile too would delete every row NOT ALSO present in
// doc.template_slots (nearly all of them — a real schedule's rows are rarely individually edited),
// wiping out the bulk-replace baseline this exact same projectAll pass just inserted above. It would
// also (see the concurrent-regenerate design in campDocument.js) delete the WINNING generation's rows
// whose per-row flat entries came from the LOSING generation's now-orphaned ids, or vice versa — the
// scope-level reconcile alone is the correct, complete ownership boundary for this table's existence.
function deleteReconcileEntity(db, doc, entity) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    deleteReconcileBulkReplaceEntity(db, doc, entity)
    return
  }
  // `camps` is never delete-reconciled: it is a singleton identity row, not a collection of
  // records the document could legitimately go to zero-of. If this device's own camp id isn't a
  // key in doc.camps (e.g. the document only ever saw a different camp's row — the exact
  // divergence upsertCampsEntity above guards against, or simply a doc that predates this slice
  // and has never had a camps write land in it yet), the generic rule below would delete this
  // device's OWN camps row out from under every `SELECT ... FROM camps LIMIT 1` lookup in the
  // app — instantly breaking the entire device, not a graceful degradation. There is no product
  // flow that deletes a camp; skip entirely.
  if (entity === 'camps') return
  // camp_authority_log (T331) has no backing SQL table — nothing to delete-reconcile against. Its
  // verified state is carried in applied_authority_log/authority_cache, written only by
  // upsertCampAuthorityLogEntity below, never by the generic delete-reconcile pass.
  if (entity === 'camp_authority_log') return
  const inDoc = new Set(listRecordIds(doc, entity))
  for (const { id } of db.prepare(`SELECT id FROM ${entity}`).all()) {
    if (!inDoc.has(id)) applyProjection(db, { entity, entity_id: id, field: DELETE_FIELD, value: 1 })
  }
}

// Project one entity's slice of `doc` into SQLite: upsert then
// delete-reconcile, both in one transaction. Idempotent, and — because it
// reuses applyProjection — byte-identical to the op-log projection for the
// same field values.
//
// Safe as a single-entity, single-pass operation (unlike projectAll below):
// with only one table in play there is no cross-entity FK ordering for the
// delete-reconcile half to violate.

// The projection boundary is where an unhandled conflict becomes invisible
// (docs/adr/2026-09-08-crdt-conflict-reconciliation.md). Two people editing the
// same slot produce a document where one of their decisions has already been
// discarded by Automerge into `getConflicts`; if that document projects into
// SQLite without anyone recording the disagreement, both screens show the same
// wrong answer and nobody is told. Under the op-log this wrote a `conflicts`
// row and required an explicit resolution, so leaving it silent is a
// regression, not a CRDT tradeoff.
//
// The requirement is NOT "callers remember to reconcile". It is that the system
// cannot be in a state where a conflict went unhandled — so the check lives
// HERE, at the one place a merged document becomes SQLite, and every export
// below that writes from a document runs it. A future path that merges without
// reconciling fails loudly at a projection it has to perform anyway. Same shape
// as campDocument.js's module-load subset guard: the strength is that there is
// no path around it, not the logic itself.
//
// "Recorded" is read from the `conflicts` table rather than passed in, so no
// caller can satisfy the guard by asserting it complied.
function assertConflictsRecorded(db, doc) {
  const recorded = db
    .prepare("SELECT entity, entity_id, field FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'")
    .all()
    .map((r) => ({ entity: r.entity, entityId: r.entity_id, field: r.field }))
  assertNoUnrecordedConflicts(doc, recorded)

  // Second, independent guard at the same choke point (docs/adr/2026-09-23-merge-unique-collision-
  // schema-and-conflict-shape.md, Decision 1) — a hard-set UNIQUE collision between two whole
  // records, which the scalar reconciler above can never see (different entityIds, never the same
  // document key).
  //
  // `entity_ids` was added in schema v73. A pre-v73 `conflicts` table cannot physically have
  // recorded a `unique:` conflict (that id namespace and column did not exist yet), so there is
  // nothing to assert — skip rather than let a stale-schema db hit a raw SqliteError here.
  const hasUniqueConflictColumns = db
    .pragma('table_info(conflicts)')
    .some((col) => col.name === 'entity_ids')
  const recordedUnique = hasUniqueConflictColumns
    ? db
        .prepare("SELECT entity, entity_ids, field FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'unique:%'")
        .all()
        .map((r) => ({ entity: r.entity, entityIds: JSON.parse(r.entity_ids ?? '[]'), field: r.field }))
    : []
  assertNoUnrecordedUniqueConflicts(doc, recordedUnique)
}

export function projectEntity(db, doc, entity = STAGE1_ENTITY) {
  assertModeled(entity)
  assertConflictsRecorded(db, doc)
  const run = db.transaction(() => {
    upsertEntity(db, doc, entity)
    deleteReconcileEntity(db, doc, entity)
  })
  run()
}

// Finding 1 defense-in-depth guard (docs/work/plans/2026-09-06-stage5-live-wiring-design.md §5,
// review round on Stage 5c): delete-reconcile treats the document as an authoritative superset of
// SQLite's modeled-entity rows (see rebuildFromDoc's CAUTION comment above). Empirically confirmed:
// calling projectAll with a freshly createEmptyDoc() against a live camp db silently deletes every
// row for every modeled entity — no throw, no signal, because "the doc has nothing for this entity"
// and "the doc legitimately has zero rows for this entity" are indistinguishable to
// deleteReconcileEntity by design. The only call sites that can produce this are things that resolve
// "the current doc" without proving it was ever seeded from SQLite (main.js's startup fallback chain
// before Stage 5e's seeding lands; a from-scratch doc handed to syncNode.handleReceived).
//
// Deliberately narrow rule, not a heuristic: refuse ONLY when the doc holds zero rows across EVERY
// modeled entity while SQLite holds at least one row in some modeled entity's table. This is the one
// case that is unambiguously always wrong — a document that has never been seeded and is not
// currently building a legitimately-empty fresh camp. It is intentionally not a size-ratio or
// per-entity check:
//   - A per-entity check (doc has 0 rows for entity X, SQLite has rows for X) would misfire on a
//     real, legitimate state — an entity a camp genuinely has zero rows for while the doc is
//     otherwise fully seeded and correct.
//   - A "doc smaller than SQLite by some threshold" heuristic would either be too strict (flags
//     ordinary partial edits mid-sync) or too loose (misses a doc seeded for only some entities).
// What this does NOT catch, by design: a PARTIALLY-empty document — seeded for some modeled
// entities but missing others entirely — will pass this guard (it has SOME rows somewhere) and can
// still silently delete-reconcile away the SQLite rows for whichever entities it's missing. Closing
// that gap requires actual seeding-completeness tracking (a real "has this camp's doc ever been
// fully seeded" fact), which is Stage 5e's job, not a guess bolted on here.
// Reads the right collection for the guard above's "does this entity have any rows" check: the
// flat doc[entity] map for an ordinary entity, or the `${entity}_scopes` map for a bulk-replace
// entity (template_slots) — its OWN flat collection only ever holds individual-cell-edit overlays,
// which can legitimately be empty even while a bulk-replace baseline exists (see upsertEntity's
// comment above), so checking doc[entity] alone would misreport a seeded template_slots as unseeded.
function entityHasAnyDocRow(doc, entity) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    return Object.keys(doc[`${entity}_scopes`] ?? {}).length > 0
  }
  return hasAnyRecord(doc, entity)
}

// `camps` is excluded from this guard's "does SQLite/the doc have any real data" signal (see
// RECONCILABLE_ORDER below). Every device's SQLite ALWAYS has exactly one camps row — it is a
// structural invariant of this app, not evidence of a seeded/live camp — so including it here would
// make sqliteHasAnyRow trivially and near-universally true regardless of whether any actual domain
// data exists, defeating the guard's whole purpose. camps also has its own bespoke never-delete
// handling (deleteReconcileEntity's early return) and convergence handling (upsertCampsEntity) — see
// those comments; it doesn't participate in the empty-doc-vs-live-data question this guard asks.
// camp_authority_log (T331) is excluded for the same structural reason as `camps` above, though
// for the opposite shape of reason: it has NO backing SQL table at all (see
// campDocument.js's EXTRA_MODELED_ENTITIES comment), so `SELECT 1 FROM camp_authority_log` and
// `DELETE FROM camp_authority_log` (rebuildFromDoc's wipe pass) would both throw. Its "does real
// data exist" signal and its wipe/re-derive are handled entirely by upsertCampAuthorityLogEntity
// re-running the full verify-and-replay from the document, which is idempotent and never destructive.
const RECONCILABLE_ORDER = MODELED_ORDER.filter((entity) => entity !== 'camps' && entity !== 'camp_authority_log')

function assertDocIsSupersetOrEmpty(db, doc) {
  const docHasAnyRow = RECONCILABLE_ORDER.some((entity) => entityHasAnyDocRow(doc, entity))
  if (docHasAnyRow) return
  const sqliteHasAnyRow = RECONCILABLE_ORDER.some(
    (entity) => db.prepare(`SELECT 1 FROM ${entity} LIMIT 1`).get() !== undefined
  )
  if (sqliteHasAnyRow) {
    throw new Error(
      'projectAll: refusing to delete-reconcile — the Automerge document is completely empty for ' +
        'every modeled entity while SQLite already holds rows for at least one of them. This document ' +
        'has not been seeded from SQLite (see automerge/seed.js) and is not an authoritative superset; ' +
        'projecting it would delete live camp data. See docs/work/plans/2026-09-06-stage5-live-wiring-design.md §5.'
    )
  }
}

// Project every modeled entity, all inside one transaction.
//
// Upserts run in forward MODELED_ORDER (FK-safe: a row is inserted only
// after every table its FKs point at already has that row) and
// delete-reconciles run afterward in REVERSE MODELED_ORDER (also FK-safe: a
// parent row is deleted only after every child table that could reference it
// has already had its own stale rows removed). Doing both passes as ONE
// upsert-then-delete pair, rather than projectEntity's interleaved
// upsert-then-delete per entity, is what makes a coherent delete of a parent
// and its children (e.g. the document drops a cohort AND its tiers together)
// succeed: entity-by-entity in forward order would try to delete the cohort
// while its tiers still exist and hit foreign_keys=ON.
export function projectAll(db, doc) {
  assertConflictsRecorded(db, doc)
  assertDocIsSupersetOrEmpty(db, doc)
  const failures = []
  const run = db.transaction(() => {
    for (const entity of MODELED_ORDER) upsertEntity(db, doc, entity, failures)
    for (const entity of [...MODELED_ORDER].reverse()) deleteReconcileEntity(db, doc, entity)
  })
  run()
  return failures
}

// Prove SQLite is disposable: wipe table(s) and re-derive them from the
// document alone. This is the operation that makes "SQLite is a rebuildable
// projection" a fact rather than a claim.
//
// Two shapes, both preserved:
//   - rebuildFromDoc(db, doc, entity): wipes ONE entity's table, then
//     projectEntity for just that entity (Stage 1's original behavior).
//   - rebuildFromDoc(db, doc): wipes EVERY modeled entity's table in REVERSE
//     FK order, then projectAll (Automerge generalization slice's full-camp round-trip).
//
// CAUTION (documented Stage-2 requirement, see the ADR's rules-layer section):
// this deletes every row not in the document. It is safe ONLY when the
// document is the authoritative superset of the modeled entities' rows.
// Before this is ever run against a live camp's existing SQLite data, a
// "seed the document from current SQLite" step must run first (see
// seed.js's seedDocFromSqlite/seedAllFromSqlite) — otherwise an empty/partial
// document would delete real rows and silently orphan convention-only
// referrers (fixed_events.day_id). Nothing here wires
// this to live data; it runs only against documents built in-process.
export function rebuildFromDoc(db, doc, entity) {
  assertConflictsRecorded(db, doc)
  if (entity !== undefined) {
    assertModeled(entity)
    const run = db.transaction(() => {
      // `camps` is never wiped — see RECONCILABLE_ORDER's comment above. A raw DELETE here would
      // remove the device's own singleton identity row, and PROJECTIONS.camps.ensureExists
      // refuses to ever re-create it (by design — see projections.js), permanently breaking every
      // `SELECT ... FROM camps LIMIT 1` lookup in the app.
      if (entity !== 'camps' && entity !== 'camp_authority_log') db.prepare(`DELETE FROM ${entity}`).run()
      projectEntity(db, doc, entity)
    })
    run()
    return
  }
  const reverseOrder = [...RECONCILABLE_ORDER].reverse()
  const run = db.transaction(() => {
    for (const e of reverseOrder) db.prepare(`DELETE FROM ${e}`).run()
    projectAll(db, doc)
  })
  run()
}
