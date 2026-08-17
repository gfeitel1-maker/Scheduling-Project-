import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { PROJECTIONS, applyProjection } from './projections.js'
import { getStmt } from './stmtCache.js'

// Sentinel field name for a row-delete op. Deliberately routed through the
// SAME appendOp/detectConflict/appendOp-log path as every other field-level
// write (per this project's hard rule that all writes to synced entities go
// through the op-log, never a direct bypass) rather than a new IPC channel
// or table: a delete gets a client_write_id for idempotent retry, appears in
// the operations log, replicates via the existing sync mechanism, and is
// subject to the exact same per-field conflict detection a real field write
// would get (a concurrent delete + concurrent edit of the same entity_id
// race exactly like two concurrent field writes would, via latestOp/
// detectConflict below — see applyProjection in projections.js for how this
// sentinel is turned into an actual DELETE). No entity may register a real
// field literally named '__deleted__' (mirrors BULK_REPLACE_FIELD's
// reserved-sentinel approach above), so it's trivially distinguishable from
// a genuine projected field.
export const DELETE_FIELD = '__deleted__'

// The single serialization boundary for a field-level op's `value`.
//
// better-sqlite3 only binds numbers, strings, bigints, buffers and null. Every
// other JS type is not merely rejected — it is MISinterpreted: a bare object
// is treated as a NAMED-PARAMETER bag ("Too few parameter values were
// provided") and an array is spread as positional parameters ("Too many
// parameter values were provided", or, for a 1-element array, silently bound
// to the WRONG column). Booleans throw outright.
//
// Callers legitimately hold richer JS values: ScheduleScreen writes
// template_slots.flags as a plain object, and is_released/is_span_head/
// is_anchor as booleans. Because appendOp binds `value` into the operations
// INSERT *before* applyProjection runs, an uncoerced value threw before the
// row was ever touched — the op-log write, the projection, the renderer's
// optimistic state update and its undo-point push were all skipped, surfacing
// as "Failed to place activity" / "Could not save undo point".
//
// Coercing here rather than at each call site (or in the renderer's
// writeFields helper) fixes every current and future caller at once, on both
// the local no-serverUrl path and the Host's handleSubmitOp path for ops
// arriving from a remote Client.
//
// Storage shapes are chosen to MATCH what appendBulkReplaceOp already
// produces for the same columns, so a generated slot and a manually-edited
// slot are byte-identical in the DB:
//   - objects/arrays -> JSON string. bulk_replace rows must be string-or-null
//     (validateBulkReplaceRows), so ScheduleScreen already sends
//     JSON.stringify(flags) there; template_slots.flags is TEXT either way.
//     normalizeSlots() in src/utils/normalizeSlots.js is the matching read
//     side for template_slots, but it covers only the columns it explicitly
//     names (flags, is_anchor, is_span_head, is_released) — it is not a
//     general decoder, and no other entity has a read-side counterpart at
//     all. Any FUTURE object- or boolean-valued column coerced here needs its
//     own case added there, or the renderer silently reads back the raw
//     stored primitive (an integer 0 that never equals `false`, or an
//     unparsed JSON string).
//   - booleans -> the STRINGS '1'/'0', deliberately not the numbers 1/0.
//     ScheduleScreen's bulk_replace rows already carry '1'/'0' strings (again
//     because of the string-or-null rule). is_anchor/is_span_head/is_released
//     are INTEGER-affinity columns, so SQLite normalizes '1'/'0' to the
//     integers 1/0 on write — the projected row is byte-identical either way
//     (verified by the bulk_replace-parity test in operations.test.js). The
//     tie-break is operations.value, which is a TEXT column: better-sqlite3
//     binds every JS number as a REAL, so binding the number 0 would log the
//     op's value as the string '0.0' (and 1 as '1.0'). The string form keeps
//     the op-log — the thing peers replay and humans read — exactly '1'/'0'.
// null, strings, numbers, bigints and buffers pass through untouched.
export function coerceOpValue(value) {
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value)
  }
  return value
}

// `source` (S2a) is the per-field provenance marker: 'import' (written by the
// host-local reconciliation committer), 'human' (an interactive edit), or NULL
// (decoded as human, §3). It defaults to null and is set STRUCTURALLY by each
// writer from where the code is — never copied from a client-submitted op (that
// would let a peer forge 'import'; handleSubmitOp forces 'human'). See the ADR
// §2 writer census.
// S1b: source_aliases is a host-local table with its own typed committer
// (confirmAlias.js), never registered in PROJECTIONS and never replicated —
// the same "typed committer only, never a raw field-op entity" treatment
// bulk_replace gets above. Refused here rather than left to fall through as
// a silent no-op (it has no projection to apply anyway, since it is
// unregistered), so the boundary is a clear error, and this covers BOTH
// write() (the no-serverUrl client above) and the Host's WS submit_op path
// (syncServer.js's handleSubmitOp), which both call appendOp.
// Per-field byte-length cap on operations.value (M6, D2,
// docs/adr/2026-08-16-locations-optional-map.md). `operations.value` has no
// application-level size limit anywhere else in this codebase — this is the
// first one, scoped to exactly the one field that needs it (a camp map's
// re-encoded JPEG, base64-capped client-side to ~1MB as the happy path). This
// is the AUTHORITATIVE gate, not a convenience check: it runs in appendOp
// itself, the single choke point both the local write() path and the Host's
// handleSubmitOp (a remote Client's WS submission) go through, so a
// compromised or buggy paired device cannot bypass it by skipping the
// renderer-side downscale. Same shape as MAX_BULK_REPLACE_ROWS above — a
// registry of hard caps, not a generic limit applied to every field (every
// other field this codebase writes is small by construction).
export const MAX_FIELD_VALUE_LENGTH = {
  camp_maps: { image_data: 1_400_000 }, // chars; ~1MB base64 + slack, never truncated, hard reject
}

export function appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, parent_op_id, client_write_id, source = null }) {
  if (entity === 'source_aliases') {
    throw new Error('source_aliases cannot be written through the generic op-log path — use confirmAlias')
  }
  const projection = PROJECTIONS[entity]
  if (projection && field !== DELETE_FIELD && !projection.fields.includes(field)) {
    throw new Error('field not allowed for entity')
  }

  const storedValue = coerceOpValue(value)
  const maxLength = MAX_FIELD_VALUE_LENGTH[entity]?.[field]
  if (maxLength && typeof storedValue === 'string' && storedValue.length > maxLength) {
    throw new Error('value exceeds MAX_FIELD_VALUE_LENGTH for entity/field')
  }

  const id = randomUUID()
  const timestamp = new Date().toISOString()

  const run = db.transaction(() => {
    const result = getStmt(
      db,
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity, entity_id, field, storedValue, author_user_id ?? null, device_id, timestamp, parent_op_id ?? null, client_write_id ?? null, source ?? null)

    const op = getStmt(db, 'SELECT * FROM operations WHERE seq = ?').get(result.lastInsertRowid)
    // applyProjection returns false only for a rejected camp_id write (see
    // projections.js) — every other rejection (unregistered entity/field) is
    // a legitimate silent no-op. appendOp is called both for genuinely local
    // first-party writes AND by the Host's handleSubmitOp when applying an
    // op a remote Client submitted (syncServer.js) — the latter must not
    // throw here, since an uncaught exception mid-transaction would abort
    // the Host's response to that Client's request rather than gracefully
    // reporting rejection. So this stays a silent no-op at the appendOp
    // level too, matching applyProjection's own non-throwing contract — the
    // return value is preserved for a future caller that wants to
    // distinguish success from a rejected camp_id write without forcing
    // every appendOp call site to handle a new thrown-error case today.
    applyProjection(db, op)
    return op
  })

  return run()
}

// Task 10 round-5 Fix 3: idempotency lookup used by handleSubmitOp before
// appendOp/detectConflict run, so a retried submit_op carrying the same
// client_write_id as a previously-applied write returns the ORIGINAL op
// instead of minting a second, distinct op id (which the server otherwise
// always does, since op ids are server-assigned per submission).
export function findOpByClientWriteId(db, client_write_id) {
  if (typeof client_write_id !== 'string' || client_write_id.length === 0) return null
  return getStmt(db, 'SELECT * FROM operations WHERE client_write_id = ?').get(client_write_id) || null
}

// --- Bulk-replace op-log primitive ---------------------------------------
//
// A `bulk_replace` op is a wholesale delete-all-then-reinsert for every row
// in a given entity+scope_id, atomically. It is deliberately distinct from
// the field-level op path above: it doesn't fit `operations.value` as a
// single scalar, and it doesn't fit detectConflict's "does the incoming
// op's parent_op_id match the latest op for this entity/entity_id/field"
// model (there is no single prior "field" to compare against — the op
// replaces N rows at once).
//
// Wire shape: no schema change to `operations`. entity_id carries the
// scope_id (e.g. a template id), field carries the sentinel
// BULK_REPLACE_FIELD (so a bulk_replace op is trivially distinguishable
// from a real field name — no entity registers a field literally named
// '__bulk_replace__'), and value carries JSON.stringify(rows). This fits
// the existing operations table columns without needing a schema change,
// per the design doc's suggestion.
//
// Conflict-detection semantics (round 2 — REPLACES round 1's "bulk_replace
// bypasses conflict detection entirely" design, which GOVERNOR round 1
// rejected as a CRITICAL finding: the design doc requires bulk_replace to
// stay inside the same conflict-detection machinery as other ops, so a
// concurrent field-level edit inside the bulk-replaced scope is never
// silently clobbered).
//
// A single-field op expresses "what state was I based on" via
// `parent_op_id`, checked against the single latest op for that exact
// entity/entity_id/field (see detectConflict below). A bulk_replace can't
// use that directly — it doesn't target one entity_id/field, it replaces
// every row in a scope (e.g. every template_slots row for a template_id) —
// so there is no single prior op to compare a `parent_op_id` against.
//
// The mechanism this round wires in: a bulk_replace op carries
// `based_on_seq` (an integer operations.seq, defaulting to 0 for a
// never-before-touched scope) — the highest op `seq` the submitting device
// had actually observed for that scope at the moment it composed the
// bulk_replace. "For that scope" is defined by `latestScopeOpSeq` below as
// the MAX seq among every op in the log whose entity_id is EITHER (a) the
// scope_id itself (this is how a *previous* bulk_replace for this same
// scope is recorded — see appendBulkReplaceOp, entity_id = scope_id), OR
// (b) one of the individual row ids CURRENTLY present in that scope (this
// is how a normal field-level edit to one row inside the scope is
// recorded — e.g. a per-field op on one template_slots row's activity_id).
//
// At submission time, `detectBulkReplaceConflict` recomputes that same
// MAX-seq query against the authoritative (host-side) operations table. If
// the true current value is strictly greater than the submitted
// `based_on_seq`, some op (a field edit to a row in scope, or a competing
// bulk_replace) landed in the log AFTER the submitter's snapshot and before
// this submission — exactly the concurrent-edit case the design doc
// requires to surface as a conflict, not get silently overwritten. That is
// recorded via the existing `recordConflict`/`conflicts` table and reported
// via the existing `op_conflict` message, mirroring detectConflict's
// field-level flow one level up (per-scope instead of per-field).
//
// This is coarser than field-level detection: ANY newer op anywhere in the
// scope counts, even if it were possible for it to logically not overlap
// with the bulk_replace's row set. That's a deliberate, documented
// trade-off for a first pass — see the design doc's bar ("record it in the
// conflict-detection machinery like any other op"), not "invent a
// perfectly-precise row-level diff", which is explicitly out of scope.
export const BULK_REPLACE_FIELD = '__bulk_replace__'

// Hard cap on how many rows a single bulk_replace submission may carry.
// Rejected (via validateBulkReplaceRows, before any DB access) rather than
// silently truncated or accepted. A real camp schedule's slot count is
// realistically in the hundreds (groups × days × time blocks) — 5000 is
// generous headroom over that, not a tight limit, chosen to block a
// pathological/malicious payload from ever reaching the DELETE+INSERT
// transaction.
export const MAX_BULK_REPLACE_ROWS = 5000

// Registry of entities allowed to use the bulk_replace primitive, and the
// concrete table/columns each maps to. The primitive itself is generic
// (entity + scope_id + rows) - it is not template_slots-specific in its
// plumbing - but only template_slots is a real consumer today (per the
// design doc, Sub-plan E / ScheduleScreen). A future consumer registers
// here rather than needing new bulk-replace machinery.
export const BULK_REPLACE_ENTITIES = {
  // Column list expanded (Sub-plan E Task 3): the original list only
  // anticipated id/template_id/group_id/activity_id/day_id/time_block_id.
  // ScheduleScreen.jsx's generate()/placeAnchors()/restoreSnapshot() rows
  // also carry anchor_id, is_anchor, is_span_head, and flags — any row key
  // not listed here is rejected by validateBulkReplaceRows.
  template_slots: {
    table: 'template_slots',
    scopeColumn: 'template_id',
    columns: [
      'id',
      'template_id',
      'group_id',
      'activity_id',
      'day_id',
      'time_block_id',
      'anchor_id',
      'is_anchor',
      'is_span_head',
      'flags',
    ],
    requiredColumns: ['id', 'template_id'],
  },
  template_overlays: {
    table: 'template_overlays',
    scopeColumn: 'template_id',
    columns: ['id', 'template_id', 'unit_id', 'day_id', 'from_block_order', 'to_block_order', 'label'],
    requiredColumns: ['id', 'template_id'],
  },
}

export function isBulkReplaceOp(op) {
  return !!op && op.field === BULK_REPLACE_FIELD
}

// Validates a bulk_replace payload's SHAPE before any DB access is
// attempted - per this project's established, twice-previously-violated
// IPC/WS lesson: validate type, not just presence, default-deny unrecognized
// shapes, and do this BEFORE touching the DB, not as a try/catch wrapped
// around a crash. This checks: entity is a registered bulk-replace entity,
// rows is an array, each row is a plain object containing only recognized
// columns, required columns are non-empty strings, and (when scope_id is
// provided) each row's scope column agrees with the submitted scope_id.
//
// Deliberately NOT checked here: cross-row uniqueness of `id` (e.g. two rows
// sharing the same id) - that is a real DB-level constraint violation, not a
// shape problem, and is intentionally left to the transaction below so a
// mid-transaction failure genuinely exercises SQLite's rollback rather than
// being pre-empted by validation (see the atomicity test).
export function validateBulkReplaceRows(entity, rows, scope_id) {
  const config = BULK_REPLACE_ENTITIES[entity]
  if (!config) return { valid: false, error: 'unknown entity for bulk_replace' }
  if (!Array.isArray(rows)) return { valid: false, error: 'rows must be an array' }
  if (rows.length > MAX_BULK_REPLACE_ROWS) {
    return { valid: false, error: `rows exceeds MAX_BULK_REPLACE_ROWS (${MAX_BULK_REPLACE_ROWS})` }
  }

  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { valid: false, error: 'each row must be a plain object' }
    }
    for (const col of config.requiredColumns) {
      if (typeof row[col] !== 'string' || row[col].length === 0) {
        return { valid: false, error: `row missing required field "${col}"` }
      }
    }
    for (const key of Object.keys(row)) {
      if (!config.columns.includes(key)) {
        return { valid: false, error: `row has unrecognized field "${key}"` }
      }
      const value = row[key]
      if (value !== null && typeof value !== 'string') {
        return { valid: false, error: `row field "${key}" must be a string or null` }
      }
    }
    if (
      scope_id !== undefined &&
      config.scopeColumn in row &&
      row[config.scopeColumn] !== scope_id
    ) {
      return { valid: false, error: `row scope column does not match scope_id` }
    }
  }

  return { valid: true, config }
}

// Host-side (and local/no-serverUrl) entry point: validates the payload
// shape, then atomically (single SQLite transaction) deletes every current
// row in scope, inserts the new row set, and appends the bulk_replace op to
// the `operations` log - so it replicates and appears in history exactly
// like any other op. Validation happens BEFORE the transaction opens, so a
// rejected payload never touches the DB at all; a failure DURING the
// transaction (e.g. a genuine SQLite constraint violation, such as a
// duplicate row id) rolls back the whole transaction, leaving the ORIGINAL
// rows completely untouched - the delete and the reinsert live in the same
// transaction as each other AND as the operations-log insert, so a failed
// attempt leaves no partial trace anywhere, including no orphaned op-log
// entry for an attempt that never actually took effect.
// Returns the highest operations.seq among all ops "for this scope" — see
// the mechanism comment on BULK_REPLACE_FIELD above for the exact
// definition (scope_id-as-entity_id for a prior bulk_replace, OR the id of
// any row currently present in the scope for a field-level edit). Returns
// 0 for a scope with no relevant ops yet (a brand-new scope), which is also
// the correct baseline for a bulk_replace that has never seen any prior op.
export function latestScopeOpSeq(db, entity, scope_id) {
  const config = BULK_REPLACE_ENTITIES[entity]
  if (!config) return 0
  // COALESCE(host_seq, seq): host_seq carries the Host's canonical seq for
  // ops received via applyRemoteOp on a Client db (see host_seq migration,
  // version 18) — raw seq there is a locally-minted AUTOINCREMENT value in
  // an unrelated numbering space. On the Host's own db this is a no-op
  // (host_seq is always NULL there), so this degenerates to plain seq.
  const row = getStmt(
    db,
    `SELECT MAX(COALESCE(host_seq, seq)) as maxSeq FROM operations
     WHERE entity = ?
       AND (entity_id = ? OR entity_id IN (SELECT id FROM ${config.table} WHERE ${config.scopeColumn} = ?))`
  ).get(entity, scope_id, scope_id)
  return row && Number.isInteger(row.maxSeq) ? row.maxSeq : 0
}

// Per-scope analogue of detectConflict: compares the submitter's claimed
// `based_on_seq` (what they observed last) against the TRUE current
// latestScopeOpSeq (authoritative, computed here against the DB doing the
// detecting — the Host's DB when called from handleSubmitBulkReplaceOp).
// If something newer landed in the scope since the submitter's snapshot,
// this is a genuine concurrent-write conflict per the design doc, and must
// not be silently applied. `based_on_seq` is normalized to 0 when absent/
// non-integer (an old or non-conforming client with no concept of this
// field), which yields the strictest possible behavior (any existing op in
// the scope conflicts) rather than silently trusting an absent value.
export function detectBulkReplaceConflict(db, { entity, scope_id, based_on_seq }) {
  const currentSeq = latestScopeOpSeq(db, entity, scope_id)
  const effectiveBasedOn = Number.isInteger(based_on_seq) && based_on_seq >= 0 ? based_on_seq : 0
  if (currentSeq > effectiveBasedOn) {
    // This lookup only runs against the Host's own db (this function is
    // only ever called from the Host side of a bulk_replace submission), so
    // currentSeq here is a raw seq value, never a host_seq-adjusted one —
    // host_seq is always NULL on the Host's own rows. Do not reuse this
    // `WHERE seq = ?` pattern against a Client db; there currentSeq may be a
    // Host-canonical value that only matches via host_seq, not seq.
    const existingOp = getStmt(db, 'SELECT * FROM operations WHERE seq = ?').get(currentSeq)
    return { conflict: true, existingOp }
  }
  return { conflict: false, currentSeq }
}

export function appendBulkReplaceOp(db, { entity, scope_id, rows, author_user_id, device_id, parent_op_id, client_write_id }) {
  const validation = validateBulkReplaceRows(entity, rows, scope_id)
  if (!validation.valid) {
    throw new Error(validation.error)
  }
  const config = validation.config

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const value = JSON.stringify(rows)

  const run = db.transaction(() => {
    getStmt(db, `DELETE FROM ${config.table} WHERE ${config.scopeColumn} = ?`).run(scope_id)

    const insert = getStmt(
      db,
      `INSERT INTO ${config.table} (${config.columns.join(', ')}) VALUES (${config.columns.map(() => '?').join(', ')})`
    )
    for (const row of rows) {
      insert.run(...config.columns.map((col) => (col in row ? row[col] : null)))
    }

    const result = getStmt(
      db,
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity, scope_id, BULK_REPLACE_FIELD, value, author_user_id ?? null, device_id, timestamp, parent_op_id ?? null, client_write_id ?? null)

    return getStmt(db, 'SELECT * FROM operations WHERE seq = ?').get(result.lastInsertRowid)
  })

  return run()
}

// Client-side (or any replaying reader's) application of an ALREADY-CANONICAL
// bulk_replace op - i.e. one received via `op_applied` from the Host, whose
// insert into this device's own `operations` log has already happened (see
// applyRemoteOp in syncClient.js, mirroring how applyProjection is called
// only after appendOp/the op-log insert succeeds). Re-derives the row set
// from op.value and replays the same delete-all-then-reinsert, atomically.
// Malformed op.value (shouldn't happen for a genuinely host-issued op, but
// defense-in-depth against a corrupted/tampered message) is a silent no-op
// rather than a thrown error, matching applyProjection's existing
// unknown-entity/unknown-field behavior.
export function applyBulkReplaceProjection(db, op) {
  const config = BULK_REPLACE_ENTITIES[op.entity]
  if (!config) return

  let rows
  try {
    rows = JSON.parse(op.value)
  } catch {
    return
  }

  const validation = validateBulkReplaceRows(op.entity, rows, op.entity_id)
  if (!validation.valid) return

  const run = db.transaction(() => {
    getStmt(db, `DELETE FROM ${config.table} WHERE ${config.scopeColumn} = ?`).run(op.entity_id)
    const insert = getStmt(
      db,
      `INSERT INTO ${config.table} (${config.columns.join(', ')}) VALUES (${config.columns.map(() => '?').join(', ')})`
    )
    for (const row of rows) {
      insert.run(...config.columns.map((col) => (col in row ? row[col] : null)))
    }
  })
  run()
}

// S4b §4: the op-log's current generation — the MAX op seq across the whole log.
// Read-only. S4a's export stamps it as `base_generation` so a re-import can gate
// import-over-import staleness (a field written after the export is stale). Uses
// COALESCE(host_seq, seq) for the same reason latestScopeOpSeq does — a Client db
// carries the Host's canonical seq in host_seq. Returns 0 for an empty log.
export function latestOpSeq(db) {
  const row = getStmt(db, 'SELECT MAX(COALESCE(host_seq, seq)) AS maxSeq FROM operations').get()
  return row && Number.isInteger(row.maxSeq) ? row.maxSeq : 0
}

export function latestOp(db, entity, entity_id, field) {
  return getStmt(
    db,
    `SELECT * FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1`
  ).get(entity, entity_id, field)
}

// Latest op for an entity_id across ALL fields, regardless of which field
// the incoming op targets. Used by detectConflict below so a delete
// (DELETE_FIELD) — which otherwise has no "own field" to key a same-field
// lookup on — can be compared against whatever the most recent op for that
// row actually was, and so a plain field-level op can be compared against a
// concurrent delete even though a delete's field literally never matches a
// real field name.
function latestOpForEntity(db, entity, entity_id) {
  return getStmt(
    db,
    `SELECT * FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1`
  ).get(entity, entity_id)
}

// Round 2 Security MEDIUM #2 fix (Sub-plan B Task 3): detectConflict used to
// key strictly on (entity, entity_id, field), so a delete op (field
// DELETE_FIELD) never collided with a concurrent field-level edit of the
// same entity_id (and vice versa) — both would apply silently, and a field
// edit landing after a delete would resurrect a near-empty row via
// ensureExists's INSERT OR IGNORE, with no conflict ever recorded.
//
// Fix: a delete op is compared against the latest op for its entity_id
// ACROSS ALL FIELDS (there's no single "own field" for it to collide on
// otherwise). A normal field-level op is compared against whichever is
// more recent of (a) the latest op for that same field, or (b) the latest
// delete op for that entity_id — so a field edit racing a delete surfaces
// as a conflict too, not just the reverse direction.
export function detectConflict(db, incomingOp) {
  let existingOp
  if (incomingOp.field === DELETE_FIELD) {
    existingOp = latestOpForEntity(db, incomingOp.entity, incomingOp.entity_id)
  } else {
    const sameFieldOp = latestOp(db, incomingOp.entity, incomingOp.entity_id, incomingOp.field)
    const deleteOp = latestOp(db, incomingOp.entity, incomingOp.entity_id, DELETE_FIELD)
    existingOp =
      !deleteOp ? sameFieldOp : !sameFieldOp || deleteOp.seq > sameFieldOp.seq ? deleteOp : sameFieldOp
  }
  if (!existingOp) return { conflict: false }
  if (existingOp.id === incomingOp.parent_op_id) return { conflict: false }
  return { conflict: true, existingOp }
}

// D2 (docs/adr/2026-08-15-locations-concurrent-create-collision.md): entities
// with an app-level uniqueness constraint detectConflict cannot see, because
// detectConflict is keyed on a single entity_id and this constraint spans
// DIFFERENT entity_ids (two devices concurrently creating a location with the
// same exact name mint different uuids for the same name). Checked only for
// the field the constraint is actually on — a normal field-level conflict on
// any OTHER field of an already-created row still goes through detectConflict
// unchanged. Mirrors BULK_REPLACE_ENTITIES's registry-of-config-objects shape
// above: a future entity with its own app-level UNIQUE constraint registers
// here rather than needing new collision-detection machinery.
//
// Finding E (addendum): any code that reads a detectUniqueFieldCollision
// result and forwards it — to a wire message, to IPC, to a log line — must
// field-pick, never spread/passthrough the raw row; a future entry on a
// sensitive field (e.g. anything on `users`) inherits this obligation
// automatically only if every call site honors it, which is why this
// sentence exists. detectUniqueFieldCollision itself stays `SELECT *` (a
// caller needs the full row to choose what to expose) — the discipline lives
// at the edges (see D3's `{ id, name, capacity, notes }` picks and
// electron/main.js's sanitizeOpRejectedForIpc), matching how
// sanitizeOpForIpc/IPC_PIN_FIELDS already work.
export const UNIQUE_FIELD_ENTITIES = {
  locations: { table: 'locations', field: 'name', scopeColumn: 'camp_id' },
}

// Returns the colliding row's current { id, ...fields } if `op` would
// violate a registered UNIQUE(scopeColumn, field) constraint against a
// DIFFERENT entity_id, else null. Deliberately excludes op.entity_id itself
// (`id != ?`) so a legitimate no-op rewrite of a row's own current name — or
// a rename of some OTHER row into a name that already belongs to op.entity_id
// itself, which cannot happen — is never flagged; this also means a rename
// INTO another existing row's name is correctly flagged, exactly like a
// create is (both are just "op.entity_id wants a name a different row
// already holds"). Called at both write-entry points BEFORE appendOp, so the
// doomed write (which would otherwise roll back inside appendOp's own
// transaction on Path 2, or worse, silently orphan a blank-name row via
// ensureExists on Path 1 — see the ADR) is never attempted at all.
export function detectUniqueFieldCollision(db, op) {
  const config = UNIQUE_FIELD_ENTITIES[op.entity]
  if (!config || op.field !== config.field || op.value == null || op.value === '') return null
  const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
  if (!camp) return null
  return (
    getStmt(
      db,
      `SELECT * FROM ${config.table} WHERE ${config.scopeColumn} = ? AND ${config.field} = ? AND id != ?`
    ).get(camp.id, op.value, op.entity_id) || null
  )
}

// Durably records a detected conflict so it can be rehydrated after an app
// restart — the live usePendingConflicts hook is fed exclusively by
// in-memory broadcast events, so without this a pending (or even a
// resolved-but-not-yet-dismissed) conflict would silently vanish on
// relaunch. Called from both conflict-detection sites: syncServer's
// handleSubmitOp (host-side detection) and syncClient's ws message handler
// (client-side receipt of an op_conflict from the host).
export function recordConflict(db, { incomingOp, existingOp }) {
  const id = randomUUID()
  const created_at = new Date().toISOString()
  db.prepare(
    `INSERT INTO conflicts (id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    id,
    existingOp.entity,
    existingOp.entity_id,
    existingOp.field,
    JSON.stringify(incomingOp),
    JSON.stringify(existingOp),
    existingOp.id,
    created_at
  )
  return id
}

// Reconstructs the current set of unresolved conflicts from the op-log at
// any point in time, rather than relying on a live broadcast. A conflict
// counts as resolved once ANY op exists in the log whose parent_op_id points
// at that conflict's existing_op_id — that is exactly what resolveConflict()
// in main.js writes when a user picks a side (regardless of which side was
// chosen, the resolution write's parent_op_id is always set to the losing
// existingOp's id — see main.js's resolveConflict). Lazily marks matching
// rows resolved_at as it goes, so repeated calls are cheap.
export function listPendingConflicts(db) {
  const rows = db.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY created_at ASC').all()
  const pending = []
  const now = new Date().toISOString()
  for (const row of rows) {
    const resolvingOp = db
      .prepare(
        'SELECT id FROM operations WHERE entity = ? AND entity_id = ? AND field = ? AND parent_op_id = ? LIMIT 1'
      )
      .get(row.entity, row.entity_id, row.field, row.existing_op_id)
    if (resolvingOp) {
      db.prepare('UPDATE conflicts SET resolved_at = ? WHERE id = ?').run(now, row.id)
      continue
    }
    pending.push({
      type: 'op_conflict',
      incomingOp: JSON.parse(row.incoming_op),
      existingOp: JSON.parse(row.existing_op),
    })
  }
  return pending
}
