// A document write that fails on its own leaves SQLite ahead of the Automerge
// document — and because `projectAll` makes SQLite converge to the document,
// the edit silently REVERTS at the next projection, or a new row disappears
// outright. Measured in electron/ops/operations.loneWriteFailure.test.js.
//
// Before this module the only trace was a console.error, so the loss was
// invisible AND untraceable: the op-log said the write succeeded (for SQLite it
// did), and nothing durable recorded otherwise.
//
// WHY A `store` COLUMN RATHER THAN REUSING projection_failures AS-IS. That
// table means "this op failed to reach SQLite," and its repair
// (repairProjectionForEntity) replays the op-log INTO SQLite. For a document
// failure that repair is not merely useless, it is wrong: SQLite is already
// correct, the document is the one behind, and replaying would succeed and then
// mark the failure resolved — declaring fixed a divergence that is still there.
// So the two are recorded in one table but kept distinguishable, and the
// projection repair/health paths scope themselves to store='projection'.
//
// This records the loss; it does not prevent it. Preventing it means deciding
// whether a save should fail when the document write fails, which is a
// behaviour change with its own tradeoffs — see docs/current/WHERE_DATA_LIVES.md.
export const STORE_PROJECTION = 'projection'
export const STORE_DOCUMENT = 'document'

/**
 * Durably record that an op reached SQLite but not the document.
 * Never throws — a failure to record a failure must not escalate into a
 * second, louder failure on a write that already succeeded as far as SQLite
 * is concerned.
 */
export function recordDocumentWriteFailure(db, { op_id, entity, entity_id, field, error }) {
  if (!db || !op_id) return
  try {
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, store)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(op_id) DO UPDATE SET
         error_message = excluded.error_message, failed_at = excluded.failed_at, store = excluded.store`
    ).run(
      op_id, entity, entity_id ?? '', field ?? '',
      String(error?.message ?? error ?? 'unknown'), new Date().toISOString(), STORE_DOCUMENT
    )
  } catch (err) {
    console.error('could not record a document-write failure:', err)
  }
}

/** Unresolved document-write failures — SQLite is ahead of the document here. */
export function listDocumentWriteFailures(db) {
  return db
    .prepare(
      `SELECT * FROM projection_failures
       WHERE resolved_at IS NULL AND store = ? ORDER BY failed_at ASC`
    )
    .all(STORE_DOCUMENT)
}
