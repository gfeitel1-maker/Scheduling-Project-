// @vitest-environment node
//
// T248 (docs/work/tickets/T248-child-schedule-export.md, ADR docs/adr/
// 2026-09-23-elective-run-lifecycle-and-remaining-slices.md decision (d)) —
// getElectiveRunOuterScheduleHandler. A NEW file, not appended to
// electron/electiveRunFinalize.integration.test.js, per that ticket's own
// merge-conflict-avoidance convention (each ticket's tests live in their own
// file even though they share electron/main.js/preload.js).
//
// Mirrors electron/electiveRunFinalize.integration.test.js's setup exactly:
// same electron mock, same openTemplatedDb/makeHandlers harness, real
// appendOp — mandatory integration-harness rule for anything touching
// electron/ops/**.
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
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk Alpha', tierId)
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
  const campers = [{ id: fx.camperId, name: 'Camper A' }, ...extraCampers]
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

describe('getElectiveRunOuterScheduleHandler', () => {
  it('final run: reads the immutable snapshot table, surviving an activity rename after finalize (D6)', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const fin = await handlers.finalizeElectiveRun({ token, runId })
    expect(fin.ok).toBe(true)

    db.prepare('UPDATE activities SET name = ? WHERE id = ?').run('Archery (renamed)', fx.activityId)

    const result = await handlers.getElectiveRunOuterSchedule({ token, runId })
    expect(result.runStatus).toBe('final')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      camperId: fx.camperId, dayId: fx.dayId, timeBlockId: fx.timeBlockId,
      activityName: 'Archery', locationName: 'Field',
    })
  })

  it('draft run: derives live', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const result = await handlers.getElectiveRunOuterSchedule({ token, runId })
    expect(result.runStatus).toBe('draft')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      camperId: fx.camperId, dayId: fx.dayId, timeBlockId: fx.timeBlockId, activityName: 'Archery',
    })
    expect(result.finalizedAgainstStaleGeneration).toBe(false)
  })

  it('finalize symmetry: a draft-derived row set equals the written snapshot rows field-for-field', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const draft = await handlers.getElectiveRunOuterSchedule({ token, runId })

    const fin = await handlers.finalizeElectiveRun({ token, runId })
    expect(fin.ok).toBe(true)

    const final = await handlers.getElectiveRunOuterSchedule({ token, runId })

    expect(final.rows).toEqual(draft.rows)
  })

  it('finalizedAgainstStaleGeneration is true for a final run whose snapshot generation no longer matches, false for a draft', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId } = buildRun(db, campId, fx)

    const draftResult = await handlers.getElectiveRunOuterSchedule({ token, runId })
    expect(draftResult.finalizedAgainstStaleGeneration).toBe(false)

    const fin = await handlers.finalizeElectiveRun({ token, runId })
    expect(fin.ok).toBe(true)

    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'solver_generation', value: 'gen-after-finalize', device_id: deviceId })

    const finalResult = await handlers.getElectiveRunOuterSchedule({ token, runId })
    expect(finalResult.finalizedAgainstStaleGeneration).toBe(true)
  })

  // Cross-handler roster-parity fixture (ADR MEDIUM-4 residual). Build ONE
  // fixture with a regeneration that leaves behind a stale-generation
  // source='solver' row and a source='manual' row, and assert
  // getElectiveRunHandler (T244) and getElectiveRunOuterSchedule's
  // draft-derive path (T248) agree on roster membership exactly.
  it('cross-handler parity: getElectiveRun and getElectiveRunOuterSchedule agree on roster membership after a regeneration', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const { runId, occurrenceId } = buildRun(db, campId, fx)

    const manualCamperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, is_active) VALUES (?, ?, ?, 1)').run(manualCamperId, campId, 'Manual Camper')
    const manualAssignmentId = deriveElectiveAssignmentId(runId, manualCamperId, occurrenceId)
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'run_id', value: runId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'occurrence_id', value: occurrenceId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'camper_id', value: manualCamperId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'activity_id', value: fx.activityId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'source', value: 'manual', device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: manualAssignmentId, field: 'solver_generation', value: 'gen-old', device_id: deviceId })

    // Regenerate: bump the run's marker so the original solver row goes stale.
    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'solver_generation', value: 'gen-new', device_id: deviceId })

    const viaGetRun = await handlers.getElectiveRun({ token, runId })
    const viaOuterSchedule = await handlers.getElectiveRunOuterSchedule({ token, runId })

    const rosterFromGetRun = new Set(viaGetRun.rows.map((r) => r.camper_id))
    const rosterFromOuterSchedule = new Set(viaOuterSchedule.rows.map((r) => r.camperId))

    expect(rosterFromOuterSchedule).toEqual(rosterFromGetRun)
    // Explicit, named per the ticket's own wording — not just "sets equal".
    expect(rosterFromGetRun.has(fx.camperId)).toBe(false)
    expect(rosterFromOuterSchedule.has(fx.camperId)).toBe(false)
    expect(rosterFromGetRun.has(manualCamperId)).toBe(true)
    expect(rosterFromOuterSchedule.has(manualCamperId)).toBe(true)
  })

  // Predicate-drift sensitivity: a genuinely legacy pre-T244 run (run AND its
  // solver row both carry NULL solver_generation — never regenerated) must
  // stay visible. This is the case electiveGenerationPredicate.js's header
  // comment calls out as requiring SQLite `IS`, not `=`: `NULL = NULL` is
  // never true in SQL, so a hand-written `=` fragment would silently exclude
  // every row of every run committed before T244. Built by hand (raw
  // appendOp, never commitElectiveRun, which always stamps a non-NULL
  // generation) specifically so both sides of the comparison are NULL.
  it('a legacy run with NULL solver_generation on both run and row stays visible (IS, not =)', async () => {
    const { campId, handlers, token } = await seedAdmin()
    const fx = seedFixture(db, { campId })
    const runId = randomUUID()
    const occurrenceId = deriveElectiveOccurrenceId(runId, fx.setId, fx.dayId, fx.timeBlockId, fx.tierId)

    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'camp_id', value: campId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'name', value: 'Legacy run', device_id: deviceId })
    appendOp(db, { entity: 'elective_assignment_runs', entity_id: runId, field: 'status', value: 'draft', device_id: deviceId })
    appendOp(db, { entity: 'elective_occurrences', entity_id: occurrenceId, field: 'run_id', value: runId, device_id: deviceId })
    appendOp(db, { entity: 'elective_occurrences', entity_id: occurrenceId, field: 'elective_set_id', value: fx.setId, device_id: deviceId })
    appendOp(db, { entity: 'elective_occurrences', entity_id: occurrenceId, field: 'day_id', value: fx.dayId, device_id: deviceId })
    appendOp(db, { entity: 'elective_occurrences', entity_id: occurrenceId, field: 'time_block_id', value: fx.timeBlockId, device_id: deviceId })
    const legacyAssignmentId = deriveElectiveAssignmentId(runId, fx.camperId, occurrenceId)
    appendOp(db, { entity: 'elective_assignments', entity_id: legacyAssignmentId, field: 'run_id', value: runId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: legacyAssignmentId, field: 'occurrence_id', value: occurrenceId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: legacyAssignmentId, field: 'camper_id', value: fx.camperId, device_id: deviceId })
    appendOp(db, { entity: 'elective_assignments', entity_id: legacyAssignmentId, field: 'activity_id', value: fx.activityId, device_id: deviceId })
    // Deliberately NOT writing source or solver_generation — both stay at
    // their schema defaults (source='solver', solver_generation NULL), and
    // the run's own solver_generation is never written either.

    const viaGetRun = await handlers.getElectiveRun({ token, runId })
    const viaOuterSchedule = await handlers.getElectiveRunOuterSchedule({ token, runId })

    expect(viaGetRun.rows.map((r) => r.camper_id)).toContain(fx.camperId)
    expect(viaOuterSchedule.rows.map((r) => r.camperId)).toContain(fx.camperId)
  })
})
