import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGateReportCli, CliUsageError } from './gateReportCli.js'
import { loadWorkflowRun, checkWorkflowProvenance } from './workflowDispatchProvenance.js'

// Real Workflow-tool run (T346), trimmed to the fields the binder reads: journal.jsonl result
// lines and agent-<id>.meta.json agentType. security / code-reviewer / red-hat reviewers.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflow-run-t346')

let scratch
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'gate-report-wf-')) })
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

// Hand-written verifier PASS must cite real green gate results stamped for the commit under review.
const VALID_SHA = '1234567890abcdef1234567890abcdef12345678'
const EVIDENCE = join(mkdtempSync(join(tmpdir(), 'gate-report-wf-evidence-')), 'gate-results.txt')
writeFileSync(EVIDENCE, [`# gate run against ${VALID_SHA} dirty=0`, 'STEP lint | rc=0 | ok', 'STEP tests-1 | rc=0 | Tests 9 passed (9)', 'DONE'].join('\n'))
const verifier = { gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [], evidence_ref: EVIDENCE }
const opinion = (gate_name, summary, extra = {}) => ({
  gate_name, verdict: 'PASS', score: 4, na_reason: null, evidence_ref: null,
  findings: [{ severity: 'LOW', summary }], ...extra,
})
const SEC = 'Two overlapping approveDevice calls for the same device can leave the row authorized'
const RH = 'Concurrent double-approve: the second call snapshots'
const CR = "audit outcome is 'deny' with reason 'joiner_disconnected'"

// The commit under review is fake; its committer time is injected (epoch 0 = older than any run).
const run = (reports, workflowDir = FIXTURE, taskId = 'T346', commitTimeOf = () => 0) => {
  const inputPath = join(scratch, 'in.json')
  writeFileSync(inputPath, JSON.stringify({
    taskId, round: 1, commit: VALID_SHA, expectedOpinionGates: ['security', 'red_hat', 'code_reviewer'],
    reports: [verifier, ...reports], workflowDir,
  }))
  return runGateReportCli(inputPath, { runsDir: scratch, commitTimeOf })
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

  it('refuses an empty-findings report against a recorded run that has findings', () => {
    const forged = [opinion('security', SEC, { findings: [] }), ...good().slice(1)]
    expect(() => run(forged)).toThrow(/security/)
  })

  it('refuses a one-character finding summary that is merely a substring', () => {
    const forged = [opinion('security', 'e'), ...good().slice(1)]
    expect(() => run(forged)).toThrow(/security/)
  })

  it('refuses a run that is not tied to the report task', () => {
    expect(() => run(good(), FIXTURE, 'T999')).toThrow(/T999/)
  })

  it('binds by the run directory name when the journal has no label', () => {
    const dir = join(scratch, 'wf_t999-run')
    cpSync(FIXTURE, dir, { recursive: true })
    expect(run(good(), dir, 'T999').decision_eligibility).toBe('PASS_ELIGIBLE')
  })

  it('does not let T34 match a T346 run', () => {
    const { agents, labels, dirName } = loadWorkflowRun(FIXTURE)
    const r = checkWorkflowProvenance({ agents, labels, dirName, taskId: 'T34', report: opinion('security', SEC) })
    expect(r.bound).toBe(false)
  })
})

// Real Workflow run (T347), sanitised. Its run directory and journal labels name no task; the
// task appears only in each reviewer's recorded prompt (agent-<id>.jsonl). Results are
// {verdict, findings:[string]} rather than {blocking, nonblocking}.
const FIXTURE_347 = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflow-run-t347')
const SEC347 = 'No confirmed vulnerabilities in the diff of origin/main...65fef8cd'
const RH347 = 'VERIFIED, planted-defect evidence is real.'
const CR347 = 'Verdict: pass. Fix commit 65fef8cd matches owner-approved items (a)-(c)'
const good347 = () => [opinion('security', SEC347), opinion('red_hat', RH347), opinion('code_reviewer', CR347)]

describe('workflowDir provenance, task named only in the dispatched prompt', () => {
  it('binds reports to reviewers whose recorded prompt names the task', () => {
    expect(run(good347(), FIXTURE_347, 'T347').decision_eligibility).toBe('PASS_ELIGIBLE')
  })

  it('refuses a task that is only a secondary mention (not the first task id) in the reviewer prompt', () => {
    const sec = opinion('security', SEC347)
    for (const id of ['T340', 'T331']) {
      expect(checkWorkflowProvenance({ ...loadWorkflowRun(FIXTURE_347), taskId: id, report: sec, commitTime: 0 }).bound).toBe(false)
    }
    expect(checkWorkflowProvenance({ ...loadWorkflowRun(FIXTURE_347), taskId: 'T347', report: sec, commitTime: 0 }).bound).toBe(true)
  })

  it('refuses a task that is only a secondary mention (not the first task id) in the reviewer prompt', () => {
    const sec = opinion('security', SEC347)
    for (const id of ['T340', 'T331']) {
      expect(checkWorkflowProvenance({ ...loadWorkflowRun(FIXTURE_347), taskId: id, report: sec, commitTime: 0 }).bound).toBe(false)
    }
    expect(checkWorkflowProvenance({ ...loadWorkflowRun(FIXTURE_347), taskId: 'T347', report: sec, commitTime: 0 }).bound).toBe(true)
  })

  it('refuses a run whose reviewer prompts never mention the task', () => {
    expect(() => run(good347(), FIXTURE_347, 'T999')).toThrow(/T999/)
  })

  it('does not let T34 match a prompt naming T347', () => {
    expect(() => run(good347(), FIXTURE_347, 'T34')).toThrow(/T34/)
  })

  it('refuses when the prompt that names the task belongs to a different agent', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE_347, dir, { recursive: true })
    writeFileSync(join(dir, 'agent-a77bebf8889850805.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'Security review of something else' } }) + '\n')
    expect(() => run(good347(), dir, 'T347')).toThrow(/security/)
  })

  it('refuses a flipped verdict against a recorded pass', () => {
    const forged = [{ gate_name: 'security', verdict: 'FAIL', score: 1, na_reason: null, evidence_ref: null,
      findings: [{ severity: 'BLOCKING', summary: SEC347 }] }, ...good347().slice(1)]
    expect(() => run(forged, FIXTURE_347, 'T347')).toThrow(/security/)
  })

  it('refuses an invented finding', () => {
    const forged = [opinion('security', 'SQL injection in the pairing handler'), ...good347().slice(1)]
    expect(() => run(forged, FIXTURE_347, 'T347')).toThrow(/security/)
  })
})

// Red Hat follow-ups on #753: (a) commit recency + run hash, (b) latest dispatch, (c) exact label.
describe('workflowDir binding is fresh, latest and exact', () => {
  it('(a) refuses a run whose reviewer dispatch predates the commit under review', () => {
    expect(() => run(good(), FIXTURE, 'T346', () => Date.now() + 86_400_000)).toThrow(/older than|predates/)
  })

  it('(a) refuses when the commit time cannot be resolved', () => {
    expect(() => run(good(), FIXTURE, 'T346', () => null)).toThrow(/commit time/)
  })

  it('(a) records the run directory and a content hash that changes with the run', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE, dir, { recursive: true })
    const first = run(good(), dir).workflow_run_ref
    expect(first.dir).toBe(dir)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(dir, 'journal.jsonl'), readFileSync(join(dir, 'journal.jsonl'), 'utf8') + '{"type":"note"}\n')
    expect(run(good(), dir).workflow_run_ref.hash).not.toBe(first.hash)
  })

  it('(b) refuses a report that binds only an earlier dispatch of the same agentType', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE, dir, { recursive: true })
    writeFileSync(join(dir, 'agent-later.meta.json'), JSON.stringify({ agentType: 'security' }))
    writeFileSync(join(dir, 'journal.jsonl'), readFileSync(join(dir, 'journal.jsonl'), 'utf8') +
      JSON.stringify({ type: 'result', agentId: 'later', result: { verdict: 'fail', blocking: ['Re-review: approveDevice still races under load'], nonblocking: [] } }) + '\n')
    expect(() => run(good(), dir)).toThrow(/security.*latest/s)
  })

  it('(c) a stray label that mentions the task among others does not tie the run', () => {
    const dir = join(scratch, 'run')
    cpSync(FIXTURE, dir, { recursive: true })
    const j = readFileSync(join(dir, 'journal.jsonl'), 'utf8').replace('"governor:t346"', '"governor:t999 see t346"')
    writeFileSync(join(dir, 'journal.jsonl'), j)
    expect(() => run(good(), dir, 'T346')).toThrow(/T346/)
  })

  it('(c) a directory name naming two tasks does not tie the run', () => {
    const dir = join(scratch, 'wf_t999-vs-t346')
    cpSync(FIXTURE, dir, { recursive: true })
    writeFileSync(join(dir, 'journal.jsonl'), readFileSync(join(dir, 'journal.jsonl'), 'utf8').replace('"governor:t346"', '"governor"'))
    expect(() => run(good(), dir, 'T999')).toThrow(/T999/)
  })
})
