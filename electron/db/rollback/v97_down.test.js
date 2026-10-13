// rollbackV97 drops last_import_undo and nothing else.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV97 } from './v97_down.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).c > 0

describe('rollbackV97', () => {
  it('drops last_import_undo, reports what was discarded, clears version >= 97, leaves roster_cache, and is idempotent', () => {
    const file = path.join(os.tmpdir(), `shoresh-v97-down-${Date.now()}-${Math.random()}.sqlite`)
    files.push(file)
    const db = openLocalDb(file)
    db.prepare("INSERT INTO last_import_undo (id, import_run_id, file_name, committed_at, record) VALUES (1, 'r', 'f.txt', 'now', '{}')").run()
    db.prepare("INSERT INTO roster_cache (device_id, peer_id, verified_at) VALUES ('d', 'p', 'now')").run()
    expect(rollbackV97(db).discarded).toEqual({ undoRows: 1 })
    expect(hasTable(db, 'last_import_undo')).toBe(false)
    expect(getSchemaVersion(db)).toBe(96)
    expect(db.prepare('SELECT peer_id FROM roster_cache').get().peer_id).toBe('p')
    expect(rollbackV97(db).discarded).toEqual({ undoRows: 0 })
    db.close()
  })
})
