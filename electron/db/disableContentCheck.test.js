// @vitest-environment node
// T345 keeper condition A: no backup is deleted on a header-only check. Both the live disable and boot
// recovery's roll-forward reopen the plaintext db keyless (integrity + per-table row counts recorded in the
// journal before the swap) and LOAD the plaintext document as Automerge (hash recorded in the journal).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { recoverInterruptedDisable, writeJournal, backupPathFor, DISABLE_JOURNAL_FILE } from './disableRecovery.js'
import { disableAtRestEncryption } from './disableAtRestEncryption.js'
import { getOrCreateDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher } from './docCipher.js'
import { fakeDriver, FAKE_MAGIC } from './fakeCipherDriver.js'
import { saveDoc, createEmptyDoc } from '../automerge/campDocument.js'

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
}
const STAMP = '2026-10-11T00-00-00-000Z'
const COUNTS = { camps: 1, users: 3 }
const docBytes = Buffer.from(saveDoc(createEmptyDoc()))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function setup({ keyGone = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-disable-content-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'automerge'))
  const key = getOrCreateDbKey(dir, safeStorage)
  const cipher = makeDocCipher(key)
  const env = {
    dir, key, cipher,
    dbPath: path.join(dir, 'camp.sqlite'),
    docPath: path.join(dir, 'automerge', 'camp-1.automerge'),
    keyPath: path.join(dir, KEY_FILE),
    markerPath: path.join(dir, 'encryption.disabled'),
  }
  fs.writeFileSync(backupPathFor(env.dbPath, STAMP), `ENC${JSON.stringify(COUNTS)}`, 'latin1')
  fs.writeFileSync(backupPathFor(env.docPath, STAMP), cipher.encrypt(docBytes))
  fs.writeFileSync(env.dbPath, FAKE_MAGIC + JSON.stringify(COUNTS), 'latin1')
  fs.writeFileSync(env.docPath, docBytes)
  if (keyGone) fs.renameSync(env.keyPath, `${env.keyPath}.disabling`)
  writeJournal(dir, {
    state: 'committing', stamp: STAMP,
    files: [
      { kind: 'db', path: env.dbPath, counts: COUNTS },
      { kind: 'doc', path: env.docPath, sha256: sha(docBytes), length: docBytes.length },
    ],
  })
  return env
}
const recover = (env) => recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() })
const backupsKept = (env) => fs.existsSync(backupPathFor(env.dbPath, STAMP)) && fs.existsSync(backupPathFor(env.docPath, STAMP))

describe('roll-forward after the key is gone: full content check before any backup is deleted', () => {
  it('good plaintext db and document -> completed, backups deleted', () => {
    const env = setup()
    expect(recover(env).outcome).toBe('completed')
    expect(fs.existsSync(backupPathFor(env.dbPath, STAMP))).toBe(false)
    expect(fs.existsSync(backupPathFor(env.docPath, STAMP))).toBe(false)
    expect(fs.existsSync(path.join(env.dir, DISABLE_JOURNAL_FILE))).toBe(false)
  })

  it('db with a plaintext header but torn contents -> backups kept, fails closed', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, FAKE_MAGIC + '{"camps":1,"us', 'latin1')
    const res = recover(env)
    expect(res.outcome).toBe('unverified_plain')
    expect(res.message).toMatch(/nothing was deleted/i)
    expect(backupsKept(env)).toBe(true)
    expect(fs.existsSync(path.join(env.dir, DISABLE_JOURNAL_FILE))).toBe(true)
    expect(fs.existsSync(`${env.keyPath}.disabling`)).toBe(true)
  })

  it('db whose row counts differ from the journal -> backups kept', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, FAKE_MAGIC + JSON.stringify({ camps: 1, users: 2 }), 'latin1')
    expect(recover(env).outcome).toBe('unverified_plain')
    expect(backupsKept(env)).toBe(true)
  })

  it('document with the Automerge header but torn body -> backups kept', () => {
    const env = setup()
    fs.writeFileSync(env.docPath, docBytes.subarray(0, Math.floor(docBytes.length / 2)))
    expect(recover(env).outcome).toBe('unverified_plain')
    expect(backupsKept(env)).toBe(true)
  })

  it('document that parses but is not the recorded one -> backups kept', () => {
    const env = setup()
    const other = Buffer.from(saveDoc(createEmptyDoc()))
    other[other.length - 1] ^= 0xff
    fs.writeFileSync(env.docPath, other)
    expect(recover(env).outcome).toBe('unverified_plain')
    expect(backupsKept(env)).toBe(true)
  })

  it('a journal that recorded no expectations cannot verify -> backups kept', () => {
    const env = setup()
    writeJournal(env.dir, { state: 'committing', stamp: STAMP, files: [{ kind: 'db', path: env.dbPath }, { kind: 'doc', path: env.docPath }] })
    expect(recover(env).outcome).toBe('unverified_plain')
    expect(backupsKept(env)).toBe(true)
  })

  it('a later boot with the files repaired finishes the job', () => {
    const env = setup()
    const good = fs.readFileSync(env.dbPath)
    fs.writeFileSync(env.dbPath, FAKE_MAGIC + '{"camps', 'latin1')
    expect(recover(env).outcome).toBe('unverified_plain')
    fs.writeFileSync(env.dbPath, good)
    expect(recover(env).outcome).toBe('completed')
    expect(fs.existsSync(backupPathFor(env.dbPath, STAMP))).toBe(false)
  })
})

describe('roll-forward while the key is still in place: a failed content check rolls back', () => {
  it('torn plaintext db, key present -> rolled back to the encrypted backups', () => {
    const env = setup({ keyGone: false })
    fs.writeFileSync(env.dbPath, FAKE_MAGIC + '{"camps":1,"us', 'latin1')
    expect(recover(env).outcome).toBe('rolled_back')
    expect(fs.existsSync(env.keyPath)).toBe(true)
    expect(fs.readFileSync(env.dbPath, 'latin1')).toBe(`ENC${JSON.stringify(COUNTS)}`)
    expect(backupsKept(env)).toBe(false)
  })
})

describe('live disable: the same content check runs before the key moves', () => {
  it('a document that parses wrong after the swap rolls the whole disable back with the key in place', () => {
    const env = setup({ keyGone: false })
    fs.rmSync(path.join(env.dir, DISABLE_JOURNAL_FILE))
    for (const f of [backupPathFor(env.dbPath, STAMP), backupPathFor(env.docPath, STAMP)]) fs.rmSync(f)
    fs.writeFileSync(env.dbPath, `ENC${JSON.stringify(COUNTS)}`, 'latin1')
    fs.writeFileSync(env.docPath, env.cipher.encrypt(docBytes))
    const fsImpl = {
      ...fs,
      renameSync: (a, b) => {
        fs.renameSync(a, b)
        if (b === env.docPath) fs.writeFileSync(b, docBytes.subarray(0, 20))
      },
    }
    expect(() => disableAtRestEncryption({ userDataDir: env.dir, dbPaths: [env.dbPath], safeStorage, Database: fakeDriver(), fsImpl }))
      .toThrow()
    expect(fs.existsSync(env.keyPath)).toBe(true)
    expect(fs.existsSync(env.markerPath)).toBe(false)
    expect(fs.readFileSync(env.docPath).equals(docBytes)).toBe(false)
    expect(env.cipher.decrypt(fs.readFileSync(env.docPath)).equals(docBytes)).toBe(true)
  })
})
