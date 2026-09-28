// T276 — executed-behaviour tests for the sync starter extracted out of
// main.js's `!process.env.VITEST`-gated block. Before the extraction these
// properties (the TOCTOU in-flight latch, the join-session funnel guard)
// could only be asserted on AST shape (mainSyncStartupWiring.test.js) — a
// regression that KEPT the shape while breaking the behaviour would still
// pass. This file imports only syncStarter.js, never main.js, so it proves
// the real thing runs, not a parsed description of it.
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

// This whole file assumes the real default engine (SHORESH_SYNC_ENGINE unset
// or not 'oplog' -> 'automerge'). isAutomergeEngine is read directly rather
// than mocked, per the ticket: it is the real gate `start()` checks first.
if (!isAutomergeEngine()) {
  throw new Error('syncStarter.test.js assumes the default automerge engine; set SHORESH_SYNC_ENGINE=automerge or leave it unset')
}

let db
let dbFile
let deviceId
let userDataPath

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)

  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-syncstarter-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
})

afterEach(() => {
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

/** A fake node object shaped enough for start() to finish successfully without throwing. */
function makeFakeNode(overrides = {}) {
  return {
    broadcastLocalDoc: () => {},
    onPeersChanged: () => {},
    setAuthToken: () => {},
    stop: async () => {},
    ...overrides,
  }
}

function makeStarter({ getLiveHandlers = () => null, startSyncNodeImpl } = {}) {
  return createAutomergeSyncStarter({
    deviceId,
    db,
    userDataPath,
    docCipher: null,
    getMainWindow: () => null,
    getLiveHandlers,
    startSyncNodeImpl,
  })
}

describe('createAutomergeSyncStarter: concurrency (T274 round 2, now executed)', () => {
  it('admits at most one real node start when start() is called twice before either resolves', async () => {
    insertCamp()

    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    // A manually-resolved deferred promise, not setTimeout: the two start()
    // calls below are issued synchronously, back-to-back, in the same tick.
    // Everything start() does before its first await (the campId lookup,
    // ensureAutomergeDocSeeded, the domain-migration checks, doc resolution)
    // is synchronous fs/db work — the first real suspension point is
    // `await startSyncNodeImpl()`. Gating THAT promise, rather than using a
    // timer, is what proves the second call's synchronous prologue (guards +
    // latch) runs to completion before the first call's await ever settles —
    // a setTimeout(0) would still work, but would only prove "after a tick",
    // not "before this specific await resolves".
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const startSyncNodeImpl = vi.fn(async () => {
      await gate
      return fakeStartSyncNode
    })

    const starter = makeStarter({ startSyncNodeImpl })

    const p1 = starter.start()
    const p2 = starter.start()

    releaseGate()
    await Promise.all([p1, p2])

    expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
    expect(starter.getNode()).toBeTruthy()
  })
})

describe('createAutomergeSyncStarter: funnel guard (T274 final, now executed)', () => {
  it('never starts a node while a join session is retained', async () => {
    insertCamp()
    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter = makeStarter({
      getLiveHandlers: () => ({ hasRetainedJoinSession: () => true }),
      startSyncNodeImpl: async () => fakeStartSyncNode,
    })

    await starter.start()

    expect(fakeStartSyncNode).not.toHaveBeenCalled()
    expect(starter.getNode()).toBeNull()
  })

  // Non-vacuity companion: the guard above must gate the real path, not
  // always refuse — otherwise the first test would pass for the wrong
  // reason (nothing ever starts a node at all).
  it('starts a node when no join session is retained and every other precondition is met', async () => {
    insertCamp()
    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter = makeStarter({
      getLiveHandlers: () => ({ hasRetainedJoinSession: () => false }),
      startSyncNodeImpl: async () => fakeStartSyncNode,
    })

    await starter.start()

    expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
    expect(starter.getNode()).toBeTruthy()
  })
})

describe('createAutomergeSyncStarter: idempotency, no-camp, and failure bookkeeping', () => {
  it('does not re-call startSyncNodeImpl once a node is already running', async () => {
    insertCamp()
    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const startSyncNodeImpl = vi.fn(async () => fakeStartSyncNode)
    const starter = makeStarter({ startSyncNodeImpl })

    await starter.start()
    expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
    const firstNode = starter.getNode()

    await starter.start()

    expect(fakeStartSyncNode).toHaveBeenCalledTimes(1)
    expect(starter.getNode()).toBe(firstNode)
  })

  it('leaves startupAttempted false when no camp has been bootstrapped yet', async () => {
    // No insertCamp() call — the db has no camps row.
    const startSyncNodeImpl = vi.fn(async () => vi.fn())
    const starter = makeStarter({ startSyncNodeImpl })

    await starter.start()

    expect(startSyncNodeImpl).not.toHaveBeenCalled()
    expect(starter.getNode()).toBeNull()
    expect(starter.getStartupAttempted()).toBe(false)
  })

  it('catches a thrown startSyncNodeImpl, flips startupAttempted true, and leaves no node running', async () => {
    insertCamp()
    const startSyncNodeImpl = vi.fn(async () => {
      throw new Error('boom: transport failed to bind')
    })
    const starter = makeStarter({ startSyncNodeImpl })

    await starter.start()

    expect(starter.getNode()).toBeNull()
    expect(starter.getStartupAttempted()).toBe(true)

    // And the failure is not latched forever — a later retry can still try again.
    const fakeStartSyncNode = vi.fn(async () => makeFakeNode())
    const starter2 = makeStarter({ startSyncNodeImpl: async () => fakeStartSyncNode })
    await starter2.start()
    expect(starter2.getNode()).toBeTruthy()
  })
})

// T292 round 2 FIX 2 — a remote merge (another device's edit landing via
// libp2p) never fires localWriteClient's onOpApplied (that only covers this
// device's own local write()/writeBulkReplace()), so the camp data document
// writer must be scheduled from onRemoteOps instead. This proves the option
// start() actually passes to startSyncNode reaches getLiveHandlers()'s
// scheduleCampDataRecord — the real seam, not a description of it.
describe('createAutomergeSyncStarter: onRemoteOps schedules the camp data record (T292)', () => {
  it('calls getLiveHandlers().scheduleCampDataRecord() when onRemoteOps fires', async () => {
    insertCamp()
    let capturedOnRemoteOps
    const fakeStartSyncNode = vi.fn(async (opts) => {
      capturedOnRemoteOps = opts.onRemoteOps
      return makeFakeNode()
    })
    const scheduleCampDataRecord = vi.fn()
    const starter = makeStarter({
      getLiveHandlers: () => ({ scheduleCampDataRecord }),
      startSyncNodeImpl: async () => fakeStartSyncNode,
    })

    await starter.start()
    expect(typeof capturedOnRemoteOps).toBe('function')

    capturedOnRemoteOps([{ entity: 'groups', entity_id: 'g1' }])

    expect(scheduleCampDataRecord).toHaveBeenCalledTimes(1)
  })

  it('does not throw when getLiveHandlers() or scheduleCampDataRecord is absent', async () => {
    insertCamp()
    let capturedOnRemoteOps
    const fakeStartSyncNode = vi.fn(async (opts) => {
      capturedOnRemoteOps = opts.onRemoteOps
      return makeFakeNode()
    })
    const starter = makeStarter({
      getLiveHandlers: () => null,
      startSyncNodeImpl: async () => fakeStartSyncNode,
    })

    await starter.start()

    expect(() => capturedOnRemoteOps([])).not.toThrow()
  })
})
