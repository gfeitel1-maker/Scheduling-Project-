// Binds an opinion PerGateReport to a reviewer dispatched by the Workflow tool (or any run that
// leaves a workflow directory on disk), which writes no toolUseResult.agentId records into a
// Governor transcript — see opinionReportProvenance.js for the transcript path.
//
// A run directory holds journal.jsonl (one {type:'result', agentId, result} line per completed
// agent) and agent-<id>.meta.json ({agentType}). Binding requires, per report: a subagent of the
// gate's type, with a recorded result (completed), and a report that is consistent with that
// result. A reviewer's result is {verdict:'pass'|'fail', blocking:[], nonblocking:[]} (or text);
// the report is the Grader's transcription of it plus a score, so it cannot be hash-compared.
// Instead: the verdict must agree, every BLOCKING finding must match a recorded blocking entry,
// and every finding summary must appear verbatim (whitespace-normalised) in a recorded entry.
//
// The task tie is either run-wide or per dispatch: the taskId appears as a token in the run
// directory name or a journal 'started' label (e.g. "governor:t346"), or in the dispatched
// reviewer's own recorded prompt (the first user message of agent-<id>.jsonl) — the only place a
// run that labels agents by role ("security") names its task. A prompt tie binds that agent only.
// A result may also be {verdict, findings:[string]}: a pass records them as non-blocking entries,
// a fail as blocking ones. Findings must be non-empty (an empty list
// binds only a result that recorded none) and each summary at least MIN_SUMMARY characters.
//
// Limits, same envelope as opinionReportProvenance.js: this does not prove the dispatch reviewed
// this commit (a label names the task, not the commit), and a determined author who copies real text from an unrelated run defeats it.
// It stops invented findings, a flipped verdict, and an absent or wrong-typed reviewer.

import { readFileSync, readdirSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { SUBAGENT_TYPE_BY_GATE } from './opinionReportProvenance.js'

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

const MIN_SUMMARY = 20

function firstPrompt(dir, agentId) {
  try {
    const first = readFileSync(join(dir, `agent-${agentId}.jsonl`), 'utf8').split('\n', 1)[0]
    const c = JSON.parse(first)?.message?.content
    return typeof c === 'string' ? c : (c ?? []).map((x) => x?.text ?? '').join(' ')
  } catch {
    return ''
  }
}

export function loadWorkflowRun(dir) {
  const results = new Map()
  const labels = []
  for (const line of readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n')) {
    if (!line) continue
    const ev = JSON.parse(line)
    if (ev.type === 'started' && ev.label) labels.push(String(ev.label))
    if (ev.type === 'result' && ev.agentId) results.set(ev.agentId, ev.result)
  }
  const agents = []
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!m) continue
    const { agentType } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (results.has(m[1])) agents.push({ agentId: m[1], agentType, result: results.get(m[1]), prompt: firstPrompt(dir, m[1]) })
  }
  return { agents, labels, dirName: basename(resolve(dir)) }
}

function entriesOf(result) {
  if (typeof result === 'string') return { all: [norm(result)], blocking: [] }
  const listed = (result?.findings ?? []).map(norm)
  const blocking = [...(result?.blocking ?? []).map(norm), ...(result?.verdict === 'fail' ? listed : [])]
  const nonblocking = [...(result?.nonblocking ?? []).map(norm), ...(result?.verdict === 'fail' ? [] : listed)]
  return { all: [...blocking, ...nonblocking], blocking }
}

function consistent(report, result) {
  const { all, blocking } = entriesOf(result)
  if (typeof result !== 'string') {
    const expected = result?.verdict === 'pass' && blocking.length === 0 ? 'PASS'
      : result?.verdict === 'fail' && blocking.length > 0 ? 'FAIL' : null
    if (report.verdict !== expected) return false
  }
  const findings = report.findings ?? []
  if (findings.length === 0) return all.length === 0
  return findings.every((f) => {
    const s = norm(f?.summary ?? '')
    if (s.length < MIN_SUMMARY || !all.some((e) => e.includes(s))) return false
    return f.severity !== 'BLOCKING' || blocking.some((e) => e.includes(s))
  })
}

/** @returns {{bound: boolean, agentId?: string, reason?: string}} */
export function checkWorkflowProvenance({ agents, labels = [], dirName = '', taskId, report }) {
  const tie = new RegExp(`(^|[^a-z0-9])${String(taskId ?? '').replace(/[^a-z0-9]/gi, '')}([^a-z0-9]|$)`, 'i')
  const runTied = Boolean(taskId) && [dirName, ...labels].some((t) => tie.test(t))
  const subagentType = SUBAGENT_TYPE_BY_GATE[report?.gate_name]
  if (!subagentType) return { bound: false, reason: `"${report?.gate_name}" is not an opinion gate` }
  const ofType = agents.filter((a) => a.agentType === subagentType)
  if (ofType.length === 0) {
    return { bound: false, reason: `no completed ${subagentType} dispatch found in the workflow run` }
  }
  const candidates = ofType.filter((a) => runTied || (taskId && tie.test(a.prompt ?? '')))
  if (candidates.length === 0) {
    return { bound: false, reason: `the workflow run is not tied to task ${taskId} (no run directory name, dispatch label or ${subagentType} prompt names it)` }
  }
  const match = candidates.find((a) => consistent(report, a.result))
  return match
    ? { bound: true, agentId: match.agentId }
    : { bound: false, reason: `report does not match the recorded result of any ${subagentType} dispatch in the workflow run` }
}
