import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { PROJECTIONS, applyProjection, sanitizeMutuallyExclusiveRow } from './projections.js'
import { getStmt } from './stmtCache.js'
import { recordDocumentWriteFailure } from './documentWriteFailures.js'
import { DOCUMENT_OUTCOME } from './documentOutcome.js'
import { MODELED_ENTITIES, BULK_REPLACE_MODELED_ENTITIES } from '../automerge/campDocument.js'
import { isOpLogEngine } from '../sync/automerge/syncEngineFlag.js'
import {
  recordLocalWrite, recordLocalBulkReplace,
  beginDeferredDocWrites, commitDeferredDocWrites, discardDeferredDocWrites,
} from '../sync/automerge/liveDoc.js'
// Moved to campScopedEntities.js (parent-scoped entities slice) — see that file's comment for why:
// campDocument.js needs these too and cannot import them from here without a circular dependency.
// Re-exported unchanged so every existing importer of these three from operations.js is unaffected.
export { BULK_REPLACE_ENTITIES, MAX_BULK_REPLACE_ROWS, validateBulkReplaceRows } from './campScopedEntities.js'
import { BULK_REPLACE_ENTITIES, validateBulkReplaceRows } from './campScopedEntities.js'

// ─── Retired mechanism: the WebSocket Host's `submit_op` path (T311) ─────────
//
// Many comments in this file were written when `appendOp` had TWO top-level
// entry points: this device's own `write()` path, and the WebSocket Host's
// `submit_op` handler (`handleSubmitOp` in `electron/sync/syncServer.js`)
// applying an op a remote Client had submitted.
//
// _Prior: that second caller is gone. `syncServer.js` and `syncClient.js` were
// DELETED at the Stage 6c cutover, along with `handleSubmitOp`, `applyRemoteOp`,
// the `submit_op`/`op_applied` wire exchange, and the first-pairing `full_sync`
// snapshot. There is no Host process serving a socket and no `ws://`._
//
// What is true today: **appendOp is a local-write primitive only.** Every caller
// is a first-party committer running on this device — `localWriteClient.js`'s
// `write()` behind the IPC surface, plus the typed committers (`ingest.js`,
// `deleteRecord.js`, `restore.js`, `duplicateWeek.js`, `promoteToAdmin.js`,
// `migrationDomainState.js`, and the elective committers). A write arriving from
// ANOTHER device never reaches appendOp at all: it arrives as a merged Automerge
// document and is projected into SQLite by `electron/automerge/projector.js`,
// which replays each field through `applyProjection` as a synthetic op. That
// path therefore inherits applyProjection's guards and NOT appendOp's — the
// distinction matters wherever a comment below calls appendOp a "choke point".
//
// Comments below refer back to this note instead of restating it. Where such a
// comment's claim is now VOID rather than merely re-described, it says so.
// ─────────────────────────────────────────────────────────────────────────────

// Sentinel field name for a row-delete op. Deliberately routed through the
// SAME appendOp/op-log path as every other field-level
// write (per this project's hard rule that all writes to synced entities go
// through the op-log, never a direct bypass) rather than a new IPC channel
// or table: a delete gets a client_write_id for idempotent retry, appears in
// the operations log, replicates via the existing sync mechanism, and is
// subject to the exact same concurrent-write arbitration a real field write
// would get (a concurrent delete + concurrent edit of the same entity_id
// race exactly like two concurrent field writes would — arbitration is the
// CRDT reconciler's, electron/automerge/reconcile.js, and the row it writes
// for a human comes from electron/automerge/conflictStore.js; see
// applyProjection in projections.js for how this
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
// writeFields helper) fixes every current and future caller at once.
// _Prior: "on both the local no-serverUrl path and the Host's handleSubmitOp
// path for ops arriving from a remote Client" — see the retired-mechanism note
// at the top of this file. Local first-party writes are now the only appendOp
// callers, so "every caller" is the whole of it._
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
// writer from where the code is — never copied from a submitted op (that would
// let a peer forge 'import'). _Prior: "handleSubmitOp forces 'human'" named the
// mechanism that enforced this — see the retired-mechanism note at the top of
// this file. The rule still holds, and now holds structurally rather than by
// that coercion: no remote path reaches appendOp, so `source` can only be set by
// a local committer from where the code is._ See the ADR §2 writer census.
// S1b: source_aliases is a host-local table with its own typed committer
// (confirmAlias.js), never registered in PROJECTIONS and never replicated —
// the same "typed committer only, never a raw field-op entity" treatment
// bulk_replace gets above. Refused here rather than left to fall through as
// a silent no-op (it has no projection to apply anyway, since it is
// unregistered), so the boundary is a clear error, and it covers every appendOp
// caller. _Prior: "this covers BOTH write() (the no-serverUrl client above) and
// the Host's WS submit_op path (syncServer.js's handleSubmitOp), which both call
// appendOp." That second top-level caller does not exist — see the
// retired-mechanism note at the top of this file. This sentence is why the note
// is there: anyone reading it for appendOp's CALLER CENSUS (T309 had to) was
// told there are two entry points when there is one._
// Per-field byte-length cap on operations.value (M6, D2,
// docs/adr/2026-08-16-locations-optional-map.md). `operations.value` has no
// application-level size limit anywhere else in this codebase — this is the
// first one, scoped to exactly the one field that needs it (a camp map's
// re-encoded JPEG, base64-capped client-side to ~1MB as the happy path). This
// is the authoritative gate for a LOCAL write: it runs in appendOp itself, the
// one choke point every local committer goes through, so the renderer cannot
// bypass it by skipping the client-side downscale.
//
// ⚠️ _Prior, and VOID rather than merely re-described: this claimed to be "the
// AUTHORITATIVE gate, not a convenience check" because appendOp was "the single
// choke point both the local write() path and the Host's handleSubmitOp (a
// remote Client's WS submission) go through, so a compromised or buggy paired
// device cannot bypass it by skipping the renderer-side downscale." The remote
// path no longer passes through appendOp (see the retired-mechanism note at the
// top of this file), and MAX_FIELD_VALUE_LENGTH has no other reader — appendOp
// below is the only place it is enforced. An oversized camp_maps.image_data
// arriving inside a merged document is projected by
// electron/automerge/projector.js without this check. Restoring a cap on the
// document-replay path is a BEHAVIOUR change and is deliberately not done here;
// T311 was a comment-only sweep and records the gap rather than closing it._
// Same shape as MAX_BULK_REPLACE_ROWS above — a
// registry of hard caps, not a generic limit applied to every field (every
// other field this codebase writes is small by construction).
// Re-exported so callers keep a single import site; defined in its own module
// because liveDoc.js needs it too and this file already imports liveDoc.js.
// The vocabulary and the reasoning live there.
export { DOCUMENT_OUTCOME } from './documentOutcome.js'

export const MAX_FIELD_VALUE_LENGTH = {
  camp_maps: { image_data: 1_400_000 }, // chars; ~1MB base64 + slack, never truncated, hard reject
}

// How many runAtomic frames are open on this db handle (T309). Read by
// appendOp to decide whether it must own rollback for its own op or whether a
// boundary that has already promised all-or-nothing is doing it — see
// `insideAtomicBoundary` below for why the answer matters and why it is not
// simply `db.inTransaction`. Keyed on the handle, not module-global, for the
// same reason stmtCache.js is: several real db handles coexist in one process
// (Host + this-device), and every test in this suite opens its own.
const atomicDepth = new WeakMap()

// True when a runAtomic frame has taken responsibility for rolling this write
// back, so appendOp does not need its own transaction to do it.
//
// NOT `db.inTransaction` on its own, and the difference is load-bearing.
// `db.inTransaction` answers "is SOME transaction open". The question here is
// "has a boundary that PROMISES all-or-nothing taken this op on". runAtomic
// makes that promise in its contract above; a bare `db.transaction` does not,
// and five modules are explicitly allowed to open one (see the guard at the
// bottom of operations.transactionBoundary.test.js) on the grounds that they
// write only host-local tables. None calls appendOp today — but keying off
// `db.inTransaction` would silently change appendOp's guarantee for the first
// one that did. The depth check makes the suppression opt-in by the only
// boundary whose contract already covers it; `db.inTransaction` stays as a
// second condition so a stale depth can never suppress the transaction when
// SQLite has no outer one to fall back on.
function insideAtomicBoundary(db) {
  return (atomicDepth.get(db) ?? 0) > 0 && db.inTransaction
}

// Run a multi-write job so that ALL THREE stores share one rollback boundary.
//
// Use this instead of `db.transaction(fn)()` anywhere the body calls `appendOp`
// or `appendBulkReplaceOp` more than once — an import, a delete cascade, an
// undo, a restore, a week duplication.
//
// `db.transaction` alone is not enough, and that is the bug this closes.
// `appendOp` writes the Automerge document once its SQLite work returns, on the
// belief that the data is committed. Inside a bare `db.transaction` that belief
// is false: the outer transaction is still open and uncommitted. If it later
// rolls back, SQLite and the op-log are undone while the document keeps every
// write, and the next projectAll writes them back into SQLite. The import the
// director was told had failed reappears.
//
// (The original form of that bug was sharper still: `appendOp` opened its OWN
// inner transaction, which better-sqlite3 nests as a SAVEPOINT, so the savepoint
// RELEASED — looking exactly like a commit — while the outer transaction stayed
// open. Since T309 `appendOp` no longer opens that inner transaction while a
// runAtomic frame is open, so the misleading release is gone; the reason this
// function must exist is not.)
//
// An Automerge document cannot be rolled back, so the document is simply not
// written until the outermost transaction has committed. Nested calls are
// depth-counted and only the outermost flushes.
//
// The SQLite transaction is still the inner boundary, unchanged — this only
// adds the document to the same boundary.
export function runAtomic(db, fn) {
  beginDeferredDocWrites(db)
  atomicDepth.set(db, (atomicDepth.get(db) ?? 0) + 1)
  let result
  try {
    result = db.transaction(fn)()
  } catch (err) {
    discardDeferredDocWrites(db)
    throw err
  } finally {
    // In a `finally` precisely because the catch above rethrows: a boundary
    // that threw must still close its frame, or every later top-level appendOp
    // on this handle would believe a boundary is open and stop owning its own
    // rollback. Touches only the counter — the flush below stays outside, for
    // the reason stated there.
    atomicDepth.set(db, (atomicDepth.get(db) ?? 1) - 1)
  }
  // Deliberately AFTER the transaction has committed, and deliberately not in a
  // `finally`: a throw must discard, and only a clean commit may flush.
  // commitDeferredDocWrites contains its own failures — see the note there on
  // why a throw at flush time must never reach this caller.
  commitDeferredDocWrites(db)
  return result
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

  // The op-log row and its projection must land together or not at all. WHO
  // guarantees that depends on where we are (T309,
  // docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md):
  //
  //   - top level  — appendOp is the outermost writer and opens its own
  //     transaction, exactly as it always has. A caller may catch the throw and
  //     carry on knowing the failed op left nothing behind, which
  //     `commitElectiveCandidates` in ingest.js does, deliberately outside any
  //     transaction.
  //   - inside runAtomic — that boundary has already promised all three stores
  //     roll back together, so a nested transaction here would only duplicate
  //     it. better-sqlite3 nests as a SAVEPOINT, and an OPEN savepoint obliges
  //     SQLite to keep sub-journal undo records for every write made inside it:
  //     just over half the CPU of a 100-camper import, measured (1,566 ms -> 740
  //     ms idle, 8,564 ops). Caching the SAVEPOINT statements does nothing (also
  //     measured, zero gain) — it has to not be opened.
  //
  // The invariant this rests on: no write path may catch an appendOp throw and
  // CONTINUE while inside a runAtomic body. Every call site was read, and none
  // does; the guard at the bottom of operations.transactionBoundary.test.js
  // keeps it that way.
  const body = () => {
    const result = getStmt(
      db,
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity, entity_id, field, storedValue, author_user_id ?? null, device_id, timestamp, parent_op_id ?? null, client_write_id ?? null, source ?? null)

    const op = getStmt(db, 'SELECT * FROM operations WHERE seq = ?').get(result.lastInsertRowid)
    // applyProjection returns false only for a rejected camp_id write (see
    // projections.js) — every other rejection (unregistered entity/field) is
    // a legitimate silent no-op. _Prior: the reason given was that appendOp is
    // called "both for genuinely local first-party writes AND by the Host's
    // handleSubmitOp when applying an op a remote Client submitted
    // (syncServer.js)", the latter of which "must not throw here, since an
    // uncaught exception mid-transaction would abort the Host's response to that
    // Client's request rather than gracefully reporting rejection." That caller
    // is gone (see the retired-mechanism note at the top of this file), so that
    // particular justification is void._ It stays a silent no-op at the appendOp
    // level too, matching applyProjection's own non-throwing contract — the
    // return value is preserved for a future caller that wants to
    // distinguish success from a rejected camp_id write without forcing
    // every appendOp call site to handle a new thrown-error case today.
    applyProjection(db, op)
    return op
  }

  const op = insideAtomicBoundary(db) ? body() : db.transaction(body)()

  // Stage 5b (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 2): mirror the write into
  // the Automerge doc, ONLY when the flag is on. `isOpLogEngine()` early-returns unchanged for the
  // default path — this is the whole reversibility guarantee: flag-OFF runs zero new code, not
  // "the same result via a different path." Never allowed to affect the op-log write above, which
  // has already committed and returned by the time this runs.
  if (isOpLogEngine()) {
    op[DOCUMENT_OUTCOME] = 'engine-off'
    return op
  }

  try {
    // `source` carries the human/import ownership of this write into the shared
    // document (docs/adr/2026-09-09-field-provenance-in-the-document.md). Read
    // off the op that was just written rather than the caller's argument, so the
    // document records exactly what the op-log recorded — including appendOp's
    // own defaulting — and the two can never disagree.
    const outcome = recordLocalWrite(db, { entity, entity_id, field, value: storedValue, source: op.source, author_user_id: op.author_user_id, op_id: op.id }, op)
    op[DOCUMENT_OUTCOME] = MODELED_ENTITIES.has(entity) ? outcome : 'not-modeled'
  } catch (err) {
    // Durable, not just a console line. SQLite has this write and the document
    // does not, so `projectAll` will silently revert it at the next projection
    // — recorded as store='document' because replaying the op-log (the repair
    // for a projection failure) would be wrong here: SQLite is already correct.
    console.error('automerge dual-write failed (op-log write already committed, unaffected):', err)
    recordDocumentWriteFailure(db, { op_id: op.id, entity, entity_id, field, error: err })
    op[DOCUMENT_OUTCOME] = 'failed'
  }

  return op
}

// Idempotency lookup: for a client_write_id that has already been applied,
// returns the ORIGINAL op instead of letting the caller mint a second, distinct
// op id for the same logical write.
// _Prior (Task 10 round-5 Fix 3): "used by handleSubmitOp before
// appendOp/~~detectConflict~~ run, so a retried submit_op carrying the same
// client_write_id ... (which the server otherwise always does, since op ids are
// server-assigned per submission)." There is no server and no submit_op — see
// the retired-mechanism note at the top of this file. Its callers today are in
// electron/ops/ingest.js, which uses it to make an interrupted import's row
// writes replay-safe._
export function findOpByClientWriteId(db, client_write_id) {
  if (typeof client_write_id !== 'string' || client_write_id.length === 0) return null
  return getStmt(db, 'SELECT * FROM operations WHERE client_write_id = ?').get(client_write_id) || null
}

// --- Bulk-replace op-log primitive ---------------------------------------
//
// A `bulk_replace` op is a wholesale delete-all-then-reinsert for every row
// in a given entity+scope_id, atomically. It is deliberately distinct from
// the field-level op path above: it doesn't fit `operations.value` as a
// single scalar, and it never fitted the op-log's retired per-field
// "does the incoming op's parent_op_id match the latest op for this
// entity/entity_id/field" model either (there is no single prior "field"
// to compare against — the op replaces N rows at once).
//
// Wire shape: no schema change to `operations`. entity_id carries the
// scope_id (e.g. a template id), field carries the sentinel
// BULK_REPLACE_FIELD (so a bulk_replace op is trivially distinguishable
// from a real field name — no entity registers a field literally named
// '__bulk_replace__'), and value carries JSON.stringify(rows). This fits
// the existing operations table columns without needing a schema change,
// per the design doc's suggestion.
//
// Concurrent-write arbitration for a bulk_replace is the CRDT reconciler's
// (electron/automerge/reconcile.js -> reconcileForProjection.js ->
// conflictStore.js's `recordConflicts`), exactly as it is for a field-level
// write: two devices' bulk_replaces are reconciled in the Automerge document
// and a genuine disagreement surfaces as a `conflicts` row for a human.
//
// _Prior: the op-log carried its own per-scope arbitration beside this
// primitive — a bulk_replace op carried `based_on_seq` (the highest op `seq`
// the submitting device had observed for that scope), recomputed on the Host
// at submission time by ~~detectBulkReplaceConflict~~ against
// ~~latestScopeOpSeq~~ and recorded via ~~recordConflict~~, with the
// deliberately coarse rule that ANY newer op anywhere in the scope counted.
// All three functions went with the WS Host path (T311 finding 2; see the
// retired-mechanism note at the top of this file): nothing has passed
// `based_on_seq` since the Stage 6c cutover, and the arbitration it fed is
// now the reconciler's. The `operations.based_on_seq` column remains in the
// schema, written by nothing._
export const BULK_REPLACE_FIELD = '__bulk_replace__'

export function isBulkReplaceOp(op) {
  return !!op && op.field === BULK_REPLACE_FIELD
}

// Entry point for a bulk_replace write. _Prior: "Host-side (and
// local/no-serverUrl) entry point" — there is no Host side; see the
// retired-mechanism note at the top of this file. Its callers are both local:
// electron/sync/localWriteClient.js's writeBulkReplace (behind main.js's
// bulkReplace IPC) and electron/ops/duplicateWeek.js._ Validates the payload
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
export function appendBulkReplaceOp(db, { entity, scope_id, rows, author_user_id, device_id, parent_op_id, client_write_id }) {
  const validation = validateBulkReplaceRows(entity, rows, scope_id)
  if (!validation.valid) {
    throw new Error(validation.error)
  }
  const config = validation.config

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  // T111: sanitize the whole rows array up front, before it is serialized
  // into the op-log payload — sanitizing only inside the insert loop below
  // would leave operations.value (persisted and broadcast to every peer)
  // carrying the raw both-non-null row even though the inserted row is
  // clean. sanitizedRows is used for both.
  const sanitizedRows = rows.map((row) => sanitizeMutuallyExclusiveRow(entity, row))
  const value = JSON.stringify(sanitizedRows)

  const run = db.transaction(() => {
    getStmt(db, `DELETE FROM ${config.table} WHERE ${config.scopeColumn} = ?`).run(scope_id)

    const insert = getStmt(
      db,
      `INSERT INTO ${config.table} (${config.columns.join(', ')}) VALUES (${config.columns.map(() => '?').join(', ')})`
    )
    for (const row of sanitizedRows) {
      insert.run(...config.columns.map((col) => (col in row ? row[col] : null)))
    }

    const result = getStmt(
      db,
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity, scope_id, BULK_REPLACE_FIELD, value, author_user_id ?? null, device_id, timestamp, parent_op_id ?? null, client_write_id ?? null)

    return getStmt(db, 'SELECT * FROM operations WHERE seq = ?').get(result.lastInsertRowid)
  })

  const op = run()

  // Parent-scoped entities slice: mirror the write into the Automerge doc, same shape and same
  // "flag-OFF is a provable no-op" guarantee as appendOp's dual-write above — isOpLogEngine() early-
  // returns unchanged for the default path. This was a documented gap before this slice
  // (appendBulkReplaceOp had no Automerge branch at all): every OTHER write primitive already
  // mirrored into the doc, but a full schedule regenerate — the single highest-volume write this
  // app makes — silently never reached it. Uses sanitizedRows (not the raw `rows` argument) so the
  // doc and the op-log/operations.value always agree, exactly like the DB insert above.
  if (isOpLogEngine()) {
    op[DOCUMENT_OUTCOME] = 'engine-off'
    return op
  }

  try {
    // `op_id` is carried so a failed save at the end of the debounce window can
    // name the op that was lost (liveDoc.js's flushPendingWrites) — the same
    // thing appendOp's recordLocalWrite has always passed.
    const outcome = recordLocalBulkReplace(db, { entity, scope_id, rows: sanitizedRows, op_id: op.id }, op)
    op[DOCUMENT_OUTCOME] = BULK_REPLACE_MODELED_ENTITIES.has(entity) ? outcome : 'not-modeled'
  } catch (err) {
    // Durable, not just a console line — same reasoning as appendOp's own
    // dual-write catch above. This was the ONE write primitive whose document
    // failure left no record at all, and it is the highest-volume write the app
    // makes (a whole schedule regenerate is one bulk_replace), so it was also
    // the most consequential one to lose silently.
    console.error('automerge bulk-replace dual-write failed (op-log write already committed, unaffected):', err)
    recordDocumentWriteFailure(db, { op_id: op.id, entity, entity_id: scope_id, field: BULK_REPLACE_FIELD, error: err })
    op[DOCUMENT_OUTCOME] = 'failed'
  }

  return op
}

// Application of an ALREADY-CANONICAL bulk_replace op by a replaying reader:
// re-project a scope's rows from an op whose own durable record already exists.
// Its live caller is the document-replay path — electron/automerge/projector.js
// synthesizes an op from the merged Automerge document and calls this — plus
// electron/db/localDb.js's replay.
// _Prior: "Client-side (or any replaying reader's) application ... i.e. one
// received via `op_applied` from the Host, whose insert into this device's own
// `operations` log has already happened (see applyRemoteOp in syncClient.js,
// mirroring how applyProjection is called only after appendOp/the op-log insert
// succeeds)." `op_applied` and `applyRemoteOp` went with syncClient.js at the
// Stage 6c cutover — see the retired-mechanism note at the top of this file. The
// function's contract is unchanged; only the description of who feeds it was
// stale. Note that on the projector path there is no op-log insert at all, so
// the "already happened" precondition is now about the DOCUMENT being
// authoritative, not about an operations row existing first._ Re-derives the row set
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
    // T111: sanitize defensively on replay too, in case op.value's JSON
    // (e.g. a pre-fix snapshot's stored payload) itself carries a
    // both-non-null row — this is the real backstop, not merely relying on
    // every writer having been patched.
    for (const row of rows) {
      const sanitized = sanitizeMutuallyExclusiveRow(op.entity, row)
      insert.run(...config.columns.map((col) => (col in sanitized ? sanitized[col] : null)))
    }
  })
  run()
}

// S4b §4: the op-log's current generation — the MAX op seq across the whole log.
// Read-only. S4a's export stamps it as `base_generation` so a re-import can gate
// import-over-import staleness (a field written after the export is stale). Uses
// COALESCE(host_seq, seq), kept for the column's sake but a no-op in practice.
// _Prior: "a Client db carries the Host's canonical seq in host_seq" (the
// host_seq migration, schema v18), which is why the COALESCE is here at all.
// No longer true: `applyRemoteOp` was host_seq's only writer and went with
// syncClient.js at the Stage 6c cutover (see the retired-mechanism note at the
// top of this file), so every row is host_seq IS NULL on every device and this
// degenerates to plain seq. The one other function that shared this reasoning,
// ~~latestScopeOpSeq~~, was deleted with the op-log's dead conflict-arbitration
// layer (T311 finding 2)._
// Returns 0 for an empty log.
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

// D2 (docs/adr/2026-08-15-locations-concurrent-create-collision.md): entities
// with an app-level uniqueness constraint per-record arbitration cannot see,
// because such arbitration is keyed on a single entity_id and this constraint
// spans
// DIFFERENT entity_ids (two devices concurrently creating a location with the
// same exact name mint different uuids for the same name). Checked only for
// the field the constraint is actually on — a normal field-level disagreement
// on any OTHER field of an already-created row is reconciled by the CRDT
// reconciler (electron/automerge/reconcile.js) unchanged; the ADR's original
// wording cited the op-log's ~~detectConflict~~, deleted by T311 finding 2.
// Mirrors BULK_REPLACE_ENTITIES's registry-of-config-objects shape
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
// T238 (docs/work/tickets/T238-unique-field-registry-covers-all-ten.md):
// entries carry `scopeColumns` — an ORDERED LIST, camp scope always first —
// rather than a single `scopeColumn`, so a composite UNIQUE (tiers/
// time_blocks below) can be expressed without falsely rejecting a legal
// record that only collides when the non-camp scope column is ignored (a
// tier named "A" under cohort 1 must NOT collide with a tier named "A"
// under cohort 2). Every entry below has exactly one element unless noted
// otherwise; detectUniqueFieldCollision builds one predicate term per
// element, so a single-column entry behaves exactly as the old singular
// `scopeColumn` shape did.
export const UNIQUE_FIELD_ENTITIES = {
  locations: { table: 'locations', field: 'name', scopeColumns: ['camp_id'] },
  // elective_sets has UNIQUE(camp_id, name). Two devices creating the same-named
  // set concurrently (a director on each, or both confirming the same ingest
  // nudge before sync) would otherwise throw ungracefully on replay. Registering
  // it here routes the collision through the same conflict-resolution path
  // locations uses — covers both the authored-create and the Slice 3a nudge path.
  elective_sets: { table: 'elective_sets', field: 'name', scopeColumns: ['camp_id'] },
  // events has UNIQUE(camp_id, name) — same cross-device same-named-create
  // collision class as elective_sets/locations (docs/adr/2026-08-15-
  // locations-concurrent-create-collision.md), covered the same way.
  events: { table: 'events', field: 'name', scopeColumns: ['camp_id'] },
  // activities has UNIQUE(camp_id, name) — same cross-device same-named-create
  // collision class as locations/elective_sets/events. Normal single-device
  // creates never hit this: createActivity (createActivityHelper.js) dedups
  // case-insensitively against the in-memory activities list BEFORE writing.
  // This only fires on a genuine cross-device race where both devices' local
  // dedup passed (neither had synced the other's create yet). Prerequisite
  // for the two-rows split feature (docs/adr/2026-08-23-two-rows-
  // multipattern-split.md), which mints new activity rows (e.g. "Swim (rec)")
  // two devices could both create.
  activities: { table: 'activities', field: 'name', scopeColumns: ['camp_id'] },
  // days_of_operation has UNIQUE(camp_id, day_of_week) as of T205. Registered
  // so a genuinely-concurrent cross-device collision on the same weekday with
  // DIFFERENT ids (the Host-seed-races-invite onboarding race — deterministic
  // ids close the SAME-id case structurally, this closes the different-id
  // case) becomes a typed, director-resolvable conflict instead of a raw
  // SQLITE_CONSTRAINT_UNIQUE thrown deep inside a shared projection
  // transaction. See docs/work/tickets/T205-days-of-operation-uniqueness-and-dedup-migration.md.
  days_of_operation: { table: 'days_of_operation', field: 'day_of_week', scopeColumns: ['camp_id'] },
  // T238 owner decision 6: `groups`, `cohorts`, `tiers`, `time_blocks`,
  // `schedule_weeks`, `special_days` were relaxed from a hard UNIQUE to a
  // plain index in v73 (T241) so the projection can mirror a document
  // collision losslessly instead of one device's create silently vanishing.
  // Before v73 they at least threw a raw SQLITE_CONSTRAINT_UNIQUE; after v73
  // this advisory pre-check is the ONLY local nudge a director typing a
  // duplicate on purpose gets, so leaving them unregistered makes them
  // quietly WORSE at exactly the moment they stop erroring.
  //
  // groups has UNIQUE(camp_id, name) pre-v73 (schema.sql's idx_groups_camp_name).
  groups: { table: 'groups', field: 'name', scopeColumns: ['camp_id'] },
  // cohorts has UNIQUE(camp_id, name) pre-v73.
  cohorts: { table: 'cohorts', field: 'name', scopeColumns: ['camp_id'] },
  // tiers has UNIQUE(camp_id, cohort_id, name) pre-v73 — COMPOSITE scope, not
  // just camp-wide. `cohort_id` (scopeColumns[1]) is not read from the camps
  // table like `camp_id` is: detectUniqueFieldCollision reads it off the
  // CURRENT row for op.entity_id itself. On a create this is only known if
  // cohort_id was already written when the unique field (`name`) write
  // lands — orderFieldsForCreate (src/data/setupCrudRepository.js) enforces
  // exactly that ordering for entities registered in
  // UNIQUE_FIELD_EXTRA_SCOPE_COLUMNS. If the row (or the column on it)
  // doesn't exist yet, the check can't be performed and is skipped —
  // advisory only, never blocking (Art. V) — rather than guessing.
  tiers: { table: 'tiers', field: 'name', scopeColumns: ['camp_id', 'cohort_id'] },
  // time_blocks has UNIQUE(camp_id, cohort_id, name) pre-v73 — same composite-
  // scope reasoning as tiers above.
  time_blocks: { table: 'time_blocks', field: 'name', scopeColumns: ['camp_id', 'cohort_id'] },
  // schedule_weeks has UNIQUE(camp_id, name) pre-v73 (a plain named index,
  // not an inline UNIQUE — see schema.sql's comment above its CREATE TABLE —
  // but the constraint semantics were the same before v73 relaxed it).
  schedule_weeks: { table: 'schedule_weeks', field: 'name', scopeColumns: ['camp_id'] },
  // special_days has UNIQUE(camp_id, name) pre-v73.
  special_days: { table: 'special_days', field: 'name', scopeColumns: ['camp_id'] },
}

// Extra (non-camp) scope columns a create must write BEFORE the unique field
// itself, so detectUniqueFieldCollision can read their value off the row —
// see the `tiers`/`time_blocks` comments above. Consumed by
// orderFieldsForCreate (src/data/setupCrudRepository.js); kept here, next to
// UNIQUE_FIELD_ENTITIES, so the two can't drift independently within this
// file. src/ cannot import this module directly (better-sqlite3/node:crypto),
// so setupCrudRepository.js carries its own transcription, the same way
// UNIQUE_FIRST_FIELD already transcribes UNIQUE_FIELD_ENTITIES's `field`.
export const UNIQUE_FIELD_EXTRA_SCOPE_COLUMNS = {
  tiers: ['cohort_id'],
  time_blocks: ['cohort_id'],
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
// doomed write (which would otherwise throw out of appendOp on Path 2 —
// rolling back its own transaction at the top level, or since T309 the whole
// runAtomic boundary when it is inside one — or worse, silently orphan a
// blank-name row via ensureExists on Path 1 — see the ADR) is never attempted
// at all.
export function detectUniqueFieldCollision(db, op) {
  const config = UNIQUE_FIELD_ENTITIES[op.entity]
  if (!config || op.field !== config.field || op.value == null || op.value === '') return null
  const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
  if (!camp) return null

  // One bound value per scopeColumns entry, in order. `camp_id` is always
  // this device's single camp (never read from the op or the row — see the
  // single-camp-per-device-db invariant). Any OTHER scope column (T238's
  // composite case, e.g. tiers' `cohort_id`) is not camp-wide, so its value
  // can only come from the record's OWN current row for op.entity_id — the
  // row exists at this point only if that scope column was already written
  // (orderFieldsForCreate, src/data/setupCrudRepository.js, writes it before
  // the unique field on a create). If the row or the column's value isn't
  // there yet, the check genuinely cannot be performed — skip it (return
  // null) rather than guess; this is advisory only, never blocking (Art. V).
  const scopeValues = []
  for (const col of config.scopeColumns) {
    if (col === 'camp_id') {
      scopeValues.push(camp.id)
      continue
    }
    const row = getStmt(db, `SELECT ${col} FROM ${config.table} WHERE id = ?`).get(op.entity_id)
    if (!row || row[col] == null) return null
    scopeValues.push(row[col])
  }

  const scopePredicate = config.scopeColumns.map((col) => `${col} = ?`).join(' AND ')
  return (
    getStmt(
      db,
      `SELECT * FROM ${config.table} WHERE ${scopePredicate} AND ${config.field} = ? AND id != ?`
    ).get(...scopeValues, op.value, op.entity_id) || null
  )
}

// Reconstructs the current set of unresolved conflicts from the op-log at
// any point in time, rather than relying on a live broadcast. LIVE — behind
// main.js's `shoresh:list-conflicts` IPC handler, read by the renderer via
// preload.js. The rows it reads are written by
// electron/automerge/conflictStore.js (`recordConflicts` for a scalar
// disagreement, `recordUniqueConflicts` for a hard-set UNIQUE collision), off
// the merged document via reconcileForProjection.js. _Prior: the op-log wrote
// them itself here, via ~~recordConflict~~, deleted by T311 finding 2._
// A conflict
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
    // T243 — a hard-set UNIQUE collision (conflictStore.js's
    // recordUniqueConflicts) has no op-log resolution: there is no
    // resolving op with a parent_op_id, because nothing here is "chosen" —
    // it clears when clearResolvedUniqueConflicts next runs and the
    // collision is no longer in the document. So this row never enters the
    // resolvingOp check below, which is scalar-conflict-only.
    if (row.kind === 'unique') {
      pending.push({
        type: 'unique_conflict',
        id: row.id,
        entity: row.entity,
        field: row.field,
        entityIds: JSON.parse(row.entity_ids),
        existingRecord: JSON.parse(row.existing_op),
        incomingRecord: JSON.parse(row.incoming_op),
      })
      continue
    }
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
