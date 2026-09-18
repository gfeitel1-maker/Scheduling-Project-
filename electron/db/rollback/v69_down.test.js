// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { nextSequence } from '../../sync/automerge/rendezvousSequence.js'
import { rollbackV69 } from './v69_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v69down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('rollbackV69', () => {
  it('drops rendezvous_sequence and reports the discarded counter value', () => {
    const db = freshDb()
    nextSequence(db)
    nextSequence(db)
    nextSequence(db)

    const result = rollbackV69(db)

    expect(result.lastSequence).toBe(3)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rendezvous_sequence'").get()
    ).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 69').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(68)
    db.close()
  })

  it('is idempotent — a second call on an already-rolled-back db is a no-op', () => {
    const db = freshDb()
    nextSequence(db)

    rollbackV69(db)
    const second = rollbackV69(db)

    expect(second.lastSequence).toBe(0)
    db.close()
  })

  it('never strands a higher schema version (uses >= not =)', () => {
    const db = freshDb()
    // Simulate a db that has migrated PAST v69 by hand-stamping a higher version row.
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (70, ?)').run(
      new Date().toISOString()
    )

    rollbackV69(db)

    expect(getSchemaVersion(db)).toBeLessThan(70)
    db.close()
  })
})
