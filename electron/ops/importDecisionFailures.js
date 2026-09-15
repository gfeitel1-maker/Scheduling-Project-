// A durable trace for when recordImportDecisions (decisionJournal.js) fails
// to write import_decisions. Its own small table — see the table comment in
// schema.sql for why this is neither sync_health_events (T174: a different
// domain, and check_projection_health reads that table as SYNC state) nor
// audit_events (T174's own finding: its outcome column is an authorization
// vocabulary, 'allow'/'deny' only, and rejects anything else silently).
//
// Mirrors syncHealthEvents.js's central lesson: a writer that cannot throw
// needs a caller that can ask whether it worked, so this REPORTS success
// rather than assuming it — the property T148's original audit_events route
// lacked, which is why its failure went a week unnoticed.
import { randomUUID } from 'node:crypto'

/**
 * Record one import-decision-journal write failure. Never throws — the
 * caller is already handling a failure and must not acquire a second one.
 *
 * Returns true when the row landed.
 */
export function recordImportDecisionFailure(db, { campId, detail, incident } = {}) {
  if (!db) return false
  try {
    db.prepare(
      `INSERT INTO import_decision_failures (id, camp_id, detail, incident, occurred_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      campId ?? null,
      detail == null ? null : String(detail).slice(0, 4000),
      incident ?? null,
      new Date().toISOString()
    )
    return true
  } catch (err) {
    // The disk (or closed handle) that just failed the journal insert can
    // refuse this too. Nothing can be done about that here; what matters is
    // not CLAIMING it worked.
    console.error(`[${incident ?? 'import-decision-failure'}] could not record the failure itself:`, err?.message ?? err)
    return false
  }
}

/** Every recorded failure, newest first — a diagnostics read, not a UI surface. */
export function listImportDecisionFailures(db, { limit = 50 } = {}) {
  try {
    return db
      .prepare('SELECT id, camp_id, detail, incident, occurred_at FROM import_decision_failures ORDER BY occurred_at DESC LIMIT ?')
      .all(limit)
  } catch {
    return []
  }
}
