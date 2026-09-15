import { describe, it, expect } from 'vitest'
import { parseGateResults, buildVerifierReport, parseGateStamp } from './verifierReport.js'
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

// ─── T169 ────────────────────────────────────────────────────────────────────
// evidence_ref existing and parsing green proves a green run happened at SOME point. It does not
// prove it happened for THIS diff. Nothing bound the results file to a commit, so a stale but
// legitimately green file from an unrelated commit validated cleanly through the reducer.

const stamped = (sha, dirty = 0) =>
  `# gate run against ${sha} dirty=${dirty}\nSTEP lint | rc=0 | ok\nSTEP tests-1 | rc=0 | Tests 9 passed (9)\nDONE`

describe('parseGateStamp', () => {
  it('reads the sha and dirty count from the stamp line', () => {
    expect(parseGateStamp(stamped('1111111111111111111111111111111111111111', 3)))
      .toEqual({ sha: '1111111111111111111111111111111111111111', dirty: 3, chunks: null })
  })
  it('returns null when there is no stamp', () => {
    expect(parseGateStamp('STEP lint | rc=0 | ok\nDONE')).toBeNull()
  })

  it('reads the declared chunk count when present', () => {
    const t = '# gate run against 1111111111111111111111111111111111111111 dirty=0 chunks=9'
    expect(parseGateStamp(t).chunks).toBe(9)
  })
})

describe('binding evidence to a commit (T169)', () => {
  const ref = 'docs/work/runs/evidence/g.txt'

  it('PASSes when the stamp matches the commit the report is for', () => {
    const r = buildVerifierReport({ text: stamped('1111111111111111111111111111111111111111'), evidenceRef: ref, expectedSha: '1111111111111111111111111111111111111111' })
    expect(r.verdict).toBe('PASS')
  })

  // The exact scenario in the ticket: a stale green run from an unrelated commit.
  it('REJECTS a green results file stamped with a different commit', () => {
    const r = buildVerifierReport({ text: stamped('2222222222222222222222222222222222222222'), evidenceRef: ref, expectedSha: '1111111111111111111111111111111111111111' })
    expect(r.verdict).toBe('UNVERIFIED')
    expect(r.findings.some((f) => /different commit|does not match/i.test(f.summary))).toBe(true)
    // Contract: gateReportSchema rejects a BLOCKING finding unless the verdict is FAIL. An
    // UNVERIFIED report carrying one is MALFORMED, which would reach BLOCK by accident and
    // throw the reason away. The severity has to match the verdict.
    expect(validatePerGateReport(r).malformed).toBe(false)
    expect(r.findings.every((f) => f.severity !== 'BLOCKING')).toBe(true)
  })

  it('REJECTS an unstamped file when a commit was specified — unbound is not verified', () => {
    const r = buildVerifierReport({ text: 'STEP lint | rc=0 | ok\nDONE', evidenceRef: ref, expectedSha: '1111111111111111111111111111111111111111' })
    expect(r.verdict).toBe('UNVERIFIED')
  })

  it('REJECTS a run made against a dirty tree — that tree exists nowhere', () => {
    const r = buildVerifierReport({ text: stamped('1111111111111111111111111111111111111111', 2), evidenceRef: ref, expectedSha: '1111111111111111111111111111111111111111' })
    expect(r.verdict).toBe('UNVERIFIED')
    expect(r.findings.some((f) => /dirty/i.test(f.summary))).toBe(true)
    expect(validatePerGateReport(r).malformed).toBe(false)
  })

  it('accepts a short sha against the full stamp and vice versa', () => {
    const r = buildVerifierReport({ text: stamped('1111111111111111111111111111111111111111'), evidenceRef: ref, expectedSha: '1111111' })
    expect(r.verdict).toBe('PASS')
  })

  // A genuine failure must never be softened into "we cannot tell".
  it('a FAILED run stays FAIL even when the binding is also wrong', () => {
    const bad = `# gate run against '2222222222222222222222222222222222222222' dirty=0\nSTEP tests-1 | rc=1 | boom\nDONE`
    expect(buildVerifierReport({ text: bad, evidenceRef: ref, expectedSha: '1111111111111111111111111111111111111111' }).verdict).toBe('FAIL')
  })

  it('without expectedSha the old behaviour holds, but a dirty stamp still blocks', () => {
    expect(buildVerifierReport({ text: stamped('1111111111111111111111111111111111111111'), evidenceRef: ref }).verdict).toBe('PASS')
    expect(buildVerifierReport({ text: stamped('1111111111111111111111111111111111111111', 5), evidenceRef: ref }).verdict).toBe('UNVERIFIED')
  })
})

// ─── Red Hat, 2026-09-15: a gate that ran ZERO unit tests reported PASS ───────
// lint + integration + security + governance alone satisfy "steps.length > 0 and a terminal
// DONE". gate.sh's own header says to "check the chunk totals sum to a whole-suite count" — a
// rule the file stated and never enforced. The stamp now declares how many test chunks the run
// intended, and the report checks that many actually appear.
describe('test-chunk completeness (the stamp declares what the run intended)', () => {
  const head = (chunks) =>
    `# gate run against 1111111111111111111111111111111111111111 dirty=0 chunks=${chunks}`
  const tests = (n) =>
    Array.from({ length: n }, (_, i) => `STEP tests-${i + 1} | rc=0 | Tests 9 passed (9)`).join('\n')
  const body = 'STEP lint | rc=0 | ok\nSTEP integration | rc=0 | 20/20\nSTEP security | rc=0 | 0 findings'

  it('PASSes when every declared chunk ran', () => {
    const t = [head(3), body, tests(3), 'DONE'].join('\n')
    expect(buildVerifierReport({ text: t, evidenceRef: 'e' }).verdict).toBe('PASS')
  })

  it('a run that executed NO test chunks is UNVERIFIED, not PASS', () => {
    const t = [head(9), body, 'DONE'].join('\n')
    const r = buildVerifierReport({ text: t, evidenceRef: 'e' })
    expect(r.verdict).toBe('UNVERIFIED')
    expect(r.findings.some((f) => /chunk/i.test(f.summary))).toBe(true)
    expect(validatePerGateReport(r).malformed).toBe(false)
  })

  it('a run missing SOME declared chunks is UNVERIFIED', () => {
    const t = [head(9), body, tests(4), 'DONE'].join('\n')
    expect(buildVerifierReport({ text: t, evidenceRef: 'e' }).verdict).toBe('UNVERIFIED')
  })

  it('more chunks than declared is also UNVERIFIED — the file does not match its own header', () => {
    const t = [head(2), body, tests(5), 'DONE'].join('\n')
    expect(buildVerifierReport({ text: t, evidenceRef: 'e' }).verdict).toBe('UNVERIFIED')
  })

  it('a stamp without chunks= keeps the old behaviour, so older evidence still reads', () => {
    const t = ['# gate run against 1111111111111111111111111111111111111111 dirty=0', body, 'DONE'].join('\n')
    expect(buildVerifierReport({ text: t, evidenceRef: 'e' }).verdict).toBe('PASS')
  })

  it('a failing step still FAILs rather than being masked by a chunk mismatch', () => {
    const t = [head(9), 'STEP tests-1 | rc=1 | boom', 'DONE'].join('\n')
    expect(buildVerifierReport({ text: t, evidenceRef: 'e' }).verdict).toBe('FAIL')
  })
})
