// @vitest-environment node
// Headless callers surface the NAMED refusal (never db_key_unavailable) when encryption is on and the
// tool was not launched through a director-granted authorization.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = (script, args, env) =>
  spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })

describe('unauthorized headless launch', () => {
  it.each([
    ['scripts/mcp/server.js', ['--db', '/nonexistent.sqlite']],
    ['scripts/ingest.js', ['/nonexistent.xlsx', '--db', '/nonexistent.sqlite']],
    ['scripts/electives.js', ['preview', '--db', '/nonexistent.sqlite', '--file', '/nonexistent.csv']],
  ])('%s refuses with tool-not-authorized', (script, args) => {
    const r = run(script, args, {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('tool-not-authorized')
    expect(r.stderr).not.toContain('db_key_unavailable')
  })

  it('a read-scoped tool asked to write is refused by name', () => {
    const r = run('scripts/mcp/server.js', ['--db', '/nonexistent.sqlite', '--allow-write'], {
      SHORESH_DB_KEY: 'ab'.repeat(32),
      SHORESH_TOOL_SCOPE: 'read',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('tool-scope-read-only')
  })

  it('non-vacuity: with encryption pinned off the same launch is NOT refused for authorization', () => {
    const r = run('scripts/ingest.js', ['/nonexistent.xlsx', '--db', '/nonexistent.sqlite'], { SHORESH_AT_REST_ENCRYPTION: 'off' })
    expect(r.stderr).not.toContain('tool-not-authorized')
  })
})
