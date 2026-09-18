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

// projection_failures is PII-adjacent (T194 round 4, Defect 4): error.message is written verbatim
// from whatever threw. No validator on this path interpolates a written VALUE into its thrown
// message today, so nothing leaks — but that is a property of the validators, not of this table,
// and this bound is the one place that stays true even if a future validator gets it wrong.
const ERROR_MESSAGE_MAX_LENGTH = 500

export function boundedErrorMessage(error) {
  const message = String(error?.message ?? error ?? 'unknown')
  return message.length > ERROR_MESSAGE_MAX_LENGTH ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH) : message
}

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
      boundedErrorMessage(error), new Date().toISOString(), STORE_DOCUMENT
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

/**
 * Did the durable trace actually land for these ops?
 *
 * `recordDocumentWriteFailure` never throws — correct, since failing to record
 * a failure must not escalate a write that already succeeded as far as SQLite.
 * But "never throws" and "always worked" are different claims, and the fault
 * this whole mechanism exists for (a full or unwritable disk) is exactly the
 * one that can take the recording write down with the original. The caller
 * needs to be able to tell the difference and say so.
 *
 * Returns true when there was nothing to record.
 */
export function documentWriteFailureRecorded(db, opIds) {
  const ids = [...(opIds ?? [])]
  if (ids.length === 0) return true
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM projection_failures WHERE store = ? AND op_id IN (${placeholders})`)
      .get(STORE_DOCUMENT, ...ids)
    return row.n === ids.length
  } catch {
    // If we cannot even READ the ledger, we certainly cannot claim it was written.
    return false
  }
}

/**
 * How many writes this device has that the authoritative document does not.
 *
 * The number behind an honest acknowledgement (T153). `status: 'applied'` has
 * always meant "SQLite has it", which is not the same as "the camp has it" —
 * and the sidebar's offline copy ("your changes are saved here and will reach it
 * when it is back") is true for an ordinary disconnection and FALSE for these,
 * which will never reach anyone unless the divergence is repaired.
 */
export function unsharedWriteCount(db) {
  try {
    return db
      .prepare(`SELECT COUNT(*) AS n FROM projection_failures WHERE resolved_at IS NULL AND store = ?`)
      .get(STORE_DOCUMENT).n
  } catch {
    return 0
  }
}
