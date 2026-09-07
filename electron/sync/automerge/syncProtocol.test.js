// @vitest-environment node
//
// Stage 5f-2 (real Automerge sync protocol, replacing whole-document pushes): the acceptance tests
// that define "done" for this slice. Before this, two devices only converged on the NEXT WRITE
// after connecting (an intermittent whole-doc push had been removed in #317 rather than shipped
// flaky) — the case these tests exercise, "connect with no further writes", had never worked.
//
// Mirrors syncNode.test.js's harness (two real libp2p nodes, two separate SQLite dbs, the SAME
// evaluateAuthenticate-backed handshake production uses) rather than a fake transport, so these
// tests exercise the actual admission gate and wire protocol, not a stand-in for them.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { ensureHostSigningKey, issueCampToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-syncproto-${tag}-${Date.now()}-${Math.random()}.sqlite`)
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

let dbA, dbB
let nodes = []
beforeEach(() => {
  dbA = freshDb('a')
  dbB = freshDb('b')
})
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop()))
  nodes = []
  for (const db of [dbA, dbB]) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function activityRow(db, id) {
  return db.prepare('SELECT id, name, location FROM activities WHERE id = ?').get(id)
}

// Single run of the core scenario, used both standalone and in the flakiness-proving loop below.
async function runConvergesOnConnectNoWrites() {
  const files_ = []
  const f = (tag) => {
    const p = path.join(os.tmpdir(), `shoresh-syncproto-loop-${tag}-${Date.now()}-${Math.random()}.sqlite`)
    files_.push(p)
    return p
  }
  const db1 = openLocalDb(f('a'))
  db1.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  const db2 = openLocalDb(f('b'))
  db2.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')

  // Node A has PRE-EXISTING state before node B even exists — the case that matters: a device
  // that already has data must hand it to a freshly connecting peer without either side writing
  // anything new.
  let seeded = createEmptyDoc()
  seeded = applyWrite(seeded, { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
  seeded = applyWrite(seeded, { entity: 'activities', entity_id: 'archery', field: 'location', value: 'Field 1' })

  const a = await startSyncNode({ deviceId: 'device-a', db: db1, doc: A.clone(seeded) })
  const b = await startSyncNode({ deviceId: 'device-b', db: db2, doc: createEmptyDoc() })

  try {
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(db1, db2)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // NO further writes on either side — convergence must come from admission alone.
    await waitFor(() => activityRow(db2, 'archery')?.location === 'Field 1')
    const row = activityRow(db2, 'archery')
    if (row?.name !== 'Archery' || row?.location !== 'Field 1') {
      throw new Error(`did not converge: ${JSON.stringify(row)}`)
    }
  } finally {
    await Promise.all([a.stop(), b.stop()])
    try { db1.close() } catch { /* already closed */ }
    try { db2.close() } catch { /* already closed */ }
    for (const p of files_) if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

describe('syncNode — real Automerge sync protocol (Stage 5f-2)', () => {
  it('a peer with pre-existing state converges the other side with NO further writes', async () => {
    await runConvergesOnConnectNoWrites()
  })

  // The previous whole-doc-push attempt at this failed roughly 1 run in 3 (timing-dependent
  // delivery, not a logic bug) — that is why it was removed in #317 rather than shipped. A flaky
  // pass here is a FAIL: run the same scenario, from scratch, 10 times.
  it('converges reliably across repeated connect cycles (not timing-dependent)', async () => {
    const ITERATIONS = 10
    for (let i = 0; i < ITERATIONS; i++) {
      await runConvergesOnConnectNoWrites()
    }
  }, 30000)

  it('concurrent writes on both sides converge to the same document on both', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)
    // Let the initial admission-driven sync settle before diverging concurrently.
    await new Promise((r) => setTimeout(r, 150))

    await Promise.all([
      a.applyLocal(
        applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'x', field: 'name', value: 'From A' })
      ),
      b.applyLocal(
        applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'y', field: 'name', value: 'From B' })
      ),
    ])

    await waitFor(() => activityRow(dbA, 'x')?.name === 'From A' && activityRow(dbA, 'y')?.name === 'From B')
    await waitFor(() => activityRow(dbB, 'x')?.name === 'From A' && activityRow(dbB, 'y')?.name === 'From B')

    expect(A.getHeads(a.getDoc()).sort()).toEqual(A.getHeads(b.getDoc()).sort())
  })

  it('a peer that is not admitted receives nothing over the sync protocol and cannot inject', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    // Deliberately skip authentication — neither side admits the other.
    let seeded = A.clone(genesis)
    seeded = applyWrite(seeded, { entity: 'activities', entity_id: 'secret', field: 'name', value: 'Secret' })
    await a.applyLocal(seeded)

    // Give the (absent) sync protocol every chance to have leaked something.
    await new Promise((r) => setTimeout(r, 300))
    expect(activityRow(dbB, 'secret')).toBeUndefined()
    expect(b.getDoc().activities?.secret).toBeUndefined()
  })

  it('reconnect after disconnect re-converges', async () => {
    const genesis = createEmptyDoc()
    let a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    let b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)
    await new Promise((r) => setTimeout(r, 100))

    // Disconnect node B entirely (stop its transport), then start a FRESH node B on the same db —
    // simulates a real reconnect (new libp2p peer id, same underlying camp state). Capture B's doc
    // BEFORE stopping so the restarted node resumes from what it already had (mirrors production:
    // a restart reloads its own persisted doc, it doesn't start from an empty one).
    const bDocBeforeStop = b.getDoc()
    await b.stop()
    nodes = nodes.filter((n) => n !== b)

    // Node A writes something while B is offline.
    const changed = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'offline', field: 'name', value: 'While Offline' })
    await a.applyLocal(changed)

    b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(bDocBeforeStop) })
    nodes.push(b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().some((p) => p === b.peerId))
    const tokenB2 = issueCampToken(dbA, 'user-b', 'device-b')
    await authenticateBothWays(a, b, tokenA, tokenB2)

    await waitFor(() => activityRow(dbB, 'offline')?.name === 'While Offline')
    expect(activityRow(dbB, 'offline').name).toBe('While Offline')
  })
})
