// @vitest-environment node
//
// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md) — a NEW
// file (per this repo's per-ticket test-file convention), asserting the exit clause
// electiveRunOuterSchedule.integration.test.js's UNMODIFIED symmetry test does not cover directly:
// inherited (group-template) cells appear on BOTH the draft-derive path and the finalize snapshot,
// span-collapsed, and finalize/re-derive symmetry holds when inherited rows are present too.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

vi.mock('./sync/localWriteClient.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { createLocalWriteClient: vi.fn((mockDb, opts) => actual.createLocalWriteClient(mockDb, opts)) }
})

import { getOrCreateDeviceId } from './db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { commitElectiveRun } from './ops/commitElectiveRun.js'
import { makeHandlers } from './main.js'
import { deriveElectiveOccurrenceId } from './ops/electiveDerivedIds.js'

let tmpFile
let db
let deviceId

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  tmpFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  db.prepare(
    "UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)

  const hostKey = ensureHostSigningKey(db)
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS trg_test_set_signing_public_key
    AFTER INSERT ON camps
    WHEN NEW.signing_public_key IS NULL
    BEGIN
      UPDATE camps SET signing_public_key = '${hostKey.public_key}' WHERE id = NEW.id;
    END;
  `)

  vi.clearAllMocks()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

afterAll(() => {
  cleanupTemplatedDbs()
})

async function seedAdmin({ name = 'Director', pin = '123400' } = {}) {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp A', 'a'.repeat(64))
  const user = await createUser(db, { camp_id: campId, name, pin, role: 'admin' }, async ({ entity, entity_id, field, value }) => {
    const op = appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: deviceId, parent_op_id: null })
    return { status: 'applied', op }
  })
  const handlers = makeHandlers(db, deviceId, {})
  const { token } = await handlers.login({ name, pin })
  return { campId, user, handlers, token }
}

// Fixture with a group that has BOTH an elective-set slot (Archery, this run's own occurrence) and
// a plain non-elective template slot (Arts & Crafts) in the SAME template, so a finalized run's
// snapshot must carry both an 'elective' and an 'inherited' row for the same camper.
function seedFixture(db, { campId, templateId = 'tpl-1' } = {}) {
  const groupId = randomUUID()
  const tierId = randomUUID()
  const setId = randomUUID()
  const electiveActivityId = randomUUID()
  const inheritedActivityId = randomUUID()
  const locationId = randomUUID()
  const camperId = randomUUID()
  const dayId = 'day-1'
  const electiveBlockId = 'tb-1'
  const inheritedBlockId = 'tb-2'

  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk Alpha', tierId)
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(locationId, campId, 'Field', 5)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)').run(electiveActivityId, campId, 'Archery', locationId)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)').run(inheritedActivityId, campId, 'Arts & Crafts', locationId)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'AM Electives')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), setId, electiveActivityId, 'unlimited', null)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, setId, dayId, electiveBlockId)
  // The non-elective, group-template slot the run's camper should INHERIT.
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, inheritedActivityId, dayId, inheritedBlockId)
  db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)').run(camperId, campId, 'Camper A', groupId)

  return { groupId, tierId, setId, electiveActivityId, inheritedActivityId, locationId, camperId, dayId, electiveBlockId, inheritedBlockId, templateId }
}

function buildRun(db, campId, fx, { runId = randomUUID() } = {}) {
  const occurrenceId = deriveElectiveOccurrenceId(runId, fx.setId, fx.dayId, fx.electiveBlockId, fx.tierId)
  const occurrences = [{ id: occurrenceId, elective_set_id: fx.setId, day_id: fx.dayId, time_block_id: fx.electiveBlockId, tier_id: fx.tierId }]
  const parsed = {
    campers: [{ id: fx.camperId, display_name: 'Camper A', external_id: null }],
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: [{ camper_id: fx.camperId, label: 'Archery', labelKey: 'archery', rank: 1 }],
    sameNameCampers: [],
    skippedRows: [],
  }
  const assignments = [{ camper_id: fx.camperId, occurrence_id: occurrenceId, labelKey: 'archery', activity_id: fx.electiveActivityId, preference_rank: 1, flags: [] }]
  const out = commitElectiveRun(db, {
    campId, deviceId, name: 'Week 1 electives', parsed, assignments, occurrences,
    scheduleTemplateId: fx.templateId, runId,
  })
  expect(out.ok).toBe(true)
  return { runId: out.runId }
}

describe('T197 inherited cells: draft-derive, finalize snapshot, and symmetry', () => {
  it('draft-derive includes both the elective placement AND the inherited group-template cell', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const result = await handlers.getElectiveRunOuterSchedule({ token, runId })

    expect(result.rows).toHaveLength(2)
    const elective = result.rows.find((r) => r.cellKind === 'elective')
    const inherited = result.rows.find((r) => r.cellKind === 'inherited')
    expect(elective).toMatchObject({ activityName: 'Archery', timeBlockId: fx.electiveBlockId })
    expect(inherited).toMatchObject({ activityName: 'Arts & Crafts', timeBlockId: fx.inheritedBlockId })
  })

  it('a finalized run survives a later template edit: the inherited cell stays in the export even after the template slot is deleted (D6)', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const fin = await handlers.finalizeElectiveRun({ token, runId })
    expect(fin.ok).toBe(true)

    // Simulate a later template edit: rename the inherited activity AND delete its template slot.
    db.prepare('UPDATE activities SET name = ? WHERE id = ?').run('Arts & Crafts (renamed)', fx.inheritedActivityId)
    db.prepare('DELETE FROM template_slots WHERE group_id = ? AND activity_id = ?').run(fx.groupId, fx.inheritedActivityId)

    const result = await handlers.getElectiveRunOuterSchedule({ token, runId })
    expect(result.runStatus).toBe('final')
    const inherited = result.rows.find((r) => r.cellKind === 'inherited')
    expect(inherited).toMatchObject({ activityName: 'Arts & Crafts' }) // frozen at finalize, NOT renamed, NOT gone
  })

  it('finalize symmetry holds with inherited rows present: draft-derived rows equal snapshot rows field-for-field', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const draft = await handlers.getElectiveRunOuterSchedule({ token, runId })
    const fin = await handlers.finalizeElectiveRun({ token, runId })
    expect(fin.ok).toBe(true)
    const final = await handlers.getElectiveRunOuterSchedule({ token, runId })

    expect(final.rows).toEqual(draft.rows)
  })
})
