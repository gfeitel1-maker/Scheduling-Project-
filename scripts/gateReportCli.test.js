import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGateReportCli, CliUsageError } from './gateReportCli.js'

let scratch

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gate-report-cli-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const writeInput = (name, data) => {
  const path = join(scratch, name)
  writeFileSync(path, JSON.stringify(data))
  return path
}

const verifier = { gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [], evidence_ref: 'x' }
const opinion = (gate_name, score) => ({ gate_name, verdict: 'PASS', score, na_reason: null, findings: [], evidence_ref: null })

const validInput = {
  taskId: 'T200', round: 1, expectedOpinionGates: ['security', 'red_hat', 'tester', 'code_reviewer'],
  reports: [verifier, opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)],
}

describe('runGateReportCli', () => {
  it('1. valid input produces the exact GateReport plus gate_report_ref, and persists it', () => {
    const inputPath = writeInput('input.json', validInput)
    const result = runGateReportCli(inputPath, { runsDir: scratch })

    expect(result.task_id).toBe('T200')
    expect(result.round).toBe(1)
    expect(result.decision_eligibility).toBe('PASS_ELIGIBLE')
    expect(result.gate_report_ref).toBe(join(scratch, 'gate-reports', 'T200-r1.json'))
    expect(existsSync(result.gate_report_ref)).toBe(true)

    const persisted = JSON.parse(readFileSync(result.gate_report_ref, 'utf8'))
    const withoutRef = { ...result }
    delete withoutRef.gate_report_ref
    expect(persisted).toEqual(withoutRef)
  })

  it('2. re-running the same (task_id, round) overwrites rather than erroring or duplicating', () => {
    const inputPath = writeInput('input.json', validInput)
    const first = runGateReportCli(inputPath, { runsDir: scratch })

    const changedInput = {
      ...validInput,
      reports: [verifier, opinion('security', 5), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)],
    }
    const inputPath2 = writeInput('input2.json', changedInput)
    const second = runGateReportCli(inputPath2, { runsDir: scratch })

    expect(second.gate_report_ref).toBe(first.gate_report_ref)
    const persisted = JSON.parse(readFileSync(second.gate_report_ref, 'utf8'))
    expect(persisted.overall_score).toBe(4.25)
  })

  it('3a. missing taskId exits with an error naming the missing field', () => {
    const rest = { ...validInput }
    delete rest.taskId
    const inputPath = writeInput('bad.json', rest)
    expect(() => runGateReportCli(inputPath, { runsDir: scratch })).toThrow(CliUsageError)
    try {
      runGateReportCli(inputPath, { runsDir: scratch })
    } catch (e) {
      expect(e.message).toMatch(/taskId/)
    }
  })

  it('3b. reports not an array exits with a clear message', () => {
    const inputPath = writeInput('bad.json', { ...validInput, reports: 'not-an-array' })
    expect(() => runGateReportCli(inputPath, { runsDir: scratch })).toThrow(/reports/)
  })

  it('3c. unparseable JSON exits with a clear message', () => {
    const path = join(scratch, 'broken.json')
    writeFileSync(path, '{ not json')
    expect(() => runGateReportCli(path, { runsDir: scratch })).toThrow(CliUsageError)
  })

  it('3d. missing input file exits with a clear message', () => {
    expect(() => runGateReportCli(join(scratch, 'nope.json'), { runsDir: scratch })).toThrow(CliUsageError)
  })

  it('4. two distinct (task_id, round) inputs never collide', () => {
    const inputA = writeInput('a.json', { ...validInput, taskId: 'TA', round: 1 })
    const inputB = writeInput('b.json', { ...validInput, taskId: 'TB', round: 1 })
    const resultA = runGateReportCli(inputA, { runsDir: scratch })
    const resultB = runGateReportCli(inputB, { runsDir: scratch })

    expect(resultA.gate_report_ref).not.toBe(resultB.gate_report_ref)
    expect(existsSync(resultA.gate_report_ref)).toBe(true)
    expect(existsSync(resultB.gate_report_ref)).toBe(true)
  })
})

// ─── T167 part 2 ─────────────────────────────────────────────────────────────
// Grader is dispatched 3 times against Verifier's 21. The step it skips is clerical — transcribing
// reports into typed PerGateReports — and it is the step that produces the durable artifact, which
// is why 283 commits landed in three weeks with no run record. Verifier's report is a function of
// exit codes, so the CLI can build it from the gate's own results file and Grader never types it.
describe('deriving the verifier report from a gate results file', () => {
  const GREEN = [
    '# gate run against 1111111111111111111111111111111111111111 dirty=0',
    'STEP lint | rc=0 | ok',
    'STEP tests-1 | rc=0 | Tests 9 passed (9)',
    'DONE',
  ].join('\n')

  function withFiles(resultsText, input, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'gaterep-'))
    const results = join(dir, 'gate.txt')
    writeFileSync(results, resultsText)
    const inputPath = join(dir, 'in.json')
    writeFileSync(inputPath, JSON.stringify({ ...input, gateResults: results }))
    try { return fn(inputPath, join(dir, 'runs')) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  const base = { taskId: 'T', round: 1, expectedOpinionGates: ['code_reviewer'],
    reports: [{ gate_name: 'code_reviewer', verdict: 'PASS', score: 5, findings: [] }] }

  it('synthesises the verifier report so the caller never writes one', () => {
    const out = withFiles(GREEN, { ...base, commit: '1111111' },
      (p, runs) => runGateReportCli(p, { runsDir: runs }))
    expect(out.verifier_pass).toBe(true)
    expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
  })

  // T169 carried through: a results file from a different commit must not certify this one.
  it('refuses a results file from a different commit', () => {
    const out = withFiles(GREEN, { ...base, commit: '2222222' },
      (p, runs) => runGateReportCli(p, { runsDir: runs }))
    expect(out.verifier_pass).toBe(false)
    expect(out.decision_eligibility).toBe('BLOCK')
  })

  // Ambiguity is a usage error, not a silent precedence rule.
  it('rejects supplying BOTH a gate results file and a hand-written verifier report', () => {
    expect(() => withFiles(GREEN,
      { ...base, commit: '1111111', reports: [...base.reports, { gate_name: 'verifier', verdict: 'PASS', score: null, findings: [], evidence_ref: 'x' }] },
      (p, runs) => runGateReportCli(p, { runsDir: runs }))).toThrow(CliUsageError)
  })

  it('a missing gate results file is a usage error, not a silent skip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaterep-'))
    const inputPath = join(dir, 'in.json')
    writeFileSync(inputPath, JSON.stringify({ ...base, gateResults: join(dir, 'nope.txt') }))
    expect(() => runGateReportCli(inputPath, { runsDir: join(dir, 'runs') })).toThrow(CliUsageError)
    rmSync(dir, { recursive: true, force: true })
  })
})
