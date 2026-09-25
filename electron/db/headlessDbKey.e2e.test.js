// @vitest-environment node
//
// END-TO-END proof of the HEADLESS at-rest-key path — the one chain T175 left unproven: a plain-Node
// tool (MCP server / ingest CLI), handed the key ONLY on the protected env channel, opens a REAL
// SQLCipher-encrypted DB and reads it back. It exercises the real chain
//
//     resolveHeadlessDbKey (env → Buffer)  →  openLocalDb keyed  →  read a row
//
// against a THROWAWAY encrypted DB created with a FIXED TEST key, and the unlock-helper exec plumbing
// (parseUnlockArgs + childEnvWithKey → a spawned child receives the key in its env only). It does NOT
// touch safeStorage or the OS keychain — the keychain unseal was proven on 2026-09-16 and is
// deliberately out of scope (owner ruling 2026-09-25: don't touch access); the test SUBSTITUTES a
// fixed test key at that boundary.
//
// GATING: the real crypto needs the encrypting driver (better-sqlite3-multiple-ciphers). Where it is
// not usably built for this runtime, the driver-dependent group SKIPS with a visible "driver ABSENT
// — not a pass" marker (mirroring sqliteCipher.integration.test.js), never a silent green. The
// flag-guard and unlock-plumbing assertions are ABI-independent and always run.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ABI-independent, no dependence on the at-rest flag → safe to import statically.
import { resolveHeadlessDbKey } from './headlessDbKey.js'
import { parseUnlockArgs, childEnvWithKey } from '../unlockDbKey.js'
import { isPlaintextSqliteFile } from './sqliteCipher.js'
import { KEY_BYTES } from './dbEncryptionKey.js'

// The at-rest flag (atRestEncryption.js) is read ONCE at that module's import. To exercise the T260
// `db_key_unavailable` guard — which only fires when encryption is ENABLED in THIS process — the flag
// must be set BEFORE the module graph that reads it is evaluated. So it is set here at top-level
// (before beforeAll), and openLocalDb is pulled in via DYNAMIC import in beforeAll so it observes the
// enabled flag. Restored in afterAll: this project runs with per-file isolation (vite.config.js
// `isolated`), so a fresh registry re-reads the env for the next file, but restoring is correct
// hygiene regardless.
const priorFlag = process.env.SHORESH_AT_REST_ENCRYPTION
process.env.SHORESH_AT_REST_ENCRYPTION = 'on'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..')
const LOCAL_DB_URL = new URL('./localDb.js', import.meta.url).href
const HEADLESS_KEY_URL = new URL('./headlessDbKey.js', import.meta.url).href

// A fixed 32-byte TEST key — deterministic, never a real device key, never from the keychain.
const TEST_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const WRONG_KEY_HEX = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'

let openLocalDb
let driverAvailable = false

beforeAll(async () => {
  ;({ openLocalDb } = await import(LOCAL_DB_URL))
  const require = createRequire(import.meta.url)
  // require() succeeding is NOT enough — the native binding loads lazily and only fails at
  // construction. Build a throwaway in-memory db to prove the driver is usable in THIS runtime.
  try {
    const D = require('better-sqlite3-multiple-ciphers')
    D(':memory:').close()
    driverAvailable = true
  } catch {
    driverAvailable = false
  }
})

afterAll(() => {
  if (priorFlag === undefined) delete process.env.SHORESH_AT_REST_ENCRYPTION
  else process.env.SHORESH_AT_REST_ENCRYPTION = priorFlag
})

const tmp = []
function tmpFile(tag) {
  const f = path.join(os.tmpdir(), `shoresh-headless-e2e-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  tmp.push(f)
  return f
}
afterAll(() => {
  for (const f of tmp.splice(0)) {
    for (const s of ['', '-wal', '-shm', '.enc-migrate', '.bak']) {
      try { fs.rmSync(`${f}${s}`, { force: true }) } catch { /* */ }
    }
    // clean any pre-migration backups left beside the file
    try {
      const dir = path.dirname(f)
      const base = path.basename(f)
      for (const n of fs.readdirSync(dir)) {
        if (n.startsWith(base)) { try { fs.rmSync(path.join(dir, n), { force: true }) } catch { /* */ } }
      }
    } catch { /* */ }
  }
})

// ── ABI-INDEPENDENT: the key channel and unlock-helper plumbing ────────────────────────────────────
// These run on every runtime; they need no native driver.

describe('headless key channel — resolver + unlock-helper plumbing (no driver, no keychain)', () => {
  it('resolveHeadlessDbKey reads a valid key from SHORESH_DB_KEY as a 32-byte Buffer', () => {
    const key = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: TEST_KEY_HEX } })
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(KEY_BYTES)
    expect(key.toString('hex')).toBe(TEST_KEY_HEX)
  })

  it('resolveHeadlessDbKey returns null when no channel is set (INERT — caller opens plaintext)', () => {
    expect(resolveHeadlessDbKey({ env: {} })).toBe(null)
  })

  it('resolveHeadlessDbKey THROWS on a malformed key rather than silently opening plaintext', () => {
    expect(() => resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: 'deadbeef' } })).toThrow(/hex characters/)
  })

  it('parseUnlockArgs routes --exec to the child command, default to print', () => {
    expect(parseUnlockArgs(['--exec', '--', 'node', 'scripts/mcp/server.js', '--db', '/p'])).toEqual({
      mode: 'exec',
      command: ['node', 'scripts/mcp/server.js', '--db', '/p'],
    })
    expect(parseUnlockArgs(['--print'])).toEqual({ mode: 'print' })
  })

  it('childEnvWithKey puts the key in the child ENV ONLY — never in the command argv', () => {
    const parsed = parseUnlockArgs(['--exec', '--', 'node', 'scripts/mcp/server.js', '--db', '/p'])
    const env = childEnvWithKey(TEST_KEY_HEX, { PATH: '/usr/bin' })
    expect(env.SHORESH_DB_KEY).toBe(TEST_KEY_HEX)
    expect(env.PATH).toBe('/usr/bin') // base env preserved
    // The secret must not travel on argv (world-visible in `ps`): assert it is absent from the command.
    expect(parsed.command.join(' ')).not.toContain(TEST_KEY_HEX)
  })
})

// The T260 guard fires BEFORE any driver is touched, so it is ABI-independent too.
describe('T260 fail-closed: encryption enabled in-process + no key = refuse by name', () => {
  it('openLocalDb refuses with db_key_unavailable when the flag is on and no key reached it', () => {
    let threw
    try {
      openLocalDb(tmpFile('noguard-should-not-create'))
    } catch (err) {
      threw = err
    }
    expect(threw).toBeDefined()
    expect(threw.code).toBe('db_key_unavailable')
  })
})

// ── DRIVER-DEPENDENT: the real SQLCipher end-to-end chain ───────────────────────────────────────────
describe.skipIf(!driverAvailable)('headless E2E — real encrypted DB read back through the env-key channel', () => {
  it('creates an encrypted DB with a fixed TEST key, then a headless open via SHORESH_DB_KEY reads it back', () => {
    const f = tmpFile('readback')
    const testKey = Buffer.from(TEST_KEY_HEX, 'hex')

    // Producer: create the real encrypted DB with the fixed test key (openLocalDb keyed path).
    let db = openLocalDb(f, { key: testKey })
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c-e2e', 'Encrypted Camp')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(false) // encrypted header, not "SQLite format 3\0"

    // Headless consumer: key arrives ONLY on the protected env channel → resolver → keyed open → read.
    const key = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: TEST_KEY_HEX } })
    db = openLocalDb(f, { key })
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c-e2e').name).toBe('Encrypted Camp')
    db.close()
  })

  it('NON-VACUITY: a WRONG key on the same channel is REJECTED (proves the channel is load-bearing)', () => {
    const f = tmpFile('wrongchannel')
    db_write(f)

    // Right key reads back…
    const good = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: TEST_KEY_HEX } })
    let db = openLocalDb(f, { key: good })
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c-e2e').name).toBe('Encrypted Camp')
    db.close()

    // …a wrong key on the identical code path is rejected — not merely "an error", specifically the
    // wrong-key open/read fails while the right key above succeeded.
    const wrong = resolveHeadlessDbKey({ env: { SHORESH_DB_KEY: WRONG_KEY_HEX } })
    expect(() => {
      const bad = openLocalDb(f, { key: wrong })
      bad.prepare('SELECT name FROM camps').get()
      bad.close()
    }).toThrow()
  })

  it('a headless open WITHOUT the key against the encrypted file fails CLOSED (db_key_unavailable)', () => {
    const f = tmpFile('nokey')
    db_write(f)
    // No channel set → resolver returns null → with the flag on, openLocalDb refuses by name rather
    // than falling to the plaintext driver against encrypted bytes.
    const key = resolveHeadlessDbKey({ env: {} })
    expect(key).toBe(null)
    let threw
    try { openLocalDb(f, { key }) } catch (err) { threw = err }
    expect(threw?.code).toBe('db_key_unavailable')
  })

  it('SPAWN E2E: a separate plain-Node process, given the key in its ENV ONLY, reads the row back', () => {
    const f = tmpFile('spawn')
    db_write(f)

    const child = writeChildReader()
    // Build the child env exactly the way unlockDbKey --exec does: base env + SHORESH_DB_KEY.
    // Carry the flag through so the child's openLocalDb sees encryption enabled (matches how the real
    // unlock helper's child inherits the launching process env).
    const env = childEnvWithKey(TEST_KEY_HEX, { ...process.env })
    const res = spawnSync(process.execPath, [child, f], { cwd: REPO_ROOT, env, encoding: 'utf8' })

    // The key must NOT appear on the child's argv (only [scriptPath, dbPath] were passed).
    expect([child, f].join(' ')).not.toContain(TEST_KEY_HEX)
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toContain('Encrypted Camp')
  })

  it('SPAWN NON-VACUITY: the same process WITHOUT the env key fails (env channel is load-bearing)', () => {
    const f = tmpFile('spawn-nokey')
    db_write(f)

    const child = writeChildReader()
    const env = { ...process.env }
    delete env.SHORESH_DB_KEY // remove the channel
    const res = spawnSync(process.execPath, [child, f], { cwd: REPO_ROOT, env, encoding: 'utf8' })

    expect(res.status).not.toBe(0) // child could not obtain the key → fails closed
    expect(res.stdout.trim()).not.toContain('Encrypted Camp')
  })
})

// Visible marker: a skipped driver run must never read as a pass for encryption.
describe('headless E2E driver availability', () => {
  it(driverAvailable
    ? 'driver present — headless encryption E2E ran'
    : 'driver ABSENT — headless E2E skipped (NOT a pass for encryption)', () => {
    expect(typeof driverAvailable).toBe('boolean')
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
// Create the encrypted fixture DB with the fixed test key + one known row.
function db_write(f) {
  const db = openLocalDb(f, { key: Buffer.from(TEST_KEY_HEX, 'hex') })
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c-e2e', 'Encrypted Camp')
  db.close()
}

// A tiny plain-Node reader that mirrors a headless tool: resolve the key from the env channel, open
// the DB keyed, print the row. It imports the REAL repo modules by absolute file URL, so bare deps
// (better-sqlite3-multiple-ciphers) resolve from the repo's node_modules regardless of cwd.
let _childPath = null
function writeChildReader() {
  if (_childPath) return _childPath
  const script = `
import { resolveHeadlessDbKey } from ${JSON.stringify(HEADLESS_KEY_URL)}
import { openLocalDb } from ${JSON.stringify(LOCAL_DB_URL)}
const f = process.argv[2]
const key = resolveHeadlessDbKey()
if (!key) { openLocalDb(f, { key }) /* flag on + no key → throws db_key_unavailable */ }
const db = openLocalDb(f, { key })
const row = db.prepare('SELECT name FROM camps WHERE id = ?').get('c-e2e')
db.close()
process.stdout.write(String(row && row.name))
`
  _childPath = path.join(os.tmpdir(), `shoresh-headless-child-${Date.now()}-${Math.random()}.mjs`)
  fs.writeFileSync(_childPath, script, 'utf8')
  tmp.push(_childPath)
  return _childPath
}
