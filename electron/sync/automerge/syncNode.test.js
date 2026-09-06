// @vitest-environment node
//
// Stage 4c acceptance test (design doc's Test strategy points 3, 4, 6): the
// full edit -> transport -> merge -> SQLite path, across two SEPARATE SQLite
// databases, each behind its own libp2p node. This is Stage 4's mechanical
// equivalent of the WS protocol's scheduleE2E.sync.test.js parity proof.
//
// Stage 5d-1 update (docs/adr/2026-09-06-libp2p-membership-mapping.md §3):
// startSyncNode now gates doc-sync behind the auth-over-libp2p handshake, so
// every test below that exchanges doc bytes must authenticate first —
// setupAuthorizedDevicePair/authenticateBothWays do that using the SAME
// evaluateAuthenticate logic (via startSyncNode's real onAuthenticate wiring)
// production code uses, not a test-only bypass.
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
  const f = path.join(os.tmpdir(), `shoresh-stage4-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

// dbA plays the Host (holds host_signing_key, mints camp tokens); BOTH dbs
// get the same signing_public_key and BOTH devices marked authorized —
// mirroring what a real full-sync of camps/devices would already have
// replicated to a genuinely paired Client before this handshake runs.
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

// Each side must authenticate TO THE OTHER before that other side's doc-sync
// handler will accept frames from it — admission is one-directional per
// receiving node (transport.js's authenticatedPeers set), so a two-way
// broadcast relationship needs both handshakes.
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

async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function activityRow(db, id) {
  return db.prepare('SELECT id, name, location FROM activities WHERE id = ?').get(id)
}

describe('syncNode — Automerge merge + projector over a real transport', () => {
  it('an edit on node A projects into node B\'s OWN separate SQLite db', async () => {
    // Shared genesis doc (same ancestry -> clean merges), each node gets its
    // own clone so actor ids differ, exactly like the prototype's A.clone.
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    const changed = applyWrite(a.getDoc(), {
      entity: 'activities',
      entity_id: 'archery',
      field: 'name',
      value: 'Archery',
    })
    const changed2 = applyWrite(changed, {
      entity: 'activities',
      entity_id: 'archery',
      field: 'location',
      value: 'Field 1',
    })
    await a.applyLocal(changed2)

    await waitFor(() => activityRow(dbB, 'archery')?.location === 'Field 1')

    const rowA = activityRow(dbA, 'archery')
    const rowB = activityRow(dbB, 'archery')
    expect(rowB).toEqual(rowA)
    expect(rowB.name).toBe('Archery')
    expect(rowB.location).toBe('Field 1')
  })

  it('concurrent same-field edits on both nodes converge and surface via A.getConflicts', async () => {
    const genesis = createEmptyDoc()
    const seeded = applyWrite(genesis, {
      entity: 'activities',
      entity_id: 'archery',
      field: 'location',
      value: 'Gym',
    })
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(seeded) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(seeded) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Let the initial connection settle before diverging concurrently.
    await new Promise((r) => setTimeout(r, 100))

    // Fire both edits concurrently (not sequentially awaited) so neither side
    // has received the other's change before making its own — this is what
    // makes the two writes genuinely concurrent from Automerge's perspective.
    await Promise.all([
      a.applyLocal(
        applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'location', value: 'Lake' })
      ),
      b.applyLocal(
        applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'location', value: 'Kiln' })
      ),
    ])

    // Poll until BOTH sides have independently merged the other's edit (each
    // side's own merge/projection is a separate async path — waiting on only
    // one side's doc can observe it mid-way through the other side's still-
    // in-flight merge, which is what made this assertion flaky).
    const hasConflict = (doc) => {
      const conflicts = A.getConflicts(doc.activities.archery, 'location')
      return conflicts && Object.keys(conflicts).length >= 2
    }
    await waitFor(() => hasConflict(a.getDoc()) && hasConflict(b.getDoc()))

    const conflicts = A.getConflicts(a.getDoc().activities.archery, 'location')
    expect(conflicts && Object.keys(conflicts).length).toBeGreaterThanOrEqual(2)

    const rowA = activityRow(dbA, 'archery')
    const rowB = activityRow(dbB, 'archery')
    expect(rowA).toEqual(rowB)
  })

  it('logs the serialized doc size for a representative seed (evidence for Stage 5 planning)', async () => {
    let doc = createEmptyDoc()
    for (let i = 0; i < 20; i++) {
      doc = applyWrite(doc, { entity: 'activities', entity_id: `activity-${i}`, field: 'name', value: `Activity ${i}` })
      doc = applyWrite(doc, { entity: 'activities', entity_id: `activity-${i}`, field: 'location', value: `Field ${i}` })
    }
    for (let i = 0; i < 10; i++) {
      doc = applyWrite(doc, { entity: 'groups', entity_id: `group-${i}`, field: 'name', value: `Group ${i}` })
    }
    const bytes = A.save(doc)
    console.log(`[stage4 evidence] serialized doc size for 20 activities + 10 groups: ${bytes.length} bytes`)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('an adversarial malformed doc payload does not crash the receiving node', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Send garbage bytes directly through the underlying transport's protocol,
    // bypassing A.save — simulates a malformed/adversarial peer.
    await a.sendDocTo(b.peerId, new Uint8Array([0xff, 0x00, 0x13, 0x37]))
    await new Promise((r) => setTimeout(r, 200))

    // Node B must still be responsive: a subsequent valid edit still converges.
    const changed = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'x', field: 'name', value: 'X' })
    await a.applyLocal(changed)
    await waitFor(() => activityRow(dbB, 'x')?.name === 'X')
    expect(activityRow(dbB, 'x').name).toBe('X')
  })

  it('a VALID-merging but projector-incompatible peer doc does not crash or poison node B', async () => {
    // Red Hat blocker: a doc that A.load/A.merge accept but whose merged shape
    // violates a projector invariant (a child referencing a missing parent ->
    // real FK violation) must not become an unhandled rejection / process crash,
    // and must not silently poison the node. Expected: surfaced + SQLite
    // last-good + doc kept as CRDT truth + sync continues.
    const genesis = createEmptyDoc()
    const projErrors = []
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({
      deviceId: 'device-b',
      db: dbB,
      doc: A.clone(genesis),
      onProjectionError: (err, _doc, fromPeerId) => projErrors.push({ err, fromPeerId }),
    })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Merges cleanly, but the anchor references a cohort that doesn't exist ->
    // projectAll (foreign_keys=ON) throws atomically.
    let bad = A.clone(genesis)
    bad = applyWrite(bad, { entity: 'anchor_activities', entity_id: 'anc-1', field: 'name', value: 'Flagpole' })
    bad = applyWrite(bad, { entity: 'anchor_activities', entity_id: 'anc-1', field: 'cohort_id', value: 'ghost-cohort' })
    await a.sendDocTo(b.peerId, A.save(bad))

    // Failure is surfaced, not swallowed or crashed.
    await waitFor(() => projErrors.length > 0)
    expect(projErrors[0].err).toBeInstanceOf(Error)
    // SQLite left at last-good: the bad anchor never partially materialized.
    expect(dbB.prepare('SELECT COUNT(*) AS c FROM anchor_activities').get().c).toBe(0)
    // The merged doc is kept as CRDT truth (the merge was NOT reverted).
    expect(b.getDoc().anchor_activities['anc-1']).toBeTruthy()

    // NOT poisoned: node B still receives + merges further syncs. A subsequent
    // valid edit still converges into B's DOC (SQLite stays blocked on the
    // unresolved anchor until the Stage-2 rules layer repairs it — documented).
    const good = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-ok', field: 'name', value: 'Swim' })
    await a.applyLocal(good)
    await waitFor(() => b.getDoc().activities?.['act-ok']?.name === 'Swim')
    expect(b.getDoc().activities['act-ok'].name).toBe('Swim')
  })
})
