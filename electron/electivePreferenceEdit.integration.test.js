// @vitest-environment node
//
// T297 — the preference-edit IPC handlers, driven through the REAL
// makeHandlers/authorize path rather than by calling the ops module. Fixtures
// are fabricated; no real camper data is in this repo and none may be added.
//
// Mirrors electron/electiveRunFinalize.integration.test.js's harness exactly
// (same electron mock, same openTemplatedDb/makeHandlers setup, real appendOp),
// per this repo's integration-harness rule for anything touching electron/ops.
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

import { getOrCreateDeviceId } from './db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { commitElectiveRun } from './ops/commitElectiveRun.js'
import { makeHandlers } from './main.js'
import { deriveElectiveOccurrenceId, deriveElectiveChoiceId } from './ops/electiveDerivedIds.js'

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

async function seedCamp() {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Shoresh', 'a'.repeat(64))
  await createUser(db, { camp_id: campId, name: 'Director', pin: '123400', role: 'admin' }, localTestWrite())
  await createUser(db, { camp_id: campId, name: 'Counsellor', pin: '567800', role: 'staff' }, localTestWrite())
  const handlers = makeHandlers(db, deviceId, {})
  const { token: adminToken } = await handlers.login({ name: 'Director', pin: '123400' })
  const { token: staffToken } = await handlers.login({ name: 'Counsellor', pin: '567800' })
  return { campId, handlers, adminToken, staffToken }
}

// One elective set at Monday/Period 1, two campers, a PLANNER-GRID sheet (each
// row coordinate-keyed, occurrence_id absent) — the shape a director actually
// imports and the one a naive edit path mishandles.
function seedRun(db, campId) {
  const runId = randomUUID()
  const tierId = randomUUID()
  const setId = randomUUID()
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-1', campId, 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-1', campId, 'Period 1')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'AM Electives')
  for (const [id, name] of [['act-gaga', 'Gaga'], ['act-ceramics', 'Ceramics']]) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
    db.prepare(
      'INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, status) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), setId, id, 'unlimited', 'confirmed')
  }
  const occurrenceId = deriveElectiveOccurrenceId(runId, setId, 'day-1', 'tb-1', tierId)
  const out = commitElectiveRun(db, {
    campId, deviceId, name: 'Week 1 electives', runId,
    parsed: {
      campers: [
        { id: 'cam-1', display_name: 'Ari Green', external_id: null },
        { id: 'cam-2', display_name: 'Noa Katz', external_id: null },
      ],
      choices: [{ label: 'Gaga', labelKey: 'gaga' }, { label: 'Ceramics', labelKey: 'ceramics' }],
      preferences: [
        { camper_id: 'cam-1', occurrence_id: null, coordinate: { dayName: 'monday', periodLabel: '1' }, label: 'Gaga', labelKey: 'gaga', rank: 1, rank_kind: 'cell-choice' },
        { camper_id: 'cam-2', occurrence_id: null, coordinate: { dayName: 'monday', periodLabel: '1' }, label: 'Ceramics', labelKey: 'ceramics', rank: 1, rank_kind: 'cell-choice' },
      ],
      sameNameCampers: [],
      skippedRows: [],
    },
    assignments: [
      { camper_id: 'cam-1', occurrence_id: occurrenceId, labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 },
      { camper_id: 'cam-2', occurrence_id: occurrenceId, labelKey: 'ceramics', activity_id: 'act-ceramics', preference_rank: 1 },
    ],
    occurrences: [{ id: occurrenceId, elective_set_id: setId, day_id: 'day-1', time_block_id: 'tb-1', tier_id: tierId }],
  })
  expect(out).toMatchObject({ ok: true })
  return { runId, occurrenceId }
}

describe('setElectivePreference over IPC', () => {
  it('refuses a staff token and an invalid one — the handler is behind authorize()', async () => {
    const { campId, handlers, adminToken, staffToken } = await seedCamp()
    const { runId, occurrenceId } = seedRun(db, campId)
    const args = {
      runId, camperId: 'cam-1', occurrenceId,
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice',
    }

    // The whole participant domain is admin-only (ADR D9) and the ACTION NAME
    // is what enforces it, so a staff session is forbidden rather than merely
    // getting an empty answer.
    //
    // SYNCHRONOUS throws, asserted as such: these handlers are plain functions
    // like setElectiveAssignmentHandler beside them, and ipcMain.handle is what
    // gives the renderer a promise. `expect(...).rejects` would evaluate the
    // call before expect ever saw it (main.test.js:1240's form).
    expect(() => handlers.setElectivePreference({ ...args, token: staffToken }))
      .toThrow('admin role required')
    expect(() => handlers.setElectivePreference({ ...args, token: 'not-a-token' }))
      .toThrow('invalid session')

    // And the same call with an admin token lands, so the refusals above are
    // about authorization and not about a broken argument shape.
    expect(handlers.setElectivePreference({ ...args, token: adminToken }))
      .toMatchObject({ ok: true })
  })

  it('writes the edit and reports a refusal as a value, not a rejected promise', async () => {
    const { campId, handlers, adminToken } = await seedCamp()
    const { runId, occurrenceId } = seedRun(db, campId)
    const ceramics = deriveElectiveChoiceId(runId, 'ceramics')

    const out = handlers.setElectivePreference({
      token: adminToken, runId, camperId: 'cam-1', occurrenceId,
      choiceId: ceramics, rank: 1, rankKind: 'cell-choice',
    })
    expect(out).toMatchObject({ ok: true })

    const rows = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').all(runId, 'cam-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].choice_id).toBe(ceramics)

    // A domain refusal comes back as {ok:false,error} so the screen can render
    // it; only auth and argument-shape problems throw.
    expect(handlers.setElectivePreference({
      token: adminToken, runId, camperId: 'cam-1', occurrenceId,
      choiceId: 'echo1:unknown', rank: 1, rankKind: 'cell-choice',
    })).toEqual({ ok: false, error: 'CHOICE_NOT_IN_RUN' })
  })

  it('honours replaces_preference_id, so a correction keeps the scope it is correcting', async () => {
    // THE HOP THAT WAS BROKEN. The handler enumerates its arguments explicitly
    // (so a caller cannot smuggle a token in), and replacesPreferenceId was
    // missing from that list — every edit fell through to the "add" branch and
    // the scope-inheritance design was unreachable through IPC while the op's own
    // unit tests passed.
    const { campId, handlers, adminToken } = await seedCamp()
    const { runId, occurrenceId } = seedRun(db, campId)
    const imported = db
      .prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?')
      .get(runId, 'cam-1')
    // The imported planner row names a coordinate and no occurrence.
    expect(imported.occurrence_id).toBe(null)

    const out = handlers.setElectivePreference({
      token: adminToken, runId, camperId: 'cam-1', occurrenceId,
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice', replacesPreferenceId: imported.id,
    })
    expect(out).toMatchObject({ ok: true })

    const after = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').all(runId, 'cam-1')
    expect(after).toHaveLength(1)
    // Scope INHERITED: still coordinate-keyed, still the child's own spelling. An
    // occurrence_id here is the dropped-argument bug.
    expect(after[0].occurrence_id).toBe(null)
    expect(after[0].coordinate_day_label).toBe('monday')
    expect(after[0].choice_id).toBe(deriveElectiveChoiceId(runId, 'ceramics'))
  })

  it('rejects a malformed replaces_preference_id at the boundary', async () => {
    const { campId, handlers, adminToken } = await seedCamp()
    const { runId, occurrenceId } = seedRun(db, campId)
    expect(() => handlers.setElectivePreference({
      token: adminToken, runId, camperId: 'cam-1', occurrenceId,
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'), replacesPreferenceId: 42,
    })).toThrow('replacesPreferenceId must be a non-empty string or null')
  })

  it('removeElectivePreference is behind the same gate and withdraws the row', async () => {
    const { campId, handlers, adminToken, staffToken } = await seedCamp()
    const { runId } = seedRun(db, campId)
    const row = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-1')

    expect(() => handlers.removeElectivePreference({ token: staffToken, runId, preferenceId: row.id }))
      .toThrow('admin role required')

    expect(handlers.removeElectivePreference({ token: adminToken, runId, preferenceId: row.id }))
      .toMatchObject({ ok: true })
    expect(db.prepare('SELECT * FROM elective_preferences WHERE id = ?').get(row.id)).toBeUndefined()
  })
})

describe('getElectiveRun carries the run’s preferences', () => {
  it('returns them in the engine’s own preference shape so a re-solve needs no sheet', async () => {
    const { campId, handlers, adminToken } = await seedCamp()
    const { runId } = seedRun(db, campId)

    const out = handlers.getElectiveRun({ token: adminToken, runId })
    // The engine reads p.camper_id / p.choice_id / p.occurrence_id / p.rank and
    // resolvePreferenceCoordinates reads p.coordinate — so a row handed over
    // this boundary must carry all five or a re-solve from the database
    // silently loses the cell.
    expect(out.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          camper_id: 'cam-1',
          choice_id: deriveElectiveChoiceId(runId, 'gaga'),
          occurrence_id: null,
          rank: 1,
          coordinate: { dayName: 'monday', periodLabel: '1' },
        }),
      ])
    )
  })
})
