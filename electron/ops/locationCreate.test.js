// T101 — db-backed wrapper around resolveLocationCandidateId.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { deriveLocationId } from './locationId.js'
import { resolveLocationCreateId } from './locationCreate.js'

let db, tmpFile
const campId = 'camp1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-locationcreate-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
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
