// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { previewPreferenceImport } from './preferenceImportPreview.js'

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
    'INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)'
  ).run('esa-2', 'es-1', 'act-art')
  db.prepare(
    "INSERT INTO elective_assignment_runs (id, camp_id, name, status) VALUES (?, ?, ?, 'draft')"
  ).run('run-1', 'camp-1', 'Run One')
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
    'elective_assignment_runs',
    'elective_occurrences',
    'elective_choices',
    'elective_choice_offerings',
    'elective_preferences',
    'operations',
  ]
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
}

describe('previewPreferenceImport', () => {
  it('resolves rows against the live snapshot', () => {
    const result = previewPreferenceImport(db, {
      camp_id: 'camp-1',
      run_id: 'run-1',
      headers: HEADERS,
      rows: ROWS,
      mapping: MAPPING,
    })
    expect(result.blockedCount).toBe(0)
    expect(result.camperResolutions[0].status).toBe('offered_new')
    expect(result.choiceResolutions[0].status).toBe('resolved')
  })

  it('writes nothing — mechanism A: zero INSERT/UPDATE/DELETE statements prepared', () => {
    const originalPrepare = db.prepare.bind(db)
    const prepared = []
    db.prepare = (sql) => {
      prepared.push(sql)
      return originalPrepare(sql)
    }
    previewPreferenceImport(db, { camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING })
    db.prepare = originalPrepare
    const mutating = prepared.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))
    expect(mutating).toEqual([])
  })

  it('writes nothing — mechanism B: row counts identical before and after against a live db', () => {
    const before = allRowCounts(db)
    previewPreferenceImport(db, { camp_id: 'camp-1', run_id: 'run-1', headers: HEADERS, rows: ROWS, mapping: MAPPING })
    const after = allRowCounts(db)
    expect(after).toEqual(before)
  })

  it('returns duplicate:true and resolves nothing on a repeated source_sha256 for the same camp', () => {
    db.prepare(
      "UPDATE elective_assignment_runs SET source_sha256 = 'hash-1' WHERE id = 'run-1'"
    ).run()
    const result = previewPreferenceImport(db, {
      camp_id: 'camp-1',
      run_id: 'run-2',
      headers: HEADERS,
      rows: ROWS,
      mapping: MAPPING,
      source_sha256: 'hash-1',
    })
    expect(result).toEqual({ duplicate: true, existingRunId: 'run-1' })
  })
})
