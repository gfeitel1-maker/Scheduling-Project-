// @vitest-environment node
//
// Stage 4c acceptance test (design doc's Test strategy points 3, 4, 6): the
// full edit -> transport -> merge -> SQLite path, across two SEPARATE SQLite
// databases, each behind its own libp2p node. This is Stage 4's mechanical
// equivalent of the WS protocol's scheduleE2E.sync.test.js parity proof.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { startSyncNode } from './syncNode.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-stage4-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  return db
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
})
