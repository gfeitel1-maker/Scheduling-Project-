import { describe, it, expect } from 'vitest'
import { parseGateResults, buildVerifierReport } from './verifierReport.js'
import { validatePerGateReport } from './gateReportSchema.js'

const GREEN = `STEP lint | rc=0 | 26 problems (0 errors, 26 warnings)
STEP tests-1 | rc=0 | Tests 612 passed (612)
STEP integration | rc=0 | 20/20 passed
STEP security | rc=0 | 0 findings
STEP governance | rc=0 | no findings
DONE`

const RED = `STEP lint | rc=0 | 26 problems (0 errors, 26 warnings)
STEP tests-3 | rc=1 | Tests 1 failed | 44 passed (45)
 × syncProtocol > converges reliably
STEP integration | rc=0 | 20/20 passed
DONE`

describe('parseGateResults', () => {
  it('reads one entry per STEP line, preserving rc and summary', () => {
    const r = parseGateResults(GREEN)
    expect(r.map((s) => s.name)).toEqual(['lint', 'tests-1', 'integration', 'security', 'governance'])
    expect(r.every((s) => s.rc === 0)).toBe(true)
    expect(r[1].summary).toContain('612 passed')
  })

  it('ignores DONE and non-STEP noise', () => {
    expect(parseGateResults(RED).map((s) => s.name)).toEqual(['lint', 'tests-3', 'integration'])
  })

  it('returns an empty list for empty input rather than throwing', () => {
    expect(parseGateResults('')).toEqual([])
  })
})

describe('buildVerifierReport', () => {
  it('PASSes when every step exited 0, and carries no score', () => {
    const rep = buildVerifierReport({ text: GREEN, evidenceRef: 'docs/work/runs/evidence/g.txt' })
    expect(rep.gate_name).toBe('verifier')
    expect(rep.verdict).toBe('PASS')
    expect(rep.score).toBeNull()
    expect(rep.findings).toEqual([])
    expect(validatePerGateReport(rep).malformed).toBe(false)
  })

  it('FAILs with one BLOCKING finding per failed step', () => {
    const rep = buildVerifierReport({ text: RED, evidenceRef: 'docs/work/runs/evidence/g.txt' })
    expect(rep.verdict).toBe('FAIL')
    expect(rep.findings).toHaveLength(1)
    expect(rep.findings[0].severity).toBe('BLOCKING')
    expect(rep.findings[0].ref).toBe('tests-3')
    expect(validatePerGateReport(rep).malformed).toBe(false)
  })

  // The whole point: a gate that never ran must not read as a pass. This is the same
  // "started is not succeeded" defect the harness work exists to close, one level up.
  it('is UNVERIFIED when no step ran at all — never a silent PASS', () => {
    const rep = buildVerifierReport({ text: '', evidenceRef: 'docs/work/runs/evidence/g.txt' })
    expect(rep.verdict).toBe('UNVERIFIED')
    expect(validatePerGateReport(rep).malformed).toBe(false)
  })

  it('is UNVERIFIED when the run was truncated (no DONE marker)', () => {
    const partial = 'STEP lint | rc=0 | ok\nSTEP tests-1 | rc=0 | Tests 10 passed (10)'
    const rep = buildVerifierReport({ text: partial, evidenceRef: 'e.txt' })
    expect(rep.verdict).toBe('UNVERIFIED')
  })

  it('a truncated run that already has a failure still FAILs, not UNVERIFIED', () => {
    const rep = buildVerifierReport({ text: 'STEP tests-1 | rc=1 | boom', evidenceRef: 'e.txt' })
    expect(rep.verdict).toBe('FAIL')
  })

  // Red Hat, round 2: `/^DONE$/m` matched a standalone DONE ANYWHERE, so a run that died after
  // step 1 — whose captured output happened to contain a bare "DONE" line, which build tools
  // print — read as PASS while 4 of 5 gates never ran. "Started" read as "succeeded", one level
  // up, in the evidence layer, and validatePerGateReport would have accepted it.
  it('a DONE that is not the terminal line does NOT mean complete', () => {
    const stray = 'STEP lint | rc=0 | ok\nDONE\nSTEP tests-1 | rc=0 | Tests 10 passed (10)'
    expect(buildVerifierReport({ text: stray, evidenceRef: 'e.txt' }).verdict).toBe('UNVERIFIED')
  })

  it('a bare DONE inside captured step output cannot manufacture a PASS', () => {
    const noisy = 'STEP tests-1 | rc=0 | Tests 10 passed (10)\nbuild stage: DONE\n'
    expect(buildVerifierReport({ text: noisy, evidenceRef: 'e.txt' }).verdict).toBe('UNVERIFIED')
  })

  it('tolerates trailing blank lines and CRLF around the terminal DONE', () => {
    const crlf = 'STEP lint | rc=0 | ok\r\nSTEP tests-1 | rc=0 | Tests 10 passed (10)\r\nDONE\r\n\r\n'
    expect(buildVerifierReport({ text: crlf, evidenceRef: 'e.txt' }).verdict).toBe('PASS')
  })

  it('requires an evidence_ref — the reducer rejects a verifier report without one', () => {
    const rep = buildVerifierReport({ text: GREEN, evidenceRef: null })
    expect(validatePerGateReport(rep).malformed).toBe(true)
  })
})
