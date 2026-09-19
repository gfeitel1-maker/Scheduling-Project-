// @vitest-environment node
//
// T205 — schema v70: UNIQUE(camp_id, day_of_week) on days_of_operation, plus
// the dedupe/repoint migration that makes it applicable to an already-live
// camp db. See docs/work/tickets/T205-days-of-operation-uniqueness-and-dedup-migration.md.
//
// METHOD (ticket §4): fixtures are built by driving the real write path
// (applyProjection, exactly what appendOp calls) wherever the scenario is
// PRODUCIBLE that way. The one exception — called out per test — is the
// NULL-day orphan: T205 Part A's fix means the CURRENT write path can no
// longer produce it, so it is planted with a raw INSERT standing in for a
// row a PRE-T205 build already wrote to a real camp's db.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { applyProjection } from '../ops/projections.js'
import { deriveDayId } from '../ops/dayId.js'

let tmpFile

afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function freshDb() {
  tmpFile = path.join(os.tmpdir(), `shoresh-test-${Date.now()}-${Math.random()}.sqlite`)
  return openLocalDb(tmpFile)
}

// Rebuilds days_of_operation WITHOUT the inline UNIQUE — simulating a real
// pre-v70 db (schema.sql's CREATE TABLE IF NOT EXISTS never retrofits an
// existing table), same technique as the groups/cohorts v11/v12 precedent
// tests in localDb.migrations.test.js.
function dropToPreV70Shape(db) {
  db.exec('DROP TABLE days_of_operation')
  db.exec(`
    CREATE TABLE days_of_operation (
      id TEXT PRIMARY KEY,
      camp_id TEXT NOT NULL REFERENCES camps(id),
      label TEXT NOT NULL,
      day_of_week INTEGER,
      sort_order INTEGER
    )
  `)
  db.prepare('DELETE FROM schema_migrations WHERE version >= 70').run()
}

function seedCamp(db, campId = 'camp1') {
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
}

// Writes a complete days_of_operation row through the real write path
// (applyProjection == what appendOp calls), matching how seedDays actually
// creates a row field-by-field.
function writeDay(db, id, campId, label, dayOfWeek) {
  applyProjection(db, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: campId })
  applyProjection(db, { entity: 'days_of_operation', entity_id: id, field: 'label', value: label })
  applyProjection(db, { entity: 'days_of_operation', entity_id: id, field: 'day_of_week', value: dayOfWeek })
}

describe('T205 schema v70: days_of_operation UNIQUE(camp_id, day_of_week)', () => {
  it('a fresh install rejects a second day with the same camp_id + day_of_week', () => {
    const db = freshDb()
    seedCamp(db)
    writeDay(db, 'd1', 'camp1', 'Monday', 1)
    expect(() => {
      db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, ?)')
        .run('d2', 'camp1', 'Monday (dup)', 1)
    }).toThrow(/UNIQUE/)
    db.close()
  })

  // THE PREMISE SCENARIO (ticket §1, verified true): the Host's un-awaited
  // seedDays races an immediate second-device invite on a BRAND-NEW camp.
  // Pre-T205, both devices mint crypto.randomUUID() ids, so two genuinely
  // different rows land for the same weekday — this is what the migration's
  // dedupe branch exists to clean up on an upgrade.
  it('dedupes two real-write-path rows for the same weekday, keeping exactly one', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    writeDay(db, 'device-a-monday', 'camp1', 'Monday', 1)
    writeDay(db, 'device-b-monday', 'camp1', 'Monday', 1)

    expect(() => initSchema(db)).not.toThrow()

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND day_of_week = 1').all('camp1')
    expect(rows.length).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  // "A timed-out-but-landed write followed by a retry" (ticket §4): the first
  // seedDays call's write actually landed but the caller believed it failed
  // (or crashed before recording success) and retried, which — pre-T205 —
  // minted a SECOND crypto.randomUUID() row for the same weekday because the
  // retry's repair-matcher never saw the first row complete in time.
  it('plants a timed-out-but-landed write + retry: exactly one surviving Monday row', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    writeDay(db, 'landed-write', 'camp1', 'Monday', 1) // the write that "timed out" but actually landed
    writeDay(db, 'retry-write', 'camp1', 'Monday', 1) // the retry, believing nothing exists yet

    initSchema(db)

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND day_of_week = 1').all('camp1')
    expect(rows.length).toBe(1)
    db.close()
  })

  // Defect 1 (ticket §3.1): the NULL-day orphan. NOT producible through the
  // current (T205 part-A-fixed) write path any more — ensureExists now
  // stamps day_of_week in the same insert for a deterministic id, and a
  // legacy random id simply leaves day_of_week NULL forever without ever
  // getting a torn intermediate state from a REJECTED write. This raw INSERT
  // stands in for a row a PRE-T205 build already wrote to a real camp's db:
  // camp_id + label ('Tuesday') materialized, day_of_week permanently NULL
  // because the later field write collided and was rejected.
  it('heals a lone NULL-day orphan onto its label-derived weekday when no other row claims it', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, NULL)')
      .run('torn-tuesday', 'camp1', 'Tuesday')

    initSchema(db)

    const row = db.prepare('SELECT * FROM days_of_operation WHERE id = ?').get('torn-tuesday')
    expect(row).toBeTruthy()
    expect(row.day_of_week).toBe(2)
    db.close()
  })

  it('treats a NULL-day orphan as a LOSER (repointed then removed) when a complete row already holds that weekday', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    writeDay(db, 'device-b-tuesday', 'camp1', 'Tuesday', 2) // the retry that actually completed
    db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, NULL)')
      .run('torn-tuesday', 'camp1', 'Tuesday') // the original torn write

    db.prepare(
      "INSERT INTO template_slots (id, template_id, day_id) VALUES ('slot-on-torn', 'tmpl1', 'torn-tuesday')"
    ).run()

    initSchema(db)

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND day_of_week = 2').all('camp1')
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('device-b-tuesday')
    // The referencer that pointed at the LOSER (torn-tuesday) must be
    // repointed to the survivor, never left dangling (defect 3).
    expect(db.prepare('SELECT day_id FROM template_slots WHERE id = ?').get('slot-on-torn').day_id).toBe(
      'device-b-tuesday'
    )
    db.close()
  })

  // Defect 3 (ticket §3.3): enumerate referencers by what they HOLD, not by
  // `REFERENCES` — template_slots.day_id and elective_occurrences.day_id
  // declare no FK at all and were missed by three separate grep-based
  // enumerations in round 1.
  it('repoints ALL FOUR day_id-holding columns off a duplicate day before deleting it', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    writeDay(db, 'monday-keep', 'camp1', 'Monday', 1)
    writeDay(db, 'monday-dupe', 'camp1', 'Monday (dup)', 1)

    db.prepare(
      "INSERT INTO template_slots (id, template_id, day_id) VALUES ('ts1', 'tmpl1', 'monday-dupe')"
    ).run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, day_id) VALUES ('aa1', 'camp1', 'Swim', 'monday-dupe')"
    ).run()
    db.prepare(
      "INSERT INTO elective_sets (id, camp_id, name, day_id) VALUES ('es1', 'camp1', 'Set A', 'monday-dupe')"
    ).run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run A')"
    ).run()
    db.prepare(
      "INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id) VALUES ('eo1', 'run1', 'es1', 'monday-dupe')"
    ).run()

    initSchema(db)

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND day_of_week = 1').all('camp1')
    expect(rows.length).toBe(1)
    const survivorId = rows[0].id

    expect(db.prepare('SELECT day_id FROM template_slots WHERE id = ?').get('ts1').day_id).toBe(survivorId)
    expect(db.prepare('SELECT day_id FROM anchor_activities WHERE id = ?').get('aa1').day_id).toBe(survivorId)
    expect(db.prepare('SELECT day_id FROM elective_sets WHERE id = ?').get('es1').day_id).toBe(survivorId)
    expect(db.prepare('SELECT day_id FROM elective_occurrences WHERE id = ?').get('eo1').day_id).toBe(survivorId)
    db.close()
  })

  // Non-vacuity: a camp legitimately has zero duplicates on upgrade far more
  // often than it has any — this proves the migration is a no-op there, not
  // just "doesn't crash".
  it('is a no-op for a camp with no duplicates — no rows deleted, no referencer touched', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)
    writeDay(db, 'mon', 'camp1', 'Monday', 1)
    writeDay(db, 'tue', 'camp1', 'Tuesday', 2)
    db.prepare("INSERT INTO template_slots (id, template_id, day_id) VALUES ('ts1', 'tmpl1', 'mon')").run()

    initSchema(db)

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ?').all('camp1')
    expect(rows.map((r) => r.id).sort()).toEqual(['mon', 'tue'])
    expect(db.prepare('SELECT day_id FROM template_slots WHERE id = ?').get('ts1').day_id).toBe('mon')
    db.close()
  })

  // Part D: durable, cross-restart domain-state refusal marker.
  it('records a durable domain_state_migration_pending row when the migration actually deletes a row', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)
    writeDay(db, 'a', 'camp1', 'Monday', 1)
    writeDay(db, 'b', 'camp1', 'Monday', 1)

    initSchema(db)

    const pending = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 70').get()
    expect(pending).toBeTruthy()
    expect(pending.resolved_at).toBeNull()
    db.close()
  })

  it('records the deleted loser entity_ids in the marker detail, for FIX 2\'s document-routed resolve', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)
    writeDay(db, 'a', 'camp1', 'Monday', 1)
    writeDay(db, 'b', 'camp1', 'Monday (dup)', 1)

    initSchema(db)

    const pending = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 70').get()
    const detail = JSON.parse(pending.detail)
    expect(detail.losers).toEqual([{ entity: 'days_of_operation', entity_id: 'b' }])
    db.close()
  })

  it('records NO durable marker when the migration finds nothing to dedupe', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)
    writeDay(db, 'mon', 'camp1', 'Monday', 1)

    initSchema(db)

    const pending = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 70').get()
    expect(pending).toBeUndefined()
    db.close()
  })
})

describe('T205 round 2 FIX 3: deterministic survivor selection across devices', () => {
  // Two devices deduping the SAME pre-existing duplicate pair must pick the
  // SAME survivor, or their post-migration states never reconcile. Preference:
  // the row whose id equals deriveDayId(camp_id, weekday) — the canonical id
  // any device minting this weekday today would choose — if one exists in the
  // group.
  it('prefers the row whose id IS deriveDayId(camp_id, weekday) as survivor, even when it is not the lowest id', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    const canonicalId = deriveDayId('camp1', 1)
    // A lexicographically-smaller, non-canonical legacy id — would win under a
    // naive "smallest id" rule, but must NOT win here.
    writeDay(db, 'aaaa-legacy', 'camp1', 'Monday', 1)
    writeDay(db, canonicalId, 'camp1', 'Monday (dup)', 1)

    initSchema(db)

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND day_of_week = 1').all('camp1')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(canonicalId)
    db.close()
  })

  // No canonical id present in the group (both are legacy random ids): falls
  // back to the lexicographically-smallest id — deterministic, dependency-free,
  // and identical on every device comparing the SAME id strings.
  it('falls back to the lexicographically-smallest id when no row has the canonical id', () => {
    const db = freshDb()
    seedCamp(db)
    dropToPreV70Shape(db)

    writeDay(db, 'zzzz-legacy', 'camp1', 'Monday', 1)
    writeDay(db, 'aaaa-legacy', 'camp1', 'Monday (dup)', 1)

    initSchema(db)

    const rows = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND day_of_week = 1').all('camp1')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('aaaa-legacy')
    db.close()
  })
})
