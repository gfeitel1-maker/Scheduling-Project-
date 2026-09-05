// @vitest-environment node
//
// electron/ops/locationWordDecisions.js — unit tests for the single
// writer/reader of location_word_decisions (host-local). See
// locationWordDecisions.migration.test.js for the schema/migration/registry
// tests; this file tests the helper contract only.
// docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-conflict-triage-coverage.md
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { recordNotAPlace, isWordDeclinedAsPlace, normalizeWordKey } from './locationWordDecisions.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function testDb() {
  const db = openLocalDb(tmpFile('location-word-decisions'))
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp2', 'Other Camp', 'b'.repeat(64))
  return db
}

describe('normalizeWordKey', () => {
  it('lowercases and collapses/trims whitespace', () => {
    expect(normalizeWordKey('  Barn  ')).toBe('barn')
    expect(normalizeWordKey('Back   Playground')).toBe('back playground')
    expect(normalizeWordKey('301')).toBe('301')
  })
})

describe('recordNotAPlace', () => {
  it('records a decision, normalized', () => {
    const db = testDb()
    recordNotAPlace(db, { campId: 'camp1', rawWord: '  Barn  ', confirmedBy: 'user1' })
    const row = db.prepare('SELECT * FROM location_word_decisions WHERE camp_id = ?').get('camp1')
    expect(row.word_key).toBe('barn')
    expect(row.raw_word).toBe('Barn')
    expect(row.decision).toBe('not_a_place')
    expect(row.confirmed_by).toBe('user1')
  })

  it('is idempotent — recording the same word twice is a no-op collision, not an error', () => {
    const db = testDb()
    recordNotAPlace(db, { campId: 'camp1', rawWord: 'Barn' })
    expect(() => recordNotAPlace(db, { campId: 'camp1', rawWord: 'Barn' })).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM location_word_decisions WHERE camp_id = ?').get('camp1').c).toBe(1)
  })

  it('is case/whitespace-insensitive at the same camp', () => {
    const db = testDb()
    recordNotAPlace(db, { campId: 'camp1', rawWord: 'Barn' })
    recordNotAPlace(db, { campId: 'camp1', rawWord: '  barn  ' })
    expect(db.prepare('SELECT COUNT(*) c FROM location_word_decisions WHERE camp_id = ?').get('camp1').c).toBe(1)
  })

  it('scopes per camp — the same word at a different camp is a separate row', () => {
    const db = testDb()
    recordNotAPlace(db, { campId: 'camp1', rawWord: 'Barn' })
    recordNotAPlace(db, { campId: 'camp2', rawWord: 'Barn' })
    expect(db.prepare('SELECT COUNT(*) c FROM location_word_decisions').get().c).toBe(2)
  })

  it('requires campId and rawWord', () => {
    const db = testDb()
    expect(() => recordNotAPlace(db, { campId: null, rawWord: 'Barn' })).toThrow()
    expect(() => recordNotAPlace(db, { campId: 'camp1', rawWord: '   ' })).toThrow()
  })
})

describe('isWordDeclinedAsPlace', () => {
  it('is false before any decision is recorded', () => {
    const db = testDb()
    expect(isWordDeclinedAsPlace(db, { campId: 'camp1', rawWord: 'Barn' })).toBe(false)
  })

  it('is true after "not a place" was recorded for the same word/camp, normalized', () => {
    const db = testDb()
    recordNotAPlace(db, { campId: 'camp1', rawWord: 'Barn' })
    expect(isWordDeclinedAsPlace(db, { campId: 'camp1', rawWord: '  BARN  ' })).toBe(true)
  })

  it('is false for the same word at a different camp', () => {
    const db = testDb()
    recordNotAPlace(db, { campId: 'camp1', rawWord: 'Barn' })
    expect(isWordDeclinedAsPlace(db, { campId: 'camp2', rawWord: 'Barn' })).toBe(false)
  })
})
