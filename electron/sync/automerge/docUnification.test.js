import { readRecord } from '../../automerge/campDocument.js'
// Stage 5f (docs/work/plans/2026-09-06-stage5-live-wiring-design.md — unify liveDoc.js's and
// syncNode.js's independently-diverging document holders): regression coverage for the confirmed
// defect where a row that arrived via remote merge is silently deleted the next time this device
// makes an unrelated local edit and then restarts.
//
// Root cause (see liveDoc.js / syncNode.js module comments after this fix): before Stage 5f,
// liveDoc.js's `docsByCamp` (mutated by every local write, the only thing ever persisted) and
// syncNode.js's private `state.doc` (mutated by every remote merge, never persisted) were two
// separate Automerge documents that never reconciled. A local edit after a remote merge persisted
// liveDoc's STALE copy — missing the remotely-merged row — and a later restart's startup
// projection deleted that row from SQLite via delete-reconcile.
//
// This test drives the real modules (no mocking of Automerge/SQLite) exactly the way main.js does:
// liveDoc.ensureSeeded/recordLocalWrite for device A's own local-write mirror, and a real
// startSyncNode for device A's receive side, against device B as a second real node. "Restart" is
// simulated by liveDoc.resetForTests() (drops all in-process caches) followed by re-running the
// same startup sequence main.js runs: ensureSeeded (load-or-seed) then projectAll against the
// resolved doc — main.js's ACTUAL pre-fix startup sequence, kept here deliberately so this test
// keeps proving the unification fix even though main.js itself no longer calls projectAll at
// startup (see main.js's own comment on why that call was removed as a separate, independent
// simplification).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { applyWrite } from '../../automerge/campDocument.js'
import { projectAll } from '../../automerge/projector.js'
import { ensureHostSigningKey, issueCampToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import {
  recordLocalWrite,
  setUserDataDirGetter,
  setLocalWriteBroadcaster,
  resetForTests,
  ensureSeeded,
  getDocIfLoaded,
  flushPendingWrites,
} from './liveDoc.js'

let files = []
let dirs = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-docunify-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

function setupAuthorizedDevicePair(dbA, dbB) {
  const hostKey = ensureHostSigningKey(dbA)
  for (const db of [dbA, dbB]) {
    db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
    ).run('device-a', 'Device A', new Date().toISOString())
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
    ).run('device-b', 'Device B', new Date().toISOString())
  }
  return {
    tokenA: issueCampToken(dbA, 'user-a', 'device-a'),
    tokenB: issueCampToken(dbA, 'user-b', 'device-b'),
  }
}

async function authenticateBothWays(a, b, tokenA, tokenB) {
  await a.authenticateWith(b.peerId, { type: 'authenticate', token: tokenA, device_id: 'device-a' })
  await b.authenticateWith(a.peerId, { type: 'authenticate', token: tokenB, device_id: 'device-b' })
}

async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function activityRow(db, id) {
  return db.prepare('SELECT id, name FROM activities WHERE id = ?').get(id)
}

let dbA, dbB
let nodes = []
let userDataDirA

beforeEach(() => {
  dbA = freshDb('a')
  dbB = freshDb('b')
  userDataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-docunify-userdata-'))
  dirs.push(userDataDirA)
  setUserDataDirGetter(() => userDataDirA)
})

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop()))
  nodes = []
  resetForTests()
  for (const db of [dbA, dbB]) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('doc ownership unification — the (c) data-loss regression', () => {
  it('a row that arrived via remote merge survives an unrelated local edit + restart', async () => {
    // Device A: seed via liveDoc (mirrors main.js's ensureAutomergeDocSeeded), same doc every
    // local-write mirror will build on.
    const seededA = ensureSeeded(dbA)
    expect(seededA).toBeTruthy()

    // Both nodes get their OWN clone (distinct actor ids), exactly like main.js handing a
    // freshly-resolved doc to startSyncNode and syncNode.test.js's own pattern.
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(seededA) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(seededA) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // B writes a row and broadcasts it — it must land in A's SQLite via the real merge/project path.
    const bDoc = applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
    await b.applyLocal(bDoc)
    await waitFor(() => activityRow(dbA, 'archery')?.name === 'Archery')
    expect(activityRow(dbA, 'archery').name).toBe('Archery')

    // A now makes an UNRELATED local edit, through the SAME path appendOp/operations.js uses in
    // production (liveDoc.recordLocalWrite) — not through syncNode.applyLocal.
    recordLocalWrite(dbA, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    flushPendingWrites()

    // Sanity: the persisted file now reflects A's local edit.
    expect(readRecord(getDocIfLoaded(dbA), 'groups', 'g1').name).toBe('Bunk A')

    // Simulate a restart: drop every in-process cache, reconfigure exactly as main.js does at
    // launch, and re-run main.js's ACTUAL startup sequence (seed-or-load, then project the
    // resolved doc — this is the sequence that deletes data pre-fix; see module comment above).
    await a.stop()
    nodes = nodes.filter((n) => n !== a)
    resetForTests()
    setUserDataDirGetter(() => userDataDirA)

    const restartedDoc = ensureSeeded(dbA)
    projectAll(dbA, restartedDoc)

    // The row B synced in BEFORE A's restart must still be there.
    expect(activityRow(dbA, 'archery')).toBeTruthy()
    expect(activityRow(dbA, 'archery').name).toBe('Archery')
  })
})

describe('local writes broadcast (item 2) without a full projectAll per write', () => {
  it('a real op-log-style local write on A (liveDoc.recordLocalWrite) converges to B', async () => {
    const seededA = ensureSeeded(dbA)
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(seededA) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(seededA) })
    nodes.push(a, b)

    // Wire A's broadcaster exactly as main.js does once its sync node has started.
    setLocalWriteBroadcaster(dbA, a.broadcastLocalDoc)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    recordLocalWrite(dbA, { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
    flushPendingWrites() // fires the debounced save AND the debounced broadcast together

    await waitFor(() => activityRow(dbB, 'archery')?.name === 'Archery')
    expect(activityRow(dbB, 'archery').name).toBe('Archery')
  })

  it('does not call projectAll for a local write — only liveDoc updates the in-memory doc and schedules persistence/broadcast', async () => {
    const seededA = ensureSeeded(dbA)
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(seededA) })
    nodes.push(a)

    let broadcastCount = 0
    setLocalWriteBroadcaster(dbA, async (doc) => {
      broadcastCount += 1
      await a.broadcastLocalDoc(doc)
    })

    const projectorModule = await import('../../automerge/projector.js')
    const projectAllSpy = vi.spyOn(projectorModule, 'projectAll')

    for (let i = 0; i < 10; i++) {
      recordLocalWrite(dbA, { entity: 'activities', entity_id: `a${i}`, field: 'name', value: `Activity ${i}` })
    }
    flushPendingWrites()

    // 10 field-ops, coalesced into exactly one broadcast (the debounce), and NEVER a projectAll —
    // the row already reached SQLite via appendOp's own op-log write, long before recordLocalWrite
    // ever ran.
    expect(broadcastCount).toBe(1)
    expect(projectAllSpy).not.toHaveBeenCalled()
    projectAllSpy.mockRestore()
  })
})
