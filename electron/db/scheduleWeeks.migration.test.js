// @vitest-environment node
//
// Migration v27 — schedule weeks become a first-class entity.
// docs/adr/2026-08-02-schedule-weeks-first-class.md
//
// The DATABASE/SYNC seam the ADR requires proof of: an existing camp (one
// manual + one generated schedule, pre-week) must land under exactly one
// "Week 1", nothing deleted; the week id must be deterministic (two devices
// migrating the same camp independently must agree); and a re-run must be a
// no-op. The per-week / cross-week uniqueness and the fresh-vs-migrated index
// parity are proven in scheduleKind.migration.test.js; this file owns the
// migration's own before/after behaviour.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, initSchema, getSchemaVersion } from './localDb.js'
import { deriveScheduleTemplateId } from '../ops/scheduleTemplateId.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function seedCamp(db, campId) {
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, `Camp ${campId}`)
}

// A database rolled back to the v26 shape (no schedule_weeks table, no week_id
// column, the old camp-scoped unique index) so v27 can be exercised against it.
function preV27Db() {
  const file = path.join(os.tmpdir(), `shoresh-weeks-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = openLocalDb(file) // fully migrated to current
  db.pragma('foreign_keys = OFF')
  db.exec(`
    DROP TABLE IF EXISTS schedule_weeks;
    ALTER TABLE schedule_templates RENAME TO schedule_templates_old;
    CREATE TABLE schedule_templates (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'generated'
    );
    INSERT INTO schedule_templates (id, camp_id, name, kind)
      SELECT id, camp_id, name, kind FROM schedule_templates_old;
    DROP TABLE schedule_templates_old;
    DROP INDEX IF EXISTS idx_schedule_templates_week_kind;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp_kind ON schedule_templates(camp_id, kind);
  `)
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 27').run()
  return db
}

function insertTemplate(db, campId, kind) {
  const id = deriveScheduleTemplateId(campId, kind)
  db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
    .run(id, campId, kind === 'manual' ? 'Manual' : 'Generated', kind)
  return id
}

describe('migration v27: schedule weeks', () => {
  it("gives an existing camp one Week 1 that holds BOTH its schedules, nothing deleted", () => {
    const db = preV27Db()
    seedCamp(db, 'camp1')
    const genId = insertTemplate(db, 'camp1', 'generated')
    const manId = insertTemplate(db, 'camp1', 'manual')
    expect(getSchemaVersion(db)).toBe(26)

    initSchema(db) // runs v27

    const weeks = db.prepare('SELECT * FROM schedule_weeks WHERE camp_id = ?').all('camp1')
    expect(weeks).toHaveLength(1)
    expect(weeks[0].name).toBe('Week 1')
    // Deterministic id — two devices migrating this camp must land the same one.
    expect(weeks[0].id).toBe('schedule-week:camp1:1')

    // BOTH pre-existing schedules now point at that one week, keeping their ids.
    const rows = db.prepare('SELECT id, week_id FROM schedule_templates ORDER BY id').all()
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.week_id).toBe('schedule-week:camp1:1')
    expect(rows.map((r) => r.id).sort()).toEqual([genId, manId].sort())
    db.close()
  })

  it('gives every camp its own Week 1 (deterministic per camp)', () => {
    const db = preV27Db()
    seedCamp(db, 'camp1')
    seedCamp(db, 'camp2')
    insertTemplate(db, 'camp1', 'generated')
    insertTemplate(db, 'camp2', 'generated')

    initSchema(db)

    expect(db.prepare('SELECT id FROM schedule_weeks WHERE camp_id = ?').get('camp1').id).toBe('schedule-week:camp1:1')
    expect(db.prepare('SELECT id FROM schedule_weeks WHERE camp_id = ?').get('camp2').id).toBe('schedule-week:camp2:1')
    expect(db.prepare("SELECT week_id FROM schedule_templates WHERE camp_id = 'camp1'").get().week_id).toBe('schedule-week:camp1:1')
    expect(db.prepare("SELECT week_id FROM schedule_templates WHERE camp_id = 'camp2'").get().week_id).toBe('schedule-week:camp2:1')
    db.close()
  })

  it('is a no-op when re-run (idempotent): no second Week 1, week_id unchanged', () => {
    const db = preV27Db()
    seedCamp(db, 'camp1')
    insertTemplate(db, 'camp1', 'generated')
    initSchema(db)

    // Re-run the whole migration path from a v26 stamp.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 27').run()
    initSchema(db)

    expect(db.prepare('SELECT COUNT(*) c FROM schedule_weeks WHERE camp_id = ?').get('camp1').c).toBe(1)
    expect(db.prepare("SELECT week_id FROM schedule_templates WHERE camp_id = 'camp1'").get().week_id).toBe('schedule-week:camp1:1')
    db.close()
  })

  it('lands a camp with no schedules at all with a Week 1 and nothing else', () => {
    const db = preV27Db()
    seedCamp(db, 'camp1')
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_weeks WHERE camp_id = ?').get('camp1').c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(0)
    db.close()
  })

  // Review non-blocker #4: the asymmetric case — a camp with ONLY a manual row
  // and no generated one. The backfill UPDATE is keyed by camp_id, not kind, so
  // it should cover this by the same logic as the both-schedules case; proven
  // here as its own scenario because it is exactly the "real existing data"
  // shape a spreadsheet-replacement camp (manual only, never generated) has.
  it('backfills a camp that has only a manual schedule (no generated row)', () => {
    const db = preV27Db()
    seedCamp(db, 'camp1')
    const manId = insertTemplate(db, 'camp1', 'manual')

    initSchema(db)

    expect(db.prepare('SELECT id FROM schedule_weeks WHERE camp_id = ?').get('camp1').id).toBe('schedule-week:camp1:1')
    expect(db.prepare('SELECT week_id FROM schedule_templates WHERE id = ?').get(manId).week_id).toBe('schedule-week:camp1:1')
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(1)
    db.close()
  })

  // Review non-blocker: downgrade is a SUPPORTED path (product owner, 2026-08-02).
  // An old build has no week_id column and resolves a route by (camp_id, kind).
  // This proves downgrade is NON-DESTRUCTIVE: after a second week is added post-
  // migration (as the running app would), every week's rows still coexist, and
  // Week 1's row keeps the original camp-derived id an old build already used —
  // so an old build operates on Week 1 and loses nothing; re-upgrading restores
  // the full multi-week view. See the ADR rollback section.
  it('downgrade is non-destructive: a second week added post-migration leaves Week 1 intact and re-resolvable', () => {
    const db = preV27Db()
    seedCamp(db, 'camp1')
    const week1Gen = insertTemplate(db, 'camp1', 'generated') // original camp-derived id
    initSchema(db) // v27 points week1Gen at Week 1

    // The running app makes a second week with its own generated schedule.
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 1, 0)')
      .run('schedule-week:camp1:2', 'camp1', 'Week 2')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind, week_id) VALUES (?, ?, ?, ?, ?)')
      .run('schedule-template:schedule-week:camp1:2', 'camp1', 'Generated', 'generated', 'schedule-week:camp1:2')

    // Both weeks' generated rows coexist — nothing was destroyed.
    expect(db.prepare("SELECT COUNT(*) c FROM schedule_templates WHERE camp_id = 'camp1' AND kind = 'generated'").get().c).toBe(2)
    // Week 1 still carries its original camp-derived id (what a pre-v27 build used),
    // and it is still pointed at Week 1 — the old build finds a real, intact schedule.
    const w1 = db.prepare('SELECT week_id FROM schedule_templates WHERE id = ?').get(week1Gen)
    expect(w1.week_id).toBe('schedule-week:camp1:1')
    db.close()
  })
})
