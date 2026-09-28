// What the importer ASKED, and what the director did about it (T173 slice 1).
//
// WHY THIS EXISTS AT ALL. The app already remembers answers — five host-local
// tables (`source_aliases`, `compound_cell_decisions`, `location_word_decisions`,
// `declined_two_row_splits`, `open_reconciliation_decisions`) each cache one kind
// of confirmed decision. What none of them records is the QUESTION: which ones
// were asked, how often, what was chosen among the options, what was left
// unanswered, and — most commonly, and entirely invisibly — what was accepted
// without comment.
//
// Five tables of yes-answers is a cache, not a signal. You cannot learn from
// decisions you never recorded as decisions, which is why this ships BEFORE any
// learning does: the seedlings in later slices are designed against what this
// shows, not against a guess about which questions are annoying.
//
// Pure, and deliberately at the same seam as `identityRememberCalls`
// (reconciliationTriage.js), which already derives persistence calls from the
// same `(decisions, answers)` pair. Same inputs, same shape, same best-effort
// after-commit call site — this is not a new pattern, it is the existing one
// applied to a second purpose.
import { isBackedConfirmChange } from '../screens/reconciliationResolutions'

// An outcome is about what the DIRECTOR did, not about whether the import
// succeeded. The four are exhaustive over the states a presented decision can
// end an import in, and the distinction that matters most is the first from the
// second: `accepted` is the silent nod that is invisible today.
export const OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',     // left the proposal as it stood
  CHANGED: 'changed',       // resolved it to something other than the proposal
  REJECTED: 'rejected',     // explicitly declined / skipped it
  UNANSWERED: 'unanswered', // never resolved — held back, not auto-applied
})

// `express` decisions are shown but demand nothing; `standard` wants a look;
// `hold` must be answered. Recorded as PRESENTED so the journal can later show
// which lane a question actually arrived in, independent of how it was answered.
function laneOf(decision) {
  return decision._lane ?? null
}

// The director's answer shape is PER KIND, and the shapes are not
// interchangeable — read off `isDecisionResolved` (reconciliationResolutions.js)
// rather than assumed. A first draft of this function guessed a uniform
// `answer.choice` and would have recorded almost every real answer as
// UNANSWERED, which is the worst possible failure for a journal: not empty, but
// confidently wrong, and every later slice trusts it.
//
// Anything this cannot interpret is UNANSWERED. A thin journal is recoverable;
// an inventive one is not.
function outcomeFor(decision, answer) {
  if (!answer) return OUTCOMES.UNANSWERED

  if (decision.kind === 'confirm_value') {
    // 'looks_right' took the proposal as it stood; 'edited' replaced it.
    if (answer.action === 'looks_right') return OUTCOMES.ACCEPTED
    if (answer.action === 'edited') return OUTCOMES.CHANGED
    return OUTCOMES.UNANSWERED
  }

  if (decision.kind === 'confirm_change') {
    if (isBackedConfirmChange(decision)) {
      // Here the PROPOSAL is the overwrite: 'accept' took it, 'keep' declined
      // it in favour of the director's existing value.
      if (answer.choice === 'accept') return OUTCOMES.ACCEPTED
      if (answer.choice === 'keep') return OUTCOMES.REJECTED
      return OUTCOMES.UNANSWERED
    }
    // Non-backed: no write is possible either way, so an acknowledgement is the
    // whole resolution. Recorded as accepted because that is what it means —
    // "I have seen this" — not because anything was applied.
    return answer.ack === true ? OUTCOMES.ACCEPTED : OUTCOMES.UNANSWERED
  }

  if (decision.kind === 'review_legacy_priority') {
    return answer.resolved === true ? OUTCOMES.ACCEPTED : OUTCOMES.UNANSWERED
  }

  if (decision.kind === 'resolve_conflict') {
    // Held identity conflicts. 'existing' pointed at a specific record (the
    // director supplied the answer), 'create' took the default of minting a new
    // one, 'skip' declined to resolve at all.
    if (answer.choice === 'existing') return OUTCOMES.CHANGED
    if (answer.choice === 'create') return OUTCOMES.ACCEPTED
    if (answer.choice === 'skip') return OUTCOMES.REJECTED
    return OUTCOMES.UNANSWERED
  }

  if (decision.kind === 'resolve_unknown_label') {
    // T285 — the import panel's residue. The sheet named an activity this camp
    // does not have; the director can settle it, and settling it changes what
    // gets imported.
    //
    // CHANGED rather than ACCEPTED, and the distinction is the point of the
    // journal rather than a detail of it: there is no proposal here to accept.
    // Nothing was preselected, so acting is always the director supplying an
    // answer the import did not have. An unanswered one — the label left
    // unresolved, which is the DEFAULT and costs nothing — is the case a later
    // learning slice most needs to see, because a label nobody ever resolves is
    // a question not worth asking.
    if (answer.action === 'added_activity') return OUTCOMES.CHANGED
    // T298 — the second resolution. Also CHANGED, and for the same reason: there
    // was no proposal preselected, so mapping is the director supplying an answer
    // the import did not have. That a PROPOSAL was shown next to the picker does
    // not make taking it an ACCEPTED: the director still had to press it, and the
    // learning question a later slice asks of this row is "was the proposal
    // right", which `chosen` answers by naming the activity and `proposed` by
    // naming what we suggested.
    if (answer.action === 'mapped_to_existing') return OUTCOMES.CHANGED
    return OUTCOMES.UNANSWERED
  }

  if (decision.kind === 'resolve_packed_cell') {
    // T298 — a cell naming several activities at once. THREE readings, all of
    // them the director's to pick, so every one of them is CHANGED; there is no
    // default reading to accept, which is precisely why the cell was residue.
    //
    // WHETHER THE DELIMITER SHOULD BE REMEMBERED is the open question this row
    // exists to answer, and it is deliberately not answered by building a store.
    // T118's `compound_cell_decisions` is the precedent for remembering a
    // director-confirmed reading of an ambiguous cell per camp, and it is the
    // right shape when the time comes — but it earned that by being about a
    // pattern (`Sports w/G1`) recurring across a file, whereas a packed cell is
    // one string. Which of the three readings a camp picks, and whether it picks
    // the same one every time, is exactly what these rows will show. Until they
    // do, remembering would be a guess wearing a table.
    if (answer.action === 'split_packed') return OUTCOMES.CHANGED
    if (answer.action === 'added_activity') return OUTCOMES.CHANGED
    if (answer.action === 'mapped_to_existing') return OUTCOMES.CHANGED
    return OUTCOMES.UNANSWERED
  }

  // A kind this function has not been taught. Deliberately not a throw: a new
  // decision kind must never be able to fail an import through the journal,
  // which is diagnostics. It is recorded as unanswered and shows up as a gap in
  // the data, which is the signal to teach it.
  return OUTCOMES.UNANSWERED
}

// Compact JSON, never the whole decision: this table is written on every import
// and a decision object carries the parsed source rows behind it. Only the
// fields a later slice can actually learn from are kept.
function compact(value) {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch {
    // A value that will not serialize is not worth failing an import over.
    return null
  }
}

function proposedOf(decision) {
  return compact({
    entity: decision.entity ?? null,
    entityName: decision.entityName ?? null,
    field: decision.field ?? null,
    confidence: decision.confidence ?? null,
    // T298 — WHAT WE SUGGESTED, when we suggested anything. `undefined` rather
    // than null when absent, so it drops out of the JSON entirely: a decision
    // that proposed nothing must be distinguishable from one that proposed
    // nothing IN PARTICULAR, and the whole question a later learning slice puts
    // to this table is whether the proposals were any good.
    proposal: decision.proposal ?? undefined,
  })
}

function chosenOf(answer) {
  if (!answer) return null
  return compact({
    choice: answer.choice ?? null,
    entity_id: answer.entity_id ?? null,
    value: answer.value ?? null,
    // T298 — WHICH ACTION the director took. `outcomeFor` above reads this and
    // then throws it away, collapsing three distinct resolutions of a packed
    // cell into one CHANGED; the outcome is the right summary and the wrong
    // record. Recording it costs one short string and is the difference between
    // "the director settled it" and "the director settled it by splitting".
    // `undefined` when absent, so the kinds that answer by `choice` are stored
    // exactly as before.
    action: answer.action ?? undefined,
    // The activity a mapping pointed AT. Named rather than an id because a
    // resolution is about a spelling, and the id is not what was compared.
    activityName: answer.activityName ?? undefined,
  })
}

/**
 * One entry per decision PRESENTED — not per decision answered.
 *
 * The unanswered ones are the point as much as the answered ones: a question
 * the director skipped every time is a question that should probably not be
 * asked, and nothing currently records that they skipped it.
 *
 * @param decisions the decision list as presented
 * @param answers   the screen's answers, keyed by decision id
 * @param importId  groups one import's entries together
 */
export function journalEntriesFor(decisions, answers, importId) {
  const entries = []
  for (const d of decisions ?? []) {
    if (!d || !d.id || !d.kind) continue
    const answer = (answers ?? {})[d.id]
    entries.push({
      import_id: importId,
      kind: d.kind,
      lane: laneOf(d),
      proposed: proposedOf(d),
      outcome: outcomeFor(d, answer),
      chosen: chosenOf(answer),
    })
  }
  return entries
}
