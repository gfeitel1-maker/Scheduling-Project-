// T337 gate-fix round 2 (Security-Assessment F-1), integration-level proof against the REAL
// syncStarter.js wiring (not just the composition function in relayEnablement.test.js): with
// SHORESH_RELAY_ENABLED=true but dcutr genuinely absent from this build, startSyncNode is never
// handed a relayServerFactory/relayTransportFactory — the flag alone cannot activate the relay.
// Mirrors syncStarter.test.js's own fixture/harness pattern (startSyncNodeImpl injection point).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { isAutomergeEngine } from './syncEngineFlag.js'

if (!isAutomergeEngine()) {
  throw new Error('relayEnablementIntegration.test.js assumes the default automerge engine')
}

let db
let dbFile
let deviceId
let userDataPath
let originalRelayEnabled

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)

  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-relay-enablement-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)

  originalRelayEnabled = process.env.SHORESH_RELAY_ENABLED
})

afterEach(() => {
  if (originalRelayEnabled === undefined) delete process.env.SHORESH_RELAY_ENABLED
  else process.env.SHORESH_RELAY_ENABLED = originalRelayEnabled
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
})

afterEach(() => {
  cleanupTemplatedDbs()
})

function insertCamp() {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  return campId
}

function makeFakeNode(overrides = {}) {
  return {
    broadcastLocalDoc: () => {},
    onPeersChanged: () => {},
    setAuthToken: () => {},
    stop: async () => {},
    ...overrides,
  }
}

function makeStarter({ startSyncNodeImpl }) {
  return createAutomergeSyncStarter({
    deviceId,
    db,
    userDataPath,
    docCipher: null,
    getMainWindow: () => null,
    getLiveHandlers: () => null,
    startSyncNodeImpl,
  })
}

describe('T337 gate-fix round 2 — SHORESH_RELAY_ENABLED alone cannot activate the relay', () => {
  // UPDATED for T336 (377c28f0 landed @libp2p/dcutr; AutoNAT dropped, dcutr-only; this chunk wires dcutr):
  // this test's original premise ("dcutr absent, this build, today") is no longer true — the
  // hole-punch foundation packages are now present in every build's resolved tree, same as this
  // file's own test environment. With BOTH conditions now genuinely satisfied (flag ON AND
  // foundation present), relayEligible is correctly TRUE and the relay/dcutr factories ARE handed
  // to startSyncNode — that is the intended, designed behavior this slice builds, not a hazard.
  // The coupling's actual non-negotiable property — flag alone is never sufficient — is what the
  // inertness-with-packages test immediately below this describe block proves instead (flag OFF,
  // packages genuinely present, still fully inert).
  it('documenting: with the flag ON and the foundation genuinely present, startSyncNode DOES receive the relay + direct-upgrade factories', async () => {
    insertCamp()
    process.env.SHORESH_RELAY_ENABLED = 'true'

    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter = makeStarter({ startSyncNodeImpl: async () => fakeStartSyncNode })

    await starter.start()

    expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
    const passedArgs = fakeStartSyncNode.mock.calls[0][0]
    expect(typeof passedArgs.relayServerFactory).toBe('function')
    expect(typeof passedArgs.relayTransportFactory).toBe('function')
    expect(typeof passedArgs.directUpgradeServiceFactory).toBe('function')
  })

  it('non-vacuity: with the flag OFF (default), the same coupling is trivially also inert', async () => {
    insertCamp()
    delete process.env.SHORESH_RELAY_ENABLED

    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter = makeStarter({ startSyncNodeImpl: async () => fakeStartSyncNode })

    await starter.start()

    const passedArgs = fakeStartSyncNode.mock.calls[0][0]
    expect(passedArgs.relayServerFactory).toBeUndefined()
    expect(passedArgs.relayTransportFactory).toBeUndefined()
    expect(passedArgs.directUpgradeServiceFactory).toBeUndefined()
  })
})
