// SHIP-BLOCKER (packaged main, fresh userData): "Start a new camp" left sync
// refused by the domain-state-migration guard. A FRESH database runs the whole
// migration chain (span from 0), and every domain-state migration in it ran
// against EMPTY tables — no camp existed to diverge from. Bootstrap then writes
// the document, the guard sees docExists && risky span, and refuses forever.
//
// Unlike syncAfterBootstrap.test.js (openTemplatedDb, which never records a
// from-0 span), these open the db through the REAL openLocalDb on a fresh path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openLocalDb, getOrCreateDeviceId, migrationSpanFor, CURRENT_SCHEMA_VERSION } from './db/localDb.js'
import { syncRefusalForDomainMigration } from './db/migrationDomainState.js'
import { makeHandlers } from './main.js'
import { createAutomergeSyncStarter } from './sync/automerge/syncStarter.js'
import { docPath as automergeDocPath } from './sync/automerge/docStore.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './sync/automerge/liveDoc.js'

let dir, dbFile, userDataPath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-fresh-'))
  dbFile = path.join(dir, 'shoresh.db')
  userDataPath = path.join(dir, 'userData')
  fs.mkdirSync(userDataPath)
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Starts the REAL starter with a stub node, and reports whether the guard let it through.
async function guardAllowsStart(db, deviceId) {
  const started = vi.fn(async () => ({ stop: async () => {}, getMultiaddrs: () => [] }))
  const starter = createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => started,
  })
  await starter.start()
  return started.mock.calls.length > 0
}

async function bootstrapFresh() {
  const db = openLocalDb(dbFile, { plaintext: true })
  expect(migrationSpanFor(db)).toEqual({ from: 0, to: CURRENT_SCHEMA_VERSION })
  const deviceId = getOrCreateDeviceId(db)
  const h = makeHandlers(db, deviceId, {})
  await h.chooseMode({ mode: 'host', campName: 'Camp Fresh' })
  await h.bootstrapCamp({ campName: 'Camp Fresh', adminName: 'Root', adminPin: '999999' })
  const campId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
  return { db, deviceId, campId }
}

describe('fresh camp: the domain-state-migration guard does not block sync', () => {
  it('fresh userData -> full chain -> bootstrap -> sync allowed in the same run', async () => {
    const { db, deviceId, campId } = await bootstrapFresh()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(fs.existsSync(automergeDocPath(userDataPath, campId))).toBe(true)
    expect(syncRefusalForDomainMigration(db, { docExists: true })).toBeNull()
    expect(await guardAllowsStart(db, deviceId)).toBe(true)
    db.close()
  })

  it('restart: reopening the same db after bootstrap -> sync allowed', async () => {
    const first = await bootstrapFresh()
    first.db.close()
    resetForTests()
    setUserDataDirGetter(() => userDataPath)
    setDocCipher(null)
    const db = openLocalDb(dbFile, { plaintext: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(syncRefusalForDomainMigration(db, { docExists: true })).toBeNull()
    expect(await guardAllowsStart(db, first.deviceId)).toBe(true)
    db.close()
  })
})

describe('the guard still protects an existing document-bearing camp', () => {
  it('a domain-state migration span from a non-zero version with a document is refused', async () => {
    const { db, deviceId } = await bootstrapFresh()
    db.close()
    // Simulate an existing camp at v69 upgraded past v70 on this launch.
    const raw = openLocalDb(dbFile, { plaintext: true })
    raw.prepare('DELETE FROM schema_migrations WHERE version > 69').run()
    raw.close()
    resetForTests()
    setUserDataDirGetter(() => userDataPath)
    setDocCipher(null)
    let reopened
    try {
      reopened = openLocalDb(dbFile, { plaintext: true })
    } catch {
      return expect.fail('re-running migrations from v69 must be idempotent for this fixture')
    }
    const span = migrationSpanFor(reopened)
    expect(span.from).toBe(69)
    const refusal = syncRefusalForDomainMigration(reopened, { docExists: true })
    expect(refusal?.versions).toEqual(expect.arrayContaining([70]))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await guardAllowsStart(reopened, deviceId)).toBe(false)
    reopened.close()
  })
})
