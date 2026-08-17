import { describe, it, expect } from 'vitest'
import { normalizeName, recognitionKey } from './preview'

// ADR 2026-08-17-onescreen-reconciliation-merge.md §2/A2 — buildPreview/
// describePreview/looksLikeAMerge moved out (see buildPlan.test.js for the
// merge/confidence coverage). normalizeName/recognitionKey stay: identity-
// matching primitives 10+ modules depend on.

describe('normalizeName', () => {
  it('ignores case and collapses whitespace, like the per-screen imports', () => {
    expect(normalizeName('  Back   Playground ')).toBe('back playground')
    expect(normalizeName('SWIM')).toBe(normalizeName('swim'))
  })
})

describe('recognitionKey', () => {
  it('case-folds every entity except locations', () => {
    expect(recognitionKey('activities', 'Swim')).toBe(recognitionKey('activities', 'swim'))
    expect(recognitionKey('locations', 'Pool')).not.toBe(recognitionKey('locations', 'pool'))
  })
})
