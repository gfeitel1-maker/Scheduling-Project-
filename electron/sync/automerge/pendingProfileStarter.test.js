// @vitest-environment node
// T340: syncStarter -> startSyncNode carries the fd-adaptive pending profile (link 1 of 3; the other
// two are pendingProfileSyncNode.test.js and pendingProfileTransport.test.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'

let db, dbFile, deviceId, userDataPath
beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pending-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(randomUUID(), 'Camp Test', 'a'.repeat(64))
})
afterEach(() => {
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

async function profileFor(limit) {
  const startSyncNode = vi.fn(async () => ({ broadcastLocalDoc() {}, onPeersChanged() {}, setAuthToken() {}, stop: async () => {} }))
  const starter = createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => startSyncNode,
    readFdLimit: () => limit,
  })
  await starter.start()
  return startSyncNode.mock.calls[0][0].pendingProfile
}

describe('syncStarter passes the pending profile to startSyncNode', () => {
  it('a 256 open-file limit yields 32/128', async () => {
    expect(await profileFor(256)).toMatchObject({ publicSubCap: 32, globalPending: 128 })
  })
  it('a 10240 open-file limit yields 64/256', async () => {
    expect(await profileFor(10240)).toMatchObject({ publicSubCap: 64, globalPending: 256 })
  })
})
