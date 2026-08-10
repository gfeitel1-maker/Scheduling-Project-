import { describe, it, expect } from 'vitest'
import { reduceGateReport } from './gateReportReduce.js'

const EXPECTED = ['security', 'red_hat', 'tester', 'code_reviewer']

const verifier = (overrides = {}) => ({
  gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null,
  findings: [], evidence_ref: 'docs/work/runs/x.log', ...overrides,
})

const opinion = (gate_name, score, overrides = {}) => ({
  gate_name, verdict: 'PASS', score, na_reason: null, findings: [], evidence_ref: null, ...overrides,
})

const fullPanel = (scores = [4, 4, 4, 4]) => [
  verifier(),
  opinion('security', scores[0]),
  opinion('red_hat', scores[1]),
  opinion('tester', scores[2]),
  opinion('code_reviewer', scores[3]),
]

describe('reduceGateReport', () => {
  it('1. five well-formed reports produce a correct aggregate', () => {
    const out = reduceGateReport({
      taskId: 'T1', round: 1, expectedOpinionGates: EXPECTED, reports: fullPanel([4, 4, 4, 4]),
    })
    expect(out.verifier_pass).toBe(true)
    expect(out.overall_score).toBe(4)
    expect(out.lowest_dimension).toBe(4)
    expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
    expect(out.incomplete).toBe(false)
    expect(out.malformed).toEqual([])
  })

  describe('2. spec §10 worked example', () => {
    it('round 1: Verifier FAIL forces BLOCK despite a 4.0 average', () => {
      const out = reduceGateReport({
        taskId: 'T-worked', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier({ verdict: 'FAIL', findings: [{ severity: 'BLOCKING', summary: '1 failing test' }] }),
          opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4),
        ],
      })
      expect(out.verifier_pass).toBe(false)
      expect(out.overall_score).toBe(4.0)
      expect(out.lowest_dimension).toBe(4)
      expect(out.blocking_findings).toEqual([{ severity: 'BLOCKING', summary: '1 failing test', gate_name: 'verifier' }])
      expect(out.incomplete).toBe(false)
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('round 2: Verifier PASS with {4,5,4,4} -> PASS_ELIGIBLE', () => {
      const out = reduceGateReport({
        taskId: 'T-worked', round: 2, expectedOpinionGates: EXPECTED,
        reports: fullPanel([4, 5, 4, 4]),
      })
      expect(out.verifier_pass).toBe(true)
      expect(out.overall_score).toBe(4.25)
      expect(out.lowest_dimension).toBe(4)
      expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
    })
  })

  describe('3. verifier_pass=false forces BLOCK regardless of a high overall_score', () => {
    it('Verifier FAIL', () => {
      const out = reduceGateReport({
        taskId: 'T3', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier({ verdict: 'FAIL', findings: [{ severity: 'BLOCKING', summary: 'x' }] }), ...fullPanel([5, 5, 5, 5]).slice(1)],
      })
      expect(out.verifier_pass).toBe(false)
      expect(out.overall_score).toBe(5)
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('Verifier UNVERIFIED', () => {
      const out = reduceGateReport({
        taskId: 'T3', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier({ verdict: 'UNVERIFIED' }), ...fullPanel([5, 5, 5, 5]).slice(1)],
      })
      expect(out.verifier_pass).toBe(false)
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('Verifier missing entirely', () => {
      const out = reduceGateReport({
        taskId: 'T3', round: 1, expectedOpinionGates: EXPECTED,
        reports: fullPanel([5, 5, 5, 5]).slice(1),
      })
      expect(out.verifier_pass).toBe(false)
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('Verifier malformed (scored)', () => {
      const out = reduceGateReport({
        taskId: 'T3', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier({ score: 4 }), ...fullPanel([5, 5, 5, 5]).slice(1)],
      })
      expect(out.verifier_pass).toBe(false)
      expect(out.decision_eligibility).toBe('BLOCK')
    })
  })

  it('4. a missing opinion gate sets incomplete/gap but does not alone force BLOCK', () => {
    const out = reduceGateReport({
      taskId: 'T4', round: 1, expectedOpinionGates: EXPECTED,
      reports: [verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4)],
    })
    expect(out.incomplete).toBe(true)
    expect(out.gap).toEqual([{ gate_name: 'code_reviewer', reason: 'missing' }])
    expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
  })

  it('5. a malformed opinion report is excluded from S, in malformed[], gap reason "malformed", forces BLOCK', () => {
    const out = reduceGateReport({
      taskId: 'T5', round: 1, expectedOpinionGates: EXPECTED,
      reports: [
        verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4),
        opinion('code_reviewer', 7), // out of range -> malformed
      ],
    })
    expect(out.gate_scores.code_reviewer).toBeNull()
    expect(out.malformed).toEqual([{ gate_name: 'code_reviewer', problem: expect.any(String) }])
    expect(out.gap).toContainEqual({ gate_name: 'code_reviewer', reason: 'malformed' })
    expect(out.decision_eligibility).toBe('BLOCK')
  })

  describe('6/7. self-declared N/A', () => {
    it('with a reason: excluded from S, in self_declared_na[], no incomplete, no forced BLOCK', () => {
      const out = reduceGateReport({
        taskId: 'T6', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4),
          { gate_name: 'code_reviewer', verdict: 'N/A', score: null, na_reason: 'docs-only change', findings: [], evidence_ref: null },
        ],
      })
      expect(out.gate_scores.code_reviewer).toBeNull()
      expect(out.self_declared_na).toEqual([{ gate_name: 'code_reviewer', na_reason: 'docs-only change' }])
      expect(out.incomplete).toBe(false)
      expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
    })

    it('with a reasonless N/A: malformed, not a legitimate N/A', () => {
      const out = reduceGateReport({
        taskId: 'T7', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4),
          { gate_name: 'code_reviewer', verdict: 'N/A', score: null, na_reason: null, findings: [], evidence_ref: null },
        ],
      })
      expect(out.malformed).toEqual([{ gate_name: 'code_reviewer', problem: expect.any(String) }])
      expect(out.self_declared_na).toEqual([])
      expect(out.gap).toContainEqual({ gate_name: 'code_reviewer', reason: 'malformed' })
    })
  })

  describe('8. cross_gate_flags', () => {
    it('flags a ref shared by two gates', () => {
      const out = reduceGateReport({
        taskId: 'T8', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(),
          opinion('security', 4, { findings: [{ severity: 'MEDIUM', summary: 'x', ref: 'electron/db/x.js' }] }),
          opinion('red_hat', 4, { findings: [{ severity: 'LOW', summary: 'y', ref: 'electron/db/x.js' }] }),
          opinion('tester', 4), opinion('code_reviewer', 4),
        ],
      })
      expect(out.cross_gate_flags).toEqual([{ ref: 'electron/db/x.js', gate_names: ['red_hat', 'security'] }])
    })

    it('does not flag a ref referenced by only one gate', () => {
      const out = reduceGateReport({
        taskId: 'T8b', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(),
          opinion('security', 4, { findings: [{ severity: 'MEDIUM', summary: 'x', ref: 'a.js' }] }),
          opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4),
        ],
      })
      expect(out.cross_gate_flags).toEqual([])
    })

    it('a finding with no ref never contributes to a flag', () => {
      const out = reduceGateReport({
        taskId: 'T8c', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(),
          opinion('security', 4, { findings: [{ severity: 'MEDIUM', summary: 'x' }] }),
          opinion('red_hat', 4, { findings: [{ severity: 'MEDIUM', summary: 'y' }] }),
          opinion('tester', 4), opinion('code_reviewer', 4),
        ],
      })
      expect(out.cross_gate_flags).toEqual([])
    })
  })

  describe('9. L1-L6 anti-laundering properties', () => {
    it('L1: an opinion gate not in expectedOpinionGates and never reported is N/A-shaped, not missing', () => {
      const out = reduceGateReport({
        taskId: 'T-L1', round: 1, expectedOpinionGates: ['security', 'red_hat', 'tester'],
        reports: [verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4)],
      })
      expect(out.gap).toEqual([])
      expect(out.incomplete).toBe(false)
      expect(out.gate_scores.code_reviewer).toBeNull()
    })

    it('L2: discretion never reaches the Verifier or a FAIL — a FAIL opinion gate is not treated as a "gap"', () => {
      const out = reduceGateReport({
        taskId: 'T-L2', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(),
          opinion('security', 2, { verdict: 'FAIL', findings: [{ severity: 'BLOCKING', summary: 'x' }] }),
          opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4),
        ],
      })
      expect(out.gap).toEqual([])
      expect(out.incomplete).toBe(false)
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('L3: a malformed report is treated as absent for scoring but still forces BLOCK, logged with reason malformed', () => {
      const out = reduceGateReport({
        taskId: 'T-L3', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4),
          opinion('code_reviewer', null, { verdict: 'N/A', na_reason: null }),
        ],
      })
      expect(out.gate_scores.code_reviewer).toBeNull()
      expect(out.gap.find((g) => g.gate_name === 'code_reviewer').reason).toBe('malformed')
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('L4: gaps are persisted in the returned object (un-erasable / surfaced)', () => {
      const out = reduceGateReport({
        taskId: 'T-L4', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4)],
      })
      expect(out.gap).toEqual([{ gate_name: 'code_reviewer', reason: 'missing' }])
    })

    it('L5: no score invention — N/A and missing gates are null, never 0 or 5', () => {
      const out = reduceGateReport({
        taskId: 'T-L5', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4)],
      })
      expect(out.gate_scores.code_reviewer).toBeNull()
      expect(out.overall_score).toBe(4)
    })

    it('L6: a self-declared N/A with a reason is surfaced in self_declared_na, not silently dropped', () => {
      const out = reduceGateReport({
        taskId: 'T-L6', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(), opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4),
          { gate_name: 'code_reviewer', verdict: 'N/A', score: null, na_reason: 'not applicable', findings: [], evidence_ref: null },
        ],
      })
      expect(out.self_declared_na).toEqual([{ gate_name: 'code_reviewer', na_reason: 'not applicable' }])
    })
  })

  describe('10. degenerate edges E1-E5', () => {
    it('E1 empty panel: nothing ran -> BLOCK, cannot pass', () => {
      const out = reduceGateReport({ taskId: 'T-E1', round: 1, expectedOpinionGates: EXPECTED, reports: [] })
      expect(out.verifier_pass).toBe(false)
      expect(out.overall_score).toBeNull()
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('E2 single opinion gate only, Verifier missing -> BLOCK', () => {
      const out = reduceGateReport({
        taskId: 'T-E2', round: 1, expectedOpinionGates: EXPECTED,
        reports: [opinion('security', 5)],
      })
      expect(out.verifier_pass).toBe(false)
      expect(out.decision_eligibility).toBe('BLOCK')
    })

    it('E3 Verifier PASS, all four opinion gates N/A -> BLOCK (rule 4, not an automatic pass)', () => {
      const na = (gate) => ({ gate_name: gate, verdict: 'N/A', score: null, na_reason: 'docs-only', findings: [], evidence_ref: null })
      const out = reduceGateReport({
        taskId: 'T-E3', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier(), na('security'), na('red_hat'), na('tester'), na('code_reviewer')],
      })
      expect(out.verifier_pass).toBe(true)
      expect(out.overall_score).toBeNull()
      expect(out.decision_eligibility).toBe('BLOCK')
      expect(out.self_declared_na).toHaveLength(4)
    })

    it('E4 Verifier PASS, three N/A, one opinion PASS score 5 -> PASS_ELIGIBLE on a single dimension', () => {
      const na = (gate) => ({ gate_name: gate, verdict: 'N/A', score: null, na_reason: 'docs-only', findings: [], evidence_ref: null })
      const out = reduceGateReport({
        taskId: 'T-E4', round: 1, expectedOpinionGates: EXPECTED,
        reports: [verifier(), opinion('security', 5), na('red_hat'), na('tester'), na('code_reviewer')],
      })
      expect(out.overall_score).toBe(5)
      expect(out.lowest_dimension).toBe(5)
      expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
    })

    it('E5 two gates flag the same file, neither blocking -> flag present, may still be PASS_ELIGIBLE', () => {
      const out = reduceGateReport({
        taskId: 'T-E5', round: 1, expectedOpinionGates: EXPECTED,
        reports: [
          verifier(),
          opinion('security', 4, { findings: [{ severity: 'LOW', summary: 'x', ref: 'a.js' }] }),
          opinion('red_hat', 4, { findings: [{ severity: 'LOW', summary: 'y', ref: 'a.js' }] }),
          opinion('tester', 4), opinion('code_reviewer', 4),
        ],
      })
      expect(out.cross_gate_flags).toEqual([{ ref: 'a.js', gate_names: ['red_hat', 'security'] }])
      expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
    })
  })

  describe('L7 — no unexpected-gate score inflation', () => {
    it('a well-formed report from a gate NOT in expectedOpinionGates is malformed, excluded from S, and cannot flip BLOCK to PASS_ELIGIBLE', () => {
      // Legit 3-gate panel {4,4,3} -> overall 3.667 -> BLOCK (lowest_dimension 3
      // trips nothing, but overall < 4.0 does). A 4th, unexpected code_reviewer
      // report scoring 5 must not be averaged in to flip this to PASS_ELIGIBLE.
      const out = reduceGateReport({
        taskId: 'T-L7', round: 1, expectedOpinionGates: ['security', 'red_hat', 'tester'],
        reports: [
          verifier(),
          opinion('security', 4), opinion('red_hat', 4), opinion('tester', 3),
          opinion('code_reviewer', 5), // present, well-formed, but not expected
        ],
      })
      expect(out.malformed).toContainEqual({ gate_name: 'code_reviewer', problem: expect.any(String) })
      expect(out.gate_scores.code_reviewer).toBeNull()
      expect(out.overall_score).toBeCloseTo(11 / 3)
      expect(out.decision_eligibility).toBe('BLOCK')
    })
  })

  it('duplicate gate_name reports: both malformed, neither in S, the FAIL finding does not leak into blocking_findings', () => {
    const out = reduceGateReport({
      taskId: 'T-dup', round: 1, expectedOpinionGates: EXPECTED,
      reports: [
        verifier(), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4),
        { gate_name: 'security', verdict: 'FAIL', score: 1, na_reason: null, findings: [{ severity: 'BLOCKING', summary: 'dup-fail' }], evidence_ref: null },
        opinion('security', 5),
      ],
    })
    expect(out.malformed).toHaveLength(2)
    expect(out.malformed.every((m) => m.gate_name === 'security')).toBe(true)
    expect(out.gate_scores.security).toBeNull()
    expect(out.blocking_findings.find((f) => f.summary === 'dup-fail')).toBeUndefined()
    expect(out.decision_eligibility).toBe('BLOCK')
  })

  it('11. determinism: same input (different object identity) -> byte-identical output, twice in a row', () => {
    const makeInput = () => ({
      taskId: 'T-det', round: 1, expectedOpinionGates: [...EXPECTED], reports: fullPanel([4, 4, 4, 4]),
    })
    const out1 = reduceGateReport(makeInput())
    const out2 = reduceGateReport(makeInput())
    const out3 = reduceGateReport(makeInput())
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2))
    expect(JSON.stringify(out2)).toBe(JSON.stringify(out3))
  })
})
