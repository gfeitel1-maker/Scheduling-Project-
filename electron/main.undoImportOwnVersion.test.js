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

// T219: a double-period elective writes a bundle per choice after the commit. Those bundles belong to
// the import too, so undo removes them with the set (a bundle holds a hard FK to its set, so a bundle
// left behind would keep the set and every import-minted choice on its account).
describe('undo of an import that linked a double-period elective', () => {
  it('removes the elective set, its choices and the bundles the import wrote', async () => {
    const run = await handlers.ingestCommit({
      token,
      captureInverse: true,
      approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00'], activities: [] },
      links: {},
      confirmedElectiveSets: [{ name: 'Chugim', choices: ['Pottery', 'Drama'] }],
      placements: ['9:00-10:00', '10:00-11:00'].map((b) => ({ groupName: 'Otters 1', dayName: 'Monday', blockLabel: b, activityName: 'Chugim', electiveSetName: 'Chugim', choices: ['Pottery', 'Drama'] })),
      sourceFileName: 'week.txt',
    })
    expect(run.version?.created).toBe(true)
    // Positive control: the import did link the span.
    expect(count('elective_sets')).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(2)

    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })

    expect(res.kept).toEqual([])
    expect(count('elective_sets')).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_set_activities').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundle_periods').get().n).toBe(0)
  })
})

describe('undo of an import that created an elective', () => {
  it('removes the elective set and the choices it minted', async () => {
    const run = await handlers.ingestCommit({
      token,
      captureInverse: true,
      approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00'], activities: [] },
      links: {},
      confirmedElectiveSets: [{ name: 'Chugim', choices: ['Pottery', 'Drama'] }],
      placements: [{ groupName: 'Otters 1', dayName: 'Monday', blockLabel: '9:00-10:00', activityName: 'Chugim', electiveSetName: 'Chugim', choices: ['Pottery', 'Drama'] }],
      sourceFileName: 'week.txt',
    })
    expect(count('elective_sets')).toBe(1)
    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })
    expect(res.kept).toEqual([])
    expect(count('elective_sets')).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_set_activities').get().n).toBe(0)
  })
})

// Red Hat #6: a bundle the director edited since the import is theirs and stays; its periods are
// its substance, so they stay with it rather than leaving an inert bundle with no periods.
describe('undo after the director edited an imported bundle', () => {
  it('keeps the edited bundle with all its periods', async () => {
    const run = await handlers.ingestCommit({
      token,
      captureInverse: true,
      approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00'], activities: [] },
      links: {},
      confirmedElectiveSets: [{ name: 'Chugim', choices: ['Pottery'] }],
      placements: ['9:00-10:00', '10:00-11:00'].map((b) => ({ groupName: 'Otters 1', dayName: 'Monday', blockLabel: b, activityName: 'Chugim', electiveSetName: 'Chugim', choices: ['Pottery'] })),
      sourceFileName: 'week.txt',
    })
    const bundle = db.prepare('SELECT id FROM elective_bundles').get()
    appendOp(db, { entity: 'elective_bundles', entity_id: bundle.id, field: 'name', value: 'Pottery double', author_user_id: null, device_id: deviceId, source: 'human' })

    const res = await handlers.ingestUndo({ token, importRunId: run.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })

    expect(res.kept).toContainEqual(expect.objectContaining({ entity: 'elective_bundles', entity_id: bundle.id, reason: 'edited_since_import' }))
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundle_periods WHERE bundle_id = ?').get(bundle.id).n).toBe(2)
  })
})

// Keeper ruling: undo means "as if the import never happened". Undo then a re-import of the same
// file behaves like a first import; only a director's own delete is a tombstone.
describe('undo, then re-import the same file', () => {
  const doubleChug = () => handlers.ingestCommit({
    token,
    captureInverse: true,
    approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00', '11:00-11:30'], activities: [] },
    links: {},
    confirmedElectiveSets: [{ name: 'Chugim', choices: ['Pottery', 'Drama'] }],
    fixedEvents: [{ name: 'Mifkad', time_block: '11:00-11:30', days: ['Monday'], scope: { is_all_groups: true, groups: [] } }],
    placements: ['9:00-10:00', '10:00-11:00'].map((b) => ({ groupName: 'Otters 1', dayName: 'Monday', blockLabel: b, activityName: 'Chugim', electiveSetName: 'Chugim', choices: ['Pottery', 'Drama'] })),
    sourceFileName: 'week.txt',
  })

  it('relinks the double period and brings the fixed event back', async () => {
    // The camp's group, day and periods exist before this import, so undo leaves them and the
    // re-import resolves to the SAME ids: the case where an undo delete could act as a tombstone.
    await handlers.ingestCommit({
      token,
      approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00', '11:00-11:30'], activities: [] },
      links: {},
    })
    const first = await doubleChug()
    // Positive control: the first import linked the span and created the event.
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(2)
    expect(count('fixed_events')).toBe(1)
    const res = await handlers.ingestUndo({ token, importRunId: first.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })
    expect(res.kept).toEqual([])
    expect(count('fixed_events')).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(0)

    await doubleChug()

    expect(count('fixed_events')).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundle_periods').get().n).toBe(4)
  })
})

// Final audit (packaged 5813133): the director deleted a set, an import recreated it under the same
// derived id, the import was undone, and a re-import of the same file then created no set at all.
// Semantics (keeper ruling): undo leaves no rejection, and an import that succeeded in recreating a
// row the director had deleted ends that rejection for the row. Both orders are pinned.
describe('a set the director deleted, recreated by an import', () => {
  const setup = () => handlers.ingestCommit({
    token,
    approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00'], activities: [] },
    links: {},
  })
  const importChug = () => handlers.ingestCommit({
    token,
    captureInverse: true,
    approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00'], activities: [] },
    links: {},
    confirmedElectiveSets: [{ name: 'Chugim', choices: ['Pottery', 'Drama'] }],
    placements: ['9:00-10:00', '10:00-11:00'].map((b) => ({ groupName: 'Otters 1', dayName: 'Monday', blockLabel: b, activityName: 'Chugim', electiveSetName: 'Chugim', choices: ['Pottery', 'Drama'] })),
    sourceFileName: 'week.txt',
  })
  const directorDeletesSets = async () => {
    for (const { id } of db.prepare('SELECT id FROM elective_sets').all()) {
      const res = await handlers.deleteElectiveSet({ token, electiveSetId: id })
      expect(res?.error).toBeUndefined()
    }
    expect(count('elective_sets')).toBe(0)
  }

  it('director delete, import, undo, re-import: the set and its bundles come back (the audit order)', async () => {
    await setup()
    // The audit's campB: an earlier import brought its own elective, which the director deleted.
    await handlers.ingestCommit({
      token,
      approved: { groups: ['Otters 1'], tiers: [], days_of_operation: ['Monday'], time_blocks: ['9:00-10:00', '10:00-11:00'], activities: [] },
      links: {},
      confirmedElectiveSets: [{ name: 'Indoor Elective', choices: ['Chess'] }],
    })
    await directorDeletesSets()
    const first = await importChug()
    expect(count('elective_sets')).toBe(1)
    const undone = await handlers.ingestUndo({ token, importRunId: first.importRunId, client_write_id: randomUUID(), invertibleOps: [], createdEntityIds: [] })
    expect(undone.kept).toEqual([])
    expect(count('elective_sets')).toBe(0)

    await importChug()

    expect(count('elective_sets')).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(2)
  })

  it('import, director delete, re-import: the director wins only until the import succeeds', async () => {
    await setup()
    await importChug()
    await directorDeletesSets()
    await importChug()
    // The set is recreated by the import (a set has no import rejection), and its double period
    // is linked again: the earlier rejection ended when this import recreated the rows.
    expect(count('elective_sets')).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_bundles').get().n).toBe(2)
  })
})
