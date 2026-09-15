import { describe, it, expect } from 'vitest'
import { parseLine, foldEvents } from './observeRun.js'

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
