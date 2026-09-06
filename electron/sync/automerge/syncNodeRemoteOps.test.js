// @vitest-environment node
//
// Stage 5c (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 3, § 6): two in-process
// syncNodes converge (same pattern as syncNode.test.js), and the synthesized `op_applied`-shaped
// events the RECEIVING node's onRemoteOps callback gets are asserted structurally parseable by the
// same consumers' expectations as a hand-built op-log fixture would be, and are sanitized through
// main.js's REAL sanitizeOpForIpc (reused verbatim, not reimplemented) before anything resembling
// an IPC send would happen.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { startSyncNode } from './syncNode.js'
import { sanitizeOpForIpc } from '../../main.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-stage5c-${tag}-${Date.now()}-${Math.random()}.sqlite`)
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

describe('syncNode onRemoteOps — Stage 5c read-path parity', () => {
  it('a remote edit synthesizes op_applied-shaped events on the receiving node, AFTER projection', async () => {
    const genesis = createEmptyDoc()
    const receivedEvents = []
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({
      deviceId: 'device-b',
      db: dbB,
      doc: A.clone(genesis),
      onRemoteOps: (events, meta) => receivedEvents.push({ events, meta }),
    })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    let changed = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
    changed = applyWrite(changed, { entity: 'activities', entity_id: 'archery', field: 'location', value: 'Field 1' })
    await a.applyLocal(changed)

    await waitFor(() => receivedEvents.length > 0)

    // By the time onRemoteOps fired, SQLite must already reflect the change (fires AFTER projectAll).
    const row = dbB.prepare('SELECT id, name, location FROM activities WHERE id = ?').get('archery')
    expect(row).toEqual({ id: 'archery', name: 'Archery', location: 'Field 1' })

    const allEvents = receivedEvents.flatMap((r) => r.events)
    const byField = Object.fromEntries(allEvents.map((e) => [e.field, e]))

    // Structural parity with a hand-built op-log fixture (the shape src/ consumers already parse):
    // {entity, entity_id, field, value, device_id, author_user_id}.
    expect(byField.name).toMatchObject({ entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
    expect(byField.location).toMatchObject({ entity: 'activities', entity_id: 'archery', field: 'location', value: 'Field 1' })
    for (const e of allEvents) {
      expect(e).toHaveProperty('entity')
      expect(e).toHaveProperty('entity_id')
      expect(e).toHaveProperty('field')
      expect(e).toHaveProperty('value')
      expect(e).toHaveProperty('device_id')
      expect(e).toHaveProperty('author_user_id', null)
      // device_id is the REMOTE peer (node A's peerId from B's perspective) — never node B's own id.
      expect(e.device_id).toBe(a.peerId)
      expect(e.device_id).not.toBe('device-b')
    }
  })

  it('sanitizeOpForIpc (reused verbatim from main.js) strips a users PIN field from a synthesized event', () => {
    const rawEvent = { entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'super-secret-hash', device_id: 'peer-x', author_user_id: null }
    const sanitized = sanitizeOpForIpc(rawEvent)
    expect(sanitized).not.toHaveProperty('value')
    expect(sanitized.entity).toBe('users')
    expect(sanitized.field).toBe('pin_hash')

    const nonPinEvent = { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery', device_id: 'peer-x', author_user_id: null }
    expect(sanitizeOpForIpc(nonPinEvent)).toEqual(nonPinEvent)
  })

  it('no projection error -> onRemoteOps still fires normally (baseline; the negative case is a design note, not a synthesizable event)', async () => {
    const genesis = createEmptyDoc()
    let remoteOpsCalls = 0
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({
      deviceId: 'device-b',
      db: dbB,
      doc: A.clone(genesis),
      onRemoteOps: () => { remoteOpsCalls += 1 },
    })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'x', field: 'name', value: 'X' }))
    await waitFor(() => remoteOpsCalls > 0)
    expect(remoteOpsCalls).toBeGreaterThan(0)
  })

  it('a consumer throw inside onRemoteOps does not break sync or escape as an unhandled rejection', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({
      deviceId: 'device-b',
      db: dbB,
      doc: A.clone(genesis),
      onRemoteOps: () => { throw new Error('consumer boom') },
    })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'x', field: 'name', value: 'X' }))
    await waitFor(() => dbB.prepare('SELECT name FROM activities WHERE id = ?').get('x')?.name === 'X')
    expect(dbB.prepare('SELECT name FROM activities WHERE id = ?').get('x').name).toBe('X')
  })
})
