// Audit E5 (2026-10-10) — the copy for a NOT_REQUESTED placement's reason, and the
// one summary line, both read from the solver's `not_requested_reason`.
import { describe, it, expect } from 'vitest'
import { notRequestedChip, notRequestedSummary } from './notRequestedReasons.js'

const a = (camper_id, reason, flags = ['NOT_REQUESTED']) =>
  ({ camper_id, flags, ...(reason ? { not_requested_reason: reason } : {}) })

describe('notRequestedChip', () => {
  it.each([
    ['CHOICES_FULL', 'Not requested: their choices were full'],
    ['CHOICES_DID_NOT_RUN', 'Not requested: their choices did not run'],
    ['CHOICES_FULL_OR_DID_NOT_RUN', 'Not requested: their choices were full or did not run'],
    ['NO_CHOICE_OFFERED', 'Not requested: none of their choices is offered here'],
  ])('%s', (reason, text) => {
    expect(notRequestedChip(a('c', reason))).toBe(text)
  })
  it('says only "Not requested" when the solver gave no reason — never a guess', () => {
    expect(notRequestedChip(a('c', null))).toBe('Not requested')
  })
})

describe('notRequestedSummary', () => {
  it('counts each reason, largest first, in one line', () => {
    const line = notRequestedSummary([
      a('c1', 'NO_CHOICE_OFFERED'), a('c2', 'NO_CHOICE_OFFERED'), a('c3', 'CHOICES_FULL'),
      a('c4', null, []), a('c5', null, ['NOT_TOP_CHOICE']),
    ])
    expect(line).toBe('3 placements are not something the camper requested: 2 because none of their choices was offered then, 1 because their choices were full.')
  })
  it('names an unexplained placement as unexplained', () => {
    expect(notRequestedSummary([a('c1', null)])).toBe('1 placement is not something the camper requested: 1 because the solver recorded no reason.')
  })
  it('is null when everyone got something they asked for', () => {
    expect(notRequestedSummary([a('c1', null, [])])).toBeNull()
  })
})
