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
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
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
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('lets the two routes coexist within a week, rejects a duplicate route in the same week, and allows the same route in a DIFFERENT week', () => {
    // Uniqueness moved from (camp_id, kind) to (week_id, kind) at v27
    // (docs/adr/2026-08-02-schedule-weeks-first-class.md), so the rows must
    // carry a week_id to exercise it — two rows with a NULL week_id would not
    // collide (distinct NULLs), which is why every real write supplies one.
    const db = freshDb()
    seedCamp(db)
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, 0)')
      .run('week1', 'camp1', 'Week 1', 0)
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, 0)')
      .run('week2', 'camp1', 'Week 2', 1)
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
      .run('schedule-template:week1', 'camp1', 'Master Template', 'generated', 'week1')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
      .run('schedule-template:week1:manual', 'camp1', 'Manual', 'manual', 'week1')

    expect(db.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(2)

    // The per-route invariant survives, now scoped to the WEEK.
    expect(() =>
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
        .run('rogue-uuid', 'camp1', 'Second Generated', 'generated', 'week1')
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
        .run('rogue-uuid-2', 'camp1', 'Third', 'manual', 'week1')
    ).toThrow(/UNIQUE/)

    // The whole point of Slice 1: the SAME route in a DIFFERENT week is allowed.
    expect(() =>
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
        .run('schedule-template:week2', 'camp1', 'Week 2 Generated', 'generated', 'week2')
    ).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(3)
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
    // v27 retired idx_schedule_templates_camp_kind in favour of the week-scoped one.
    expect(names).toContain('idx_schedule_templates_week_kind')
    expect(names).not.toContain('idx_schedule_templates_camp_kind')

    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
    expect(getSchemaVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION)
    fresh.close()
    migrated.close()
  })
})

// =============================================================================
// The starting state nobody exercised: a MIGRATED database whose pre-v23
// schedule_templates row has a RANDOM UUID id.
//
// Migration v21 re-keys every row present AT THAT MOMENT to the deterministic
// id — but it is a one-shot data fix, and the renderer kept minting
// crypto.randomUUID() until the deterministic-id work landed in the renderer.
// Any row created in between carries a random UUID that no migration will ever
// normalise. A fresh database derives its ids correctly, so this whole class of
// defect is structurally invisible to a fresh-db-only test: a derived id can
// never collide with itself.
// =============================================================================

const UUID_TEMPLATE_ID = '48485127-57b0-42d9-b889-61d05d639ae7'

// Rebuilds the pre-v23 schedule_templates shape and seeds a row whose id is a
// random UUID, then re-runs the migrations over it. Asserts the fixture is not
// silently rotting back into a derived id.
function migratedDbWithRandomUuidTemplate(campId = 'camp1', { seed } = {}) {
  const file = path.join(os.tmpdir(), `shoresh-uuid-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  seedCamp(db, campId)

  db.exec('PRAGMA foreign_keys = OFF')
  db.exec(`
    ALTER TABLE schedule_templates RENAME TO schedule_templates_old;
    CREATE TABLE schedule_templates (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      name TEXT NOT NULL
    );
    DROP TABLE schedule_templates_old;
    DROP INDEX IF EXISTS idx_schedule_templates_camp_kind;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp ON schedule_templates(camp_id);
  `)
  db.exec('PRAGMA foreign_keys = ON')
  db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)')
    .run(UUID_TEMPLATE_ID, campId, 'Master Template')

  expect(UUID_TEMPLATE_ID).not.toBe(deriveScheduleTemplateId(campId))

  if (seed) seed(db)

  db.prepare('DELETE FROM schema_migrations WHERE version >= 23').run()
  initSchema(db)
  return db
}

function insertSlots(db, templateId, n, prefix) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(`${prefix}-${i}`, templateId)
  }
}

describe('migrated database whose generated template has a RANDOM UUID id', () => {
  it('A1: v23 leaves the UUID id in place and stamps kind=generated', () => {
    const db = migratedDbWithRandomUuidTemplate()
    const rows = db.prepare('SELECT id, kind FROM schedule_templates').all()
    expect(rows).toEqual([{ id: UUID_TEMPLATE_ID, kind: 'generated' }])
    db.close()
  })

  it('A2: a write that would add a second row for a route already in that week fails loudly, not silently', () => {
    const db = migratedDbWithRandomUuidTemplate()
    // v27 backfilled the pre-existing UUID row into this camp's Week 1.
    const weekId = 'schedule-week:camp1:1'
    const derived = deriveScheduleTemplateId(weekId) // a DIFFERENT id than the UUID row

    // `kind` is written first, and the (week_id, kind) collision is NOT yet
    // detectable here — the week is unknown until its own field arrives
    // (the write-ordering contract; see electron/ops/projections.js). So this
    // write does not throw; the conflict is caught one field later.
    expect(() =>
      applyProjection(db, { entity: 'schedule_templates', entity_id: derived, field: 'kind', value: 'generated' })
    ).not.toThrow()

    // Setting the week is where the collision with the existing UUID row is
    // caught — loudly, so a future regression that writes to the wrong id can
    // never silently no-op the way it did before the backstop existed.
    expect(() =>
      applyProjection(db, { entity: 'schedule_templates', entity_id: derived, field: 'week_id', value: weekId })
    ).toThrow(/SCHEDULE_TEMPLATE_KIND_CONFLICT/)

    // The invariant that matters held: exactly one row holds (Week 1, generated),
    // and it is the real UUID row — the errant write never became a second holder.
    const holders = db.prepare("SELECT id FROM schedule_templates WHERE week_id = ? AND kind = 'generated'").all(weekId)
    expect(holders).toHaveLength(1)
    expect(holders[0].id).toBe(UUID_TEMPLATE_ID)

    // The LOSING side, asserted rather than asserted-away (review 2026-08-02):
    // the `kind` write committed in its own appendOp transaction before the
    // `week_id` write threw, so the derived-id row is left behind as a residual
    // with week_id NULL. This is the harmless-clutter outcome the projections.js
    // backstop comment now documents — it is invisible to the week's grid
    // (week_id !== weekId) and self-heals if that week+route is written again.
    const residual = db.prepare('SELECT week_id FROM schedule_templates WHERE id = ?').get(derived)
    expect(residual).toBeTruthy()
    expect(residual.week_id).toBeNull()
    // And it is NOT a holder of the week — the whole point of the backstop.
    expect(holders.map((h) => h.id)).not.toContain(derived)
    db.close()
  })

  it('A3: the manual route still mints its own row alongside the UUID generated row', () => {
    const db = migratedDbWithRandomUuidTemplate()
    for (const op of manualTemplateOps('camp1')) applyProjection(db, op)

    const rows = db.prepare('SELECT id, kind FROM schedule_templates ORDER BY kind').all()
    expect(rows).toEqual([
      { id: UUID_TEMPLATE_ID, kind: 'generated' },
      { id: deriveScheduleTemplateId('camp1', 'manual'), kind: 'manual' },
    ])
    db.close()
  })

  it('A4: v24 ADOPTS orphan slots when the resolved row has none of its own', () => {
    const derived = deriveScheduleTemplateId('camp1')
    const db = migratedDbWithRandomUuidTemplate('camp1', {
      seed: (d) => insertSlots(d, derived, 50, 'orphan'),
    })

    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(UUID_TEMPLATE_ID).c).toBe(50)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(derived).c).toBe(0)
    const journal = db.prepare('SELECT * FROM migration_v24_repoint_log').all()
    expect(journal).toHaveLength(50)
    expect([...new Set(journal.map((j) => j.table_name))]).toEqual(['template_slots'])
    db.close()
  })

  it('A5: v24 LEAVES orphan slots alone when the resolved row already has a week (the reproduction database’s own shape)', () => {
    const derived = deriveScheduleTemplateId('camp1')
    const manual = deriveScheduleTemplateId('camp1', 'manual')
    const db = migratedDbWithRandomUuidTemplate('camp1', {
      seed: (d) => {
        insertSlots(d, UUID_TEMPLATE_ID, 50, 'visible')
        insertSlots(d, derived, 50, 'orphan')
        insertSlots(d, manual, 50, 'man')
      },
    })

    const visible = db.prepare('SELECT id FROM template_slots WHERE template_id = ? ORDER BY id')
      .all(UUID_TEMPLATE_ID).map((r) => r.id)
    expect(visible).toEqual(Array.from({ length: 50 }, (_, i) => `visible-${i}`).sort())
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(derived).c).toBe(50)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots').get().c).toBe(150)
    expect(db.prepare('SELECT COUNT(*) c FROM migration_v24_repoint_log').get().c).toBe(0)
    db.close()
  })

  it('A6: v24 is idempotent — a second initSchema moves nothing and does not grow the journal', () => {
    const derived = deriveScheduleTemplateId('camp1')
    const db = migratedDbWithRandomUuidTemplate('camp1', {
      seed: (d) => insertSlots(d, derived, 5, 'orphan'),
    })
    const before = db.prepare('SELECT COUNT(*) c FROM migration_v24_repoint_log').get().c
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM migration_v24_repoint_log').get().c).toBe(before)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(UUID_TEMPLATE_ID).c).toBe(5)
    db.close()
  })

  it('A7: v24 observes the POST-repair world — a template materialised from the op log counts as having a week', () => {
    // The manual template row exists only in the op log. v23's
    // repairMissingScheduleTemplates must materialise it BEFORE v24 decides
    // whether the route has a competing week.
    const db = migratedDbWithRandomUuidTemplate('camp1', {
      seed: (d) => {
        let seq = 1
        for (const op of manualTemplateOps('camp1')) {
          d.prepare(
            `INSERT INTO operations (id, seq, entity, entity_id, field, value, device_id, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, 'device1', ?)`
          ).run(`op-${seq}`, seq, op.entity, op.entity_id, op.field, op.value, new Date().toISOString())
          seq++
        }
      },
    })

    const manual = deriveScheduleTemplateId('camp1', 'manual')
    expect(db.prepare('SELECT kind FROM schedule_templates WHERE id = ?').get(manual)).toEqual({ kind: 'manual' })
    db.close()
  })

  it('A8: the v24 down script restores the exact pre-migration slot grouping', async () => {
    const { rollbackV24 } = await import('./rollback/v24_down.js')
    const derived = deriveScheduleTemplateId('camp1')
    const db = migratedDbWithRandomUuidTemplate('camp1', {
      seed: (d) => insertSlots(d, derived, 12, 'orphan'),
    })

    const grouping = () =>
      db.prepare('SELECT template_id, id FROM template_slots ORDER BY template_id, id').all()
    expect(grouping().every((r) => r.template_id === UUID_TEMPLATE_ID)).toBe(true)

    rollbackV24(db)

    expect(grouping().every((r) => r.template_id === derived)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 24').get().c).toBe(0)
    // Journal is kept by default so the rollback can itself be rolled forward.
    expect(db.prepare('SELECT COUNT(*) c FROM migration_v24_repoint_log').get().c).toBe(12)
    db.close()
  })

  it('B2/B3: fresh and migrated databases hold the same TABLES, and the same schedule data up to id', () => {
    const fresh = freshDb()
    seedCamp(fresh, 'camp1')
    // Fresh camp, real write path, generated then manual.
    for (const op of [
      { entity: 'schedule_templates', entity_id: deriveScheduleTemplateId('camp1'), field: 'kind', value: 'generated' },
      { entity: 'schedule_templates', entity_id: deriveScheduleTemplateId('camp1'), field: 'camp_id', value: 'camp1' },
      { entity: 'schedule_templates', entity_id: deriveScheduleTemplateId('camp1'), field: 'name', value: 'Master Template' },
      ...manualTemplateOps('camp1'),
    ]) applyProjection(fresh, op)
    insertSlots(fresh, deriveScheduleTemplateId('camp1'), 4, 'g')
    insertSlots(fresh, deriveScheduleTemplateId('camp1', 'manual'), 3, 'm')

    // Migrated camp, SAME sequence — except its generated row already exists
    // under a random UUID, so the renderer resolves to it and writes nothing.
    const migrated = migratedDbWithRandomUuidTemplate('camp1')
    for (const op of manualTemplateOps('camp1')) applyProjection(migrated, op)
    insertSlots(migrated, UUID_TEMPLATE_ID, 4, 'g')
    insertSlots(migrated, deriveScheduleTemplateId('camp1', 'manual'), 3, 'm')

    const tables = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map((r) => r.name)
    expect(tables(migrated)).toEqual(tables(fresh))

    // Equivalent UP TO ID, and deliberately so: the ids differ by design —
    // that is the whole point of resolving by (camp_id, kind) rather than by a
    // derived id. What must match is the SHAPE: one row per kind, each route's
    // slots hanging off the row whose kind matches.
    const shape = (db) =>
      db.prepare(
        `SELECT t.kind, COUNT(s.id) AS slots
           FROM schedule_templates t
           LEFT JOIN template_slots s ON s.template_id = t.id
          GROUP BY t.kind ORDER BY t.kind`
      ).all()
    expect(shape(migrated)).toEqual(shape(fresh))
    expect(shape(fresh)).toEqual([{ kind: 'generated', slots: 4 }, { kind: 'manual', slots: 3 }])

    fresh.close()
    migrated.close()
  })
})
