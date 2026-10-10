// @vitest-environment node
//
// A hung punchWiring.stop() must not stop the native libdatachannel cleanup from running: the
// process cannot exit without it, and will-quit's 5s race would otherwise re-quit into a hang.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const h = vi.hoisted(() => ({ stop: () => new Promise(() => {}), nativeShutdown: vi.fn(async () => {}) }))
vi.mock('./punchReconnectWiring.js', async (importOriginal) => ({ ...(await importOriginal()), wirePunchReconnect: async () => ({ stop: () => h.stop() }) }))
vi.mock('./punchTransport.js', () => ({
  punchTransport: () => () => ({ createListener: () => ({}) }),
  shutdownPunchNative: h.nativeShutdown,
}))
vi.mock('./punchEnablement.js', () => ({ punchRuntimeEligible: () => true, punchNativeLoadable: () => true }))

import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'

let db, dbFile, userDataPath, originalFlag

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shutdown-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  originalFlag = process.env.SHORESH_PUNCH_ENABLED
  process.env.SHORESH_PUNCH_ENABLED = 'true'
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(randomUUID(), 'Camp Test', 'a'.repeat(64))
  h.nativeShutdown.mockClear()
})
afterEach(() => {
  if (originalFlag === undefined) delete process.env.SHORESH_PUNCH_ENABLED
  else process.env.SHORESH_PUNCH_ENABLED = originalFlag
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

async function started() {
  const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
  const starter = createAutomergeSyncStarter({
    deviceId: getOrCreateDeviceId(db), db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => async (args) => {
      args.punchTransportFactory({ logger: { forComponent: () => noop } })
      return { broadcastLocalDoc() {}, onPeersChanged() {}, setAuthToken() {}, stop: async () => {} }
    },
    punchStopTimeoutMs: 50,
  })
  await starter.start()
  return starter
}

describe('shutdownPunch bounds punchWiring.stop()', () => {
  it('runs native cleanup even when stop never resolves', async () => {
    h.stop = () => new Promise(() => {})
    const starter = await started()
    const outcome = await Promise.race([starter.shutdownPunch().then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 1000))])
    expect(outcome).toBe('done')
    expect(h.nativeShutdown).toHaveBeenCalledTimes(1)
  })

  it('runs native cleanup even when stop throws', async () => {
    h.stop = async () => { throw new Error('boom') }
    const starter = await started()
    await starter.shutdownPunch().catch(() => {})
    expect(h.nativeShutdown).toHaveBeenCalledTimes(1)
  })
})
