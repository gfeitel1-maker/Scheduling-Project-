// Audit E5 (2026-10-10) — the words for WHY a camper was placed in something they
// did not request. The reason itself is the solver's (`not_requested_reason`, set
// by buildElectiveAssignments from its own settled state); this file only words it.
// An assignment the solver gave no reason for reads plain "Not requested" — the
// copy never supplies a reason the solver did not.
const CHIP = {
  CHOICES_FULL: 'their choices were full',
  CHOICES_DID_NOT_RUN: 'their choices did not run',
  CHOICES_FULL_OR_DID_NOT_RUN: 'their choices were full or did not run',
  NO_CHOICE_OFFERED: 'none of their choices is offered here',
}

// Counted per PLACEMENT (one camper in one period), which is what an assignment
// row is — a camper in five periods can be five of these.
const SUMMARY = {
  NO_CHOICE_OFFERED: 'none of their choices was offered then',
  CHOICES_FULL: 'their choices were full',
  CHOICES_DID_NOT_RUN: 'their choices did not run (below minimum)',
  CHOICES_FULL_OR_DID_NOT_RUN: 'their choices were full or did not run',
  null: 'the solver recorded no reason',
}

export function notRequestedChip(assignment) {
  const why = CHIP[assignment?.not_requested_reason]
  return why ? `Not requested: ${why}` : 'Not requested'
}

export function notRequestedSummary(assignments = []) {
  const counts = new Map()
  let total = 0
  for (const a of assignments) {
    if (!(a.flags ?? []).includes('NOT_REQUESTED')) continue
    total += 1
    const key = SUMMARY[a.not_requested_reason] ? a.not_requested_reason : null
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (total === 0) return null
  const parts = [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])))
    .map(([key, n]) => `${n} because ${SUMMARY[key]}`)
  const head = total === 1 ? '1 placement is' : `${total} placements are`
  return `${head} not something the camper requested: ${parts.join(', ')}.`
}
