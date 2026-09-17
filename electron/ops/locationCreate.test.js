// T101 — db-backed wrapper around resolveLocationCandidateId.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { deriveLocationId } from './locationId.js'
import { resolveLocationCreateId } from './locationCreate.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
let db, tmpFile
const campId = 'camp1'

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
})

afterEach(() => {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpFile + suffix)) fs.unlinkSync(tmpFile + suffix)
  }
})

describe('resolveLocationCreateId', () => {
  it('returns the base id when there is no collision', () => {
    expect(resolveLocationCreateId(db, campId, 'Pool')).toBe(deriveLocationId(campId, 'Pool'))
  })

  it('reuses the base id when its current name matches', () => {
    const base = deriveLocationId(campId, 'Pool')
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, 1)').run(base, campId, 'Pool')
    expect(resolveLocationCreateId(db, campId, 'Pool')).toBe(base)
  })

  it('mints a disambiguated id on rename-recollide, never reusing the renamed row', () => {
    const base = deriveLocationId(campId, 'Pool')
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, 1)').run(base, campId, 'Swimming Pool')
    expect(resolveLocationCreateId(db, campId, 'Pool')).toBe(`${base}:2`)
  })
})
