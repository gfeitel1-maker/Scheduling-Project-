// Pure dispatch for one MCP tool call — extracted out of server.js so it can
// be unit-tested without booting the stdio server. server.js connects a
// StdioServerTransport at module top level, so importing it in a test starts
// a real server; this function has no top-level side effects and no db
// dependency of its own, so a test can exercise it with a stub tools map.
export async function dispatchToolCall(toolsByName, name, args, ctx) {
  const tool = toolsByName.get(name)
  if (!tool) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }) }] }
  }
  try {
    // `await` on a handler's return value is a no-op today — every handler in
    // tools.js is synchronous — but it means this catch also covers a handler
    // that becomes async, or returns a rejected promise, without anyone
    // having to remember to change the dispatch code when that happens.
    const result = await tool.handler(args, ctx)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (err) {
    console.error(`scripts/mcp/server.js: tool ${name} threw:`, err)
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `tool ${name} failed: ${err.message}` }) }] }
  }
}
