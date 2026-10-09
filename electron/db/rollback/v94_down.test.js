// rollbackV94 drops the two host-handoff tables and nothing else.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV94 } from './v94_down.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})
function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).c > 0

describe('rollbackV94', () => {
  it('drops both tables, reports what was discarded, clears version >= 94, leaves host_signing_key, and is idempotent', () => {
    const db = openLocalDb(tmpFile('v94-down'))
    db.prepare("INSERT INTO host_handoff (id, handoff_id, role, peer_device_id, state, updated_at) VALUES (1, 'h', 'taker', 'd', 'stored', 'now')").run()
    db.prepare("INSERT INTO host_signing_key_pending (id, handoff_id, public_key, private_key, host_only_rows, created_at) VALUES (1, 'h', 'p', 'k', '{}', 'now')").run()
    db.prepare("INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, 'live', 'live', 'now')").run()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (93, ?)').run('now')
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (94, ?)').run('now')
    expect(rollbackV94(db).discarded).toEqual({ handoffRows: 1, pendingKeys: 1 })
    expect(hasTable(db, 'host_handoff')).toBe(false)
    expect(hasTable(db, 'host_signing_key_pending')).toBe(false)
    expect(getSchemaVersion(db)).toBe(93)
    expect(db.prepare('SELECT public_key FROM host_signing_key').get().public_key).toBe('live')
    expect(rollbackV94(db).discarded).toEqual({ handoffRows: 0, pendingKeys: 0 })
    db.close()
  })
})
