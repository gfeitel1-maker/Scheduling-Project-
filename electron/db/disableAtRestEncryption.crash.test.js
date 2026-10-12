// @vitest-environment node
// T345 kill-mid-disable recovery (docs/adr/2026-09-28-at-rest-encryption-disable-control.md, "Crash safety").
// The process is "killed" before EVERY filesystem mutation (and driver rekey) the disable performs, once
// cleanly and once with the interrupted write torn in half, then boot recovery runs on the same directory.
// After recovery the device must be in exactly one of two KNOWN states and never half of each:
//   encrypted: key present, no opt-out marker, db + document still encrypted and readable with identical content
//   plain:     key gone, opt-out marker present, db + document plaintext and readable with identical content
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { disableAtRestEncryption } from './disableAtRestEncryption.js'
import { recoverInterruptedDisable, DISABLE_JOURNAL_FILE } from './disableRecovery.js'
import { getOrCreateDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher, isEncrypted } from './docCipher.js'
import { isPlaintextSqliteFile, readTableCounts } from './sqliteCipher.js'
import { fakeDriver } from './fakeCipherDriver.js'
import { saveDoc, createEmptyDoc } from '../automerge/campDocument.js'

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
}
const tables = { camps: 1, users: 3 }
const otherTables = { camps: 5 }
const docBytes = Buffer.from(saveDoc(createEmptyDoc()))
const KILL = Object.assign(new Error('process killed'), { killed: true })

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-disable-crash-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'automerge'))
  const key = getOrCreateDbKey(dir, safeStorage)
  const cipher = makeDocCipher(key)
  const env = {
    dir, key, cipher,
    keyPath: path.join(dir, KEY_FILE),
    markerPath: path.join(dir, 'encryption.disabled'),
    dbPath: path.join(dir, 'camp.sqlite'),
    otherPath: path.join(dir, 'other.sqlite'),
    docPath: path.join(dir, 'automerge', 'camp-1.automerge'),
  }
  fs.writeFileSync(env.dbPath, `ENC${JSON.stringify(tables)}`, 'latin1')
  fs.writeFileSync(env.otherPath, `ENC${JSON.stringify(otherTables)}`, 'latin1')
  fs.writeFileSync(env.docPath, cipher.encrypt(docBytes))
  return env
}

// Every mutating fs call (and the driver's rekey) is a numbered step. At step `killAt` the process dies:
// that call and every later one throws, so no cleanup or rollback code can run, exactly like SIGKILL.
// `torn` additionally leaves the killed write half-done on disk.
function killable({ killAt = Infinity, torn = false } = {}) {
  let n = 0
  let dead = false
  const log = []
  const step = (label, run, tear) => {
    if (dead) throw KILL
    n++
    log.push(label)
    if (n === killAt) {
      dead = true
      if (torn && tear) { try { tear() } catch { /* the tear itself may fail */ } }
      throw KILL
    }
    return run()
  }
  const half = (b) => b.subarray(0, Math.floor(b.length / 2))
  const fsImpl = {
    ...fs,
    writeFileSync: (p, data, ...r) => step(`write ${path.basename(String(p))}`, () => fs.writeFileSync(p, data, ...r),
      () => fs.writeFileSync(p, half(Buffer.from(data)))),
    copyFileSync: (a, b, ...r) => step(`copy ${path.basename(String(a))} -> ${path.basename(String(b))}`, () => fs.copyFileSync(a, b, ...r),
      () => { fs.copyFileSync(a, b); fs.writeFileSync(b, half(fs.readFileSync(b))) }),
    renameSync: (a, b) => step(`rename ${path.basename(String(a))} -> ${path.basename(String(b))}`, () => fs.renameSync(a, b)),
    unlinkSync: (p) => step(`unlink ${path.basename(String(p))}`, () => fs.unlinkSync(p)),
    mkdirSync: (p, ...r) => step(`mkdir ${path.basename(String(p))}`, () => fs.mkdirSync(p, ...r)),
    rmSync: (p, ...r) => step(`rm ${path.basename(String(p))}`, () => fs.rmSync(p, ...r)),
  }
  const Database = fakeDriver({
    beforeRekey: (p) => step(`rekey ${path.basename(p)}`, () => {}, () => fs.writeFileSync(p, crypto.randomBytes(20))),
  })
  return { fsImpl, Database, count: () => n, log }
}

const names = (env) => [
  ...fs.readdirSync(env.dir), ...fs.readdirSync(path.join(env.dir, 'automerge')),
]
const LEFTOVER = /\.bak$|\.tmp$|\.disable-staged$|\.disabling$|disable-journal|\.unreadable/

function classify(env) {
  const keyThere = fs.existsSync(env.keyPath)
  const markerThere = fs.existsSync(env.markerPath)
  expect(names(env).filter((n) => LEFTOVER.test(n))).toEqual([])
  if (keyThere) {
    expect(markerThere).toBe(false)
    for (const [p, t] of [[env.dbPath, tables], [env.otherPath, otherTables]]) {
      expect(isPlaintextSqliteFile(p)).toBe(false)
      expect(readTableCounts(fakeDriver(), p, env.key)).toEqual(t)
    }
    const raw = fs.readFileSync(env.docPath)
    expect(isEncrypted(raw)).toBe(true)
    expect(env.cipher.decrypt(raw).equals(docBytes)).toBe(true)
    return 'encrypted'
  }
  expect(markerThere).toBe(true)
  for (const [p, t] of [[env.dbPath, tables], [env.otherPath, otherTables]]) {
    expect(isPlaintextSqliteFile(p)).toBe(true)
    expect(readTableCounts(fakeDriver(), p, null)).toEqual(t)
  }
  const raw = fs.readFileSync(env.docPath)
  expect(isEncrypted(raw)).toBe(false)
  expect(raw.equals(docBytes)).toBe(true)
  return 'plain'
}

const runDisable = (env, k) => disableAtRestEncryption({
  userDataDir: env.dir, dbPaths: [env.dbPath, env.otherPath], safeStorage,
  Database: k.Database, fsImpl: k.fsImpl,
})

function countSteps() {
  const env = setup()
  const k = killable()
  runDisable(env, k)
  return { total: k.count(), log: k.log }
}

describe('disable: kill at every step, then boot recovery', () => {
  it('an uninterrupted run is the plain state with nothing left behind', () => {
    const env = setup()
    runDisable(env, killable())
    expect(classify(env)).toBe('plain')
  })

  for (const torn of [false, true]) {
    it(`killed before every step (${torn ? 'torn write' : 'clean'}) -> encrypted or plain, never half`, () => {
      const { total } = countSteps()
      expect(total).toBeGreaterThan(10)
      const seen = new Set()
      for (let at = 1; at <= total; at++) {
        const env = setup()
        const k = killable({ killAt: at, torn })
        // a kill in the post-commit tail is swallowed there (it only collects warnings); the step count proves it fired
        try { runDisable(env, k) } catch { /* killed */ }
        expect(k.log.length, `step ${at} never fired`).toBe(at)
        const res = recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() })
        let state
        try { state = classify(env) } catch (err) { err.message = `after kill at step ${at} (${k.log[at - 1]}), outcome ${res.outcome}: ${err.message}`; throw err }
        seen.add(state)
        // recovery is idempotent: a second boot changes nothing
        expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('none')
        expect(classify(env)).toBe(state)
      }
      expect([...seen].sort()).toEqual(['encrypted', 'plain'])
    })
  }

  it('a disable that throws at any step leaves the key at its own path (the post-failure window can never reach a shredded key)', () => {
    const { total } = countSteps()
    let threw = 0
    for (let at = 1; at <= total; at++) {
      const env = setup()
      try { runDisable(env, killable({ killAt: at })) } catch {
        threw++
        expect(fs.existsSync(env.keyPath), `step ${at}`).toBe(true)
      }
    }
    expect(threw).toBeGreaterThan(10)
  }, 120000)

  it('recovery that is itself killed at every step still converges on a known state', () => {
    const { total } = countSteps()
    let checked = 0
    for (let at = 1; at <= total; at++) {
      const probe = setup()
      try { runDisable(probe, killable({ killAt: at })) } catch { /* killed */ }
      let steps = 0
      {
        const counter = killable()
        recoverInterruptedDisable({ userDataDir: probe.dir, Database: fakeDriver(), fsImpl: counter.fsImpl })
        steps = counter.count()
      }
      for (let rk = 1; rk <= steps; rk++) {
        const env = setup()
        try { runDisable(env, killable({ killAt: at })) } catch { /* killed */ }
        try { recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver(), fsImpl: killable({ killAt: rk }).fsImpl }) } catch (err) { expect(err.killed).toBe(true) }
        recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() })
        try { classify(env) } catch (err) { err.message = `kill at ${at}, recovery killed at ${rk}: ${err.message}`; throw err }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  }, 180000)
})

describe('disable: unreadable or unrecognised journal fails closed', () => {
  const cases = {
    'garbage bytes': () => crypto.randomBytes(40),
    'truncated json': () => Buffer.from('{"version":1,"state":"commit'),
    'empty file': () => Buffer.alloc(0),
    'unknown version': () => Buffer.from(JSON.stringify({ version: 99, state: 'committing', stamp: '2026-10-11T00-00-00-000Z', files: [] })),
    'unknown state': () => Buffer.from(JSON.stringify({ version: 1, state: 'halfway', stamp: '2026-10-11T00-00-00-000Z', files: [] })),
    'path-escaping stamp': () => Buffer.from(JSON.stringify({ version: 1, state: 'committing', stamp: '../../etc', files: [] })),
    'files not a list': () => Buffer.from(JSON.stringify({ version: 1, state: 'committing', stamp: '2026-10-11T00-00-00-000Z', files: 'x' })),
    'unknown file kind': () => Buffer.from(JSON.stringify({ version: 1, state: 'committing', stamp: '2026-10-11T00-00-00-000Z', files: [{ kind: 'rm-rf', path: '/' }] })),
  }
  for (const [name, make] of Object.entries(cases)) {
    it(`${name}: stays encrypted, touches no data, says so in plain words`, () => {
      const env = setup()
      fs.writeFileSync(path.join(env.dir, DISABLE_JOURNAL_FILE), make())
      const res = recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() })
      expect(res.outcome).toBe('unreadable_journal')
      expect(res.message).toMatch(/still (on|encrypted)|not changed/i)
      expect(res.message).not.toMatch(/ENOENT|undefined|SyntaxError|\[object/)
      const aside = `${path.join(env.dir, DISABLE_JOURNAL_FILE)}.unreadable`
      expect(fs.existsSync(aside)).toBe(true)
      expect(fs.existsSync(path.join(env.dir, DISABLE_JOURNAL_FILE))).toBe(false)
      fs.rmSync(aside)
      expect(classify(env)).toBe('encrypted')
      expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('none')
    })
  }

  it('a commit-phase journal whose files are neither staged, swapped nor backed up: not trusted, deletes nothing', () => {
    const env = setup()
    const stamp = '2026-10-11T00-00-00-000Z'
    fs.writeFileSync(path.join(env.dir, DISABLE_JOURNAL_FILE), JSON.stringify({
      version: 1, state: 'committing', stamp, files: [{ kind: 'db', path: env.dbPath }, { kind: 'doc', path: env.docPath }],
    }))
    fs.writeFileSync(env.dbPath, `SQLite format 3\0${JSON.stringify(tables)}`, 'latin1')
    const before = fs.readFileSync(env.dbPath)
    const res = recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() })
    expect(res.outcome).toBe('unreadable_journal')
    expect(res.message).toMatch(/still on|nothing was changed|nothing was deleted/i)
    expect(fs.readFileSync(env.dbPath).equals(before)).toBe(true)
    expect(fs.existsSync(env.keyPath)).toBe(true)
  })
})
