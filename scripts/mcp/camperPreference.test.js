// T297 — the preference-edit MCP tools, at the handler seam (the fast one that
// covers the logic; preferenceSheetE2E.test.js is where registration and the
// stdio envelope are proved).
//
// Fabricated names only; no real camper data is in this repo.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../../electron/db/localDb.js'
import { commitElectiveRun } from '../../electron/ops/commitElectiveRun.js'
import { deriveElectiveChoiceId } from '../../electron/ops/electiveDerivedIds.js'
import {
  camperPreferencesTool, setCamperPreferenceTool, removeCamperPreferenceTool,
} from './tools.js'

let dir
let dbPath
let runId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-mcp-t297-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-mon', campId, 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-1', campId, 'Period 1')
  runId = randomUUID()
  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1', runId,
    parsed: {
      campers: [{ id: 'cam-1', display_name: 'Testcamper Alpha', external_id: null }],
      choices: [{ label: 'Gaga', labelKey: 'gaga' }, { label: 'Ceramics', labelKey: 'ceramics' }],
      preferences: [{
        camper_id: 'cam-1', occurrence_id: null,
        coordinate: { dayName: 'monday', periodLabel: '1' },
        label: 'Gaga', labelKey: 'gaga', rank: 1, rank_kind: 'cell-choice',
      }],
      sameNameCampers: [], skippedRows: [],
    },
    assignments: [{ camper_id: 'cam-1', occurrence_id: 'occ-a', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 }],
    occurrences: [{ id: 'occ-a', elective_set_id: 'set-1', day_id: 'day-mon', time_block_id: 'tb-1', tier_id: 'tier-1' }],
  })
  expect(out).toMatchObject({ ok: true })
  db.close()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = (over = {}) => ({ dbPath, allowWrite: true, authorUserId: null, dbKey: null, ...over })

const rowsInDb = () => {
  const db = openLocalDb(dbPath)
  try {
    return db.prepare('SELECT * FROM elective_preferences WHERE run_id = ?').all(runId)
  } finally { db.close() }
}

describe('camper_preferences', () => {
  it('names the cell the CHILD wrote when no template has bound one, and says it is not hand-edited', () => {
    const out = camperPreferencesTool({ camper_name: 'Testcamper Alpha' }, ctx())
    expect(out.ok).toBe(true)
    expect(out.preferences).toHaveLength(1)
    expect(out.preferences[0]).toMatchObject({
      camper_id: 'cam-1',
      choice_label: 'Gaga',
      // occurrence_id is NULL on an imported planner row, so the day and period
      // come from the coordinate the child wrote.
      day: 'monday',
      period: '1',
      edited_by_hand: false,
    })
    expect(out.preferences[0].preference_id).toBeTruthy()
  })

  it('filters to one camper', () => {
    expect(camperPreferencesTool({ camper_name: 'Nobody Here' }, ctx()).preferences).toHaveLength(0)
  })
})

describe('set_camper_preference', () => {
  it('refuses without --allow-write, and changes nothing', () => {
    const before = rowsInDb()
    const out = setCamperPreferenceTool(
      { run_id: runId, camper_id: 'cam-1', occurrence_id: 'occ-a', choice_id: deriveElectiveChoiceId(runId, 'ceramics') },
      ctx({ allowWrite: false })
    )
    expect(out).toMatchObject({ ok: false, exitCode: 1 })
    expect(out.error).toMatch(/--allow-write/)
    expect(rowsInDb()).toEqual(before)
  })

  it('corrects the imported answer and marks it hand-edited, without adding a second row', () => {
    const preferenceId = camperPreferencesTool({}, ctx()).preferences[0].preference_id
    const out = setCamperPreferenceTool({
      run_id: runId, camper_id: 'cam-1', occurrence_id: 'occ-a',
      choice_id: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rank_kind: 'cell-choice', replaces_preference_id: preferenceId,
    }, ctx())
    expect(out).toMatchObject({ ok: true, exitCode: 0 })

    const after = camperPreferencesTool({}, ctx()).preferences
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ choice_label: 'Ceramics', edited_by_hand: true })
    // Scope inherited: still the coordinate the child wrote, not a cell imposed.
    expect(after[0].occurrence_id).toBe(null)
  })

  it('returns the refusal rather than throwing when the choice is unknown', () => {
    expect(setCamperPreferenceTool({
      run_id: runId, camper_id: 'cam-1', occurrence_id: 'occ-a', choice_id: 'echo1:nope',
    }, ctx())).toMatchObject({ ok: false, error: 'CHOICE_NOT_IN_RUN', exitCode: 1 })
  })
})

describe('remove_camper_preference', () => {
  it('refuses without --allow-write', () => {
    const before = rowsInDb()
    expect(removeCamperPreferenceTool({ run_id: runId, preference_id: before[0].id }, ctx({ allowWrite: false })))
      .toMatchObject({ ok: false, exitCode: 1 })
    expect(rowsInDb()).toEqual(before)
  })

  it('withdraws the row', () => {
    const preferenceId = rowsInDb()[0].id
    expect(removeCamperPreferenceTool({ run_id: runId, preference_id: preferenceId }, ctx()))
      .toMatchObject({ ok: true, exitCode: 0 })
    expect(rowsInDb()).toHaveLength(0)
  })
})
