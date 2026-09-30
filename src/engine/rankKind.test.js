// T318 round 2 — one shared, dependency-free predicate for "does this
// rank_kind carry positive evidence of ordering". Extracted after the same
// 2-value check was found duplicated across four call sites (buildElectiveAssignments.js,
// camperElectiveWeek.js's rankLabel, preferenceSheet.js's three private
// constants, and exportRunSummary.js) — see
// ~/.claude/projects/-Users-gregfeitel-dev-shoresh/memory/feedback_guard_the_choke_point_not_the_instance.md.
// A typo in a constant here would now propagate to every consumer at once,
// which the duplicated form could not do — so the constants' exact string
// values are pinned below, not just the predicate's behavior.
import { describe, it, expect } from 'vitest'
import { hasOrderingEvidence, CELL_CHOICE, ORDERED_FALLBACK, UNORDERED_SET } from './rankKind.js'

describe('rankKind constants', () => {
  it('pins the exact persisted string values (elective_preferences.rank_kind, v79)', () => {
    expect(CELL_CHOICE).toBe('cell-choice')
    expect(ORDERED_FALLBACK).toBe('ordered-fallback')
    expect(UNORDERED_SET).toBe('unordered-set')
  })
})

describe('hasOrderingEvidence', () => {
  it('is true for cell-choice', () => {
    expect(hasOrderingEvidence('cell-choice')).toBe(true)
  })

  it('is true for ordered-fallback', () => {
    expect(hasOrderingEvidence('ordered-fallback')).toBe(true)
  })

  it('is false for unordered-set — a tie among equals, never a ranking', () => {
    expect(hasOrderingEvidence('unordered-set')).toBe(false)
  })

  it('is false for null — no evidence of ordering is not evidence of order', () => {
    expect(hasOrderingEvidence(null)).toBe(false)
  })

  it('is false for undefined', () => {
    expect(hasOrderingEvidence(undefined)).toBe(false)
  })

  it('is false for an unrecognised kind, rather than throwing or defaulting true', () => {
    expect(hasOrderingEvidence('something-else')).toBe(false)
  })
})
