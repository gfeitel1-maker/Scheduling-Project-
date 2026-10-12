// @vitest-environment node
// T345 review hardening: recovery must not trust a journal alone before the irreversible key shred, and the
// commit path must be durable (fsync) so a power loss cannot leave a renamed-in file empty.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { recoverInterruptedDisable, writeJournal, atomicWrite, backupPathFor, DISABLE_JOURNAL_FILE } from './disableRecovery.js'
import { getOrCreateDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher } from './docCipher.js'
import { FAKE_MAGIC, fakeDriver } from './fakeCipherDriver.js'
import { saveDoc, createEmptyDoc } from '../automerge/campDocument.js'

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
}
const STAMP = '2026-10-11T00-00-00-000Z'
const docBytes = Buffer.from(saveDoc(createEmptyDoc()))
const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-disable-hard-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'automerge'))
  const key = getOrCreateDbKey(dir, safeStorage)
  const cipher = makeDocCipher(key)
  const dbPath = path.join(dir, 'camp.sqlite')
  const docPath = path.join(dir, 'automerge', 'camp-1.automerge')
  const encDb = Buffer.from('ENC{"camps":1}', 'latin1')
  const encDoc = cipher.encrypt(docBytes)
  return { dir, dbPath, docPath, encDb, encDoc, keyPath: path.join(dir, KEY_FILE), markerPath: path.join(dir, 'encryption.disabled') }
}
const plainDb = () => Buffer.from(`${FAKE_MAGIC}{"camps":1}`, 'latin1')
const journalOf = (env, files) => ({ state: 'committing', stamp: STAMP, files })
const dbEntry = (env) => ({ kind: 'db', path: env.dbPath, counts: { camps: 1 } })
const docEntry = (env) => ({ kind: 'doc', path: env.docPath, sha256: crypto.createHash('sha256').update(docBytes).digest('hex'), length: docBytes.length })

function expectStillEncrypted(env) {
  expect(fs.existsSync(env.keyPath)).toBe(true)
  expect(fs.existsSync(env.markerPath)).toBe(false)
}

describe('recovery does not trust a journal alone before shredding the key', () => {
  it('a committing journal with no files is unreadable and keeps the key', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, env.encDb)
    writeJournal(env.dir, journalOf(env, []))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('unreadable_journal')
    expectStillEncrypted(env)
    expect(fs.readFileSync(env.dbPath).equals(env.encDb)).toBe(true)
  })

  it('a committing journal that does not cover the camp db is unreadable', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, env.encDb)
    fs.writeFileSync(env.docPath, docBytes)
    fs.writeFileSync(backupPathFor(env.docPath, STAMP), env.encDoc)
    writeJournal(env.dir, journalOf(env, [docEntry(env)]))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('unreadable_journal')
    expectStillEncrypted(env)
  })

  it('a committing journal whose files have no backups (never a genuine commit) is unreadable', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, plainDb())
    fs.writeFileSync(env.docPath, docBytes)
    writeJournal(env.dir, journalOf(env, [dbEntry(env), docEntry(env)]))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('unreadable_journal')
    expectStillEncrypted(env)
  })

  it('a journal path outside the user data folder is unreadable', () => {
    const env = setup()
    const outside = path.join(os.tmpdir(), `shoresh-outside-${crypto.randomUUID()}.sqlite`)
    fs.writeFileSync(env.dbPath, env.encDb)
    writeJournal(env.dir, journalOf(env, [{ kind: 'db', path: outside }]))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('unreadable_journal')
    expectStillEncrypted(env)
  })

  it('a swapped-in document that is empty is not plain: recovery rolls back to the encrypted backups', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, plainDb())
    fs.writeFileSync(backupPathFor(env.dbPath, STAMP), env.encDb)
    fs.writeFileSync(env.docPath, Buffer.alloc(0))
    fs.writeFileSync(backupPathFor(env.docPath, STAMP), env.encDoc)
    writeJournal(env.dir, journalOf(env, [dbEntry(env), docEntry(env)]))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('rolled_back')
    expectStillEncrypted(env)
    expect(fs.readFileSync(env.docPath).equals(env.encDoc)).toBe(true)
  })

  it('a swapped-in document that is not an Automerge document is not plain', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, plainDb())
    fs.writeFileSync(backupPathFor(env.dbPath, STAMP), env.encDb)
    fs.writeFileSync(env.docPath, crypto.randomBytes(40))
    fs.writeFileSync(backupPathFor(env.docPath, STAMP), env.encDoc)
    writeJournal(env.dir, journalOf(env, [dbEntry(env), docEntry(env)]))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('rolled_back')
    expectStillEncrypted(env)
  })

  it('a genuine committing journal with verified plain files still completes', () => {
    const env = setup()
    fs.writeFileSync(env.dbPath, plainDb())
    fs.writeFileSync(backupPathFor(env.dbPath, STAMP), env.encDb)
    fs.writeFileSync(env.docPath, docBytes)
    fs.writeFileSync(backupPathFor(env.docPath, STAMP), env.encDoc)
    writeJournal(env.dir, journalOf(env, [dbEntry(env), docEntry(env)]))
    expect(recoverInterruptedDisable({ userDataDir: env.dir, Database: fakeDriver() }).outcome).toBe('completed')
    expect(fs.existsSync(env.keyPath)).toBe(false)
    expect(fs.existsSync(env.markerPath)).toBe(true)
    expect(fs.existsSync(path.join(env.dir, DISABLE_JOURNAL_FILE))).toBe(false)
  })
})

describe('durability: fsync before and after the renames', () => {
  it('atomicWrite fsyncs the temp file before the rename and the folder after', () => {
    const env = setup()
    const calls = []
    const fsImpl = {
      ...fs,
      fsyncSync: (fd) => { calls.push('fsync'); return fs.fsyncSync(fd) },
      renameSync: (a, b) => { calls.push('rename'); return fs.renameSync(a, b) },
    }
    atomicWrite(path.join(env.dir, 'x.json'), '{}', fsImpl)
    expect(calls).toEqual(['fsync', 'rename', 'fsync'])
  })
})
