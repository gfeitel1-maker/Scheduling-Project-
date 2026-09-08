// @vitest-environment node
//
// Stage 5f — a bug found by running the engine between two real machines, which no in-process test
// had exercised because CI tests never sent a redundant frame before a local write.
//
// (An initial-sync-on-admission test also lived here and was removed together with that feature:
// a whole-document push is not reliably deliverable — see syncNode.js's comment where it was
// removed. Its replacement is the tracked follow-up to adopt Automerge's own sync protocol.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as A from '@automerge/automerge'
import { randomUUID } from 'node:crypto'
import { initSchema } from '../../db/localDb.js'
import { startSyncNode } from './syncNode.js'
import { createEmptyDoc, applyWrite, listRecordIds } from '../../automerge/campDocument.js'
import { getCurrentDoc, setCurrentDoc, resetForTests } from './liveDoc.js'

let nodes = []
let dbs = []
const CAMP_ID = randomUUID()

function freshDb() {
  const db = new Database(':memory:')
  initSchema(db)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'T')
  dbs.push(db)
  return db
}

beforeEach(() => resetForTests())
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  nodes = []
  for (const d of dbs) { try { d.close() } catch { /* already closed */ } }
  dbs = []
})

describe('Stage 5f — a no-op merge must not leave a dead doc handle in the registry', () => {
  it('a local write still works after receiving a frame that brings nothing new', async () => {
    const db = freshDb()
    const doc = applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })
    const node = await startSyncNode({ deviceId: 'd1', db, doc })
    nodes.push(node)

    // Feed the node a frame identical to what it already holds: A.merge CONSUMES the registered
    // handle, the heads do not advance, and the early-return path is taken. Before the fix the
    // registry kept that consumed handle and every later local write threw "Attempting to change
    // an outdated document" — permanently, until restart. Redundant frames are routine in a mesh
    // (peers relay and re-send), so this bricked local editing in ordinary two-device use.
    await node.sendDocTo(node.peerId, A.save(doc)).catch(() => {})
    await new Promise((r) => setTimeout(r, 200))

    const current = getCurrentDoc(db)
    expect(current).toBeTruthy()
    expect(() =>
      setCurrentDoc(db, applyWrite(current, { entity: 'activities', entity_id: 'a2', field: 'name', value: 'Archery' }))
    ).not.toThrow()
    expect(listRecordIds(getCurrentDoc(db), 'activities')).toEqual(['a1', 'a2'])
  })
})
