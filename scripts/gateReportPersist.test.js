import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGateReport } from './gateReportPersist.js'

let scratch

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gate-report-persist-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const sample = (overrides = {}) => ({
  task_id: 'T100', round: 1, verifier_pass: true,
  gate_scores: { security: 4, red_hat: 4, tester: 4, code_reviewer: 4 },
  overall_score: 4, lowest_dimension: 4, blocking_findings: [],
  incomplete: false, gap: [], cross_gate_flags: [],
  decision_eligibility: 'PASS_ELIGIBLE', malformed: [], self_declared_na: [],
  ...overrides,
})

describe('writeGateReport', () => {
  it('writes the file at <runsDir>/gate-reports/<task_id>-r<round>.json', () => {
    const path = writeGateReport(sample(), { runsDir: scratch })
    expect(path).toBe(join(scratch, 'gate-reports', 'T100-r1.json'))
    expect(existsSync(path)).toBe(true)
  })

  it('the written content deep-equals the input object', () => {
    const report = sample()
    const path = writeGateReport(report, { runsDir: scratch })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report)
  })

  it('creates the gate-reports subdirectory if absent', () => {
    const path = writeGateReport(sample(), { runsDir: scratch })
    expect(existsSync(join(scratch, 'gate-reports'))).toBe(true)
    expect(path).toContain('gate-reports')
  })

  it('overwrites idempotently on re-run of the same (task_id, round)', () => {
    writeGateReport(sample({ overall_score: 4 }), { runsDir: scratch })
    const path = writeGateReport(sample({ overall_score: 4.5 }), { runsDir: scratch })
    expect(JSON.parse(readFileSync(path, 'utf8')).overall_score).toBe(4.5)
  })

  it('never touches a file outside the injected runsDir', () => {
    const path = writeGateReport(sample(), { runsDir: scratch })
    expect(path.startsWith(scratch)).toBe(true)
  })

  it('distinguishes different rounds of the same task', () => {
    const p1 = writeGateReport(sample({ task_id: 'T101', round: 1 }), { runsDir: scratch })
    const p2 = writeGateReport(sample({ task_id: 'T101', round: 2 }), { runsDir: scratch })
    expect(p1).not.toBe(p2)
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
  })
})
