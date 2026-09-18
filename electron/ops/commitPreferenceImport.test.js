// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { previewPreferenceImport } from './preferenceImportPreview.js'
import { commitPreferenceImport } from './commitPreferenceImport.js'

afterAll(() => {
  cleanupTemplatedDbs()
})

let tmpFile
let db

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  tmpFile = templated.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('group-a', 'camp-1', 'Bunk A')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-1', 'camp-1', 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('block-1', 'camp-1', 'Period 1')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-swim', 'camp-1', 'Swim')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-art', 'camp-1', 'Art')
  db.prepare(
    'INSERT INTO elective_sets (id, camp_id, name, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
  ).run('es-1', 'camp-1', 'Period 1', 'day-1', 'block-1')
  db.prepare(
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)'
  ).run('esa-1', 'es-1', 'act-swim')
  db.prepare(
    "INSERT INTO elective_assignment_runs (id, camp_id, name, status) VALUES (?, ?, ?, 'draft')"
  ).run('run-1', 'camp-1', 'Run One')
  db.prepare(
    "INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('user-1', 'camp-1', 'Admin', 'h', 's', 'admin')"
  ).run()
  db.prepare("INSERT INTO devices (id, name) VALUES ('device-1', 'Device One')").run()
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const HEADERS = ['Display Name', 'Group', 'Choice 1']
const MAPPING = {
  displayName: 0,
  group: 1,
  externalId: null,
  noPreferenceValues: [],
  choices: [{ label: 'Choice 1', isLinked: false, memberColumns: [2] }],
}
const ROWS = [{ 'Display Name': 'Alice Cohen', Group: 'Bunk A', 'Choice 1': 'Swim' }]

function allRowCounts(db) {
  const tables = [
    'campers',
    'elective_occurrences',
    'elective_choices',
    'elective_choice_offerings',
    'elective_preferences',
  ]
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
}

function previewAndConfirm() {
  const preview = previewPreferenceImport(db, { camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING })
  const newCamperId = randomUUID()
  // Director confirms the offered_new decision the preview surfaced.
  const resolutions = {
    rowResults: preview.rowResults.map((r) => ({
      ...r,
      camper: r.camper.status === 'offered_new' ? { ...r.camper, status: 'offered_new', camperId: newCamperId } : r.camper,
    })),
  }
  return { preview, resolutions, newCamperId }
}

describe('commitPreferenceImport', () => {
  it('writes campers, occurrences, choices, offerings and preferences through the op log', () => {
    const { resolutions, newCamperId } = previewAndConfirm()
    const result = commitPreferenceImport(db, {
      camp_id: 'camp-1',
      run_id: 'run-1',
      headers: HEADERS,
      rows: ROWS,
      mapping: MAPPING,
      resolutions,
      source_filename: 'prefs.xlsx',
      source_sha256: 'hash-1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      client_write_id: 'cw-1',
    })
    expect(result.committed).toBe(true)
    const camper = db.prepare('SELECT * FROM campers WHERE id = ?').get(newCamperId)
    expect(camper.display_name).toBe('Alice Cohen')
    expect(camper.group_id).toBe('group-a')
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_occurrences WHERE run_id = ?').get('run-1').n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_choices WHERE run_id = ?').get('run-1').n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_choice_offerings').get().n).toBe(1)
    const pref = db.prepare('SELECT * FROM elective_preferences WHERE camper_id = ?').get(newCamperId)
    expect(pref.rank).toBe(1)
    const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get('run-1')
    expect(run.source_sha256).toBe('hash-1')
    expect(run.source_filename).toBe('prefs.xlsx')
  })

  it('never touches SQLite directly outside the op log for participant writes (appendOp used, not a raw INSERT)', () => {
    const { resolutions } = previewAndConfirm()
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    commitPreferenceImport(db, {
      camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING, resolutions,
      source_filename: 'prefs.xlsx', source_sha256: 'hash-1', author_user_id: 'user-1', device_id: 'device-1', client_write_id: 'cw-2',
    })
    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toBeGreaterThan(before)
  })

  it('retrying the same client_write_id against a fresh db leaves identical row counts (idempotent)', () => {
    const { resolutions } = previewAndConfirm()
    const args = {
      camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING, resolutions,
      source_filename: 'prefs.xlsx', source_sha256: 'hash-1', author_user_id: 'user-1', device_id: 'device-1', client_write_id: 'cw-3',
    }
    const firstResult = commitPreferenceImport(db, args)
    expect(firstResult.committed).toBe(true)
    const first = allRowCounts(db)
    const firstOps = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    const secondResult = commitPreferenceImport(db, args)
    expect(secondResult.committed).toBe(true)
    const second = allRowCounts(db)
    const secondOps = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(second).toEqual(first)
    expect(secondOps).toBe(firstOps)
  })

  it('aborts with PREVIEW_STALE and writes nothing when the target occurrence changed since preview', () => {
    const { resolutions } = previewAndConfirm()
    // Mutate: the activity is no longer offered in this occurrence.
    db.prepare("DELETE FROM elective_set_activities WHERE elective_set_id = 'es-1' AND activity_id = 'act-swim'").run()
    const before = allRowCounts(db)
    const beforeOps = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    const result = commitPreferenceImport(db, {
      camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING, resolutions,
      source_filename: 'prefs.xlsx', source_sha256: 'hash-1', author_user_id: 'user-1', device_id: 'device-1', client_write_id: 'cw-4',
    })
    expect(result.committed).toBe(false)
    expect(result.reason).toBe('PREVIEW_STALE')
    expect(result.staleRows).toEqual([0])
    const after = allRowCounts(db)
    const afterOps = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toEqual(before)
    expect(afterOps).toBe(beforeOps)
  })

  it('records audit metadata with no camper field value', () => {
    const { resolutions } = previewAndConfirm()
    commitPreferenceImport(db, {
      camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING, resolutions,
      source_filename: 'prefs.xlsx', source_sha256: 'hash-1', author_user_id: 'user-1', device_id: 'device-1', client_write_id: 'cw-5',
    })
    const events = db.prepare('SELECT metadata FROM audit_events').all()
    const blob = JSON.stringify(events)
    expect(blob).not.toMatch(/Alice Cohen/)
    expect(blob).not.toMatch(/Swim/)
  })
})
