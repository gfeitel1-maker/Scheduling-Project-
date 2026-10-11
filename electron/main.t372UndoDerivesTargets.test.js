// @vitest-environment node
//
// T372 — import undo derives its targets from what the named run created (recorded in the main
// process), never from the renderer's createdEntityIds / fieldSnapshot / invertibleOps.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { makeHandlers } from './main.js'

let db, deviceId, campId, handlers, token

beforeEach(async () => {
  db = openTemplatedDb().db
  deviceId = getOrCreateDeviceId(db)
  const hostKey = ensureHostSigningKey(db)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)').run(campId, 'T372 Camp', 'a'.repeat(64), hostKey.public_key)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, deviceId)
  const write = async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) })
  await createUser(db, { camp_id: campId, name: 'Dir', pin: '246810', role: 'admin' }, write)
  db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), deviceId)
  handlers = makeHandlers(db, deviceId, { getAutomergeSyncNode: () => null })
  await handlers.chooseMode({ mode: 'client' })
  ;({ token } = await handlers.login({ name: 'Dir', pin: '246810' }))
})
afterEach(() => { try { db.close() } catch { /* already closed */ } })
afterAll(() => { cleanupTemplatedDbs() })

const has = (id) => !!db.prepare('SELECT 1 FROM activities WHERE id = ?').get(id)
const handMade = (name) => {
  const id = randomUUID()
  appendOp(db, { entity: 'activities', entity_id: id, field: 'camp_id', value: campId, author_user_id: null, device_id: deviceId, source: 'human' })
  appendOp(db, { entity: 'activities', entity_id: id, field: 'name', value: name, author_user_id: null, device_id: deviceId, source: 'human' })
  return id
}
const commit = async () => {
  const r = await handlers.ingestCommit({ token, approved: { activities: ['Archery'] }, captureInverse: true })
  expect(r.createdEntityIds.length).toBe(1)
  return r
}

describe('T372 undo derives targets from the recorded run', () => {
  it('a forged createdEntityIds entry for a row the run did not create is not deleted', async () => {
    const run = await commit()
    const forged = handMade('Hand Made')
    const res = await handlers.ingestUndo({
      token, importRunId: run.importRunId, client_write_id: randomUUID(),
      invertibleOps: [],
      createdEntityIds: [...run.createdEntityIds, { entity: 'activities', entity_id: forged, fieldSnapshot: {} }],
    })
    expect(has(forged)).toBe(true)
    expect(has(run.createdEntityIds[0].entity_id)).toBe(false)
    expect(res.deleted.map((d) => d.entity_id)).toEqual([run.createdEntityIds[0].entity_id])
  })

  it('a forged list with an unknown run id deletes nothing', async () => {
    const forged = handMade('Hand Made')
    await handlers.ingestUndo({
      token, importRunId: randomUUID(), client_write_id: randomUUID(), invertibleOps: [],
      createdEntityIds: [{ entity: 'activities', entity_id: forged, fieldSnapshot: {} }],
    })
    expect(has(forged)).toBe(true)
  })

  it('an emptied fieldSnapshot cannot bypass the edited-since-import check', async () => {
    const run = await commit()
    const id = run.createdEntityIds[0].entity_id
    appendOp(db, { entity: 'activities', entity_id: id, field: 'name', value: 'Archery (renamed)', author_user_id: null, device_id: deviceId, source: 'human' })
    const res = await handlers.ingestUndo({
      token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [],
      createdEntityIds: [{ entity: 'activities', entity_id: id, fieldSnapshot: {} }],
    })
    expect(has(id)).toBe(true)
    expect(res.kept.map((k) => k.reason)).toEqual(['edited_since_import'])
  })

  it('a forged invertibleOps entry cannot rewrite a field', async () => {
    const run = await commit()
    const victim = handMade('Hand Made')
    const { latestOp } = await import('./ops/operations.js')
    const seq = latestOp(db, 'activities', victim, 'name').seq
    await handlers.ingestUndo({
      token, importRunId: run.importRunId, client_write_id: randomUUID(), createdEntityIds: [],
      invertibleOps: [{ entity: 'activities', entity_id: victim, field: 'name', seq, priorValue: 'Pwned', prior_source: null }],
    })
    expect(db.prepare('SELECT name FROM activities WHERE id = ?').get(victim).name).toBe('Hand Made')
  })

  it('a normal undo by run id still removes everything the run created', async () => {
    const run = await commit()
    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID() })
    expect(has(run.createdEntityIds[0].entity_id)).toBe(false)
    expect(res.deleted.length).toBe(1)
  })
})
