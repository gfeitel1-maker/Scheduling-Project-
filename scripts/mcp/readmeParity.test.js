// Parity gate: every tool server.js registers must have a row in the README's
// `## Tools` table, and vice versa — so the table can't silently drift out of
// sync with the registry again (it had 10 rows documenting 18 tools before
// this test existed). Both sides are PARSED from their real sources — the
// registry from server.js's source text, the table from README.md's markdown
// — rather than a hardcoded list of names, which would just be a third copy
// that could itself drift.
//
// server.js cannot be imported directly: it connects a StdioServerTransport
// at module top level and exits the process if --db is missing. Reading it
// as text and regex-extracting the TOOLS array's `name:` fields avoids that
// entirely and needs no db, no subprocess, no argv.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SERVER_PATH = path.join(process.cwd(), 'scripts/mcp/server.js')
const README_PATH = path.join(process.cwd(), 'scripts/mcp/README.md')

function registeredToolNames() {
  const source = fs.readFileSync(SERVER_PATH, 'utf8')
  const start = source.indexOf('const TOOLS = [')
  const end = source.indexOf('\nconst TOOLS_BY_NAME')
  if (start === -1 || end === -1) throw new Error('could not locate the TOOLS array in server.js')
  const toolsSource = source.slice(start, end)
  return [...toolsSource.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map((m) => m[1])
}

function readmeTableToolNames() {
  const markdown = fs.readFileSync(README_PATH, 'utf8')
  const start = markdown.indexOf('## Tools')
  if (start === -1) throw new Error('could not locate the "## Tools" heading in README.md')
  const nextHeading = markdown.indexOf('\n### ', start)
  const section = nextHeading === -1 ? markdown.slice(start) : markdown.slice(start, nextHeading)
  return [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1])
}

describe('scripts/mcp/README.md Tools table stays in sync with server.js', () => {
  it('has a row for every tool server.js registers', () => {
    const registered = registeredToolNames()
    expect(registered.length).toBeGreaterThan(0)
    const documented = readmeTableToolNames()
    for (const name of registered) {
      expect(documented, `${name} is registered in server.js but missing from README.md's Tools table`).toContain(name)
    }
  })

  it('documents no tool that server.js does not actually register', () => {
    const registered = registeredToolNames()
    const documented = readmeTableToolNames()
    for (const name of documented) {
      expect(registered, `${name} has a README row but is not registered in server.js`).toContain(name)
    }
  })
})
