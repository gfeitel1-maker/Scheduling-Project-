// @vitest-environment node
//
// T347 (S1): with SHORESH_PUNCH_ENABLED off, the native-load probe must never run — loading a native
// binary is itself a side effect the inert build must not have, even when signaling is injected.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const probe = vi.hoisted(() => vi.fn(() => true))
const wiringLoaded = vi.hoisted(() => vi.fn())
vi.mock('./punchReconnectWiring.js', async (importOriginal) => { wiringLoaded(); return importOriginal() })
vi.mock('./punchEnablement.js', async (importOriginal) => ({ ...(await importOriginal()), punchNativeLoadable: probe }))

import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { makeSignalingPair } from './punchTestSupport.js'

let db, dbFile, userDataPath, originalFlag

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'punchprobe-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  originalFlag = process.env.SHORESH_PUNCH_ENABLED
  probe.mockClear()
  wiringLoaded.mockClear()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(randomUUID(), 'Camp Test', 'a'.repeat(64))
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

async function start(punchSignaling) {
  const fakeStartSyncNode = vi.fn(async () => ({ broadcastLocalDoc() {}, onPeersChanged() {}, setAuthToken() {}, stop: async () => {} }))
  const starter = createAutomergeSyncStarter({
    deviceId: getOrCreateDeviceId(db), db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => fakeStartSyncNode,
    punchSignaling,
  })
  await starter.start()
  return starter
}

describe('punchNativeLoadable short-circuit (T347)', () => {
  it('flag off + signaling injected: the native probe is never called', async () => {
    delete process.env.SHORESH_PUNCH_ENABLED
    const [signaling] = makeSignalingPair()
    await start(signaling)
    expect(probe).not.toHaveBeenCalled()
    expect(wiringLoaded).not.toHaveBeenCalled()
  })

  it('flag off with no signaling: the S4c reconnect wiring module is never loaded', async () => {
    delete process.env.SHORESH_PUNCH_ENABLED
    await start(undefined)
    expect(wiringLoaded).not.toHaveBeenCalled()
  })

  it("flag 'true' + no injected signaling (production): the probe is called - the starter builds its own routed channel (S4c)", async () => {
    process.env.SHORESH_PUNCH_ENABLED = 'true'
    const starter = await start(undefined)
    expect(probe).toHaveBeenCalledTimes(1)
    await starter.shutdownPunch()
  })

  it("non-vacuity: flag 'true' + signaling DOES call the probe", async () => {
    process.env.SHORESH_PUNCH_ENABLED = 'true'
    const [signaling] = makeSignalingPair()
    const starter = await start(signaling)
    expect(probe).toHaveBeenCalledTimes(1)
    await starter.shutdownPunch()
  })
})
