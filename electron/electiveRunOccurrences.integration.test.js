// @vitest-environment node
//
// T296 — getElectiveRunHandler returns the run's own persisted occurrence rows.
//
// WHY THIS IS NEEDED AND IS NOT SCOPE CREEP. The renderer's `occurrences` for an
// elective run are React state in AssignmentPanel, set only by
// chooseTemplateAndSolve — so a run opened COLD from the run list (the ordinary
// way a director returns to one) has `[]`. Every surface that names an
// occurrence then degrades to printing a raw id; runStateCopy.js's
// occurrenceLabel documents exactly that ("the day/time block only when the
// caller has the run's occurrences in hand ... not for one opened cold from the
// run list"). T296's view is a week of days and periods, so for it that
// degradation is not cosmetic — it is the feature not working on its main path.
//
// Nothing new is stored. commitElectiveRun already writes elective_occurrences
// with run_id/day_id/time_block_id/tier_id, in the same transaction as the
// assignments; this only hands those rows to the one read that already returns
// everything else about a run. No schema version, no new IPC channel, no new
// permission — the same 'elective_assignment_runs.read' action guards it.
//
// A separate file rather than an append to electiveRunFinalize.integration.test.js,
// for the reason that file's own header gives: concurrent tickets append to
// main.js in order, and keeping tests in their own files makes the conflicts
// mechanical.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

vi.mock('./sync/localWriteClient.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    createLocalWriteClient: vi.fn((mockDb, opts) => actual.createLocalWriteClient(mockDb, opts)),
  }
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

function localTestWrite() {
  return async ({ entity, entity_id, field, value }) => {
    const op = appendOp(db, {
      entity, entity_id, field, value,
      author_user_id: null, device_id: deviceId, parent_op_id: null,
    })
    return { status: 'applied', op }
  }
}

async function seedAdmin({ name = 'Director', pin = '123400' } = {}) {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Shoresh', 'a'.repeat(64))
  await createUser(db, { camp_id: campId, name, pin, role: 'admin' }, localTestWrite())
  const handlers = makeHandlers(db, deviceId, {})
  const { token } = await handlers.login({ name, pin })
  return { campId, handlers, token }
}

function seedFixture(campId) {
  const ids = {
    groupId: randomUUID(), tierId: randomUUID(), setId: randomUUID(),
    activityId: randomUUID(), camperId: randomUUID(),
    dayId: 'day-1', timeBlockId: 'tb-1', templateId: 'tpl-1',
  }
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(ids.tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(ids.groupId, campId, 'Bogrim A', ids.tierId)
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label, sort_order) VALUES (?, ?, ?, 1)').run(ids.dayId, campId, 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name, sort_order) VALUES (?, ?, ?, 1)').run(ids.timeBlockId, campId, 'First Period')
  db.prepare('INSERT INTO activities (id, camp_id, name, span_blocks) VALUES (?, ?, ?, 1)').run(ids.activityId, campId, 'Archery')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(ids.setId, campId, 'AM Electives')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), ids.setId, ids.activityId, 'unlimited', null)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), ids.templateId, ids.groupId, ids.setId, ids.dayId, ids.timeBlockId)
  return ids
}

function buildRun(campId, fx, { runId = randomUUID() } = {}) {
  const occurrenceId = deriveElectiveOccurrenceId(runId, fx.setId, fx.dayId, fx.timeBlockId, fx.tierId)
  const occurrences = [{ id: occurrenceId, elective_set_id: fx.setId, day_id: fx.dayId, time_block_id: fx.timeBlockId, tier_id: fx.tierId }]
  const parsed = {
    campers: [{ id: fx.camperId, display_name: 'Testcamper Alpha', external_id: null }],
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: [{ camper_id: fx.camperId, occurrence_id: occurrenceId, label: 'Archery', labelKey: 'archery', rank: 1 }],
    sameNameCampers: [],
    skippedRows: [],
  }
  const assignments = [{
    camper_id: fx.camperId, occurrence_id: occurrenceId, labelKey: 'archery',
    activity_id: fx.activityId, preference_rank: 1, flags: [],
  }]
  const out = commitElectiveRun(db, {
    campId, deviceId, name: 'Week 1 electives', parsed, assignments, occurrences,
    scheduleTemplateId: fx.templateId, runId,
  })
  expect(out.ok).toBe(true)
  return { runId: out.runId, occurrenceId }
}

describe('getElectiveRunHandler — the run’s own occurrences', () => {
  it('returns the persisted occurrence rows, so a run opened cold can name its periods', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(campId)
    const { runId, occurrenceId } = buildRun(campId, fx)

    const result = await handlers.getElectiveRun({ token, runId })

    expect(result.occurrences).toEqual([
      {
        id: occurrenceId,
        elective_set_id: fx.setId,
        day_id: fx.dayId,
        time_block_id: fx.timeBlockId,
        tier_id: fx.tierId,
      },
    ])
    // The point of the change: every assignment row's occurrence is resolvable
    // from what this one call returned, with no second read and no React state.
    const byId = new Map(result.occurrences.map((o) => [o.id, o]))
    for (const row of result.rows) expect(byId.has(row.occurrence_id)).toBe(true)
  })

  it('scopes the occurrences to the run asked for', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(campId)
    const first = buildRun(campId, fx)
    const second = buildRun(campId, fx)
    expect(first.occurrenceId).not.toBe(second.occurrenceId)

    const result = await handlers.getElectiveRun({ token, runId: first.runId })
    expect(result.occurrences.map((o) => o.id)).toEqual([first.occurrenceId])
  })

  it('still refuses without a token, on the same read action as the rest of the call', async () => {
    const { campId, handlers } = await seedAdmin()
    const fx = seedFixture(campId)
    const { runId } = buildRun(campId, fx)
    // Synchronous throw, not a rejected promise — this handler is not async.
    expect(() => handlers.getElectiveRun({ runId })).toThrow(/token is required/)
  })
})
