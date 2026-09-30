// @vitest-environment node
//
// T250 director-flow slices A0 (widen listElectiveRuns/getElectiveRun reads)
// and A4 (deleteElectiveRun cascade + handler). New file, mirrors
// electron/electiveRunFinalize.integration.test.js's harness exactly (same
// electron mock, same openTemplatedDb/makeHandlers setup, real appendOp) —
// kept separate so each T250 slice's tests stay mechanically non-conflicting.
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
import { deleteElectiveRun } from './ops/deleteElectiveRun.js'
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
  const user = await createUser(db, { camp_id: campId, name, pin, role: 'admin' }, localTestWrite())
  const handlers = makeHandlers(db, deviceId, {})
  const { token } = await handlers.login({ name, pin })
  return { campId, user, handlers, token }
}

async function seedStaff({ name = 'Staffer', pin = '654321' } = {}, { campId, handlers }) {
  await createUser(db, { camp_id: campId, name, pin, role: 'staff' }, localTestWrite())
  const { token } = await handlers.login({ name, pin })
  return { token }
}

function seedFixture(db, { campId, templateId = 'tpl-1', capacity = { mode: 'unlimited', limit: null } } = {}) {
  const groupId = randomUUID()
  const tierId = randomUUID()
  const setId = randomUUID()
  const activityId = randomUUID()
  const locationId = randomUUID()
  const camperId = randomUUID()
  const dayId = 'day-1'
  const timeBlockId = 'tb-1'

  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bogrim A', tierId)
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(locationId, campId, 'Field', 5)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)').run(activityId, campId, 'Archery', locationId)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'AM Electives')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), setId, activityId, capacity.mode, capacity.limit)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, setId, dayId, timeBlockId)

  return { groupId, tierId, setId, activityId, locationId, camperId, dayId, timeBlockId, templateId }
}

function buildRun(db, campId, fx, { runId = randomUUID(), extraCampers = [] } = {}) {
  const occurrenceId = deriveElectiveOccurrenceId(runId, fx.setId, fx.dayId, fx.timeBlockId, fx.tierId)
  const occurrences = [{ id: occurrenceId, elective_set_id: fx.setId, day_id: fx.dayId, time_block_id: fx.timeBlockId, tier_id: fx.tierId }]
  const campers = [{ id: fx.camperId, name: 'Ari Green' }, ...extraCampers]
  const parsed = {
    campers: campers.map((c) => ({ id: c.id, display_name: c.name, external_id: null })),
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: campers.map((c) => ({ camper_id: c.id, occurrence_id: occurrenceId, label: 'Archery', labelKey: 'archery', rank: 1 })),
    sameNameCampers: [],
    skippedRows: [],
  }
  const assignments = campers.map((c) => ({
    camper_id: c.id, occurrence_id: occurrenceId, labelKey: 'archery', activity_id: fx.activityId, preference_rank: 1, flags: [],
  }))
  const out = commitElectiveRun(db, {
    campId, deviceId, name: 'Week 1 electives', parsed, assignments, occurrences,
    scheduleTemplateId: fx.templateId, runId,
  })
  expect(out.ok).toBe(true)
  return { runId: out.runId, occurrenceId }
}

// ---------------------------------------------------------------------------
// A0.1 — listElectiveRunsHandler widened SELECT
// ---------------------------------------------------------------------------
describe('A0.1 listElectiveRunsHandler', () => {
  it('includes schedule_week_id, schedule_template_id, tier_id, finalized_at, finalized_by on every row', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)
    await handlers.finalizeElectiveRun({ token, runId })

    const runs = await handlers.listElectiveRuns(token)
    const run = runs.find((r) => r.id === runId)
    expect(run.schedule_template_id).toBe(fx.templateId)
    expect(run.tier_id).toBeDefined()
    expect(typeof run.finalized_at).toBe('string')
    expect(run.finalized_by).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// A0.2 — getElectiveRun additive `campers` field
// ---------------------------------------------------------------------------
describe('A0.2 getElectiveRun campers field', () => {
  it('returns every camper who has a preference or an assignment on the run, with group name resolved', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)
    db.prepare('UPDATE campers SET group_id = ? WHERE id = ?').run(fx.groupId, fx.camperId)

    const result = await handlers.getElectiveRun({ token, runId })
    expect(result.campers.some((c) => c.id === fx.camperId)).toBe(true)
    const camper = result.campers.find((c) => c.id === fx.camperId)
    expect(camper.group_name).toBe('Bogrim A')
  })
})

// ---------------------------------------------------------------------------
// A4 — deleteElectiveRun cascade
// ---------------------------------------------------------------------------
describe('deleteElectiveRun (ops)', () => {
  it('removes every child row plus the parent row, leaving no orphans', async () => {
    const { campId } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ?').get(runId).c).toBeGreaterThan(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE run_id = ?').get(runId).c).toBeGreaterThan(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_occurrences WHERE run_id = ?').get(runId).c).toBeGreaterThan(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_choices WHERE run_id = ?').get(runId).c).toBeGreaterThan(0)

    const result = deleteElectiveRun(db, { runId }, { author_user_id: null, device_id: deviceId })
    expect(result.ok).toBe(true)
    expect(result.ops.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs WHERE id = ?').get(runId).c).toBe(0)
    for (const table of [
      'elective_occurrences', 'elective_choices', 'elective_preferences', 'elective_assignments',
      'elective_run_outer_snapshots',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE run_id = ?`).get(runId).c).toBe(0)
    }
    expect(db.prepare('SELECT COUNT(*) c FROM elective_choice_offerings').get().c).toBe(0)
  })

  it('cascades child rows before the parent, through appendOp so each is replicable', async () => {
    const { campId } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const result = deleteElectiveRun(db, { runId }, { author_user_id: null, device_id: deviceId })
    const parentIndex = result.ops.findIndex((o) => o.entity === 'elective_assignment_runs')
    expect(parentIndex).toBe(result.ops.length - 1)
    for (const op of result.ops) expect(op.field).toBe('__deleted__')
  })

  it('a final run is deletable', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)
    await handlers.finalizeElectiveRun({ token, runId })

    const result = deleteElectiveRun(db, { runId }, { author_user_id: null, device_id: deviceId })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs WHERE id = ?').get(runId).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(runId).c).toBe(0)
  })

  it('returns { error: "not-found" } for a missing runId, so a retry after success is safe', () => {
    const result = deleteElectiveRun(db, { runId: 'no-such-run' }, { author_user_id: null, device_id: deviceId })
    expect(result).toEqual({ error: 'not-found' })
  })
})

// ---------------------------------------------------------------------------
// A4 — deleteElectiveRunHandler IPC wiring
// ---------------------------------------------------------------------------
describe('deleteElectiveRunHandler', () => {
  it('deletes the run when called by an admin', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const result = await handlers.deleteElectiveRun({ token, runId })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs WHERE id = ?').get(runId).c).toBe(0)
  })

  it('default-denies staff (elective_assignment_runs is absent from permissions.js ENTITIES)', async () => {
    const { campId, handlers, token: adminToken } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)
    const { token: staffToken } = await seedStaff({}, { campId, handlers })

    expect(() => handlers.deleteElectiveRun({ token: staffToken, runId })).toThrow('admin role required')
    // Unaffected — the admin's own run is still there.
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs WHERE id = ?').get(runId).c).toBe(1)
    void adminToken
  })
})
