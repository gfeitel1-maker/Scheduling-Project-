// @vitest-environment node
//
// Final audit, 2026-10-11 (packaged build d3de0e9): "Undo this import" said "Undo complete." and left
// every group and division the import created. The import's own "Imported from X" version names
// those rows, and undo keeps any row a saved version names ('used_in_saved_version'), so an import
// that saved a version could never be undone. Driven through the real IPC handlers, as the app does.
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
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)').run(campId, 'Undo Camp', 'a'.repeat(64), hostKey.public_key)
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

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE camp_id = ?`).get(campId).n
const importWeek = (groups, division) => handlers.ingestCommit({
  token,
  captureInverse: true,
  approved: { groups, tiers: [division], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00'], activities: ['Swim'] },
  links: { groups: Object.fromEntries(groups.map((g) => [g, division])) },
  placements: groups.map((g) => ({ groupName: g, dayName: 'Monday', blockLabel: '9:00-10:00', activityName: 'Swim' })),
  sourceFileName: 'week.txt',
})

describe('undo of an import that saved its own version', () => {
  it('removes the groups and division the import created', async () => {
    const run = await importWeek(['Otters 1', 'Otters 2'], 'Otters')
    expect(run.version?.created).toBe(true)
    expect(count('groups')).toBe(2)
    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })
    expect(res.kept).toEqual([])
    expect(count('groups')).toBe(0)
    expect(count('tiers')).toBe(0)
  })

  it('still keeps a row that a version the director saved names, and keeps that version', async () => {
    const run = await importWeek(['Otters 1'], 'Otters')
    const otters = db.prepare('SELECT id FROM groups WHERE name = ?').get('Otters 1').id
    const template = db.prepare('SELECT template_id FROM schedule_snapshots LIMIT 1').get().template_id
    const mine = randomUUID()
    for (const [field, value] of Object.entries({ template_id: template, name: 'My version', is_auto: 0, created_at: new Date().toISOString(), slots: JSON.stringify([{ group_id: otters }]) })) {
      appendOp(db, { entity: 'schedule_snapshots', entity_id: mine, field, value, author_user_id: null, device_id: deviceId, source: 'human' })
    }
    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })
    expect(res.kept).toContainEqual(expect.objectContaining({ name: 'Otters 1', reason: 'used_in_saved_version' }))
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(otters)).toBeTruthy()
    expect(db.prepare('SELECT 1 FROM schedule_snapshots WHERE id = ?').get(mine)).toBeTruthy()
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedule_snapshots WHERE name = 'Imported from week.txt'").get().n).toBe(0)
  })

  it('keeps an imported version the director renamed, and the rows it names', async () => {
    const run = await importWeek(['Otters 1'], 'Otters')
    const own = db.prepare("SELECT id FROM schedule_snapshots WHERE name = 'Imported from week.txt'").all()
    appendOp(db, { entity: 'schedule_snapshots', entity_id: own[0].id, field: 'name', value: 'Last summer (keep)', author_user_id: null, device_id: deviceId, source: 'human' })
    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })
    expect(db.prepare('SELECT 1 FROM schedule_snapshots WHERE id = ?').get(own[0].id)).toBeTruthy()
    expect(res.kept).toContainEqual(expect.objectContaining({ name: 'Otters 1', reason: 'used_in_saved_version' }))
  })
})

describe('a version saved before the version step failed', () => {
  it('is reported as soon as it is saved, so the import still owns it', async () => {
    const { materializeImportedVersion } = await import('./ops/materializeImportedVersion.js')
    await importWeek(['Otters 1'], 'Otters') // camp, week and catalog to place against
    db.prepare('DELETE FROM schedule_snapshots').run()
    let snapshotWrites = 0
    const failing = {
      async write({ entity, entity_id, field, value, author_user_id }) {
        if (entity === 'schedule_snapshots' && field === 'template_id' && ++snapshotWrites === 2) throw new Error('disk full')
        return { status: 'applied', op: appendOp(db, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) }
      },
    }
    const reported = []
    await expect(materializeImportedVersion(db, failing, {
      campId, authorUserId: null, sourceFileName: 'other.txt',
      placements: [{ groupName: 'Otters 1', dayName: 'Monday', blockLabel: '9:00-10:00', activityName: 'Swim' }],
      onSnapshotCreated: (id) => reported.push(id),
    })).rejects.toThrow('disk full')
    const saved = db.prepare("SELECT id FROM schedule_snapshots WHERE name = 'Imported from other.txt'").all().map((r) => r.id)
    expect(saved).toHaveLength(1)
    expect(reported).toEqual(saved)
  })
})
