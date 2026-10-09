// Audit #22 — after a FRESH camp bootstrap the sync node must be actually
// listening in the same session. Unlike main.test.js's T273 tests (which hand
// bootstrapCamp a stub starter), this wires the REAL makeHandlers to the REAL
// createAutomergeSyncStarter and the REAL startSyncNode, exactly as main.js's
// initialHandlers does.
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

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { makeHandlers } from './main.js'
import { createAutomergeSyncStarter } from './sync/automerge/syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './sync/automerge/liveDoc.js'

let db, dbFile, deviceId, userDataPath, starter, handlers

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  dbFile = t.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-sab-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  starter = createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null,
    getMainWindow: () => null,
    getLiveHandlers: () => handlers,
  })
  handlers = makeHandlers(db, deviceId, {
    getAutomergeSyncNode: () => starter.getNode(),
    getAutomergeStartupAttempted: () => starter.getStartupAttempted(),
    onCampBootstrapped: () => starter.start(),
  })
})

afterEach(async () => {
  await starter.getNode()?.stop?.()
  vi.restoreAllMocks()
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out')
}

describe('sync after a fresh bootstrap (audit #22)', () => {
  it('node is listening without restart, and logs one start line with the addr count', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh' })
    await handlers.bootstrapCamp({ campName: 'Camp Shoresh', adminName: 'Root', adminPin: '999999' })

    const node = await waitFor(() => starter.getNode())
    expect(node.getMultiaddrs().length).toBeGreaterThan(0)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^automerge sync: node started, listening on \d+ address/))
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/\/p2p\/|[0-9a-f]{32}/)
  })

  it('logs a start-failure line with the message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = createAutomergeSyncStarter({
      deviceId, db, userDataPath, docCipher: null,
      getMainWindow: () => null, getLiveHandlers: () => null,
      startSyncNodeImpl: async () => async () => { throw new Error('EADDRINUSE') },
    })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh' })
    await handlers.bootstrapCamp({ campName: 'Camp Shoresh', adminName: 'Root', adminPin: '999999' })
    await starter.getNode() // noop; the real starter may be starting in the background
    await failing.start()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'))
  })
})
