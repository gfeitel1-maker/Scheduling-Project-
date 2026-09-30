// Tests for dispatchToolCall — the pure dispatch seam extracted out of
// server.js's CallToolRequestSchema handler so a throwing (or badly
// serializing) tool handler can be exercised without booting the stdio
// server (server.js connects a StdioServerTransport at module top level).
import { describe, it, expect } from 'vitest'
import { dispatchToolCall } from './dispatch.js'

function toolsMap(entries) {
  return new Map(entries.map((t) => [t.name, t]))
}

describe('dispatchToolCall', () => {
  it('still returns the unknown-tool envelope for a name with no match', async () => {
    const result = await dispatchToolCall(toolsMap([]), 'nope', {}, {})
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ ok: false, error: 'unknown tool: nope' })
  })

  it('returns an error envelope instead of throwing when a handler throws', async () => {
    const tools = toolsMap([
      {
        name: 'throws_tool',
        handler: () => {
          throw new Error('boom')
        },
      },
    ])
    const result = await dispatchToolCall(tools, 'throws_tool', {}, {})
    const body = JSON.parse(result.content[0].text)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('boom')
  })

  it('never leaks the server\'s own stack trace to the client, even though the error message itself may legitimately name a caller-supplied path', async () => {
    const tools = toolsMap([
      {
        name: 'throws_tool',
        handler: () => {
          // A realistic case: the error message itself names a path the
          // caller already knows (their own --db argument) — that is fine
          // to return. What must never reach the client is the STACK, which
          // would additionally reveal this server's own source layout.
          throw new Error('failed reading /Users/someone/camp.sqlite')
        },
      },
    ])
    const result = await dispatchToolCall(tools, 'throws_tool', {}, {})
    const text = result.content[0].text
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/)
    expect(text).not.toContain('dispatch.js')
    expect(text).not.toContain('server.js')
  })

  it('returns an error envelope when a handler returns an unserializable value', async () => {
    const circular = {}
    circular.self = circular
    const tools = toolsMap([{ name: 'circular_tool', handler: () => circular }])
    const result = await dispatchToolCall(tools, 'circular_tool', {}, {})
    const body = JSON.parse(result.content[0].text)
    expect(body.ok).toBe(false)
    expect(body.error).toBeTruthy()
  })

  it('passes args and ctx through to the handler and serializes its result', async () => {
    const tools = toolsMap([
      {
        name: 'echo_tool',
        handler: (args, ctx) => ({ ok: true, args, dbPath: ctx.dbPath }),
      },
    ])
    const result = await dispatchToolCall(tools, 'echo_tool', { x: 1 }, { dbPath: '/tmp/a.sqlite' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ ok: true, args: { x: 1 }, dbPath: '/tmp/a.sqlite' })
  })
})
