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
// let the failure vanish into a bare console.error either. Contain it, tag
// it with a correlation id so the (possibly several) related log lines can
// be tied together, and record it durably via the audit log, which is
// itself already never-throwing and survives a full-or-unwritable disk no
// worse than this write does.
import { randomUUID } from 'node:crypto'
import { recordAuditEvent } from '../audit/auditLog.js'

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
    // recordAuditEvent is itself never-throwing (auditLog.js catches and
    // console.warns), so this cannot escalate the failure — it can only
    // either land the durable trace or, on the same broken disk/handle that
    // just failed the insert above, degrade to that one console line, same
    // as liveDoc.js's documented worst case.
    //
    // outcome: 'deny', not 'error' — audit_events.outcome has a CHECK
    // constraint of ('allow', 'deny') only (localDb.js). liveDoc.js's own
    // recordAuditEvent call passes 'error', which that CHECK silently
    // rejects — recordAuditEvent's own catch then downgrades it to a
    // console.warn, so that call has never actually landed a durable row.
    // Confirmed empirically while writing this module's tests. Using 'deny'
    // here is a deliberate deviation from the letter of that precedent to
    // honor its intent (a durable trace that actually durably lands).
    recordAuditEvent(db, {
      campId,
      actorUserId,
      action: 'import.decision_journal_write_failed',
      targetType: 'import_decisions',
      outcome: 'deny',
      reason: String(err?.message ?? err),
      metadata: { entryCount: entries.length, incident },
    })
  }
}
