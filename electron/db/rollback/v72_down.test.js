// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV72 } from './v72_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v72down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('rollbackV72', () => {
  it('removes schema_migrations rows >= 72 and leaves getSchemaVersion at 71', () => {
    const db = freshDb()

    rollbackV72(db)

    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version >= 72').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(71)
    db.close()
  })

  it('leaves lower-version schema_migrations rows in place', () => {
    const db = freshDb()

    rollbackV72(db)

    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 71').get().c).toBe(1)
    db.close()
  })

  it('does not drop the tombstones table or any of its rows', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO tombstones (id, entity, version, sig, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('ts1', 'campers:camper1', 3, 'sig-bytes-base64', '2026-09-30T00:00:00.000Z')

    rollbackV72(db)

    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='tombstones'").get().c
    ).toBe(1)
    const row = db.prepare('SELECT * FROM tombstones WHERE id = ?').get('ts1')
    expect(row).toEqual({
      id: 'ts1',
      entity: 'campers:camper1',
      version: 3,
      sig: 'sig-bytes-base64',
      created_at: '2026-09-30T00:00:00.000Z',
    })
    db.close()
  })

  it('is idempotent — running twice does not error, and a tombstone row survives the second run', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO tombstones (id, entity, version, sig, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('ts1', 'campers:camper1', 3, 'sig-bytes-base64', '2026-09-30T00:00:00.000Z')

    rollbackV72(db)
    expect(() => rollbackV72(db)).not.toThrow()

    const row = db.prepare('SELECT * FROM tombstones WHERE id = ?').get('ts1')
    expect(row).toEqual({
      id: 'ts1',
      entity: 'campers:camper1',
      version: 3,
      sig: 'sig-bytes-base64',
      created_at: '2026-09-30T00:00:00.000Z',
    })
    db.close()
  })
})
