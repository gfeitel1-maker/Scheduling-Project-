// @vitest-environment node
//
// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 1 — the
// stage-aware landing predicate: false on a bare camp, true the moment ANY
// required-setup table has a row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { campHasSetupData, REQUIRED_SETUP_TABLES } from './campHasSetupData.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-camp-has-setup-data-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp Test')
})

afterEach(() => {
  db?.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('campHasSetupData', () => {
  it('returns false on a bare camp — no rows in any required-setup table', () => {
    expect(campHasSetupData(db)).toBe(false)
  })

  it('returns true once a tiers row exists', () => {
    db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)')
      .run(randomUUID(), 'camp-1', 'Seniors')
    expect(campHasSetupData(db)).toBe(true)
  })

  it('returns true once a groups row exists', () => {
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)')
      .run(randomUUID(), 'camp-1', 'Bunk 1')
    expect(campHasSetupData(db)).toBe(true)
  })

  it('returns true once a days_of_operation row exists', () => {
    db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)')
      .run(randomUUID(), 'camp-1', 'Monday')
    expect(campHasSetupData(db)).toBe(true)
  })

  it('returns true once a time_blocks row exists', () => {
    db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)')
      .run(randomUUID(), 'camp-1', 'Period 1')
    expect(campHasSetupData(db)).toBe(true)
  })

  it('checks exactly the four required-setup tables — same set REQUIRED_AREAS treats as the blocking core', () => {
    expect(REQUIRED_SETUP_TABLES).toEqual(['tiers', 'groups', 'days_of_operation', 'time_blocks'])
  })
})
