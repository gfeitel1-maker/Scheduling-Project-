import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseLine,
  foldEvents,
  readEventsFromOffset,
  correlateDispatches,
  detectGateReportCliInvocation,
  subagentTranscriptPath,
} from './observeRun.js'

const line = (obj) => JSON.stringify(obj)

const skillUse = (name) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] },
})

const agentDispatch = (subagent_type) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type } }] },
})

const asyncLaunchResult = (agentId) => line({
  type: 'user',
  toolUseResult: { status: 'async_launched', agentId },
})

const syncCompletedResult = (agentId) => line({
  type: 'user',
  toolUseResult: { status: 'completed', agentId, content: 'DONE — did the thing' },
})

const taskStatusAttachment = (taskId, status) => line({
  type: 'attachment',
  attachment: { type: 'task_status', taskId, status },
})

// A dispatch's tool_use carries an `id`; the launch-acknowledgment record that follows carries
// the SAME id as message.content[].tool_use_id, alongside the agentId in toolUseResult. This is
// the real shape observed in the corpus (see T170) — both records are needed to attribute an
// agentId to a specific dispatch.
const dispatchWithId = (subagent_type, toolUseId) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type } }] },
})

const launchAck = (toolUseId, agentId, status = 'async_launched') => line({
  type: 'user',
  toolUseResult: { status, agentId },
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [] }] },
})

describe('parseLine', () => {
  it('extracts a Skill invocation', () => {
    const events = parseLine(skillUse('karpathy-guidelines'))
    expect(events).toEqual([{ kind: 'skill', name: 'karpathy-guidelines' }])
  })

  it('extracts an Agent dispatch by subagent_type', () => {
    const events = parseLine(agentDispatch('maker'))
    expect(events).toEqual([{ kind: 'dispatch', subagent_type: 'maker' }])
  })

  it('extracts multiple tool_use blocks from one assistant message', () => {
    const events = parseLine(line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'a' } },
          { type: 'tool_use', name: 'Agent', input: { subagent_type: 'red-hat' } },
        ],
      },
    }))
    expect(events).toEqual([
      { kind: 'skill', name: 'a' },
      { kind: 'dispatch', subagent_type: 'red-hat' },
    ])
  })

  it('extracts an async-launched dispatch resolution marker', () => {
    const events = parseLine(asyncLaunchResult('abc123'))
    expect(events).toEqual([{ kind: 'resolution', agentId: 'abc123', status: 'async_launched' }])
  })

  it('extracts a synchronously completed dispatch resolution', () => {
    const events = parseLine(syncCompletedResult('abc123'))
    expect(events).toEqual([{ kind: 'resolution', agentId: 'abc123', status: 'completed' }])
  })

  it('extracts a task_status completion attachment', () => {
    const events = parseLine(taskStatusAttachment('abc123', 'completed'))
    expect(events).toEqual([{ kind: 'resolution', agentId: 'abc123', status: 'completed' }])
  })

  it('ignores unrelated record types', () => {
    expect(parseLine(line({ type: 'system', text: 'hello' }))).toEqual([])
    expect(parseLine(line({ type: 'user', message: { content: 'plain text' } }))).toEqual([])
  })

  it('ignores tool_use blocks that are not Skill or Agent', () => {
    const events = parseLine(line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }))
    expect(events).toEqual([])
  })

  it('never throws on malformed JSON', () => {
    expect(() => parseLine('not json{{{')).not.toThrow()
    expect(parseLine('not json{{{')).toEqual([])
  })

  it('never throws on a truncated/malformed record shape', () => {
    expect(parseLine(line({ type: 'assistant', message: null }))).toEqual([])
    expect(parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }))).toEqual([])
    expect(parseLine('')).toEqual([])
  })
})

describe('foldEvents', () => {
  it('counts skills and dispatches by name', () => {
    const events = [
      { kind: 'skill', name: 'karpathy-guidelines' },
      { kind: 'skill', name: 'karpathy-guidelines' },
      { kind: 'dispatch', subagent_type: 'maker' },
      { kind: 'dispatch', subagent_type: 'maker' },
      { kind: 'dispatch', subagent_type: 'grader' },
    ]
    const report = foldEvents(events)
    expect(report.skills).toEqual({ 'karpathy-guidelines': 2 })
    expect(report.dispatches).toEqual({ maker: 2, grader: 1 })
  })

  it('marks a dispatch completed when its agentId later resolves to completed', () => {
    const events = [
      { kind: 'dispatch', subagent_type: 'maker' },
      { kind: 'resolution', agentId: 'a1', status: 'async_launched' },
      { kind: 'resolution', agentId: 'a1', status: 'completed' },
    ]
    const report = foldEvents(events)
    expect(report.completion.completed).toBe(1)
    expect(report.completion.truncated).toBe(0)
  })

  it('marks a dispatch truncated when only launched, never resolved', () => {
    const events = [
      { kind: 'dispatch', subagent_type: 'maker' },
      { kind: 'resolution', agentId: 'a1', status: 'async_launched' },
    ]
    const report = foldEvents(events)
    expect(report.completion.completed).toBe(0)
    expect(report.completion.truncated).toBe(1)
  })

  it('counts a synchronously completed dispatch as completed', () => {
    const events = [
      { kind: 'dispatch', subagent_type: 'code-reviewer' },
      { kind: 'resolution', agentId: 'a1', status: 'completed' },
    ]
    const report = foldEvents(events)
    expect(report.completion.completed).toBe(1)
    expect(report.completion.truncated).toBe(0)
  })

  it('handles an empty event list', () => {
    const report = foldEvents([])
    expect(report.skills).toEqual({})
    expect(report.dispatches).toEqual({})
    expect(report.completion).toEqual({ completed: 0, truncated: 0 })
  })

  it('merges two fold results (for incremental accumulation across files)', () => {
    const a = foldEvents([{ kind: 'skill', name: 'x' }, { kind: 'dispatch', subagent_type: 'maker' }])
    const b = foldEvents([{ kind: 'skill', name: 'x' }, { kind: 'dispatch', subagent_type: 'grader' }])
    const merged = foldEvents([], [a, b])
    expect(merged.skills).toEqual({ x: 2 })
    expect(merged.dispatches).toEqual({ maker: 1, grader: 1 })
  })
})

// ─── Red Hat, 2026-09-15 (HIGH, silent) ──────────────────────────────────────
// A file SHORTER than the stored cursor was truncated, rotated or replaced. The old code hit
// `startByte >= size` and silently reset the cursor to the new size, discarding every event in
// the first `size` bytes with no symptom at all — the same "confidently wrong and believed"
// failure the walker's own header comment describes, by a second route.
describe('cursor safety when a transcript shrinks', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'obs-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const dispatch = (role) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', id: 'x', input: { subagent_type: role } }] },
  })

  it('reads appended bytes only, when the file grew', async () => {
    const f = join(dir, 'a.jsonl')
    writeFileSync(f, dispatch('maker') + '\n')
    const first = await readEventsFromOffset(f, 0)
    expect(first.events.length).toBe(1)
    writeFileSync(f, dispatch('maker') + '\n' + dispatch('grader') + '\n')
    const second = await readEventsFromOffset(f, first.endByte)
    expect(second.events.length).toBe(1)
    expect(second.rewound).toBeFalsy()
  })

  it('flags a rewind when the cursor is past EOF instead of silently skipping', async () => {
    const f = join(dir, 'b.jsonl')
    writeFileSync(f, dispatch('maker') + '\n')
    const { endByte } = await readEventsFromOffset(f, 0)
    writeFileSync(f, dispatch('grader') + '\n')          // replaced with a SHORTER file
    const after = await readEventsFromOffset(f, endByte + 500)
    expect(after.rewound).toBe(true)
  })

  it('re-reading from zero after a rewind recovers the events that would have been lost', async () => {
    const f = join(dir, 'c.jsonl')
    writeFileSync(f, dispatch('grader') + '\n')
    const recovered = await readEventsFromOffset(f, 0)
    expect(recovered.events.length).toBe(1)
  })

  it('an exactly-unchanged file reads nothing and is not treated as a rewind', async () => {
    const f = join(dir, 'd.jsonl')
    writeFileSync(f, dispatch('maker') + '\n')
    const { endByte } = await readEventsFromOffset(f, 0)
    const again = await readEventsFromOffset(f, endByte)
    expect(again.events.length).toBe(0)
    expect(again.rewound).toBeFalsy()
  })
})

// ─── T170: per-Grader-dispatch attribution + coverage ────────────────────────
// See docs/work/tickets/T170-standing-agent-activity-report.md — three prior throwaway probes
// each silently excluded part of the population and quoted a percentage as if it covered all of
// it. These tests pin the pure logic that instead reports what it could and could not resolve.

describe('parseLine toolUseId capture', () => {
  it('carries the dispatch tool_use id through as toolUseId', () => {
    const events = parseLine(dispatchWithId('grader', 'toolu_abc'))
    expect(events).toEqual([{ kind: 'dispatch', subagent_type: 'grader', toolUseId: 'toolu_abc' }])
  })

  it('carries the launch-acknowledgment tool_use_id through as toolUseId', () => {
    const events = parseLine(launchAck('toolu_abc', 'agent123'))
    expect(events).toEqual([
      { kind: 'resolution', agentId: 'agent123', status: 'async_launched', toolUseId: 'toolu_abc' },
    ])
  })

  it('omits toolUseId when the acknowledgment record has no matching tool_result block', () => {
    const events = parseLine(asyncLaunchResult('agent123'))
    expect(events).toEqual([{ kind: 'resolution', agentId: 'agent123', status: 'async_launched' }])
  })
})

describe('correlateDispatches', () => {
  it('attributes an agentId to the dispatch that requested it, by shared tool_use id', () => {
    const events = [
      ...parseLine(dispatchWithId('grader', 'toolu_1')),
      ...parseLine(launchAck('toolu_1', 'agentA')),
    ]
    expect(correlateDispatches(events)).toEqual([
      { subagent_type: 'grader', toolUseId: 'toolu_1', agentId: 'agentA' },
    ])
  })

  it('does not attribute a dispatch whose acknowledgment never arrived (no resolvable agentId)', () => {
    const events = parseLine(dispatchWithId('grader', 'toolu_1'))
    expect(correlateDispatches(events)).toEqual([])
  })

  it('does not attribute an acknowledgment whose dispatch is missing from this event list', () => {
    const events = parseLine(launchAck('toolu_orphan', 'agentA'))
    expect(correlateDispatches(events)).toEqual([])
  })

  it('correlates multiple dispatches of different roles independently', () => {
    const events = [
      ...parseLine(dispatchWithId('grader', 'toolu_1')),
      ...parseLine(dispatchWithId('maker', 'toolu_2')),
      ...parseLine(launchAck('toolu_2', 'agentM')),
      ...parseLine(launchAck('toolu_1', 'agentG')),
    ]
    expect(correlateDispatches(events)).toEqual([
      { subagent_type: 'maker', toolUseId: 'toolu_2', agentId: 'agentM' },
      { subagent_type: 'grader', toolUseId: 'toolu_1', agentId: 'agentG' },
    ])
  })
})

describe('foldEvents agentIdCoverage', () => {
  it('reports resolved-agentId counts per role alongside dispatch totals', () => {
    const events = [
      ...parseLine(dispatchWithId('grader', 'toolu_1')),
      ...parseLine(launchAck('toolu_1', 'agentG')),
      ...parseLine(dispatchWithId('grader', 'toolu_2')), // no ack — unresolved
    ]
    const report = foldEvents(events)
    expect(report.dispatches.grader).toBe(2)
    expect(report.agentIdCoverage.grader).toBe(1)
  })

  it('merges agentIdCoverage across per-file reports', () => {
    const a = foldEvents([
      ...parseLine(dispatchWithId('grader', 'toolu_1')),
      ...parseLine(launchAck('toolu_1', 'agentG')),
    ])
    const b = foldEvents([
      ...parseLine(dispatchWithId('grader', 'toolu_2')),
      ...parseLine(launchAck('toolu_2', 'agentH')),
    ])
    const merged = foldEvents([], [a, b])
    expect(merged.agentIdCoverage.grader).toBe(2)
  })

  it('accepts a precomputed correlation to avoid recomputing it', () => {
    const events = [
      ...parseLine(dispatchWithId('grader', 'toolu_1')),
      ...parseLine(launchAck('toolu_1', 'agentG')),
    ]
    const precomputed = correlateDispatches(events)
    const report = foldEvents(events, [], precomputed)
    expect(report.agentIdCoverage.grader).toBe(1)
  })
})

describe('detectGateReportCliInvocation', () => {
  it('detects a Bash command invoking gateReportCli.js and reports the hardcoded runsDir', () => {
    const transcriptText = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node scripts/gateReportCli.js /tmp/x/input.json' } }] },
    })
    expect(detectGateReportCliInvocation(transcriptText)).toEqual({ invoked: true, runsDir: 'docs/work/runs' })
  })

  it('reports not-invoked when the transcript never mentions gateReportCli.js', () => {
    const transcriptText = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run verify' } }] },
    })
    expect(detectGateReportCliInvocation(transcriptText)).toEqual({ invoked: false, runsDir: null })
  })

  it('never throws on non-string input', () => {
    expect(detectGateReportCliInvocation(undefined)).toEqual({ invoked: false, runsDir: null })
    expect(detectGateReportCliInvocation(null)).toEqual({ invoked: false, runsDir: null })
  })
})

describe('subagentTranscriptPath', () => {
  it('builds <sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl from the main transcript path', () => {
    const mainPath = '/Users/x/.claude/projects/-slug/9019a257-101c-430a-bb97-d068ccc6ab7a.jsonl'
    expect(subagentTranscriptPath(mainPath, 'ae25dbbb645599b8b')).toBe(
      '/Users/x/.claude/projects/-slug/9019a257-101c-430a-bb97-d068ccc6ab7a/subagents/agent-ae25dbbb645599b8b.jsonl'
    )
  })
})
