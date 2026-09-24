// @vitest-environment node
//
// T244 (docs/work/tickets/T244-finalize-elective-run-ipc.md, ADR docs/adr/
// 2026-09-23-elective-run-lifecycle-and-remaining-slices.md decisions (a) and
// (b)) — finalizeElectiveRunHandler and the getElectiveRunHandler shape
// change. A NEW file, not appended to electron/main.test.js, to keep merge
// conflicts with T245/T248/T249 mechanical (each ticket appends its own
// handler(s) to main.js/preload.js in order but tests stay in separate
// files).
//
// Mirrors electron/main.test.js's setup exactly: same electron mock, same
// openTemplatedDb/makeHandlers harness, real appendOp — this exercises the
// actual write path through electron/ops/**, per this repo's mandatory
// integration-harness rule for anything touching that layer.
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
import { deriveElectiveOccurrenceId, deriveElectiveAssignmentId } from './ops/electiveDerivedIds.js'

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

// A minimal camp fixture: one group/tier, one elective set with a single
// activity offering, one template_slots row placing that set for the group at
// day-1/tb-1 on the run's schedule template, and one camper assigned into it.
// Returns everything needed to build a run and assert against it.
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
    preferences: campers.map((c) => ({ camper_id: c.id, label: 'Archery', labelKey: 'archery', rank: 1 })),
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

describe('finalizeElectiveRunHandler', () => {
  it('case 1: finalizes a clean draft — snapshot row count matches assigned-camper x occupied-cell count, every row carries solver_generation', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const result = await handlers.finalizeElectiveRun({ token, runId })
    expect(result.ok).toBe(true)
    expect(result.snapshotRows).toBe(1)
    expect(typeof result.finalizedAt).toBe('string')

    const rows = db.prepare('SELECT * FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId)
    expect(rows).toHaveLength(1)
    expect(rows[0].camper_id).toBe(fx.camperId)
    expect(rows[0].day_id).toBe(fx.dayId)
    expect(rows[0].time_block_id).toBe(fx.timeBlockId)
    expect(rows[0].activity_name).toBe('Archery')
    // solver_generation is NULL on this run (nothing sets it yet), and every
    // snapshot row must carry the SAME value the run currently has.
    const run = db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(runId)
    expect(rows[0].solver_generation).toBe(run.solver_generation)

    const runRow = db.prepare("SELECT status FROM elective_assignment_runs WHERE id = ?").get(runId)
    expect(runRow.status).toBe('final')
  })

  it('case 2: a template edit after generation but before finalize -> STALE_OUTER_SCHEDULE with a non-empty diff', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    // Move the group's elective placement to a different day — the live
    // occurrence set no longer matches what the run recorded.
    db.prepare('UPDATE template_slots SET day_id = ? WHERE elective_set_id = ?').run('day-2', fx.setId)

    const result = await handlers.finalizeElectiveRun({ token, runId })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('STALE_OUTER_SCHEDULE')
    expect(result.findings.length).toBeGreaterThan(0)

    const runRow = db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId)
    expect(runRow.status).toBe('draft')
  })

  it('case 3: OUTER_RESOURCE_CONFLICT from two overlays over capacity at one location/day/block', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    // Location capacity is 1; place two more activity slots pointing at the
    // SAME location/day/block the run's own occurrence uses, for two
    // different groups — three occupants total against capacity 1.
    db.prepare('UPDATE locations SET capacity = 1 WHERE id = ?').run(fx.locationId)
    const otherGroupA = randomUUID()
    const otherGroupB = randomUUID()
    db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(otherGroupA, campId, 'G-A', fx.tierId)
    db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(otherGroupB, campId, 'G-B', fx.tierId)
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, otherGroupA, fx.activityId, fx.dayId, fx.timeBlockId)
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, otherGroupB, fx.activityId, fx.dayId, fx.timeBlockId)

    const result = await handlers.finalizeElectiveRun({ token, runId })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('OUTER_RESOURCE_CONFLICT')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings[0].locationId).toBe(fx.locationId)
  })

  it('case 4: finalizing twice returns ALREADY_FINAL the second time and writes no duplicate snapshot rows', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const first = await handlers.finalizeElectiveRun({ token, runId })
    expect(first.ok).toBe(true)
    const countAfterFirst = db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(runId).c

    const second = await handlers.finalizeElectiveRun({ token, runId })
    expect(second).toEqual({ ok: false, error: 'ALREADY_FINAL' })

    const countAfterSecond = db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(runId).c
    expect(countAfterSecond).toBe(countAfterFirst)
  })

  it('case 5: stale-generation solver rows are excluded from getElectiveRunHandler after a regeneration, EXCEPT source=manual rows (H3 exemption)', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId, occurrenceId } = buildRun(db, campId, fx)

    // A second, manually-locked camper placed directly (source='manual'),
    // stamped with the OLD generation.
    const manualCamperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, is_active) VALUES (?, ?, ?, 1)').run(manualCamperId, campId, 'Manual Camper')
    const manualAssignmentId = deriveElectiveAssignmentId(runId, manualCamperId, occurrenceId)
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'run_id', value: runId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'occurrence_id', value: occurrenceId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'camper_id', value: manualCamperId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'activity_id', value: fx.activityId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'source', value: 'manual', device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'solver_generation', value: 'gen-old', device_id: deviceId })

    // Regenerate: bump the run's marker so the original solver row is now stale.
    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'solver_generation', value: 'gen-new', device_id: deviceId })

    const result = await handlers.getElectiveRun({ token, runId })
    const camperIds = result.rows.map((r) => r.camper_id)
    // The original solver-produced row (NULL generation) is stale against gen-new -> excluded.
    expect(camperIds).not.toContain(fx.camperId)
    // The manual row stays visible regardless of the generation mismatch.
    expect(camperIds).toContain(manualCamperId)
    expect(result.staleCount).toBeGreaterThanOrEqual(1)
  })

  it('case 6: FINALIZED_AGAINST_STALE_GENERATION — finalize a run, then a later-merged regeneration moves the marker', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const before = await handlers.getElectiveRun({ token, runId })
    expect(before.finalizedAgainstStaleGeneration).toBe(false)

    const fin = await handlers.finalizeElectiveRun({ token, runId })
    expect(fin.ok).toBe(true)

    const stillCurrent = await handlers.getElectiveRun({ token, runId })
    expect(stillCurrent.finalizedAgainstStaleGeneration).toBe(false)

    // Simulate a since-synced concurrent regeneration merging in AFTER finalize,
    // without touching the snapshot (that's exactly what a merge from another
    // device looks like: the run's scalar field moves, the snapshot doesn't).
    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'solver_generation', value: 'gen-after-finalize', device_id: deviceId })

    const after = await handlers.getElectiveRun({ token, runId })
    expect(after.finalizedAgainstStaleGeneration).toBe(true)
  })

  it('case 7: overCapacityOccurrences — two visible rows for two campers against the same occurrence+activity exceeding stored capacity', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId, capacity: { mode: 'limited', limit: 1 } })
    const camper2 = randomUUID()
    const { runId } = buildRun(db, campId, fx, { extraCampers: [{ id: camper2, name: 'Second Camper' }] })

    const result = await handlers.getElectiveRun({ token, runId })
    expect(result.overCapacityOccurrences.length).toBe(1)
    expect(result.overCapacityOccurrences[0]).toMatchObject({ activityId: fx.activityId, capacity: 1, filled: 2 })
  })
})
