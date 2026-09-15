// decisionJournal — the single writer of import_decisions (T173 slice 1,
// host-local, never replicated). Records what the importer ASKED and what
// the director did about it — see docs/superpowers/specs/
// 2026-09-15-seedlings-importer-learning-design.md for why this exists, and
// src/ingest/decisionJournal.js's journalEntriesFor for how entries are
// derived from a commit's (decisions, answers) pair.
//
// This ships DARK: nothing the director sees changes, so a write here is
// diagnostics, not a mutation the app depends on. That sets the failure
// contract, the same one T148 established for a document write that fails
// after SQLite already committed (documentWriteFailures.js,
// electron/sync/automerge/liveDoc.js's flush): NEVER throw back into the
// caller — an import that already succeeded must stay succeeded — but never
// let the failure vanish into a bare console.error either.
//
// WHERE THE FAILURE TRACE GOES, and why it changed once already. The first
// version of this file routed a failure through recordAuditEvent with
// outcome: 'error' — the exact route T148's liveDoc.js flush used. T174 (a
// Governor review of this file, 2026-09-15) found that audit_events.outcome
// is CHECK-constrained to ('allow', 'deny') only, so that insert was always
// silently rejected and the "durable trace" never landed a row — the same
// defect T148 existed to remove, reintroduced inside T148's own fix, and
// reintroduced again here by copying it. T174 fixed its own instance with a
// dedicated table (sync_health_events) rather than widening audit_events'
// vocabulary, on the grounds that audit_events is a security log and a
// non-denial row in it would mislead a future security review.
//
// That reasoning applies here too, and doubly: this failure is not even the
// same DOMAIN as sync_health_events (a SQLite/Automerge-document
// divergence) — it is an import-diagnostics write failing, which
// check_projection_health has no business reading as sync state. So this
// uses its own table, import_decision_failures
// (electron/ops/importDecisionFailures.js), recorded via
// recordImportDecisionFailure — which, like recordSyncHealthEvent, REPORTS
// whether the row landed rather than assuming it, because assuming it is
// exactly what hid the original defect for a week.
import { randomUUID } from 'node:crypto'
import { recordImportDecisionFailure } from './importDecisionFailures.js'

let failureCounter = 0

/**
 * Insert every journal entry for one import, in a single transaction — all
 * of it lands or none of it does, so a partial batch never misrepresents
 * what was actually asked.
 *
 * @param db
 * @param campId
 * @param actorUserId  the director running the import, for provenance only
 * @param entries       from src/ingest/decisionJournal.js's journalEntriesFor
 */
export function recordImportDecisions(db, { campId, actorUserId, entries } = {}) {
  if (!db || !campId || !entries || entries.length === 0) return
  try {
    const insert = db.prepare(
      `INSERT INTO import_decisions
        (id, camp_id, import_id, kind, seedling_key, lane, proposed, outcome, chosen, learned_from_id, decided_at, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const decidedAt = new Date().toISOString()
    db.transaction(() => {
      for (const e of entries) {
        insert.run(
          randomUUID(), campId, e.import_id ?? null, e.kind ?? null, e.seedling_key ?? null,
          e.lane ?? null, e.proposed ?? null, e.outcome ?? null, e.chosen ?? null,
          e.learned_from_id ?? null, decidedAt, actorUserId ?? null
        )
      }
    })()
  } catch (err) {
    const incident = `decisionjournal-${campId}-${failureCounter++}`
    console.error(
      `[${incident}] recordImportDecisions failed (import already succeeded, unaffected):`, err
    )
    const landed = recordImportDecisionFailure(db, {
      campId,
      detail: JSON.stringify({ entryCount: entries.length, error: String(err?.message ?? err) }),
      incident,
    })
    if (!landed) {
      console.error(`[${incident}] NOTHING DURABLE WAS RECORDED for this failure — this console line is the only trace that exists.`)
    }
  }
}
