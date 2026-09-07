// @vitest-environment node
//
// Stage 5f — two bugs found on a REAL two-machine run that no in-process test had exercised,
// because CI tests always wrote AFTER both peers were connected and never sent a redundant frame.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as A from '@automerge/automerge'
import { randomUUID } from 'node:crypto'
import { initSchema } from '../../db/localDb.js'
import { ensureHostSigningKey, issueCampToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { getCurrentDoc, setCurrentDoc, resetForTests } from './liveDoc.js'

let nodes = []
let dbs = []
// Both devices must be the SAME camp — a projected row carries camp_id, so two dbs with different
// camp ids would fail the FK and the merge would never land, which looks identical to "sync didn't
// work" while actually being a broken fixture.
const CAMP_ID = randomUUID()
const DEV_A = randomUUID()
const DEV_B = randomUUID()
function freshDb() {
  const db = new Database(':memory:')
  initSchema(db)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'T')
  dbs.push(db)
  return db
}
// startSyncNode wires onAuthenticate to the REAL evaluateAuthenticate, so these tests need real
// camp tokens — a fake token string is rejected and nothing is ever admitted, which looks exactly
// like "sync is broken" while actually being an invalid fixture.
function authorizeBoth(db, publicKey) {
  db.prepare('UPDATE camps SET signing_public_key = ?').run(publicKey)
  for (const id of [DEV_A, DEV_B]) {
    db.prepare("INSERT OR IGNORE INTO devices (id, name, authorized_at, pairing_status) VALUES (?,?,?,'authorized')")
      .run(id, `dev-${id.slice(0, 4)}`, new Date().toISOString())
  }
}
beforeEach(() => resetForTests())
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  nodes = []
  for (const d of dbs) { try { d.close() } catch { /* already closed */ } }
  dbs = []
})
async function waitFor(fn, { timeout = 4000 } = {}) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('Stage 5f — a no-op merge must not leave a dead doc handle in the registry', () => {
  it('a local write still works after receiving a frame that brings nothing new', async () => {
    const db = freshDb()
    const doc = applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })
    const node = await startSyncNode({ deviceId: 'd1', db, doc })
    nodes.push(node)

    // Feed the node a frame identical to what it already has: A.merge consumes the registered
    // handle, the heads do not advance, and the early-return path is taken. Before the fix the
    // registry kept the CONSUMED handle and every later local write threw
    // "Attempting to change an outdated document" — permanently, until restart.
    await node.sendDocTo(node.peerId, A.save(doc)).catch(() => {})
    await new Promise((r) => setTimeout(r, 200))

    // The registry's handle must still be usable.
    const current = getCurrentDoc(db)
    expect(current).toBeTruthy()
    expect(() =>
      setCurrentDoc(db, applyWrite(current, { entity: 'activities', entity_id: 'a2', field: 'name', value: 'Archery' }))
    ).not.toThrow()
    expect(Object.keys(getCurrentDoc(db).activities).sort()).toEqual(['a1', 'a2'])
  })
})

describe('Stage 5f — a newly admitted peer is sent the current doc (initial sync)', () => {
  it('a peer that connects AFTER a write receives that write without any new edit happening', async () => {
    const dbA = freshDb()
    const dbB = freshDb()
    // A already holds state before B ever exists — the real case: the office machine has the
    // schedule, the second device is opened later. Before the fix, B received nothing until
    // somebody made a fresh edit, because every send was triggered by a write or a relay.
    let docA = applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: 'pre', field: 'camp_id', value: CAMP_ID })
    docA = applyWrite(docA, { entity: 'activities', entity_id: 'pre', field: 'name', value: 'Archery' })

    const key = ensureHostSigningKey(dbA)
    authorizeBoth(dbA, key.public_key)
    authorizeBoth(dbB, key.public_key)
    const tokenA = issueCampToken(dbA, randomUUID(), DEV_A)
    const tokenB = issueCampToken(dbA, randomUUID(), DEV_B)

    const a = await startSyncNode({ deviceId: DEV_A, db: dbA, doc: docA })
    const b = await startSyncNode({ deviceId: DEV_B, db: dbB, doc: createEmptyDoc() })
    nodes.push(a, b)

    await b.dial(a.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    // BOTH directions must authenticate: A pushing its doc to B still has to pass B's own inbound
    // admission gate, and a node only accepts frames from peers that proved membership to IT. This
    // is the same mutual-auth requirement wireMutualAuth exists to satisfy in production — one-way
    // auth means nothing flows in either direction.
    await b.authenticateWith(a.peerId, { type: 'authenticate', token: tokenB, device_id: DEV_B })
    await a.authenticateWith(b.peerId, { type: 'authenticate', token: tokenA, device_id: DEV_A })
    await waitFor(() => a.isPeerAuthenticated(b.peerId) && b.isPeerAuthenticated(a.peerId))

    await waitFor(() => dbB.prepare("SELECT id FROM activities WHERE id = 'pre'").get() !== undefined)
    expect(dbB.prepare("SELECT name FROM activities WHERE id = 'pre'").get().name).toBe('Archery')
  })
})
