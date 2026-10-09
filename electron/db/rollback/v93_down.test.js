// T348 - rollbackV93 drops punch_identity and peer_punch_memory. Mirrors v90_down.test.js.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema } from '../localDb.js'
import { rollbackV93 } from './v93_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-v93-down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

const seed = (db) => {
  db.prepare(
    'INSERT INTO punch_identity (id, cert_pem, key_pem, fingerprint, ice_ufrag, ice_pwd, local_port, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
  ).run('c', 'k', 'AA:BB', 'abcd1234', 'p'.repeat(32), 50000, '2026-10-08T00:00:00.000Z')
  db.prepare(
    'INSERT INTO peer_punch_memory (peer_id, role, remote_sdp_type, remote_sdp, remote_fingerprint, remote_ufrag, remote_pwd, candidates, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('peer-1', 'offerer', 'answer', 'v=0', 'AA:BB', 'u', 'p', '[]', '2026-10-08T00:00:00.000Z')
}

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV93', () => {
  it('drops both tables and reports what it discarded', () => {
    const db = migratedDb()
    seed(db)
    expect(rollbackV93(db).discarded).toEqual({ punchIdentity: 1, peerPunchMemory: 1 })
    expect(hasTable(db, 'punch_identity')).toBe(false)
    expect(hasTable(db, 'peer_punch_memory')).toBe(false)
    db.close()
  })

  it('removes the v93 marker and leaves v92', () => {
    const db = migratedDb()
    rollbackV93(db)
    expect(getSchemaVersion(db)).toBe(92)
    db.close()
  })

  it('is idempotent', () => {
    const db = migratedDb()
    rollbackV93(db)
    expect(rollbackV93(db).discarded).toEqual({ punchIdentity: 0, peerPunchMemory: 0 })
    db.close()
  })

  it('lets initSchema re-create both tables, empty', () => {
    const db = migratedDb()
    seed(db)
    rollbackV93(db)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM punch_identity').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM peer_punch_memory').get().c).toBe(0)
    db.close()
  }, 30000)
})
