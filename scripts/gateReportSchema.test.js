import { describe, it, expect } from 'vitest'
import { validatePerGateReport, GATE_NAMES, VERDICTS } from './gateReportSchema.js'

const base = (overrides = {}) => ({
  gate_name: 'security',
  verdict: 'PASS',
  score: 4,
  na_reason: null,
  findings: [],
  evidence_ref: null,
  ...overrides,
})

describe('validatePerGateReport', () => {
  it('accepts a well-formed opinion PASS report', () => {
    expect(validatePerGateReport(base())).toEqual({ malformed: false })
  })

  it('accepts a well-formed verifier PASS report', () => {
    expect(validatePerGateReport({
      gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null,
      findings: [], evidence_ref: 'docs/work/runs/x.json',
    })).toEqual({ malformed: false })
  })

  it('rejects UNVERIFIED on an opinion gate', () => {
    const r = validatePerGateReport(base({ verdict: 'UNVERIFIED', score: null }))
    expect(r.malformed).toBe(true)
  })

  it('rejects a scored verifier', () => {
    const r = validatePerGateReport({
      gate_name: 'verifier', verdict: 'PASS', score: 4, na_reason: null,
      findings: [], evidence_ref: 'x',
    })
    expect(r.malformed).toBe(true)
  })

  it('rejects verdict N/A on verifier', () => {
    const r = validatePerGateReport({
      gate_name: 'verifier', verdict: 'N/A', score: null, na_reason: 'why',
      findings: [], evidence_ref: 'x',
    })
    expect(r.malformed).toBe(true)
  })

  it('rejects FAIL with no BLOCKING finding', () => {
    const r = validatePerGateReport(base({ verdict: 'FAIL', findings: [{ severity: 'HIGH', summary: 'x' }] }))
    expect(r.malformed).toBe(true)
  })

  it('rejects a BLOCKING finding with verdict not FAIL', () => {
    const r = validatePerGateReport(base({ verdict: 'PASS', findings: [{ severity: 'BLOCKING', summary: 'x' }] }))
    expect(r.malformed).toBe(true)
  })

  it('accepts FAIL with a BLOCKING finding', () => {
    const r = validatePerGateReport(base({ verdict: 'FAIL', score: 2, findings: [{ severity: 'BLOCKING', summary: 'x' }] }))
    expect(r).toEqual({ malformed: false })
  })

  it('rejects out-of-range score', () => {
    expect(validatePerGateReport(base({ score: 6 })).malformed).toBe(true)
    expect(validatePerGateReport(base({ score: 0 })).malformed).toBe(true)
  })

  it('rejects non-integer score', () => {
    expect(validatePerGateReport(base({ score: 4.5 })).malformed).toBe(true)
  })

  it('rejects null score on a scored PASS/FAIL verdict', () => {
    expect(validatePerGateReport(base({ score: null })).malformed).toBe(true)
  })

  it('rejects reasonless N/A', () => {
    const r = validatePerGateReport(base({ verdict: 'N/A', score: null, na_reason: null }))
    expect(r.malformed).toBe(true)
  })

  it('rejects empty-string na_reason on N/A', () => {
    const r = validatePerGateReport(base({ verdict: 'N/A', score: null, na_reason: '   ' }))
    expect(r.malformed).toBe(true)
  })

  it('accepts N/A with a non-empty na_reason', () => {
    const r = validatePerGateReport(base({ verdict: 'N/A', score: null, na_reason: 'not applicable here' }))
    expect(r).toEqual({ malformed: false })
  })

  it('rejects na_reason present on a non-N/A verdict', () => {
    const r = validatePerGateReport(base({ na_reason: 'should not be here' }))
    expect(r.malformed).toBe(true)
  })

  it('rejects a missing required field', () => {
    const rest = base()
    delete rest.findings
    expect(validatePerGateReport(rest).malformed).toBe(true)
  })

  it('rejects an invalid gate_name', () => {
    expect(validatePerGateReport(base({ gate_name: 'bogus' })).malformed).toBe(true)
  })

  it('rejects a missing evidence_ref for verifier', () => {
    const r = validatePerGateReport({
      gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [],
    })
    expect(r.malformed).toBe(true)
  })

  it('rejects an explicit null evidence_ref for verifier (spec §3 requires it, not just non-undefined)', () => {
    const r = validatePerGateReport({
      gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [], evidence_ref: null,
    })
    expect(r.malformed).toBe(true)
  })

  it('exports the enums used as the shared source of truth', () => {
    expect(GATE_NAMES).toContain('verifier')
    expect(VERDICTS).toContain('N/A')
  })
})
