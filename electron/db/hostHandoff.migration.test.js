// @vitest-environment node
//
// Migration v94 (docs/adr/2026-10-09-host-succession-simple.md) — host_handoff (the singleton
// handoff state row) and host_signing_key_pending (the successor's pending key + staged host-only
// rows). Both are device-local and NEVER synced, the same exclusion class as host_signing_key.
// The stamp is exercised from a database whose 94 row is removed (i.e. back at v93).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from './localDb.js'
import { PROJECTIONS } from '../ops/projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { MODELED_ENTITIES } from '../automerge/campDocument.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})
const tmp = (tag) => {
  const f = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return f
}
const cols = (db, t) => db.pragma(`table_info(${t})`).map((c) => c.name)

describe('migration v94: host handoff tables', () => {
  it('creates host_handoff and host_signing_key_pending, empty', () => {
    const db = openLocalDb(tmp('v94-fresh'))
    expect(cols(db, 'host_handoff')).toEqual(['id', 'handoff_id', 'role', 'peer_device_id', 'state', 'updated_at'])
    expect(cols(db, 'host_signing_key_pending')).toEqual(['id', 'handoff_id', 'public_key', 'private_key', 'host_only_rows', 'created_at'])
    expect(db.prepare('SELECT COUNT(*) c FROM host_handoff').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM host_signing_key_pending').get().c).toBe(0)
    db.close()
  })

  it('stamps 94 on a database at 93, and only then', () => {
    const file = tmp('v94-stamp')
    let db = openLocalDb(file)
    db.prepare('DELETE FROM schema_migrations WHERE version >= 94').run()
    expect(getSchemaVersion(db)).toBe(93)
    db.close()
    db = openLocalDb(file)
    expect(getSchemaVersion(db)).toBe(94)
    db.close()
  })

  it('the singleton tables refuse a second row', () => {
    const db = openLocalDb(tmp('v94-single'))
    db.prepare("INSERT INTO host_handoff (id, handoff_id, role, peer_device_id, state, updated_at) VALUES (1, 'h', 'giver', 'd', 'offered', 'now')").run()
    expect(() => db.prepare("INSERT INTO host_handoff (id, handoff_id, role, peer_device_id, state, updated_at) VALUES (2, 'h', 'giver', 'd', 'offered', 'now')").run()).toThrow()
    expect(() => db.prepare("INSERT INTO host_handoff (id, handoff_id, role, peer_device_id, state, updated_at) VALUES (1, 'h', 'nope', 'd', 'offered', 'now')").run()).toThrow()
    db.close()
  })

  it('standing guard: neither table is registered anywhere that syncs', () => {
    for (const t of ['host_handoff', 'host_signing_key_pending']) {
      expect(Object.keys(PROJECTIONS)).not.toContain(t)
      expect([...DIRECT_CAMP_ENTITIES]).not.toContain(t)
      expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain(t)
      expect([...MODELED_ENTITIES]).not.toContain(t)
    }
  })
})
