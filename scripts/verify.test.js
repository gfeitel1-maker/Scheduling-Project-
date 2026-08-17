import { describe, it, expect } from 'vitest'
import { verdict, runVerify, VERIFY_STEPS } from './verify.js'

describe('verify gate wrapper', () => {
  describe('verdict()', () => {
    it('reports PASS with exit code 0 when nothing failed', () => {
      const v = verdict(null)
      expect(v.code).toBe(0)
      expect(v.line).toMatch(/✅ VERIFY PASSED/)
    })

    it('reports FAIL with exit code 1 and names the failing step', () => {
      const v = verdict('test')
      expect(v.code).toBe(1)
      expect(v.line).toMatch(/❌ VERIFY FAILED at step: test/)
    })

    // The whole point of this wrapper: the verdict is TEXT, so it survives `| tail`.
    // A false-green can't happen because a failure always prints ❌ and exits 1.
    it('never emits a PASS line for a failed step', () => {
      expect(verdict('check:governance').line).not.toMatch(/PASSED/)
    })
  })

  describe('runVerify()', () => {
    it('runs every step in order when all pass and returns null', () => {
      const seen = []
      const failed = runVerify(VERIFY_STEPS, (s) => {
        seen.push(s)
        return 0
      })
      expect(failed).toBeNull()
      expect(seen).toEqual(VERIFY_STEPS)
    })

    it('short-circuits at the first failing step and returns its name', () => {
      const seen = []
      const failed = runVerify(['a', 'b', 'c'], (s) => {
        seen.push(s)
        return s === 'b' ? 1 : 0
      })
      expect(failed).toBe('b')
      // 'c' must NOT run — a real gate stops at the first failure.
      expect(seen).toEqual(['a', 'b'])
    })

    it('treats a non-zero exit code as failure', () => {
      const failed = runVerify(['only'], () => 137)
      expect(failed).toBe('only')
    })
  })

  it('gates the canonical four steps in the documented order', () => {
    expect(VERIFY_STEPS).toEqual(['lint', 'test', 'test:integration', 'check:governance'])
  })
})
