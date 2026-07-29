// @vitest-environment node
//
// Migration v23 — plural candidate schedules per camp.
// docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
//
// A camp may now hold two schedules, one per building route, distinguished by
// schedule_templates.kind. Everything here is a DATABASE/SYNC seam: the unique
// index that keeps each route to one row, the write-ordering contract that
// stops a manual row materialising as 'generated', and the replication of
// `kind` to a second device (a local-only assertion would not catch a NULL
// kind reintroducing the v21 fork).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion } from './localDb.js'
import { applyProjection } from '../ops/projections.js'
import { deriveScheduleTemplateId } from '../ops/scheduleTemplateId.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-kind-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function seedCamp(db, campId = 'camp1') {
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user1', campId, 'User', 'h', 's', 'admin')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device1', 'Device')
  return campId
}

// The ops a renderer writes to bring the manual candidate into existence, in
// the order writeFields() sends them. `kind` FIRST is the contract.
function manualTemplateOps(campId) {
  const id = deriveScheduleTemplateId(campId, 'manual')
  return [
    { entity: 'schedule_templates', entity_id: id, field: 'kind', value: 'manual' },
    { entity: 'schedule_templates', entity_id: id, field: 'camp_id', value: campId },
    { entity: 'schedule_templates', entity_id: id, field: 'name', value: 'Manual' },
  ]
}

describe('migration v23: schedule_templates.kind', () => {
  it('derives the generated id byte-identically to the one-argument form', () => {
    expect(deriveScheduleTemplateId('camp1')).toBe('schedule-template:camp1')
    expect(deriveScheduleTemplateId('camp1', 'generated')).toBe('schedule-template:camp1')
    expect(deriveScheduleTemplateId('camp1', 'manual')).toBe('schedule-template:camp1:manual')
  })

  it('backfills an existing single row to generated without moving its id', () => {
    const file = path.join(os.tmpdir(), `shoresh-kind-pre-${Date.now()}.sqlite`)
    files.push(file)
    const db = openLocalDb(file)
    seedCamp(db)
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)')
      .run('schedule-template:camp1', 'camp1', 'Master Template')
    db.prepare("INSERT INTO template_slots (id, template_id) VALUES ('slot1', 'schedule-template:camp1')").run()

    // Re-run the migration from a pre-v23 state.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 23').run()
    initSchema(db)

    const row = db.prepare('SELECT id, kind FROM schedule_templates').get()
    expect(row.id).toBe('schedule-template:camp1')
    expect(row.kind).toBe('generated')
    expect(db.prepare('SELECT template_id FROM template_slots WHERE id = ?').get('slot1').template_id)
      .toBe('schedule-template:camp1')
    expect(getSchemaVersion(db)).toBe(23)
    db.close()
  })

  it('lets the two routes coexist, and still rejects a third row or a duplicate route', () => {
    const db = freshDb()
    seedCamp(db)
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run('schedule-template:camp1', 'camp1', 'Master Template', 'generated')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run('schedule-template:camp1:manual', 'camp1', 'Manual', 'manual')

    expect(db.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(2)

    // v21's invariant survives, narrowed to one row per route.
    expect(() =>
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
        .run('rogue-uuid', 'camp1', 'Second Generated', 'generated')
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
        .run('rogue-uuid-2', 'camp1', 'Third', 'manual')
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('creates the manual row with kind=manual when kind is written first', () => {
    const db = freshDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run(deriveScheduleTemplateId(campId), campId, 'Master Template', 'generated')

    for (const op of manualTemplateOps(campId)) applyProjection(db, op)

    const rows = db.prepare('SELECT id, kind FROM schedule_templates ORDER BY kind').all()
    expect(rows).toEqual([
      { id: 'schedule-template:camp1', kind: 'generated' },
      { id: 'schedule-template:camp1:manual', kind: 'manual' },
    ])
    db.close()
  })

  it('replicates kind to a second device via op replay, so the manual candidate is not absorbed there', () => {
    const source = freshDb()
    const campId = seedCamp(source)
    for (const op of manualTemplateOps(campId)) applyProjection(source, op)

    const peer = freshDb()
    seedCamp(peer)
    peer.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run(deriveScheduleTemplateId(campId), campId, 'Master Template', 'generated')

    // Replay the same ops, in the same seq order, on the peer.
    for (const op of manualTemplateOps(campId)) applyProjection(peer, op)

    const manual = peer.prepare('SELECT kind FROM schedule_templates WHERE id = ?')
      .get('schedule-template:camp1:manual')
    expect(manual).toBeDefined()
    expect(manual.kind).toBe('manual')
    expect(peer.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(2)

    source.close()
    peer.close()
  })

  it('ships kind in the first-pairing domain snapshot column list', async () => {
    // A column missing from that list is silently defaulted on the receiving
    // device — for `kind` that means the manual candidate materialises as a
    // second 'generated' row and is absorbed by the unique index.
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).toMatch(/schedule_templates: \[[^\]]*'kind'/)
  })

  it('gives a fresh db and a migrated db identical schedule_templates columns AND indexes', () => {
    const fresh = freshDb()

    const migratedFile = path.join(os.tmpdir(), `shoresh-kind-mig-${Date.now()}.sqlite`)
    files.push(migratedFile)
    const migrated = new Database(migratedFile)
    migrated.pragma('foreign_keys = ON')
    initSchema(migrated)
    // Rebuild the pre-v23 shape: no kind column, old single-column index.
    // Never DROP COLUMN — rename/create-old/copy/drop, matching the v10
    // precedent in localDb.migrations.test.js.
    migrated.exec('PRAGMA foreign_keys = OFF')
    migrated.exec(`
      ALTER TABLE schedule_templates RENAME TO schedule_templates_old;
      CREATE TABLE schedule_templates (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL
      );
      INSERT INTO schedule_templates (id, camp_id, name)
        SELECT id, camp_id, name FROM schedule_templates_old;
      DROP TABLE schedule_templates_old;
      DROP INDEX IF EXISTS idx_schedule_templates_camp_kind;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp ON schedule_templates(camp_id);
    `)
    migrated.exec('PRAGMA foreign_keys = ON')
    migrated.prepare('DELETE FROM schema_migrations WHERE version >= 23').run()
    initSchema(migrated)

    const cols = (db) =>
      db.pragma('table_info(schedule_templates)')
        .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
    expect(cols(migrated)).toEqual(cols(fresh))

    const indexes = (db) =>
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'schedule_templates' AND sql IS NOT NULL")
        .all().sort((a, b) => a.name.localeCompare(b.name))
    expect(indexes(migrated)).toEqual(indexes(fresh))

    const names = indexes(fresh).map((i) => i.name)
    expect(names).toContain('idx_schedule_templates_camp_kind')
    expect(names).not.toContain('idx_schedule_templates_camp')

    expect(getSchemaVersion(migrated)).toBe(23)
    expect(getSchemaVersion(fresh)).toBe(23)
    fresh.close()
    migrated.close()
  })
})
