import { describe, it, expect } from 'vitest'
import { verdict, runVerify, VERIFY_STEPS, machineLoadVerdict } from './verify.js'

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

    // T164: a failure under an oversubscribed machine is INCONCLUSIVE (exit 2), not FAILED.
    it('reports INCONCLUSIVE with exit code 2 when a step fails under oversubscription', () => {
      const v = verdict('test', { oversubscribed: true })
      expect(v.code).toBe(2)
      expect(v.line).toMatch(/INCONCLUSIVE/)
      expect(v.line).toMatch(/NOT a pass/)
      expect(v.line).not.toMatch(/PASSED/) // still never a false green
    })

    it('still reports FAILED (exit 1) for a failure when the machine was NOT oversubscribed', () => {
      const v = verdict('test', { oversubscribed: false })
      expect(v.code).toBe(1)
      expect(v.line).toMatch(/FAILED/)
    })

    it('never relabels a PASS — oversubscription only matters when something failed', () => {
      const v = verdict(null, { oversubscribed: true })
      expect(v.code).toBe(0)
      expect(v.line).toMatch(/PASSED/)
    })
  })

  describe('machineLoadVerdict()', () => {
    it('flags oversubscription at 4x cores or more (the load-66-on-4-cores case)', () => {
      expect(machineLoadVerdict(66, 4)).toBe('oversubscribed') // 16x — the measured incident
      expect(machineLoadVerdict(16, 4)).toBe('oversubscribed') // exactly 4x
    })
    it('treats normal multi-session load (a few x) as ok — this repo runs oversubscribed by design', () => {
      expect(machineLoadVerdict(8, 4)).toBe('ok') // 2x
      expect(machineLoadVerdict(11, 4)).toBe('ok') // ~2.75x
    })
    it('returns ok (never relabels) when load or core count is unknown', () => {
      expect(machineLoadVerdict(NaN, 4)).toBe('ok')
      expect(machineLoadVerdict(66, 0)).toBe('ok')
      expect(machineLoadVerdict(66, undefined)).toBe('ok')
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

  it('gates the canonical steps in the documented order', () => {
    expect(VERIFY_STEPS).toEqual([
      'lint',
      'agents:check',
      'test',
      'test:integration',
      'security',
      'check:governance',
    ])
  })
})
