// Binds an opinion PerGateReport (security/red_hat/tester/code_reviewer) to evidence that a real
// subagent dispatch produced it — the last unguarded input to the GateReport reducer.
//
// Why this exists (T171). gateReportReduce.js §5.1 already rejects a well-formed report from a
// gate outside expectedOpinionGates, precisely to stop score-inflation laundering. What it cannot
// see is whether a report CLAIMING to be from code_reviewer came from an actual Code Reviewer
// dispatch, because `reports` arrives as plain data and the reducer is pure by design. A
// hand-typed report with invented findings and an invented 4/4 score is structurally
// indistinguishable from a real one. This module closes that gap upstream of the reducer, the
// same way gateReportCli.js already derives the Verifier report upstream (T167) and binds it to a
// commit (T169) — see verifierReport.js, whose shape this deliberately follows.
//
// Pure — no I/O, no clock. Takes transcript TEXT (a thin CLI-layer caller does the readFileSync),
// exactly like buildVerifierReport({ text, ... }).
//
// What this can prove, and what it cannot (state this honestly, not just in the ADR): it proves a
// subagent of the claimed type was dispatched in this transcript and reached a terminal
// 'completed' status. It does NOT prove the returned findings are the ones that dispatch actually
// produced, and it does NOT prove the dispatch reviewed the commit this gate run is for — matching
// prose/commit text inside a dispatch prompt is exactly the kind of flaky substring check that
// produces false negatives on rewording, so this deliberately does not attempt it. A determined
// author who copies real findings from an unrelated dispatch, or reuses a stale one from earlier
// in a long session, defeats this. An accidental or lazy fabrication — the demonstrated case, and
// the one this program exists to catch — does not.

import { parseLine, TERMINAL_STATUSES } from './observeRun.js'

export const SUBAGENT_TYPE_BY_GATE = {
  security: 'security',
  red_hat: 'red-hat',
  tester: 'tester',
  code_reviewer: 'code-reviewer',
}

function toLines(text) {
  return String(text ?? '').split(/\r\n?|\n/)
}

/**
 * @param {object} input
 * @param {string} input.text - contents of a session transcript .jsonl
 * @param {string} input.gateName - one of SUBAGENT_TYPE_BY_GATE's keys
 * @returns {{bound: boolean, agentId?: string, reason?: string}}
 */
export function checkOpinionProvenance({ text, gateName }) {
  const subagentType = SUBAGENT_TYPE_BY_GATE[gateName]
  if (!subagentType) {
    return { bound: false, reason: `"${gateName}" is not an opinion gate this check knows how to bind` }
  }

  // subagent_type by the tool_use_id of the dispatch that requested it.
  const subagentTypeByToolUseId = new Map()
  // agentId by the tool_use_id of the launch-ack that assigned it (joins back to the dispatch
  // above via the shared tool_use_id).
  const agentIdByToolUseId = new Map()
  // The dispatch order an agentId was first seen in, so "most recent" is well-defined when
  // several dispatches of the same subagent_type exist in one transcript.
  const agentIdOrder = []
  // Final (terminal) status per agentId. A later terminal event overwrites an earlier one, same
  // rule as observeRun.foldEvents' pendingByAgentId.
  const statusByAgentId = new Map()

  for (const rawLine of toLines(text)) {
    if (!rawLine) continue
    for (const ev of parseLine(rawLine)) {
      if (ev.kind === 'dispatch') {
        if (ev.tool_use_id) subagentTypeByToolUseId.set(ev.tool_use_id, ev.subagent_type)
      } else if (ev.kind === 'resolution') {
        if (ev.tool_use_id && !agentIdByToolUseId.has(ev.tool_use_id)) {
          agentIdByToolUseId.set(ev.tool_use_id, ev.agentId)
        }
        if (!statusByAgentId.has(ev.agentId)) agentIdOrder.push(ev.agentId)
        if (TERMINAL_STATUSES.has(ev.status)) {
          statusByAgentId.set(ev.agentId, ev.status)
        } else if (!statusByAgentId.has(ev.agentId)) {
          statusByAgentId.set(ev.agentId, 'pending')
        }
      }
    }
  }

  // Join: agentId -> subagent_type, via the tool_use_id shared by a dispatch and its launch-ack.
  const subagentTypeByAgentId = new Map()
  for (const [toolUseId, agentId] of agentIdByToolUseId.entries()) {
    const type = subagentTypeByToolUseId.get(toolUseId)
    if (type) subagentTypeByAgentId.set(agentId, type)
  }

  // Walk in reverse dispatch order so a later completed dispatch of the same type wins over an
  // earlier one — see the module doc comment on why "most recent" is the honest bound we claim,
  // not "the right one for this specific round".
  for (let i = agentIdOrder.length - 1; i >= 0; i--) {
    const agentId = agentIdOrder[i]
    if (subagentTypeByAgentId.get(agentId) !== subagentType) continue
    if (statusByAgentId.get(agentId) === 'completed') {
      return { bound: true, agentId }
    }
  }

  return { bound: false, reason: `no completed ${subagentType} dispatch found in the supplied transcript` }
}
