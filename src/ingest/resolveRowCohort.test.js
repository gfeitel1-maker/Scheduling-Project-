import { describe, it, expect } from 'vitest'
import { resolveRowCohort, describeCohortNote } from './resolveRowCohort.js'

const cohorts = [{ id: 'coh-a', name: 'Summer' }, { id: 'coh-b', name: 'Winter' }]
const active = { id: 'coh-a', name: 'Summer' }

describe('resolveRowCohort', () => {
  it('falls back to the active cohort when no cohort name column is present', () => {
    expect(resolveRowCohort('', cohorts, active)).toEqual({ cohortId: 'coh-a', mismatch: false })
  })

  it('resolves by name, matching case-insensitively', () => {
    const result = resolveRowCohort('winter', cohorts, active)
    expect(result.cohortId).toBe('coh-b')
  })

  it('flags a mismatch when the resolved cohort differs from the active one', () => {
    const result = resolveRowCohort('Winter', cohorts, active)
    expect(result.mismatch).toBe(true)
    expect(result.matchedCohortName).toBe('Winter')
  })

  it('does not flag a mismatch when the resolved cohort matches the active one', () => {
    const result = resolveRowCohort('Summer', cohorts, active)
    expect(result.mismatch).toBe(false)
  })

  // Red Hat finding (MEDIUM-HIGH): a blank cell and a NAMED-but-unmatched cell (typo,
  // renamed program) must not look identical — a silent fallback for the latter hides a
  // real data problem behind the same shape as "no column at all". `unmatchedName` is the
  // distinct signal a door surfaces as a needs-eye disclosure; `cohortId` still falls back
  // to the active cohort so the import is never blocked on it.
  it('surfaces a distinct unmatched signal, not a silent fallback, when the named cohort does not exist', () => {
    const result = resolveRowCohort('Nonexistent', cohorts, active)
    expect(result).toEqual({ cohortId: 'coh-a', mismatch: false, unmatchedName: 'Nonexistent' })
  })

  it('a blank cell stays the quiet default — no unmatchedName', () => {
    const result = resolveRowCohort('', cohorts, active)
    expect(result.unmatchedName).toBeUndefined()
  })
})

describe('describeCohortNote', () => {
  it('returns null for the quiet default (blank cell or matching the active cohort)', () => {
    expect(describeCohortNote(resolveRowCohort('', cohorts, active), active)).toBeNull()
    expect(describeCohortNote(resolveRowCohort('Summer', cohorts, active), active)).toBeNull()
  })

  it('describes a resolved mismatch', () => {
    const note = describeCohortNote(resolveRowCohort('Winter', cohorts, active), active)
    expect(note).toMatch(/Winter/)
    expect(note).toMatch(/Summer/)
  })

  it('describes an unmatched cohort name as a needs-eye disclosure, distinct from a mismatch', () => {
    const note = describeCohortNote(resolveRowCohort('Nonexistent', cohorts, active), active)
    expect(note).toMatch(/Nonexistent/)
    expect(note).toMatch(/no program/i)
    expect(note).toMatch(/Summer/)
  })
})
