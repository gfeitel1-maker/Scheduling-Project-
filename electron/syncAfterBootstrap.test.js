// Audit #22 — after a FRESH camp bootstrap the sync node must be actually
// listening in the same session. Unlike main.test.js's T273 tests (which hand
// bootstrapCamp a stub starter), this wires the REAL makeHandlers to the REAL
// createAutomergeSyncStarter and the REAL startSyncNode, as main.js's
// initialHandlers does — except onCampBootstrapped calls starter.start() directly, not main.js's
// startAutomergeSyncNodeIfEnabled wrapper (its engine/camp/T268 gates are pinned by mainSyncStartupWiring.test.js).
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
import { createSyncStarterHolder } from './sync/automerge/syncStarterHolder.js'
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

describe('sync after a project switch / restore (db swap)', () => {
  it('a camp bootstrapped on the NEW db after a swap is listening without restart, and the old node is stopped', async () => {
    const mk = (d, id) => () => createAutomergeSyncStarter({
      deviceId: id, db: d, userDataPath, docCipher: null,
      getMainWindow: () => null,
      getLiveHandlers: () => null,
    })
    let curDb = db
    let curId = deviceId
    const holder = createSyncStarterHolder(() => mk(curDb, curId)())
    const h1 = makeHandlers(db, deviceId, holder.handlerOptions())
    await h1.chooseMode({ mode: 'host', campName: 'Camp One' })
    await h1.bootstrapCamp({ campName: 'Camp One', adminName: 'Root', adminPin: '999999' })
    const oldNode = await waitFor(() => holder.getNode())
    const oldStop = vi.spyOn(oldNode, 'stop')

    const t2 = openTemplatedDb()
    curDb = t2.db
    curId = getOrCreateDeviceId(t2.db)
    await holder.replace()
    expect(oldStop).toHaveBeenCalled()
    expect(holder.getNode()).toBeNull()

    const h2 = makeHandlers(curDb, curId, holder.handlerOptions())
    await h2.chooseMode({ mode: 'host', campName: 'Camp Two' })
    await h2.bootstrapCamp({ campName: 'Camp Two', adminName: 'Root', adminPin: '999999' })
    const node2 = await waitFor(() => holder.getNode())
    expect(node2).not.toBe(oldNode)
    expect(node2.getMultiaddrs().length).toBeGreaterThan(0)

    await node2.stop()
    t2.db.close()
    if (fs.existsSync(t2.file)) fs.unlinkSync(t2.file)
  })

  const mkStarter = (d, id, extra = {}) => createAutomergeSyncStarter({
    deviceId: id, db: d, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null, ...extra,
  })
  const withCamp = async (name) => {
    const t = openTemplatedDb()
    const id = getOrCreateDeviceId(t.db)
    const h = makeHandlers(t.db, id, {})
    await h.chooseMode({ mode: 'host', campName: name })
    await h.bootstrapCamp({ campName: name, adminName: 'Root', adminPin: '999999' })
    return { ...t, id }
  }
  const dropT = (t) => { t.db.close(); if (fs.existsSync(t.file)) fs.unlinkSync(t.file) }

  it('swapping to a db that ALREADY has a camp starts the node with no bootstrap call', async () => {
    const t2 = await withCamp('Existing Camp')
    let curDb = db
    let curId = deviceId
    const holder = createSyncStarterHolder(() => mkStarter(curDb, curId))
    curDb = t2.db
    curId = t2.id
    await holder.replace()
    const node = await waitFor(() => holder.getNode())
    expect(node.getMultiaddrs().length).toBeGreaterThan(0)
    await node.stop()
    dropT(t2)
  })

  it('a start in flight during replace leaves exactly one live node', async () => {
    const t1 = await withCamp('Camp A')
    const t2 = await withCamp('Camp B')
    const made = []
    let curDb = t1.db
    let curId = t1.id
    const impl = async () => {
      const real = (await import('./sync/automerge/syncNode.js')).startSyncNode
      return async (o) => {
        const n = await real(o)
        const stop = vi.spyOn(n, 'stop')
        made.push({ n, stop })
        return n
      }
    }
    const holder = createSyncStarterHolder(() => mkStarter(curDb, curId, { startSyncNodeImpl: impl }))
    holder.start()
    curDb = t2.db
    curId = t2.id
    await holder.replace()
    await waitFor(() => holder.getNode() && made.length >= 2)
    const live = made.filter((m) => m.stop.mock.calls.length === 0)
    expect(live).toHaveLength(1)
    expect(live[0].n).toBe(holder.getNode())
    await holder.getNode().stop()
    dropT(t1)
    dropT(t2)
  })

  it('a failure while building the swapped-in handlers leaves the old project on its node', async () => {
    const t1 = await withCamp('Camp A')
    const t2 = await withCamp('Camp B')
    let curDb = t1.db
    let curId = t1.id
    const holder = createSyncStarterHolder(() => mkStarter(curDb, curId))
    await holder.start()
    const oldNode = holder.getNode()
    expect(oldNode).toBeTruthy()
    await expect(holder.swap({
      commit: () => { curDb = t2.db; curId = t2.id },
      revert: () => { curDb = t1.db; curId = t1.id },
      build: () => { throw new Error('makeHandlers failed') },
    })).rejects.toThrow('makeHandlers failed')
    expect(curDb).toBe(t1.db)
    const node = await waitFor(() => holder.getNode())
    expect(node.getMultiaddrs().length).toBeGreaterThan(0)
    await node.stop()
    dropT(t1)
    dropT(t2)
  })

  it('logs a node.stop() failure on replace instead of swallowing it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t1 = await withCamp('Camp A')
    const holder = createSyncStarterHolder(() => mkStarter(t1.db, t1.id))
    await holder.start()
    const node = holder.getNode()
    const realStop = node.stop.bind(node)
    vi.spyOn(node, 'stop').mockRejectedValue(new Error('stop boom'))
    await holder.replace()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('stop boom'))
    await realStop()
    dropT(t1)
  })
})
