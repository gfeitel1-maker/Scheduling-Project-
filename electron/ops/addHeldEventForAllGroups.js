// "Add for all groups" on a held-back event question (UX audit A1).
//
// An import holds back a recurring event only some groups showed in the file, and leaves a question on
// Roots. Answering it adds the event for every group, at the block and days the file had it. It goes
// through commitIngest, the import commit path, as an import of its own (captureInverse), so the import's
// undo removes it again like any other import.
import { commitIngest } from './ingest.js'
import { readHeldEventPayload } from './openReconciliationDecisions.js'

export function addHeldEventForAllGroups(db, { campId, decisionId, author_user_id, device_id }) {
  if (!campId) throw new Error('addHeldEventForAllGroups: campId is required')
  if (typeof decisionId !== 'string' || decisionId.length === 0) throw new Error('addHeldEventForAllGroups: decisionId is required')
  const { row, payload } = readHeldEventPayload(db, campId, decisionId)
  if (!row) throw new Error('addHeldEventForAllGroups: there is no open question with that id')
  if (row.entity_type !== 'fixed_events') throw new Error('addHeldEventForAllGroups: that question is not about an event')
  const fe = payload?.fixedEvent
  if (!fe || typeof fe.name !== 'string' || typeof fe.time_block !== 'string' || !Array.isArray(fe.days) || fe.days.length === 0) {
    throw new Error('addHeldEventForAllGroups: the question carries no event to add')
  }

  const outcome = commitIngest(db, {
    approved: {},
    camp_id: campId,
    cohort_id: payload.cohortId ?? null,
    author_user_id: author_user_id ?? null,
    device_id,
    mode: 'add',
    captureInverse: true,
    keepOpenDecisions: true,
    standaloneUndo: true,
    fixedEvents: [{ ...fe, confidence: 'high', scope: { is_all_groups: true, groups: [] } }],
  })
  if (outcome?.held) throw new Error('addHeldEventForAllGroups: the event could not be added (the commit was held)')
  // Only a created row is an addition. A slot that already holds the event (scopeChanged/unchanged) is
  // left untouched by an import, so reporting it as added would delete the question and change nothing.
  if ((outcome?.fixedEvents?.created ?? 0) === 0) {
    const why = outcome?.fixedEvents?.skipped?.[0]?.reason ?? outcome?.fixedEvents?.partial?.[0]?.reason
      ?? ((outcome?.fixedEvents?.scopeChanged?.length ?? 0) + (outcome?.fixedEvents?.unchanged ?? 0) > 0 ? 'it is already on the schedule there' : null)
    throw new Error(`addHeldEventForAllGroups: ${fe.name} was not added${why ? ` (${why})` : ''}`)
  }
  db.prepare('DELETE FROM open_reconciliation_decisions WHERE id = ? AND camp_id = ?').run(decisionId, campId)
  return outcome
}
