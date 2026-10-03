// T336 chunk 1 — inertness-with-packages integration proof, analogue of T337's
// relayEnablementIntegration.test.js (gate-fix round 2, Security-Assessment F-1). That test proved
// the relay stays inert while dcutr was ABSENT from the build. It is no longer absent
// (377c28f0 landed @libp2p/dcutr@3.0.28 as this slice's foundation; AutoNAT is NOT part of the
// foundation — dropped, dcutr-only) — so the property that matters now is the one this file proves:
// with the hole-punch foundation package GENUINELY PRESENT in the resolved dependency tree, and
// SHORESH_RELAY_ENABLED left at its default (unset/false), startSyncNode still receives NO relay or
// dcutr wiring at all. relayEnablementIntegration.test.js's own "non-vacuity" case already covers
// this exact scenario as a side effect (flag OFF, package now genuinely present) — this file states
// it as its own first-class claim, with an explicit assertion that the real `@libp2p/dcutr` package
// is actually resolvable in THIS test environment, so the inertness being proven is not vacuous
// (package absent would make "no wiring" trivially true for the wrong reason).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { isAutomergeEngine } from './syncEngineFlag.js'

if (!isAutomergeEngine()) {
  throw new Error('holePunchInertnessWithPackages.test.js assumes the default automerge engine')
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

  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-holepunch-inertness-'))
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

describe('T336 chunk 1 — hole-punch foundation present, SHORESH_RELAY_ENABLED unset(default): fully inert', () => {
  it('non-vacuity precondition: @libp2p/dcutr is ACTUALLY resolvable in this test environment', () => {
    const require = createRequire(import.meta.url)
    expect(() => require.resolve('@libp2p/dcutr')).not.toThrow()
    // AutoNAT is deliberately NOT part of the foundation (T336 ships dcutr only) — not asserted here.
  })

  it('startSyncNode receives NO relay or dcutr wiring when the flag is left at its default', async () => {
    insertCamp()
    delete process.env.SHORESH_RELAY_ENABLED

    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter = makeStarter({ startSyncNodeImpl: async () => fakeStartSyncNode })

    await starter.start()

    expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
    const passedArgs = fakeStartSyncNode.mock.calls[0][0]
    expect(passedArgs.relayServerFactory).toBeUndefined()
    expect(passedArgs.relayTransportFactory).toBeUndefined()
    expect(passedArgs.directUpgradeServiceFactory).toBeUndefined()
  })

  it('non-vacuity: flipping the flag ON (packages still present) DOES produce the factories — proves the OFF case above is a real gate, not a broken wiring path', async () => {
    insertCamp()
    process.env.SHORESH_RELAY_ENABLED = 'true'

    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter = makeStarter({ startSyncNodeImpl: async () => fakeStartSyncNode })

    await starter.start()

    const passedArgs = fakeStartSyncNode.mock.calls[0][0]
    expect(typeof passedArgs.relayServerFactory).toBe('function')
    expect(typeof passedArgs.relayTransportFactory).toBe('function')
    expect(typeof passedArgs.directUpgradeServiceFactory).toBe('function')
  })
})
