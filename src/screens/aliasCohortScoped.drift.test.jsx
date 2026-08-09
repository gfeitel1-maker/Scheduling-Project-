// @vitest-environment jsdom
//
// Drift guard: ImportScreen keeps its OWN copy of the cohort-scoped entity_type
// set (ALIAS_COHORT_SCOPED) because renderer code in src/ must never import
// electron/ at runtime. That duplication is correct only while the copy stays
// byte-for-byte equal to the engine's COHORT_SCOPED. This test — which, unlike
// runtime code, is allowed to cross the boundary — fails the moment the two
// diverge, so a future change to COHORT_SCOPED can't silently leave the alias
// path mis-keying cohort_id.
import { describe, it, expect } from 'vitest'
import { ALIAS_COHORT_SCOPED } from './importAliasScope.js'
import { COHORT_SCOPED } from '../../electron/ops/ingest.js'

const sorted = (s) => [...s].sort()

describe('ALIAS_COHORT_SCOPED drift guard', () => {
  it('is exactly the engine COHORT_SCOPED set', () => {
    expect(sorted(ALIAS_COHORT_SCOPED)).toEqual(sorted(COHORT_SCOPED))
  })

  it('has the same size (no extra or missing members)', () => {
    expect(ALIAS_COHORT_SCOPED.size).toBe(COHORT_SCOPED.size)
  })

  it('every engine-scoped type is gated by the renderer copy', () => {
    for (const t of COHORT_SCOPED) {
      expect(ALIAS_COHORT_SCOPED.has(t)).toBe(true)
    }
  })

  it('the renderer copy adds nothing the engine does not scope', () => {
    for (const t of ALIAS_COHORT_SCOPED) {
      expect(COHORT_SCOPED.has(t)).toBe(true)
    }
  })
})
