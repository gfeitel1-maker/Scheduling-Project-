// Audit E5 (2026-10-10) — a camper placed into an offering they did not request
// carries WHY, taken from the solver's own decision at that moment: their choices
// were full, their choices did not run (minimum), or none of their choices is
// offered in that period. Never a guess: a case the solver cannot account for
// carries no reason.
import { describe, it, expect } from 'vitest'
import { buildElectiveAssignments } from './buildElectiveAssignments.js'

const occ = (id) => ({ id })
const offering = (occurrence_id, labelKey, activity_id, capacity = 1, minimum = null) =>
  ({ occurrence_id, labelKey, activity_id, capacity, minimum })
const pref = (camper_id, labelKey, rank) => ({ camper_id, labelKey, rank, rank_kind: 'ordered-fallback' })
const of = (out, camperId) => out.assignments.find((a) => a.camper_id === camperId)

describe('NOT_REQUESTED carries the solver\'s reason (audit E5)', () => {
  it('CHOICES_FULL — every offering the camper asked for was at capacity', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 1), offering('o1', 'gaga', 'a-gaga', 1)],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'archery', 1)],
    })
    const loser = ['c1', 'c2'].map((id) => of(out, id)).find((a) => a.flags.includes('NOT_REQUESTED'))
    expect(loser.not_requested_reason).toBe('CHOICES_FULL')
    const winner = ['c1', 'c2'].map((id) => of(out, id)).find((a) => !a.flags.includes('NOT_REQUESTED'))
    expect(winner.not_requested_reason).toBeUndefined()
  })

  it('NO_CHOICE_OFFERED — none of the camper\'s choices is offered in this period', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'gaga', 'a-gaga', 5)],
      preferences: [pref('c1', 'ceramics', 1), pref('c1', 'woodworking', 2)],
    })
    expect(of(out, 'c1').flags).toEqual(['NOT_REQUESTED'])
    expect(of(out, 'c1').not_requested_reason).toBe('NO_CHOICE_OFFERED')
  })

  it('NO_CHOICE_OFFERED — a camper with no preferences at all', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'gaga', 'a-gaga', 5)],
      preferences: [],
    })
    expect(of(out, 'c1').not_requested_reason).toBe('NO_CHOICE_OFFERED')
  })

  it('CHOICES_DID_NOT_RUN — the offering they asked for fell below its minimum', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 5, 3), offering('o1', 'gaga', 'a-gaga', 5)],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'gaga', 1), pref('c3', 'gaga', 1)],
    })
    expect(of(out, 'c1').activity_id).toBe('a-gaga')
    expect(of(out, 'c1').not_requested_reason).toBe('CHOICES_DID_NOT_RUN')
  })

  it('CHOICES_FULL_OR_DID_NOT_RUN — one choice did not run and the other was full', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 5, 3),
        offering('o1', 'drama', 'a-drama', 1),
        offering('o1', 'gaga', 'a-gaga', 5),
      ],
      preferences: [pref('c1', 'archery', 1), pref('c1', 'drama', 2), pref('c2', 'drama', 1)],
    })
    expect(of(out, 'c1').activity_id).toBe('a-gaga')
    expect(of(out, 'c1').not_requested_reason).toBe('CHOICES_FULL_OR_DID_NOT_RUN')
  })
})
