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
// The task tie is either run-wide or per dispatch: the run directory name names exactly one task
// id and it is the taskId (e.g. "wf_t346-run"), or a journal 'started' label is EXACTLY the taskId
// or "<role>:<taskid>" (e.g. "governor:t346" — a label that merely mentions it does not tie), or in the dispatched
// reviewer's own recorded prompt (the first user message of agent-<id>.jsonl) — the only place a
// run that labels agents by role ("security") names its task. A prompt tie holds only when the
// taskId is the FIRST task id named in that prompt (a later mention is a cross-reference, not the
// subject) and binds that agent only.
// A result may also be {verdict, findings:[string]}: a pass records them as non-blocking entries,
// a fail as blocking ones. Findings must be non-empty (an empty list
// binds only a result that recorded none) and each summary at least MIN_SUMMARY characters.
//
// Freshness and identity: of the task-tied dispatches of the gate's type, only the LATEST (journal
// order) may bind — an earlier passing review cannot stand in for a later re-review — and that
// dispatch must be newer than the commit under review. A dispatch's time is the first "timestamp"
// in its own transcript (agent-<id>.jsonl, written by the harness), else that file's mtime, else
// its meta file's mtime; the journal carries no timestamps. runHash() fingerprints the run
// directory so the GateReport records exactly which run it bound.
//
// Limits, same envelope as opinionReportProvenance.js: this does not prove the dispatch reviewed
// this commit (a label names the task, not the commit), and a determined author who copies real text from an unrelated run defeats it.
// It stops invented findings, a flipped verdict, and an absent or wrong-typed reviewer.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename, resolve } from 'node:path'
import { SUBAGENT_TYPE_BY_GATE } from './opinionReportProvenance.js'

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

const MIN_SUMMARY = 20

const firstTaskId = (prompt) => /\bT\d+\b/i.exec(prompt ?? '')?.[0].toUpperCase()

function firstPrompt(dir, agentId) {
  try {
    const first = readFileSync(join(dir, `agent-${agentId}.jsonl`), 'utf8').split('\n', 1)[0]
    const c = JSON.parse(first)?.message?.content
    return typeof c === 'string' ? c : (c ?? []).map((x) => x?.text ?? '').join(' ')
  } catch {
    return ''
  }
}

function dispatchTime(dir, agentId) {
  try {
    const first = readFileSync(join(dir, `agent-${agentId}.jsonl`), 'utf8').split('\n', 1)[0]
    const t = Date.parse(JSON.parse(first)?.timestamp)
    if (Number.isFinite(t)) return t
  } catch { /* fall through to mtime */ }
  for (const f of [`agent-${agentId}.jsonl`, `agent-${agentId}.meta.json`]) {
    try { return statSync(join(dir, f)).mtimeMs } catch { /* next */ }
  }
  return null
}

/** sha256 over journal.jsonl and every agent-* file, by sorted name. */
export function runHash(dir) {
  const h = createHash('sha256')
  const names = readdirSync(dir).filter((n) => n === 'journal.jsonl' || /^agent-.+\.(meta\.json|jsonl)$/.test(n)).sort()
  for (const n of names) h.update(n).update('\0').update(readFileSync(join(dir, n))).update('\0')
  return h.digest('hex')
}

export function loadWorkflowRun(dir) {
  const results = new Map()
  const order = new Map()
  const labels = []
  readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').forEach((line, i) => {
    if (!line) return
    const ev = JSON.parse(line)
    if (ev.type === 'started' && ev.label) labels.push(String(ev.label))
    if ((ev.type === 'started' || ev.type === 'result') && ev.agentId && !order.has(ev.agentId)) order.set(ev.agentId, i)
    if (ev.type === 'result' && ev.agentId) results.set(ev.agentId, ev.result)
  })
  const agents = []
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!m) continue
    const { agentType } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (results.has(m[1])) {
      agents.push({ agentId: m[1], agentType, result: results.get(m[1]), prompt: firstPrompt(dir, m[1]),
        order: order.get(m[1]), time: dispatchTime(dir, m[1]) })
    }
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
export function checkWorkflowProvenance({ agents, labels = [], dirName = '', taskId, report, commitTime }) {
  const id = String(taskId ?? '').toUpperCase()
  const dirIds = String(dirName).toUpperCase().match(/(?<![A-Z0-9])T\d+(?![0-9])/g) ?? []
  const dirTied = new Set(dirIds).size === 1 && dirIds[0] === id
  const labelTied = labels.some((l) => { const u = l.toUpperCase(); return u === id || /^[A-Z][A-Z-]*:/.test(u) && u.slice(u.indexOf(':') + 1) === id })
  const runTied = Boolean(taskId) && (dirTied || labelTied)
  const subagentType = SUBAGENT_TYPE_BY_GATE[report?.gate_name]
  if (!subagentType) return { bound: false, reason: `"${report?.gate_name}" is not an opinion gate` }
  const ofType = agents.filter((a) => a.agentType === subagentType)
  if (ofType.length === 0) {
    return { bound: false, reason: `no completed ${subagentType} dispatch found in the workflow run` }
  }
  const candidates = ofType.filter((a) => runTied || (taskId && firstTaskId(a.prompt) === String(taskId).toUpperCase()))
  if (candidates.length === 0) {
    return { bound: false, reason: `the workflow run is not tied to task ${taskId} (no run directory name, dispatch label or ${subagentType} prompt names it)` }
  }
  const latest = candidates.reduce((a, b) => ((b.order ?? -1) > (a.order ?? -1) ? b : a))
  if (!consistent(report, latest.result)) {
    return { bound: false, reason: `report does not match the recorded result of the latest ${subagentType} dispatch (${latest.agentId}) in the workflow run` }
  }
  if (!Number.isFinite(commitTime)) {
    return { bound: false, reason: 'the commit time of the commit under review could not be resolved, so the dispatch cannot be shown to be newer than it' }
  }
  if (!Number.isFinite(latest.time) || latest.time <= commitTime) {
    return { bound: false, reason: `the latest ${subagentType} dispatch (${latest.agentId}) predates the commit under review (dispatch is older than the commit)` }
  }
  return { bound: true, agentId: latest.agentId }
}
