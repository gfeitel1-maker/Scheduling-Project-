// rollbackV97 drops open_reconciliation_decisions.payload and nothing else.
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
const cols = (db) => db.prepare('PRAGMA table_info(open_reconciliation_decisions)').all().map((c) => c.name)

describe('rollbackV97', () => {
  it('drops payload, keeps the question, reports what was discarded, clears version >= 97, and is idempotent', () => {
    const file = path.join(os.tmpdir(), `shoresh-v97-down-${Date.now()}-${Math.random()}.sqlite`)
    files.push(file)
    const db = openLocalDb(file)
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('c', 'Camp', ?)").run('a'.repeat(64))
    db.prepare(`INSERT INTO open_reconciliation_decisions
      (id, camp_id, entity_type, identity_key, kind, domain_key, child_key, import_run_id, created_at, payload)
      VALUES ('q', 'c', 'fixed_events', 'q', 'confirm_value', 'd', 'k', 'r', 'now', '{"fixedEvent":{}}')`).run()
    expect(rollbackV97(db).discarded).toEqual({ payloads: 1 })
    expect(cols(db)).not.toContain('payload')
    expect(db.prepare('SELECT id FROM open_reconciliation_decisions').get().id).toBe('q')
    expect(getSchemaVersion(db)).toBe(96)
    expect(rollbackV97(db).discarded).toEqual({ payloads: 0 })
    db.close()
  })
})
