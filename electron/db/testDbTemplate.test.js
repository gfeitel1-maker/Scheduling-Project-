// @vitest-environment node
//
// Guards the test-fixture shortcut in testDbTemplate.js. The risk this file exists for is the T62
// defect class: a fixture that DIVERGES from what the real schema produces stays green while the
// thing it stands in for has drifted. So these assert equivalence against a genuinely
// chain-migrated database, not merely that the helper returns something usable.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion, CURRENT_SCHEMA_VERSION, getOrCreateDeviceId } from './localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from './testDbTemplate.js'

const strays = []
// The reference the template must match: a database built by the real migration chain and opened
// to convergence. The second open is not ceremony — openLocalDb is not idempotent across opens
// (see testDbTemplate.js), so a once-opened database is not a fixed point and comparing against it
// would pin a transient state.
function chainBuilt() {
  const p = path.join(os.tmpdir(), `tpl-ref-${process.pid}-${Date.now()}-${Math.random()}.sqlite`)
  strays.push(p)
  openLocalDb(p).close()
  openLocalDb(p).close()
  return { db: openLocalDb(p), file: p }
}

afterEach(() => {
  cleanupTemplatedDbs()
  for (const f of strays.splice(0)) {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true })
  }
})

describe('testDbTemplate', () => {
  it('is at the current schema version', () => {
    const { db } = openTemplatedDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('has the same tables, indexes and DDL as a chain-migrated database', () => {
    const { db: ref } = chainBuilt()
    const { db: tpl } = openTemplatedDb()
    const dump = (d) =>
      d
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .all()
        .map((r) => `${r.type} ${r.name} :: ${(r.sql || '').replace(/\s+/g, ' ').trim()}`)
    // The whole point: byte-copy and chain-replay must be indistinguishable in schema.
    expect(dump(tpl)).toEqual(dump(ref))
    ref.close()
    tpl.close()
  })

  it('records the same applied migration set — the copy is not a shortcut around the chain', () => {
    const { db: ref } = chainBuilt()
    const { db: tpl } = openTemplatedDb()
    const versions = (d) => d.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version)
    expect(versions(tpl)).toEqual(versions(ref))
    ref.close()
    tpl.close()
  })

  it('mints a DISTINCT device identity per database', () => {
    // The hazard: a naive byte copy shares device_identity, so two "different devices" are one.
    const ids = new Set()
    const open = []
    for (let i = 0; i < 5; i++) {
      const { db } = openTemplatedDb()
      ids.add(getOrCreateDeviceId(db))
      open.push(db)
    }
    expect(ids.size).toBe(5)
    for (const d of open) d.close()
  })

  it('hands back independent databases — a write to one is invisible to the other', () => {
    const { db: a } = openTemplatedDb()
    const { db: b } = openTemplatedDb()
    a.prepare("INSERT INTO camps (id, name) VALUES ('c1', 'A')").run()
    expect(a.prepare('SELECT COUNT(*) n FROM camps').get().n).toBe(1)
    expect(b.prepare('SELECT COUNT(*) n FROM camps').get().n).toBe(0)
    a.close()
    b.close()
  })

  it('cleans up every file it created, sidecars included', () => {
    const { db, file } = openTemplatedDb()
    db.close()
    expect(fs.existsSync(file)).toBe(true)
    cleanupTemplatedDbs()
    expect(fs.existsSync(file)).toBe(false)
  })

  // This test used to pin the OPPOSITE: a first-open fresh database was missing an index the same
  // file had on its second open (idx_schedule_snapshots_template_id, dropped by the v53/v59
  // rebuilds after schema.sql had already run). It was written to fail once that was fixed, as the
  // signal to simplify ensureTemplate() back to a single open. T189 fixed it, so the signal fired
  // and ensureTemplate() now opens once.
  //
  // What replaces it is the invariant that makes the single open correct, kept HERE because it is
  // this helper's precondition: openLocalDb must be idempotent across opens, or a byte-copied
  // template silently depends on how many times it was opened. The general guard for the defect
  // class lives in electron/db/schemaIndexParity.migration.test.js.
  it('opens idempotently, so a single-open template is a fixed point', () => {
    const p = path.join(os.tmpdir(), `tpl-once-${process.pid}-${Date.now()}-${Math.random()}.sqlite`)
    strays.push(p)
    const objects = (db) =>
      db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .all()

    const once = openLocalDb(p)
    const afterFirst = objects(once)
    once.close()
    const twice = openLocalDb(p)
    const afterSecond = objects(twice)
    twice.close()

    expect(afterFirst).toEqual(afterSecond)
    // Non-vacuity: two empty result sets are also equal.
    expect(afterFirst.length).toBeGreaterThan(20)
    expect(afterFirst.map((o) => o.name)).toContain('idx_schedule_snapshots_template_id')
  })
})
