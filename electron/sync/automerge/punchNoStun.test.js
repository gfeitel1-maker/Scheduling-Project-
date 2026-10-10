// @vitest-environment node
//
// T359 slice 2: the production start path never configures an ICE server (no STUN, no TURN). Router port
// mapping is the way a roaming peer is reached without a third party, so a stun: URL here is a regression.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { makeSignalingPair } from './punchTestSupport.js'

let db, dbFile, deviceId, userDataPath, originalFlag
beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-nostun-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  originalFlag = process.env.SHORESH_PUNCH_ENABLED
  process.env.SHORESH_PUNCH_ENABLED = 'true'
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

const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })

describe('production punch start path configures no STUN or TURN', () => {
  it('the transport options carry no iceServers', async () => {
    const startSyncNode = vi.fn(async () => ({ broadcastLocalDoc() {}, onPeersChanged() {}, setAuthToken() {}, stop: async () => {} }))
    const [signaling] = makeSignalingPair()
    const starter = createAutomergeSyncStarter({
      deviceId, db, userDataPath, docCipher: null,
      getMainWindow: () => null, getLiveHandlers: () => null,
      startSyncNodeImpl: async () => startSyncNode,
      punchSignaling: signaling,
    })
    await starter.start()
    const transport = startSyncNode.mock.calls[0][0].punchTransportFactory({ logger: { forComponent: () => noop } })
    expect(transport.opts.iceServers ?? []).toEqual([])
    expect(JSON.stringify(transport.opts)).not.toMatch(/stun:|turns?:/i)
    await starter.shutdownPunch()
  })
})
