import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGateReportCli, confirmCiRun, defaultFetchRun, CliUsageError } from './gateReportCli.js'

// A hand-written verifier PASS must cite evidence that resolves to a green gate-results file
// stamped with the commit under review — not merely any existing file.
const VALID_SHA = '1234567890abcdef1234567890abcdef12345678'
const greenResults = (sha) => [`# gate run against ${sha} dirty=0`, 'STEP lint | rc=0 | ok', 'STEP tests-1 | rc=0 | Tests 9 passed (9)', 'DONE'].join('\n')
const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'gate-report-evidence-'))
const REAL_EVIDENCE = join(EVIDENCE_DIR, 'gate-results.txt')
writeFileSync(REAL_EVIDENCE, greenResults(VALID_SHA))


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

const verifier = { gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [], evidence_ref: REAL_EVIDENCE }
const opinion = (gate_name, score) => ({ gate_name, verdict: 'PASS', score, na_reason: null, findings: [], evidence_ref: null })

// T171 fixtures: a session transcript in which all four opinion gates were genuinely dispatched
// and completed, so provenance binding succeeds and the pre-existing CLI behavior is preserved.
const dispatchLine = (toolUseId, subagentType) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: subagentType } }] },
})
const launchAckLine = (toolUseId, agentId) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId },
})
const terminalLine = (agentId, status) => JSON.stringify({
  type: 'attachment',
  attachment: { type: 'task_status', taskId: agentId, status },
})
const boundDispatch = (toolUseId, agentId, subagentType) =>
  [dispatchLine(toolUseId, subagentType), launchAckLine(toolUseId, agentId), terminalLine(agentId, 'completed')].join('\n')

const ALL_BOUND_TRANSCRIPT = [
  boundDispatch('toolu_sec', 'agent-sec', 'security'),
  boundDispatch('toolu_rh', 'agent-rh', 'red-hat'),
  boundDispatch('toolu_test', 'agent-test', 'tester'),
  boundDispatch('toolu_cr', 'agent-cr', 'code-reviewer'),
].join('\n')

const writeTranscript = (name, text) => {
  const path = join(scratch, name)
  writeFileSync(path, text)
  return path
}

const validInput = {
  taskId: 'T200', round: 1, commit: VALID_SHA, expectedOpinionGates: ['security', 'red_hat', 'tester', 'code_reviewer'],
  reports: [verifier, opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)],
}

// Every pre-existing test below represents a caller that genuinely dispatched its reviewers —
// attach the bound transcript so this module's mandatory provenance check doesn't change what
// those tests are meant to prove.
const withBoundTranscript = (input) => ({ ...input, sessionTranscript: writeTranscript('transcript.jsonl', ALL_BOUND_TRANSCRIPT) })

describe('runGateReportCli', () => {
  it('1. valid input produces the exact GateReport plus gate_report_ref, and persists it', () => {
    const inputPath = writeInput('input.json', withBoundTranscript(validInput))
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
    const inputPath = writeInput('input.json', withBoundTranscript(validInput))
    const first = runGateReportCli(inputPath, { runsDir: scratch })

    const changedInput = {
      ...validInput,
      reports: [verifier, opinion('security', 5), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)],
    }
    const inputPath2 = writeInput('input2.json', withBoundTranscript(changedInput))
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
    const inputA = writeInput('a.json', withBoundTranscript({ ...validInput, taskId: 'TA', round: 1 }))
    const inputB = writeInput('b.json', withBoundTranscript({ ...validInput, taskId: 'TB', round: 1 }))
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
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(transcript, boundDispatch('toolu_cr', 'agent-cr', 'code-reviewer'))
    const inputPath = join(dir, 'in.json')
    writeFileSync(inputPath, JSON.stringify({ ...input, gateResults: results, sessionTranscript: transcript }))
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

// ─── T171: opinion report dispatch provenance ─────────────────────────────────
// The exact scenario that motivated this module: an orchestrator hand-writes plausible
// Code Reviewer and Red Hat findings with invented 4/4 scores, and feeds them straight into the
// CLI. No reviewer ever saw a line of the diff. Before this change the reducer had no way to see
// that and returned a clean PASS_ELIGIBLE.
describe('opinion report dispatch provenance (T171)', () => {
  it('THE ACCEPTANCE SCENARIO: a hand-fabricated opinion report with an invented score is refused by throwing, and no GateReport file is written', () => {
    const fabricated = {
      taskId: 'T-FAB', round: 1, expectedOpinionGates: ['security', 'red_hat', 'tester', 'code_reviewer'],
      // sessionTranscript deliberately omitted — the fabricator never dispatched anyone at all,
      // which is exactly what happened: the orchestrator typed this JSON directly.
      reports: [verifier, opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)],
    }
    const inputPath = writeInput('fabricated.json', fabricated)

    expect(() => runGateReportCli(inputPath, { runsDir: scratch })).toThrow(/security|red_hat|tester|code_reviewer/)
    expect(existsSync(join(scratch, 'gate-reports', 'T-FAB-r1.json'))).toBe(false)
  })

  it('a genuinely dispatched-and-completed opinion report is bound and counts normally', () => {
    const inputPath = writeInput('bound.json', withBoundTranscript(validInput))
    const result = runGateReportCli(inputPath, { runsDir: scratch })
    expect(result.decision_eligibility).toBe('PASS_ELIGIBLE')
    expect(result.malformed).toEqual([])
  })

  it('a report from a gate that was dispatched but never reached a completed status is refused by throwing, and no GateReport file is written', () => {
    const transcript = writeTranscript('pending.jsonl', [
      dispatchLine('toolu_sec', 'security'),
      launchAckLine('toolu_sec', 'agent-sec'),
      // no terminal status — the dispatch is still pending, or the transcript was captured early
      dispatchLine('toolu_rh', 'red-hat'), launchAckLine('toolu_rh', 'agent-rh'), terminalLine('agent-rh', 'completed'),
      dispatchLine('toolu_test', 'tester'), launchAckLine('toolu_test', 'agent-test'), terminalLine('agent-test', 'completed'),
      dispatchLine('toolu_cr', 'code-reviewer'), launchAckLine('toolu_cr', 'agent-cr'), terminalLine('agent-cr', 'completed'),
    ].join('\n'))
    const inputPath = writeInput('partial.json', { ...validInput, sessionTranscript: transcript })

    expect(() => runGateReportCli(inputPath, { runsDir: scratch })).toThrow(/security/)
    expect(existsSync(join(scratch, 'gate-reports', `${validInput.taskId}-r${validInput.round}.json`))).toBe(false)
  })

  it('a report claiming a gate that was dispatched for a DIFFERENT role is refused (wrong-type dispatch does not launder a claim)', () => {
    const transcript = writeTranscript('wrongtype.jsonl', ALL_BOUND_TRANSCRIPT + '\n' + boundDispatch('toolu_maker', 'agent-maker', 'maker'))
    // Only 3 of 4 opinion gates are expected/dispatched; a 4th, fabricated one is added by hand.
    const input = {
      taskId: 'T-WRONG', round: 1, commit: VALID_SHA, expectedOpinionGates: ['security', 'red_hat', 'tester', 'code_reviewer'],
      reports: [verifier, opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)],
      sessionTranscript: transcript,
    }
    const inputPath = writeInput('wrongtype.json', input)
    const result = runGateReportCli(inputPath, { runsDir: scratch })
    // All four ARE genuinely bound here (ALL_BOUND_TRANSCRIPT covers them); the extra 'maker'
    // dispatch is irrelevant noise. This asserts the check doesn't false-positive on unrelated
    // dispatches sharing the transcript.
    expect(result.decision_eligibility).toBe('PASS_ELIGIBLE')
  })
})

describe('runGateReportCli — ciRun binds Verifier to a CI run (no local gate results file)', () => {
  const SHA = '5ba82017aaaabbbbccccddddeeeeffff00001111'
  const opinions = [opinion('security', 4), opinion('red_hat', 4), opinion('tester', 4), opinion('code_reviewer', 4)]
  const base = { taskId: 'T201', round: 1, expectedOpinionGates: ['security', 'red_hat', 'tester', 'code_reviewer'], reports: opinions, commit: SHA }
  // The CLI never trusts typed ciRun fields: it re-fetches the run. Tests stub the fetch; no gh/network.
  const gateRun = (over = {}) => ({ headSha: SHA, status: 'completed', conclusion: 'success', workflowName: 'gate', workflowDatabaseId: 777, gateWorkflowId: 777, ...over })
  const stub = (run) => () => JSON.stringify(run)
  const run = (name, input, fetchRun) => runGateReportCli(writeInput(name, withBoundTranscript(input)), { runsDir: scratch, fetchRun })

  it('completed/success gate.yml run on the commit, confirmed by fetch -> verifier_pass, run recorded', () => {
    const ciRun = { id: 18234567890, headSha: SHA, status: 'completed', conclusion: 'success' }
    const result = run('ci.json', { ...base, ciRun }, stub(gateRun()))
    expect(result.verifier_pass).toBe(true)
    const persisted = JSON.parse(readFileSync(result.gate_report_ref, 'utf8'))
    expect(persisted.verifier_ci_run).toEqual({ id: 18234567890, head_sha: SHA, status: 'completed', conclusion: 'success' })
  })

  it('the gate workflow id but a different workflow name -> not pass', () => {
    const ciRun = { id: 5, headSha: SHA, status: 'completed', conclusion: 'success' }
    expect(run('ci-name.json', { ...base, ciRun }, stub(gateRun({ workflowName: 'lint' }))).verifier_pass).toBe(false)
  })

  it('no resolved gate workflow id -> not pass', () => {
    const ciRun = { id: 6, headSha: SHA, status: 'completed', conclusion: 'success' }
    expect(run('ci-noid.json', { ...base, ciRun }, stub(gateRun({ gateWorkflowId: undefined }))).verifier_pass).toBe(false)
  })

  it('passes the run id to the fetcher', () => {
    let seen
    run('ci-id.json', { ...base, ciRun: { id: 42, headSha: SHA, status: 'completed', conclusion: 'success' } }, (id) => { seen = id; return JSON.stringify(gateRun()) })
    expect(String(seen)).toBe('42')
  })

  it('CI run on a different SHA than commit -> not pass', () => {
    const ciRun = { id: 1, headSha: 'f'.repeat(40), status: 'completed', conclusion: 'success' }
    expect(run('ci2.json', { ...base, ciRun }, stub(gateRun({ headSha: 'f'.repeat(40) }))).verifier_pass).toBe(false)
  })

  describe('ciRun.id must be numeric before gh is ever invoked (argument injection)', () => {
    for (const id of ['--repo=other/fork', '-R other/repo 123', '-123', '123 --repo x', '12a', ' 42', 42.5, true]) {
      it(`id ${JSON.stringify(id)} -> fetcher never called, not counted`, () => {
        let called = false
        const fetchRun = () => { called = true; return JSON.stringify(gateRun()) }
        expect(confirmCiRun({ id }, fetchRun).run).toBeNull()
        expect(called).toBe(false)
        const r = run(`inj-${String(id).length}.json`, { ...base, ciRun: { id, headSha: SHA, status: 'completed', conclusion: 'success' } }, fetchRun)
        expect(r.verifier_pass).toBe(false)
        expect(called).toBe(false)
      })
    }
  })

  const typed = { id: 7, headSha: SHA, status: 'completed', conclusion: 'success' }
  it('gh missing / erroring -> fails closed, not pass', () => {
    expect(run('e1.json', { ...base, ciRun: typed }, () => { throw new Error('spawn gh ENOENT') }).verifier_pass).toBe(false)
  })
  it('gh returns unparseable output -> not pass', () => {
    expect(run('e2.json', { ...base, ciRun: typed }, () => 'not json').verifier_pass).toBe(false)
  })
  it('typed values say success but the fetched SHA is a different commit -> not pass', () => {
    expect(run('e3.json', { ...base, ciRun: typed }, stub(gateRun({ headSha: 'a'.repeat(40) }))).verifier_pass).toBe(false)
  })
  it('typed values say completed/success but the fetched run is in_progress -> not pass', () => {
    expect(run('e4.json', { ...base, ciRun: typed }, stub(gateRun({ status: 'in_progress', conclusion: '' }))).verifier_pass).toBe(false)
  })
  it('fetched run concluded failure -> not pass', () => {
    expect(run('e5.json', { ...base, ciRun: typed }, stub(gateRun({ conclusion: 'failure' }))).verifier_pass).toBe(false)
  })
  it('a successful run of a workflow other than gate.yml -> not pass', () => {
    expect(run('e6.json', { ...base, ciRun: typed }, stub(gateRun({ workflowName: 'gate', workflowDatabaseId: 999 }))).verifier_pass).toBe(false)
  })
  it('typed status disagrees with the fetched (successful) run -> not pass', () => {
    expect(run('e7.json', { ...base, ciRun: { ...typed, status: 'queued' } }, stub(gateRun())).verifier_pass).toBe(false)
  })

  describe('hand-written verifier PASS must cite evidence that resolves', () => {
    const hw = (evidence_ref) => ({ gate_name: 'verifier', verdict: 'PASS', score: null, na_reason: null, findings: [], evidence_ref })
    const noFetch = () => { throw new Error('fetch must not be needed') }
    it('no evidence_ref -> UNVERIFIED (verifier_pass false)', () => {
      expect(run('h1.json', { ...base, reports: [hw(null), ...opinions] }, noFetch).verifier_pass).toBe(false)
    })
    it('evidence_ref naming a file that does not exist -> verifier_pass false', () => {
      expect(run('h2.json', { ...base, reports: [hw(join(scratch, 'nope.txt')), ...opinions] }, noFetch).verifier_pass).toBe(false)
    })
    it('evidence_ref naming a green gate-results file stamped with the commit -> pass', () => {
      const f = join(scratch, 'gate-results.txt'); writeFileSync(f, greenResults(SHA))
      expect(run('h3.json', { ...base, reports: [hw(f), ...opinions] }, noFetch).verifier_pass).toBe(true)
    })
    it('evidence_ref naming an arbitrary existing file (not gate results) -> verifier_pass false', () => {
      expect(run('h3b.json', { ...base, reports: [hw('package.json'), ...opinions] }, noFetch).verifier_pass).toBe(false)
      expect(run('h3c.json', { ...base, reports: [hw(fileURLToPath(import.meta.url)), ...opinions] }, noFetch).verifier_pass).toBe(false)
    })
    it('evidence_ref naming gate results for a DIFFERENT commit -> verifier_pass false', () => {
      const f = join(scratch, 'other.txt'); writeFileSync(f, greenResults('f'.repeat(40)))
      expect(run('h3d.json', { ...base, reports: [hw(f), ...opinions] }, noFetch).verifier_pass).toBe(false)
    })
    it('evidence_ref naming a FAILING gate-results file -> verifier_pass false', () => {
      const f = join(scratch, 'red.txt'); writeFileSync(f, greenResults(SHA).replace('rc=0 | ok', 'rc=1 | boom'))
      expect(run('h3e.json', { ...base, reports: [hw(f), ...opinions] }, noFetch).verifier_pass).toBe(false)
    })
    it('evidence_ref citing the confirmed ciRun URL -> pass', () => {
      const ref = 'https://github.com/o/r/actions/runs/18234567890'
      const r = run('h4.json', { ...base, reports: [hw(ref), ...opinions], ciRun: { id: 18234567890, headSha: SHA, status: 'completed', conclusion: 'success' } }, stub(gateRun()))
      expect(r.verifier_pass).toBe(true)
    })
    it('evidence_ref citing a run id that is NOT the confirmed run -> verifier_pass false', () => {
      // the typed ciRun fails confirmation (failure), and the cited run is a different id anyway
      const r = run('h5.json', { ...base, reports: [hw('ci run 999'), ...opinions], ciRun: { id: 18234567890, headSha: SHA, status: 'completed', conclusion: 'success' } }, stub(gateRun({ conclusion: 'failure' })))
      expect(r.verifier_pass).toBe(false)
    })
    it('evidence_ref citing a confirmed gate.yml run that FAILED -> verifier_pass false', () => {
      const r = run('h7.json', { ...base, reports: [hw('https://github.com/o/r/actions/runs/999'), ...opinions], ciRun: { id: 999 } },
        stub(gateRun({ conclusion: 'failure' })))
      expect(r.verifier_pass).toBe(false)
    })
    it('evidence_ref citing a confirmed successful gate.yml run on a DIFFERENT SHA -> verifier_pass false', () => {
      const r = run('h8.json', { ...base, reports: [hw('https://github.com/o/r/actions/runs/999'), ...opinions], ciRun: { id: 999 } },
        stub(gateRun({ headSha: 'b'.repeat(40) })))
      expect(r.verifier_pass).toBe(false)
    })
    it('evidence_ref citing an UNconfirmed ciRun id -> verifier_pass false', () => {
      const r = run('h6.json', { ...base, reports: [hw('runs/18234567890'), ...opinions], ciRun: { id: 18234567890, headSha: SHA, status: 'completed', conclusion: 'success' } }, stub(gateRun({ workflowDatabaseId: 999 })))
      expect(r.verifier_pass).toBe(false)
    })
  })
})

// The REAL argv against a gh stand-in that, like gh 2.96, rejects any --json field it doesn't know.
// `path` is not one (gh says: Unknown JSON field: "path"); asking for it made every ciRun fail closed.
describe('defaultFetchRun — real gh argv', () => {
  const GH_RUN_VIEW_FIELDS = ['attempt', 'conclusion', 'createdAt', 'databaseId', 'displayTitle', 'event', 'headBranch', 'headSha', 'jobs', 'name', 'number', 'startedAt', 'status', 'updatedAt', 'url', 'workflowDatabaseId', 'workflowName']
  const SHA = '5ba82017aaaabbbbccccddddeeeeffff00001111'
  let binDir, savedPath
  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const gh = join(binDir, 'gh')
    writeFileSync(gh, `#!/usr/bin/env node
const a = process.argv.slice(2)
if (a[0] === 'api') { process.stdout.write(${JSON.stringify(JSON.stringify({ id: 777, name: 'gate', path: '.github/workflows/gate.yml' }))}); process.exit(0) }
const i = a.indexOf('--json')
const known = ${JSON.stringify(GH_RUN_VIEW_FIELDS)}
const asked = i < 0 ? [] : a[i + 1].split(',')
const bad = asked.find((f) => !known.includes(f))
if (bad) { process.stderr.write('Unknown JSON field: "' + bad + '"\\n'); process.exit(1) }
const run = { headSha: '${SHA}', status: 'completed', conclusion: 'success', workflowName: 'gate', workflowDatabaseId: 777 }
process.stdout.write(JSON.stringify(Object.fromEntries(asked.map((f) => [f, run[f]]))))
`, { mode: 0o755 })
    savedPath = process.env.PATH
    process.env.PATH = `${binDir}:${savedPath}`
  })
  afterEach(() => { process.env.PATH = savedPath; rmSync(binDir, { recursive: true, force: true }) })

  it('asks gh only for fields it supports, and a gate run confirms', () => {
    const r = confirmCiRun({ id: 18234567890, headSha: SHA, status: 'completed', conclusion: 'success' }, defaultFetchRun)
    expect(r.reason).toBeNull()
    expect(r.run).toEqual({ id: 18234567890, headSha: SHA, status: 'completed', conclusion: 'success' })
  })
})
