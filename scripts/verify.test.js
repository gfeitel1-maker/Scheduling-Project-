import { describe, it, expect } from 'vitest'
import { verdict, runVerify, VERIFY_STEPS, machineLoadVerdict, MIN_LOAD_TIMEOUT_MS } from './verify.js'

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

    // T164/T178: INCONCLUSIVE only for a SLOW failure of a LOAD-SENSITIVE step under oversubscription.
    it('reports INCONCLUSIVE (exit 2) for a slow test failure under oversubscription', () => {
      const v = verdict({ step: 'test', ms: 40_000 }, { oversubscribed: true })
      expect(v.code).toBe(2)
      expect(v.line).toMatch(/INCONCLUSIVE/)
      expect(v.line).toMatch(/NOT a pass/)
      expect(v.line).not.toMatch(/PASSED/) // still never a false green
    })

    // T178 filter (2): a FAST failure is a real defect, never laundered — the measured 295ms case.
    it('reports FAILED for a FAST test failure even under oversubscription (295ms defect)', () => {
      const v = verdict({ step: 'test', ms: 295 }, { oversubscribed: true })
      expect(v.code).toBe(1)
      expect(v.line).toMatch(/FAILED/)
    })

    // T178 filter (1): a deterministic step is never downgraded — the measured check:governance case.
    it('reports FAILED for a deterministic step even if slow + oversubscribed (check:governance)', () => {
      const v = verdict({ step: 'check:governance', ms: 60_000 }, { oversubscribed: true })
      expect(v.code).toBe(1)
      expect(v.line).toMatch(/FAILED/)
    })
    it('never downgrades lint / agents:check / security (deterministic) under load', () => {
      for (const step of ['lint', 'agents:check', 'security']) {
        expect(verdict({ step, ms: 99_000 }, { oversubscribed: true }).code).toBe(1)
      }
    })

    it('downgrades test:integration too (the other load-sensitive step) when slow', () => {
      expect(verdict({ step: 'test:integration', ms: MIN_LOAD_TIMEOUT_MS }, { oversubscribed: true }).code).toBe(2)
    })

    it('an unknown duration (bare string) is never downgraded — conservative', () => {
      expect(verdict('test', { oversubscribed: true }).code).toBe(1)
    })

    it('still reports FAILED (exit 1) for a failure when the machine was NOT oversubscribed', () => {
      const v = verdict({ step: 'test', ms: 40_000 }, { oversubscribed: false })
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

    it('short-circuits at the first failing step and returns { step, ms }', () => {
      const seen = []
      const failed = runVerify(['a', 'b', 'c'], (s) => {
        seen.push(s)
        return s === 'b' ? 1 : 0
      })
      expect(failed.step).toBe('b')
      expect(typeof failed.ms).toBe('number')
      // 'c' must NOT run — a real gate stops at the first failure.
      expect(seen).toEqual(['a', 'b'])
    })

    it('measures the failing step duration (for the load-timeout verdict)', () => {
      // injected clock: 1000ms elapses during the failing step
      let t = 0
      const clock = () => { const v = t; t += 1000; return v }
      const failed = runVerify(['only'], () => 137, clock)
      expect(failed).toEqual({ step: 'only', ms: 1000 })
    })
  })

  it('gates the canonical steps in the documented order', () => {
    expect(VERIFY_STEPS).toEqual([
      'agents:check',
      'check:governance',
      'build',
      'security',
      'test:integration',
      'lint',
      'test',
    ])
  })

  // The property the order exists for (T188). runVerify short-circuits, so a cheap deterministic
  // check must never sit behind an expensive one — that is what made a 1.2s governance failure
  // cost a full ~19-minute gate run before it was reported.
  it('orders steps cheapest-first, so a cheap failure is never reported late', () => {
    // measured seconds, 2026-09-16, quiet machine (see scripts/verify.js)
    const COST = {
      'agents:check': 0.2,
      'check:governance': 1.2,
      build: 2.8,
      security: 5.9,
      'test:integration': 20.6,
      lint: 131.3,
      test: 702.1,
    }
    const costs = VERIFY_STEPS.map((s) => COST[s])
    expect(costs.every((c) => typeof c === 'number')).toBe(true)
    expect([...costs].sort((a, b) => a - b)).toEqual(costs)
  })

  // The reorder must not silently drop or add a gate: same set, different sequence.
  it('still runs exactly the six gates, none removed by the reorder', () => {
    expect([...VERIFY_STEPS].sort()).toEqual([
      'agents:check',
      'build',
      'check:governance',
      'lint',
      'security',
      'test',
      'test:integration',
    ])
  })
})
