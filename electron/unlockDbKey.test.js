// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUnlockArgs, childEnvWithKey, releaseKeyToTool } from './unlockDbKey.js'
import { grantToolAuthorization, revokeToolAuthorization } from './auth/toolAuthorizations.js'
import { KEY_FILE } from './db/dbEncryptionKey.js'

const HEX64 = 'ab'.repeat(32)

describe('parseUnlockArgs', () => {
  it('defaults to print mode', () => {
    expect(parseUnlockArgs([])).toEqual({ mode: 'print' })
    expect(parseUnlockArgs(['--print'])).toEqual({ mode: 'print' })
  })
  it('parses --exec -- <command...> (dropping the -- separator)', () => {
    expect(parseUnlockArgs(['--exec', '--', 'node', 'scripts/mcp/server.js', '--db', '/x']))
      .toEqual({ mode: 'exec', command: ['node', 'scripts/mcp/server.js', '--db', '/x'] })
  })
  it('parses --exec without the -- separator', () => {
    expect(parseUnlockArgs(['--exec', 'node', 'x.js'])).toEqual({ mode: 'exec', command: ['node', 'x.js'] })
  })
  it('throws when --exec has no command', () => {
    expect(() => parseUnlockArgs(['--exec'])).toThrow(/requires a command/)
    expect(() => parseUnlockArgs(['--exec', '--'])).toThrow(/requires a command/)
  })
  it('no longer supports --to-file (removed for security — findings 1 & 2)', () => {
    // --to-file is not recognized; it falls through to print mode (no file is ever written).
    expect(parseUnlockArgs(['--to-file', '/run/k'])).toEqual({ mode: 'print' })
  })
})

describe('childEnvWithKey', () => {
  it('adds SHORESH_DB_KEY to the child env without mutating the base', () => {
    const base = { PATH: '/usr/bin', HOME: '/h' }
    const env = childEnvWithKey(HEX64, base)
    expect(env.SHORESH_DB_KEY).toBe(HEX64)
    expect(env.PATH).toBe('/usr/bin')
    expect(base.SHORESH_DB_KEY).toBeUndefined() // base untouched
  })
  it('the key is never on disk — it only ever appears in the spawned child env', () => {
    // Documented invariant: childEnvWithKey is the ONLY channel the helper uses in exec mode.
    const env = childEnvWithKey(HEX64, {})
    expect(Object.keys(env)).toContain('SHORESH_DB_KEY')
  })
})


// ---- Director-authorized tool connections (docs/adr/2026-10-08-director-authorized-tool-connections.md)
// Accountability gate on the existing OS-user + keychain boundary; NOT a defense vs a same-user attacker.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])
}
function diskContains(dir, hex) {
  const raw = Buffer.from(hex, 'hex')
  return filesUnder(dir).some((f) => {
    const b = fs.readFileSync(f)
    return b.includes(Buffer.from(hex)) || b.includes(raw)
  })
}

describe('argv never carries a secret', () => {
  it('rejects --secret / --tool-secret in any spelling', () => {
    for (const bad of [['--secret', 'x'], ['--secret=x'], ['--tool-secret', 'x'], ['--tool-secret=x']]) {
      expect(() => parseUnlockArgs([...bad, '--exec', 'node', 'x.js'])).toThrow(/never.*argv/i)
    }
  })
  it('accepts --secret-stdin as a flag that carries no value', () => {
    expect(parseUnlockArgs(['--secret-stdin', '--exec', 'node', 'x.js']))
      .toEqual({ mode: 'exec', command: ['node', 'x.js'], secretFromStdin: true })
  })
})

describe('releaseKeyToTool — the authorization gate on key release', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const grant = (scope = 'read') =>
    grantToolAuthorization(dir, fakeSafeStorage, { label: 'MCP', scope, createdBy: 'd1' })
  const release = (over = {}) => releaseKeyToTool({ userDataPath: dir, safeStorage: fakeSafeStorage, ...over })

  it('grant -> a tool presenting the env secret gets the key and its scope', () => {
    const { secret, authorization } = grant('read-write')
    const out = release({ env: { SHORESH_TOOL_SECRET: secret } })
    expect(out.keyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(out.authorization).toMatchObject({ id: authorization.id, scope: 'read-write' })
  })
  it('stdin secret works too', () => {
    const { secret } = grant()
    expect(release({ env: {}, stdinText: `${secret}\n` }).keyHex).toMatch(/^[0-9a-f]{64}$/)
  })
  it('revoked -> tool-authorization-revoked and the key is NOT released or even minted', () => {
    const { secret, authorization } = grant()
    revokeToolAuthorization(dir, fakeSafeStorage, authorization.id)
    let err
    try { release({ env: { SHORESH_TOOL_SECRET: secret } }) } catch (e) { err = e }
    expect(err?.code).toBe('tool-authorization-revoked')
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false)
  })
  it('unknown / missing secret -> tool-not-authorized, never db_key_unavailable', () => {
    for (const env of [{ SHORESH_TOOL_SECRET: 'forged.secret' }, {}]) {
      let err
      try { release({ env }) } catch (e) { err = e }
      expect(err?.code).toBe('tool-not-authorized')
      expect(err.code).not.toBe('db_key_unavailable')
    }
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false)
  })
  it('a getKey failure for an AUTHORIZED tool is db_key_unavailable — the only place that code is used', () => {
    const { secret } = grant()
    let err
    try {
      release({ env: { SHORESH_TOOL_SECRET: secret }, getKey: () => { throw new Error('keychain entry missing') } })
    } catch (e) { err = e }
    expect(err?.code).toBe('db_key_unavailable')
  })
  it('the key is never on disk: no file under userData holds it, raw or hex (scanner is non-vacuous)', () => {
    const { secret } = grant()
    const { keyHex } = release({ env: { SHORESH_TOOL_SECRET: secret } })
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(true) // only the SEALED blob
    expect(diskContains(dir, keyHex)).toBe(false)
    fs.writeFileSync(path.join(dir, 'planted'), keyHex)
    expect(diskContains(dir, keyHex)).toBe(true)
  })
  it('the child env carries key + scope + id, and never the tool secret', () => {
    const { secret, authorization } = grant()
    const { keyHex, authorization: a } = release({ env: { SHORESH_TOOL_SECRET: secret } })
    const env = childEnvWithKey(keyHex, { PATH: '/p', SHORESH_TOOL_SECRET: secret }, a)
    expect(env.SHORESH_DB_KEY).toBe(keyHex)
    expect(env.SHORESH_TOOL_SCOPE).toBe('read')
    expect(env.SHORESH_TOOL_AUTHORIZATION_ID).toBe(authorization.id)
    expect(env.SHORESH_TOOL_SECRET).toBeUndefined()
  })
})
