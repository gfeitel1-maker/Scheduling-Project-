// The renderer-side seam of import answer memory (docs/adr/2026-10-11-import-answer-memory.md 3.5).
// Pure. Recall comes IN as `decision.recalled`; answers go OUT as entries for rememberImportAnswers.
import { classifyDecision } from './answerMemory.js'
import { sameAnswer } from './learnedView.js'

// Attach what the store remembered onto each decision it knows about. `recalled` is
// { tier, source, match, answer, why, progress, autoApply, ... }; a screen may ignore it.
export function attachRecall(report, recallMap) {
  if (!report || !recallMap || Object.keys(recallMap).length === 0) return report
  let touched = false
  const decisions = report.decisions.map((d) => {
    const recalled = recallMap[d.id]
    if (!recalled) return d
    touched = true
    return { ...d, recalled }
  })
  return touched ? { ...report, decisions } : report
}

const EVIDENCE_KEYS = ['basis', 'scope', 'day', 'block', 'missingGroups', 'insteadByGroup', 'attendingCount', 'occurrences']

// Only what a signature depends on crosses the bridge: a decision carries the parsed rows behind it.
function compactDecision(d) {
  const out = {
    id: d.id, kind: d.kind, entity: d.entity, entityId: d.entityId ?? null, entityName: d.entityName ?? null,
    field: d.field ?? null, proposedValue: d.proposedValue ?? null, currentValue: d.currentValue ?? null,
    timeBlock: d.timeBlock ?? null, days: d.days ?? null, from: d.from ?? null, to: d.to ?? null,
  }
  if (d.evidence && typeof d.evidence === 'object') {
    out.evidence = Object.fromEntries(EVIDENCE_KEYS.filter((k) => d.evidence[k] !== undefined).map((k) => [k, d.evidence[k]]))
  }
  return out
}

/**
 * @param decisions the decisions as presented
 * @param answers   the screen's answers, keyed by decision id
 * @param bulkIds   ids answered by one control that covered several decisions (counts toward nothing)
 */
export function answerMemoryEntries(decisions, answers, { bulkIds = new Set() } = {}) {
  const entries = []
  for (const d of decisions ?? []) {
    const answer = (answers ?? {})[d.id]
    if (!answer || !classifyDecision(d)) continue
    const bulk = bulkIds.has(d.id)
    const entry = { decision: compactDecision(d), answer, bulk }
    // An explicit tap wins over the recall it was given on; one carried by a grouped answer is not explicit.
    if (answer.tap === true && !bulk) entry.tap = true
    if (answer.rememberNear === true) entry.rememberNear = true
    // An answer Shoresh applied itself is remembered for recall but is not a fresh vote for its own pattern.
    if (d.recalled?.autoApply === true && d.recalled.source === 'pattern' && sameAnswer(answer, d.recalled.answer)) entry.autoApplied = true
    // Only a recall the director was SHOWN counts as recalled (the UI sets `recallShown`): an
    // answer given without seeing the memory is a fresh answer, not an override or a tap-through.
    if (d.recalled && d.recallShown === true && entry.tap !== true) entry.recalled = { match: d.recalled.match, memoryId: d.recalled.memoryId }
    entries.push(entry)
  }
  return entries
}

// A control that answers several decisions at once marks them all bulk; answering one on its own
// afterwards un-marks it. Bulk answers are remembered but count toward no pattern.
export function trackBulk(bulkIds, ids) {
  for (const id of ids) {
    if (ids.length > 1) bulkIds.add(id)
    else bulkIds.delete(id)
  }
  return bulkIds
}
