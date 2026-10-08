import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGateReportCli, CliUsageError } from './gateReportCli.js'

// Real Workflow-tool run (T346), trimmed to the fields the binder reads: journal.jsonl result
// lines and agent-<id>.meta.json agentType. security / code-reviewer / red-hat reviewers.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflow-run-t346')

let scratch
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'gate-report-wf-')) })
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

const verifier = { gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [], evidence_ref: 'x' }
const opinion = (gate_name, summary, extra = {}) => ({
  gate_name, verdict: 'PASS', score: 4, na_reason: null, evidence_ref: null,
  findings: [{ severity: 'LOW', summary }], ...extra,
})
const SEC = 'Two overlapping approveDevice calls for the same device can leave the row authorized'
const RH = 'Concurrent double-approve: the second call snapshots'
const CR = "audit outcome is 'deny' with reason 'joiner_disconnected'"

const run = (reports, workflowDir = FIXTURE) => {
  const inputPath = join(scratch, 'in.json')
  writeFileSync(inputPath, JSON.stringify({
    taskId: 'T346', round: 1, expectedOpinionGates: ['security', 'red_hat', 'code_reviewer'],
    reports: [verifier, ...reports], workflowDir,
  }))
  return runGateReportCli(inputPath, { runsDir: scratch })
}
const good = () => [opinion('security', SEC), opinion('red_hat', RH), opinion('code_reviewer', CR)]

describe('workflowDir provenance', () => {
  it('grades reports bound to completed reviewer dispatches of a Workflow run', () => {
    const out = run(good())
    expect(out.decision_eligibility).toBe('PASS_ELIGIBLE')
  })

  it('refuses a report whose content differs from the recorded result', () => {
    const forged = [opinion('security', 'SQL injection in the pairing handler'), ...good().slice(1)]
    expect(() => run(forged)).toThrow(/provenance.*could not be established/s)
  })

  it('refuses a verdict the recorded result does not support', () => {
    const forged = [{ gate_name: 'security', verdict: 'FAIL', score: 1, na_reason: null, evidence_ref: null,
      findings: [{ severity: 'BLOCKING', summary: SEC }] }, ...good().slice(1)]
    expect(() => run(forged)).toThrow(CliUsageError)
  })

  it('refuses a gate with no dispatch in the run', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE, dir, { recursive: true })
    rmSync(join(dir, 'agent-a31907ab00378d4e5.meta.json'))
    expect(() => run(good(), dir)).toThrow(/security/)
  })

  it('refuses when the agentType does not match the gate', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE, dir, { recursive: true })
    writeFileSync(join(dir, 'agent-a31907ab00378d4e5.meta.json'), JSON.stringify({ agentType: 'maker' }))
    expect(() => run(good(), dir)).toThrow(/security/)
  })

  it('refuses a dispatch with no recorded result (not completed)', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE, dir, { recursive: true })
    const kept = readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l && !l.includes('a31907ab00378d4e5'))
    writeFileSync(join(dir, 'journal.jsonl'), kept.join('\n') + '\n')
    expect(() => run(good(), dir)).toThrow(/security/)
  })

  it('refuses an unreadable workflowDir as a usage error', () => {
    expect(() => run(good(), join(scratch, 'nope'))).toThrow(CliUsageError)
  })
})
