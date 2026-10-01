import { describe, it, expect } from 'vitest'
import { checkOpinionProvenance, SUBAGENT_TYPE_BY_GATE } from './opinionReportProvenance.js'

// Helpers build the minimal transcript shape observeRun.parseLine actually reads: an
// 'assistant' record with an Agent tool_use block (carries the dispatch's tool_use id and
// subagent_type), then a 'user' record whose toolUseResult carries the agentId + launch status
// and whose message.content carries the matching tool_result block, then — for a background
// dispatch — a later 'attachment' task_status record carrying the terminal status.
const dispatchLine = (toolUseId, subagentType) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: subagentType } }] },
})

const launchAckLine = (toolUseId, agentId, status = 'async_launched') => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  toolUseResult: { isAsync: true, status, agentId },
})

const terminalLine = (agentId, status) => JSON.stringify({
  type: 'attachment',
  attachment: { type: 'task_status', taskId: agentId, status },
})

// A FOREGROUND (synchronous) Agent dispatch's completion signal: a 'user' record whose
// message.content carries the tool_result block for the dispatch's tool_use id, and — unlike a
// background launch-ack — NO toolUseResult.agentId/status (a synchronous Agent call returns its
// result inline and the harness stamps no async launch record). Confirmed against real Governor
// subagent transcripts 2026-10-01: every foreground reviewer dispatch has exactly this shape and
// zero toolUseResult.agentId, which is why the nested foreground loop could never bind provenance.
const foregroundResultLine = (toolUseId) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'the code reviewer final report' }] },
})

describe('checkOpinionProvenance', () => {
  it('binds a code_reviewer report to a real, completed code-reviewer dispatch', () => {
    const text = [
      dispatchLine('toolu_1', 'code-reviewer'),
      launchAckLine('toolu_1', 'agent-abc'),
      terminalLine('agent-abc', 'completed'),
    ].join('\n')

    const result = checkOpinionProvenance({ text, gateName: 'code_reviewer' })
    expect(result.bound).toBe(true)
    expect(result.agentId).toBe('agent-abc')
  })

  it('THE ACCEPTANCE SCENARIO: a hand-fabricated report has no matching dispatch anywhere in the transcript, and is refused', () => {
    // This transcript is exactly what a real session looks like when an orchestrator ran a
    // Verifier gate and typed the four opinion reports by hand instead of dispatching them —
    // the scenario that produced a clean PASS_ELIGIBLE with no reviewer having seen the diff.
    const text = [
      dispatchLine('toolu_1', 'maker'),
      launchAckLine('toolu_1', 'agent-maker-1'),
      terminalLine('agent-maker-1', 'completed'),
    ].join('\n')

    const result = checkOpinionProvenance({ text, gateName: 'code_reviewer' })
    expect(result.bound).toBe(false)
    expect(result.reason).toMatch(/no completed code-reviewer dispatch/i)
  })

  it('a dispatch that never reached a terminal status does not bind (still pending, not proof of a report)', () => {
    const text = [
      dispatchLine('toolu_1', 'red-hat'),
      launchAckLine('toolu_1', 'agent-xyz'),
      // no terminal status line at all
    ].join('\n')

    const result = checkOpinionProvenance({ text, gateName: 'red_hat' })
    expect(result.bound).toBe(false)
  })

  it('a dispatch that failed does not bind a PASS/FAIL opinion report', () => {
    const text = [
      dispatchLine('toolu_1', 'security'),
      launchAckLine('toolu_1', 'agent-sec'),
      terminalLine('agent-sec', 'failed'),
    ].join('\n')

    const result = checkOpinionProvenance({ text, gateName: 'security' })
    expect(result.bound).toBe(false)
  })

  it('picks the most recent completed dispatch of the matching type when several exist', () => {
    const text = [
      dispatchLine('toolu_1', 'tester'),
      launchAckLine('toolu_1', 'agent-old'),
      terminalLine('agent-old', 'completed'),
      dispatchLine('toolu_2', 'tester'),
      launchAckLine('toolu_2', 'agent-new'),
      terminalLine('agent-new', 'completed'),
    ].join('\n')

    const result = checkOpinionProvenance({ text, gateName: 'tester' })
    expect(result.bound).toBe(true)
    expect(result.agentId).toBe('agent-new')
  })

  it('binds a FOREGROUND code-reviewer dispatch whose only completion is the returned tool_result (no toolUseResult.agentId)', () => {
    // The nested-subagent loop dispatches reviewers synchronously (dispatch discipline forbids
    // backgrounding them), so their completion appears as a returned tool_result, never a
    // toolUseResult.agentId launch-ack. Before this was recognized, the GateReport reducer could
    // never bind a foreground reviewer and the Grader BLOCKED on every nested loop.
    const toolUseId = 'toolu_fg_cr'
    const text = [
      dispatchLine(toolUseId, 'code-reviewer'),
      foregroundResultLine(toolUseId),
    ].join('\n')
    const result = checkOpinionProvenance({ text, gateName: 'code_reviewer' })
    expect(result.bound).toBe(true)
  })

  it('NON-VACUITY: a foreground dispatch that never returned a tool_result does not bind', () => {
    // The dispatch is present but no tool_result joins it — the subagent never completed, so a
    // report claiming to be from it is not proven. This is the shape that must stay unbound, or
    // the foreground path would bind a dispatch that never ran to completion.
    const text = dispatchLine('toolu_fg_incomplete', 'red-hat')
    const result = checkOpinionProvenance({ text, gateName: 'red_hat' })
    expect(result.bound).toBe(false)
  })

  it('a foreground tool_result whose tool_use_id matches no Agent dispatch does not bind (an ordinary Bash/Read result is not a dispatch completion)', () => {
    // Every tool result is a user record with a tool_result block; only those joined to an Agent
    // dispatch count. A lone tool_result (e.g. a Bash call) must not bind an opinion gate.
    const text = foregroundResultLine('toolu_bash_unrelated')
    const result = checkOpinionProvenance({ text, gateName: 'code_reviewer' })
    expect(result.bound).toBe(false)
  })

  it('empty/blank transcript text is unbound, not a crash', () => {
    expect(checkOpinionProvenance({ text: '', gateName: 'code_reviewer' }).bound).toBe(false)
  })

  it('covers every opinion gate name with a subagent_type mapping', () => {
    expect(SUBAGENT_TYPE_BY_GATE).toEqual({
      security: 'security',
      red_hat: 'red-hat',
      tester: 'tester',
      code_reviewer: 'code-reviewer',
    })
  })
})
