// @vitest-environment node
//
// T347 (S1) inertness: the punch transport is wired ONLY when SHORESH_PUNCH_ENABLED is the literal
// string 'true' AND the native-capability check passes. Default off; 'TRUE', '1', 'yes', ' true' and
// unset all leave startSyncNode with no punch wiring. Mirrors holePunchInertnessWithPackages.test.js:
// the OFF cases are only meaningful because the ON case below proves the wiring path is real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { punchRuntimeEligible } from './punchEnablement.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { isAutomergeEngine } from './syncEngineFlag.js'
import { makeSignalingPair } from './punchTestSupport.js'

if (!isAutomergeEngine()) {
  throw new Error('punchInertness.test.js assumes the default automerge engine')
}

let db
let dbFile
let deviceId
let userDataPath
let originalPunchEnabled

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'punchinert-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  originalPunchEnabled = process.env.SHORESH_PUNCH_ENABLED
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(randomUUID(), 'Camp Test', 'a'.repeat(64))
})

afterEach(() => {
  if (originalPunchEnabled === undefined) delete process.env.SHORESH_PUNCH_ENABLED
  else process.env.SHORESH_PUNCH_ENABLED = originalPunchEnabled
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

const fakeNode = () => ({ broadcastLocalDoc: () => {}, onPeersChanged: () => {}, setAuthToken: () => {}, stop: async () => {} })

async function startWith({ punchSignaling } = {}) {
  const fakeStartSyncNode = vi.fn(async () => fakeNode())
  const starter = createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => fakeStartSyncNode,
    ...(punchSignaling ? { punchSignaling } : {}),
  })
  await starter.start()
  expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
  return { args: fakeStartSyncNode.mock.calls[0][0], starter }
}

describe('punchRuntimeEligible — strict boolean conjunction', () => {
  it('needs BOTH the enable flag and a loadable native module', () => {
    expect(punchRuntimeEligible({ punchEnabled: true, nativeLoadable: true })).toBe(true)
    expect(punchRuntimeEligible({ punchEnabled: true, nativeLoadable: false })).toBe(false)
    expect(punchRuntimeEligible({ punchEnabled: false, nativeLoadable: true })).toBe(false)
    expect(punchRuntimeEligible({ punchEnabled: 'true', nativeLoadable: true })).toBe(false)
    expect(punchRuntimeEligible({ punchEnabled: 1, nativeLoadable: 1 })).toBe(false)
    expect(punchRuntimeEligible({})).toBe(false)
  })
})

describe('T347 — SHORESH_PUNCH_ENABLED gate (default off, strict literal)', () => {
  it('non-vacuity precondition: node-datachannel is ACTUALLY resolvable here, so absence is not why the OFF cases are inert', () => {
    expect(() => createRequire(import.meta.url).resolve('node-datachannel')).not.toThrow()
  })

  for (const [label, value] of [['unset', undefined], ["'TRUE'", 'TRUE'], ["'1'", '1'], ["'yes'", 'yes'], ["' true'", ' true'], ["'true '", 'true '], ["'false'", 'false'], ["''", '']]) {
    it(`SHORESH_PUNCH_ENABLED ${label}: startSyncNode receives no punch wiring and no udp listen`, async () => {
      if (value === undefined) delete process.env.SHORESH_PUNCH_ENABLED
      else process.env.SHORESH_PUNCH_ENABLED = value
      const [signaling] = makeSignalingPair()
      const { args } = await startWith({ punchSignaling: signaling })
      expect(args.punchTransportFactory).toBeUndefined()
      expect(args.listen.some((a) => a.includes('/udp/'))).toBe(false)
    })
  }

  it('flag on and no injected channel (production, S4c): wired with the starter\'s own routed signaling channel', async () => {
    process.env.SHORESH_PUNCH_ENABLED = 'true'
    const { args, starter } = await startWith()
    expect(typeof args.punchTransportFactory).toBe('function')
    await starter.shutdownPunch()
  })

  it("non-vacuity: the literal 'true' with a signaling channel DOES wire the factory — the OFF cases above are a real gate", async () => {
    process.env.SHORESH_PUNCH_ENABLED = 'true'
    const [signaling] = makeSignalingPair()
    const { args, starter } = await startWith({ punchSignaling: signaling })
    expect(typeof args.punchTransportFactory).toBe('function')
    expect(args.listen).toContain('/ip4/0.0.0.0/udp/0')
    await starter.shutdownPunch()
  })

  it('shutdownPunch is a safe no-op when the feature never loaded', async () => {
    delete process.env.SHORESH_PUNCH_ENABLED
    const { starter } = await startWith()
    await expect(starter.shutdownPunch()).resolves.toBeUndefined()
  })
})
