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
// Limits, same envelope as opinionReportProvenance.js: this does not prove the dispatch reviewed
// this commit, and a determined author who copies real text from an unrelated run defeats it.
// It stops invented findings, a flipped verdict, and an absent or wrong-typed reviewer.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SUBAGENT_TYPE_BY_GATE } from './opinionReportProvenance.js'

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

export function loadWorkflowRun(dir) {
  const results = new Map()
  for (const line of readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n')) {
    if (!line) continue
    const ev = JSON.parse(line)
    if (ev.type === 'result' && ev.agentId) results.set(ev.agentId, ev.result)
  }
  const agents = []
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!m) continue
    const { agentType } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (results.has(m[1])) agents.push({ agentId: m[1], agentType, result: results.get(m[1]) })
  }
  return agents
}

function entriesOf(result) {
  if (typeof result === 'string') return { all: [norm(result)], blocking: [] }
  const blocking = (result?.blocking ?? []).map(norm)
  return { all: [...blocking, ...(result?.nonblocking ?? []).map(norm)], blocking }
}

function consistent(report, result) {
  const { all, blocking } = entriesOf(result)
  if (typeof result !== 'string') {
    const expected = result?.verdict === 'pass' && blocking.length === 0 ? 'PASS'
      : result?.verdict === 'fail' && blocking.length > 0 ? 'FAIL' : null
    if (report.verdict !== expected) return false
  }
  return (report.findings ?? []).every((f) => {
    const s = norm(f?.summary ?? '')
    if (!s || !all.some((e) => e.includes(s))) return false
    return f.severity !== 'BLOCKING' || blocking.some((e) => e.includes(s))
  })
}

/** @returns {{bound: boolean, agentId?: string, reason?: string}} */
export function checkWorkflowProvenance({ agents, report }) {
  const subagentType = SUBAGENT_TYPE_BY_GATE[report?.gate_name]
  if (!subagentType) return { bound: false, reason: `"${report?.gate_name}" is not an opinion gate` }
  const candidates = agents.filter((a) => a.agentType === subagentType)
  if (candidates.length === 0) {
    return { bound: false, reason: `no completed ${subagentType} dispatch found in the workflow run` }
  }
  const match = candidates.find((a) => consistent(report, a.result))
  return match
    ? { bound: true, agentId: match.agentId }
    : { bound: false, reason: `report does not match the recorded result of any ${subagentType} dispatch in the workflow run` }
}
