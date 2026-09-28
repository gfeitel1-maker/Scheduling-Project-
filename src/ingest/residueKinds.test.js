import { describe, it, expect } from 'vitest'
import { foldTokens, residueIsDecision, residueRailColor } from './residueKinds'

describe('residueIsDecision — a kind is an acknowledgment until proven otherwise', () => {
  it('treats an unresolved choice label as a decision', () => {
    expect(residueIsDecision('UNRESOLVED_CHOICE_LABEL')).toBe(true)
  })

  it('treats everything else as an acknowledgment, including an unknown kind', () => {
    // The default matters: listing a kind as a decision is a claim that an action
    // for it EXISTS, and the standing rule forbids a control whose options are all
    // inert. A kind this table has not been taught must not grow an affordance.
    for (const kind of ['SKIPPED_PREAMBLE', 'UNRECOGNISED_COLUMN', 'DROPPED_DUPLICATE_RANK', 'A_KIND_INVENTED_TOMORROW']) {
      expect(residueIsDecision(kind)).toBe(false)
    }
  })

  it('rails decisions in the caution hue and acknowledgments neutrally', () => {
    // DESIGN_STANDARD §6: bronze means "needs attention", which a decision does and
    // an acknowledgment does not. `--danger` appears nowhere in residue.
    expect(residueRailColor('UNRESOLVED_CHOICE_LABEL')).toBe('var(--accent)')
    expect(residueRailColor('SKIPPED_PREAMBLE')).toBe('var(--border)')
    expect(residueRailColor('DROPPED_DUPLICATE_RANK')).not.toBe('var(--danger)')
  })
})

describe('foldTokens — factor out the invariant, invent nothing', () => {
  it('folds a segment identical in every token', () => {
    expect(foldTokens(['Row 4, column C', 'Row 5, column C', 'Row 6, column C'])).toEqual({
      invariant: 'Column C',
      variable: ['Row 4', 'Row 5', 'Row 6'],
    })
  })

  it('folds nothing when the trailing segment differs', () => {
    // Planting the defect the fold must not have: "always drop the last segment"
    // would silently claim these two cells are in the same column.
    expect(foldTokens(['Row 4, column C', 'Row 5, column D'])).toEqual({
      invariant: null,
      variable: ['Row 4, column C', 'Row 5, column D'],
    })
  })

  it('folds nothing for a single token, which repeats nothing', () => {
    expect(foldTokens(['Row 5, column E'])).toEqual({ invariant: null, variable: ['Row 5, column E'] })
  })

  it('folds nothing when the tokens carry no segments to factor', () => {
    // A grid coordinate has no comma. Under-folding is the correct failure.
    expect(foldTokens(['Monday Period 1', 'Monday Period 2'])).toEqual({
      invariant: null,
      variable: ['Monday Period 1', 'Monday Period 2'],
    })
  })

  it('never folds away every segment — something must remain to distinguish them', () => {
    // Two identical tokens share ALL their segments. Folding all of them would
    // leave two blank instances under one heading, which says less than the
    // unfolded form.
    const out = foldTokens(['Row 4, column C', 'Row 4, column C'])
    expect(out.variable.every((v) => v.length > 0)).toBe(true)
  })

  it('folds more than one trailing segment when more than one is invariant', () => {
    expect(foldTokens(['Ari, Bunk 1, Session 2', 'Noa, Bunk 1, Session 2'])).toEqual({
      invariant: 'Bunk 1, Session 2',
      variable: ['Ari', 'Noa'],
    })
  })

  it('handles an empty list', () => {
    expect(foldTokens([])).toEqual({ invariant: null, variable: [] })
  })
})
