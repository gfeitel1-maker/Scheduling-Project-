// rollbackV96 drops roster_cache and nothing else.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV96 } from './v96_down.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).c > 0

describe('rollbackV96', () => {
  it('drops roster_cache, reports what was discarded, clears version >= 96, leaves authority_cache, and is idempotent', () => {
    const file = path.join(os.tmpdir(), `shoresh-v96-down-${Date.now()}-${Math.random()}.sqlite`)
    files.push(file)
    const db = openLocalDb(file)
    db.prepare("INSERT INTO roster_cache (device_id, peer_id, verified_at) VALUES ('d', 'p', 'now')").run()
    db.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES ('d', 'admin', 'now')").run()
    expect(rollbackV96(db).discarded).toEqual({ rosterRows: 1 })
    expect(hasTable(db, 'roster_cache')).toBe(false)
    expect(getSchemaVersion(db)).toBe(95)
    expect(db.prepare('SELECT status FROM authority_cache').get().status).toBe('admin')
    expect(rollbackV96(db).discarded).toEqual({ rosterRows: 0 })
    db.close()
  })
})
