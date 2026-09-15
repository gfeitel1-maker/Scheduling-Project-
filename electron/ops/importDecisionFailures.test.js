// @vitest-environment node
//
// electron/ops/importDecisionFailures.js — unit tests for the single writer
// of import_decision_failures. Mirrors syncHealthEvents.test.js's central
// discipline (T174): every test here asserts the row is READ BACK, not that
// the call was made — "the call was made" is exactly what hid the original
// audit_events defect for a week.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { recordImportDecisionFailure, listImportDecisionFailures } from './importDecisionFailures.js'

let db, file
beforeEach(() => {
  file = path.join(os.tmpdir(), `shoresh-import-decision-failures-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
})

describe('recordImportDecisionFailure — the row lands, and says so', () => {
  it('records a failure and reads it back', () => {
    expect(recordImportDecisionFailure(db, {
      campId: 'camp-1',
      incident: 'decisionjournal-camp-1-0',
      detail: JSON.stringify({ entryCount: 3 }),
    })).toBe(true)

    const rows = listImportDecisionFailures(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].camp_id).toBe('camp-1')
    expect(rows[0].incident).toBe('decisionjournal-camp-1-0')
    expect(JSON.parse(rows[0].detail).entryCount).toBe(3)
    db.close()
  })

  it('REPORTS failure rather than assuming success', () => {
    db.close()
    expect(recordImportDecisionFailure(db, { campId: 'camp-1', incident: 'x' })).toBe(false)
  })

  it('never throws, even on a closed db or a null db', () => {
    expect(() => recordImportDecisionFailure(null, { campId: 'camp-1' })).not.toThrow()
    db.close()
    expect(() => recordImportDecisionFailure(db, { campId: 'camp-1' })).not.toThrow()
  })

  it('truncates a runaway detail rather than refusing the row', () => {
    expect(recordImportDecisionFailure(db, { campId: 'camp-1', detail: 'x'.repeat(20000) })).toBe(true)
    expect(listImportDecisionFailures(db)[0].detail.length).toBe(4000)
  })

  it('listImportDecisionFailures returns [] rather than throwing when the table is absent', () => {
    db.exec('DROP TABLE import_decision_failures')
    expect(listImportDecisionFailures(db)).toEqual([])
  })

  it('lists every recorded failure', () => {
    recordImportDecisionFailure(db, { campId: 'camp-1', detail: 'first' })
    recordImportDecisionFailure(db, { campId: 'camp-1', detail: 'second' })
    expect(listImportDecisionFailures(db).map((r) => r.detail).sort()).toEqual(['first', 'second'])
  })
})
