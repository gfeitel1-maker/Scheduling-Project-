import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// T165: agents:check must not depend on the untracked ~/.claude/organization
// directory, and its committed manifest must be load-bearing (checked, not
// just written). These tests exercise the actual CLI, because both
// properties are about process-level behavior (exit code, env resolution),
// not something a unit test of an inner function would prove.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(__dirname, 'generateAgentProfiles.js')
const MANIFEST_PATH = path.join(ROOT, 'docs', 'governance', 'agent-bindings', 'manifest.json')

function runCheck(env = {}) {
  try {
    const output = execFileSync('node', [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      // T221: capture stderr instead of letting it through to OUR stderr. Node's
      // execFileSync both captures a child's stderr AND echoes it to the parent by
      // default, so the corruption test below — which deliberately makes the generator
      // print `DIFFERS  docs/governance/agent-bindings/manifest.json` and `1 profile(s)
      // diverged` — leaked those two lines into the gate log of an entirely PASSING run.
      // Three sessions across two branches read that as a real `agents:check` failure and
      // re-diagnosed it from scratch. The assertions below are unaffected: e.stderr is
      // still populated under 'pipe'.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (e) {
    return { code: e.status, output: (e.stdout || '') + (e.stderr || '') }
  }
}

describe('agents:check', () => {
  it('all 13 vendored profiles are byte-identical (13 match, 0 differ)', () => {
    const { code, output } = runCheck()
    expect(code).toBe(0)
    expect(output.match(/^match /gm)?.length).toBe(14) // 13 profiles + the manifest itself
    expect(output).not.toMatch(/DIFFERS/)
  })

  it('produces a correct (passing) verdict with no ~/.claude/organization directory present', () => {
    // Simulate a machine with no home organization package: point HOME at an
    // empty directory that has no .claude/organization, and do NOT set
    // SHORESH_ORG_DIR. The default must resolve to the vendored in-repo
    // fragments, not the (now-absent) home path.
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'shoresh-no-org-'))
    try {
      const { code, output } = runCheck({ HOME: fakeHome, SHORESH_ORG_DIR: undefined })
      expect(code).toBe(0)
      expect(output).not.toMatch(/No organization package/)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  describe('manifest verification', () => {
    // T221: this used to corrupt the COMMITTED manifest.json in place and rely
    // on afterEach to restore it — a crashed or interrupted run left a real
    // repo artifact corrupted in the working tree. The corrupted copy now
    // lives in a scratch temp dir, pointed at via SHORESH_AGENT_MANIFEST, so
    // there is nothing to restore and nothing for an interrupted run to leak.
    let tmpDir

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    })

    it('fails when the manifest has been corrupted', () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'shoresh-manifest-'))
      const corruptedPath = path.join(tmpDir, 'manifest.json')
      const corrupted = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
      corrupted.roles.maker.generated_hash = 'deadbeefdeadbeef'
      writeFileSync(corruptedPath, JSON.stringify(corrupted, null, 2) + '\n')

      const { code, output } = runCheck({ SHORESH_AGENT_MANIFEST: corruptedPath })

      expect(code).toBe(1)
      expect(output).toMatch(/DIFFERS.*manifest\.json/)
    })
  })
})
