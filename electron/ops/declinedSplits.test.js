// @vitest-environment node
//
// electron/ops/declinedSplits.js — unit tests for the single writer/reader
// of declined_two_row_splits (Slice 2a, host-local). See
// declinedTwoRowSplits.migration.test.js for the schema/migration/registry
// tests; this file tests the helper contract only.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { recordDeclinedSplit, listDeclinedSplitNames } from './declinedSplits.js'

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
  const db = openLocalDb(tmpFile('declined-splits'))
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp2', 'Other Camp', 'b'.repeat(64))
  return db
}

describe('recordDeclinedSplit', () => {
  it('records a decline, normalized', () => {
    const db = testDb()
    recordDeclinedSplit(db, { campId: 'camp1', activityName: '  Swim  ' })
    const row = db.prepare('SELECT * FROM declined_two_row_splits WHERE camp_id = ?').get('camp1')
    expect(row.activity_name_normalized).toBe('swim')
    expect(row.declined_at).toBeTruthy()
    db.close()
  })

  it('is idempotent — declining the same name twice writes one row', () => {
    const db = testDb()
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'Swim' })
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'swim' })
    recordDeclinedSplit(db, { campId: 'camp1', activityName: '  SWIM  ' })
    const count = db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits WHERE camp_id = ?').get('camp1').c
    expect(count).toBe(1)
    db.close()
  })

  it('scopes declines by camp — the same name in two camps writes two rows', () => {
    const db = testDb()
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'Swim' })
    recordDeclinedSplit(db, { campId: 'camp2', activityName: 'Swim' })
    const count = db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits').get().c
    expect(count).toBe(2)
    db.close()
  })

  it('requires campId and a non-empty activityName', () => {
    const db = testDb()
    expect(() => recordDeclinedSplit(db, { activityName: 'Swim' })).toThrow()
    expect(() => recordDeclinedSplit(db, { campId: 'camp1', activityName: '   ' })).toThrow()
    db.close()
  })
})

describe('listDeclinedSplitNames', () => {
  it('returns an empty set when nothing has been declined', () => {
    const db = testDb()
    expect(listDeclinedSplitNames(db, { campId: 'camp1' })).toEqual(new Set())
    db.close()
  })

  it('returns the normalized names recorded for that camp', () => {
    const db = testDb()
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'Swim' })
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'Arts & Crafts' })
    const names = listDeclinedSplitNames(db, { campId: 'camp1' })
    expect(names).toEqual(new Set(['swim', 'arts & crafts']))
    db.close()
  })

  it('does not leak declines from another camp', () => {
    const db = testDb()
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'Swim' })
    recordDeclinedSplit(db, { campId: 'camp2', activityName: 'Boating' })
    expect(listDeclinedSplitNames(db, { campId: 'camp1' })).toEqual(new Set(['swim']))
    expect(listDeclinedSplitNames(db, { campId: 'camp2' })).toEqual(new Set(['boating']))
    db.close()
  })

  it('round-trips record then list', () => {
    const db = testDb()
    recordDeclinedSplit(db, { campId: 'camp1', activityName: 'Nature' })
    const names = listDeclinedSplitNames(db, { campId: 'camp1' })
    expect(names.has('nature')).toBe(true)
    db.close()
  })
})
