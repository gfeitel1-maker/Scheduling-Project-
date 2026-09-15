// The two device-health events that have no op id to hang from — and that T148
// believed it was already recording.
//
// WHAT WENT WRONG, because the shape of the mistake is the useful part.
//
// T148 closed a class of defect: a write reaching SQLite but not the
// authoritative Automerge document, with nothing durable to show for it. Two of
// its three paths had no op id to key on — a merged document that will not
// project (a merge has no op) and a debounced save that fails on disk (the
// window is gone by the time it fails) — so both were routed to `audit_events`
// with `outcome: 'error'`.
//
// `audit_events.outcome` is CHECK-constrained to ('allow','deny'). Every one of
// those inserts was rejected by the constraint; `recordAuditEvent` caught the
// violation and turned it into a console line, exactly as it is designed to (an
// audit failure must never break the action it is recording). So the "durable
// trace" never landed a single row, and `check_projection_health` read those two
// actions back, found nothing, and reported HEALTHY.
//
// Absence read as success — inside the fix written to remove absence read as
// success. Measured 2026-09-15 with a three-row probe: the two 'error' rows were
// rejected, the 'deny' control landed.
//
// THE LESSON WORTH KEEPING: `recordAuditEvent` never throwing is correct, and it
// is also why nobody noticed for a week. A swallow-everything writer needs a
// caller that can ask "did that actually land?" — which is why
// `documentWriteFailureRecorded` exists on the other path, and why this module's
// tests assert the row is READ BACK rather than that the call returned.
import { randomUUID } from 'node:crypto'

export const SYNC_HEALTH = Object.freeze({
  DOCUMENT_SAVE_FAILED: 'document_save_failed',
  PROJECTION_FAILED: 'projection_failed',
})

/**
 * Record one health event. Never throws — the caller is already handling a
 * failure and must not acquire a second one.
 *
 * Returns true when the row landed. Unlike `recordAuditEvent`, the answer is
 * reported rather than assumed, because assuming it is what hid the original
 * defect for a week.
 */
export function recordSyncHealthEvent(db, { campId, kind, detail, incident } = {}) {
  if (!db || !kind) return false
  try {
    db.prepare(
      `INSERT INTO sync_health_events (id, camp_id, kind, detail, incident, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      campId ?? null,
      kind,
      detail == null ? null : String(detail).slice(0, 4000),
      incident ?? null,
      new Date().toISOString()
    )
    return true
  } catch (err) {
    // The disk that just refused the document save can refuse this too. Nothing
    // can be done about that here; what matters is not CLAIMING it worked.
    console.error(`[${incident ?? 'sync-health'}] could not record a sync health event (${kind}):`, err?.message ?? err)
    return false
  }
}

/** Unresolved health events, newest first — what `check_projection_health` reports. */
export function listSyncHealthEvents(db, { limit = 50 } = {}) {
  try {
    return db
      .prepare(
        `SELECT id, camp_id, kind, detail, incident, occurred_at FROM sync_health_events
         WHERE resolved_at IS NULL ORDER BY occurred_at DESC LIMIT ?`
      )
      .all(limit)
  } catch {
    return []
  }
}
