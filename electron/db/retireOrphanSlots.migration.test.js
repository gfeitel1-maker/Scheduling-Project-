// @vitest-environment node
//
// Migration v26 — retiring orphaned schedule slots by preserving them as a Version.
// docs/adr/2026-07-30-retiring-orphaned-schedule-slots.md
//
// DATABASE/SYNC seam, and the only migration in this project that DELETES rows
// from a director's schedule. The properties asserted here are, in order of
// importance:
//
//   1. A camp whose snapshot insert fails keeps every one of its rows (ADR §4).
//   2. The Version that is written restores through the EXISTING restore path.
//   3. A camp with no orphans is byte-identically unchanged.
//
// Everything else — table equivalence, the orphan predicate, rollback — follows
// the precedent in scheduleKind.migration.test.js.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION, V26_RECOVERED_WEEK_NAME } from './localDb.js'
import { rollbackV26 } from './rollback/v26_down.js'
import { deriveScheduleTemplateId } from '../ops/scheduleTemplateId.js'
import { parseSnapshotPayload, isRestorable } from '../../src/screens/snapshotRestore.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb(tag = 'v26') {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function seedCamp(db, campId = 'camp1') {
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(`grp-${campId}`, campId, 'Bunk 2')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(`act-${campId}`, campId, 'Swim')
  return campId
}

// The state a camp is left in by the v23 window: a real generated row carrying a
// RANDOM uuid, plus a week of slots written under the DERIVED generated id that
// no schedule_templates row holds.
function seedOrphanedCamp(db, campId, realId, { slots = 3, overlays = 1 } = {}) {
  seedCamp(db, campId)
  db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
    .run(realId, campId, 'Master Template', 'generated')
  const orphanId = deriveScheduleTemplateId(campId, 'generated')
  for (let i = 0; i < slots; i++) {
    db.prepare(
      `INSERT INTO template_slots
         (id, template_id, group_id, activity_id, day_id, time_block_id, flags, is_span_head, anchor_id, is_anchor)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      `${campId}-orphan-slot-${i}`, orphanId, `grp-${campId}`, `act-${campId}`,
      `day-${i}`, `block-${i}`,
      i === 0 ? JSON.stringify({ UNFILLABLE: true, UNFILLABLE_reason: 'no room' }) : '{}',
      i === 1 ? 'anchor-1' : null,
      i === 1 ? 1 : 0
    )
  }
  // template_overlays carries a REAL foreign key to schedule_templates and
  // openLocalDb sets PRAGMA foreign_keys = ON, so an orphan overlay cannot
  // arise in the field — template_slots is the outlier that has no declared FK,
  // which is exactly why it alone accumulated orphans in the v23 window. The
  // pragma is dropped here only to plant one, so v26's defensive handling of
  // the overlay branch is actually exercised rather than assumed.
  if (overlays > 0) {
    db.pragma('foreign_keys = OFF')
    for (let i = 0; i < overlays; i++) {
      db.prepare(
        `INSERT INTO template_overlays (id, template_id, unit_id, day_id, from_block_order, to_block_order, label)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(`${campId}-orphan-overlay-${i}`, orphanId, `unit-${i}`, null, 1, 2, 'Lunch')
    }
    db.pragma('foreign_keys = ON')
  }
  // A week the director CAN see, on the real template. Its presence is exactly
  // why v24 declined to repoint: repointing would overwrite it.
  db.prepare(
    `INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id, flags)
     VALUES (?, ?, ?, ?, ?, ?, '{}')`
  ).run(`${campId}-visible-slot`, realId, `grp-${campId}`, `act-${campId}`, 'day-0', 'block-0')
  return orphanId
}

// Re-run the migration from a pre-v26 state.
function rerunV26(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 26').run()
  initSchema(db)
}

function orphanSlotCount(db) {
  return db.prepare(
    `SELECT COUNT(*) c FROM template_slots s
      WHERE NOT EXISTS (SELECT 1 FROM schedule_templates t WHERE t.id = s.template_id)`
  ).get().c
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name)
}

function journal(db) {
  return db.prepare('SELECT * FROM migration_v26_retired_orphan_log ORDER BY id').all()
}

describe('migration v26: retiring orphaned schedule slots', () => {
  it('leaves zero routeless template_slots rows, and keeps the visible week', () => {
    const db = freshDb()
    const orphanId = seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    expect(orphanSlotCount(db)).toBe(3)

    rerunV26(db)

    expect(orphanSlotCount(db)).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(orphanId).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM template_overlays WHERE template_id = ?').get(orphanId).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get('random-uuid-1').c).toBe(1)
    db.close()
  })

  it('writes the Version against the REAL template, named for a director', () => {
    const db = freshDb()
    seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    rerunV26(db)

    const snap = db.prepare('SELECT * FROM schedule_snapshots').get()
    expect(snap.template_id).toBe('random-uuid-1')
    expect(snap.is_auto).toBe(0)
    expect(snap.name).toBe(V26_RECOVERED_WEEK_NAME)
    // Article V: it sits beside weeks the director saved themselves.
    expect(snap.name).not.toMatch(/orphan|template_id|migration/i)
    db.close()
  })

  // Completion evidence 2 — the Version is a preservation, not a deletion with
  // extra steps. Parsed by the real parser, then mapped exactly as
  // restoreSnapshot maps it, and compared to the rows that were deleted.
  it('restores through the existing restore path, field for field', () => {
    const db = freshDb()
    const orphanId = seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    const before = db
      .prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id')
      .all(orphanId)

    rerunV26(db)

    const snap = db.prepare('SELECT * FROM schedule_snapshots').get()
    expect(isRestorable(snap)).toBe(true)
    const parsed = parseSnapshotPayload(snap)
    expect(parsed.ok).toBe(true)

    // restoreSnapshot's own row mapping (ScheduleScreen.jsx).
    const restored = parsed.slots.map((s) => ({
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor ? 1 : 0,
      flags: JSON.stringify(s.flags || {}),
    }))
    const expected = before.map((r) => ({
      group_id: r.group_id,
      day_id: r.day_id,
      time_block_id: r.time_block_id,
      activity_id: r.activity_id,
      anchor_id: r.anchor_id,
      is_anchor: r.is_anchor ? 1 : 0,
      flags: r.flags,
    }))
    expect(restored).toEqual(expected)

    // is_anchor must survive as a BOOLEAN in the payload, matching what
    // saveSnapshot writes from normalizeSlots output.
    expect(parsed.slots.map((s) => s.is_anchor)).toEqual([false, true, false])
    expect(parsed.slots[0].flags).toEqual({ UNFILLABLE: true, UNFILLABLE_reason: 'no room' })
    expect(parsed.overlays).toEqual([
      { unit_id: 'unit-0', day_id: null, from_block_order: 1, to_block_order: 2, label: 'Lunch' },
    ])
    db.close()
  })

  // Completion evidence 3 — THE property. Per camp, not per migration.
  it('deletes nothing for a camp whose snapshot insert fails, and still finishes the other camp', () => {
    const db = freshDb()
    const orphan1 = seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    const orphan2 = seedOrphanedCamp(db, 'camp2', 'random-uuid-2')
    db.exec(`CREATE TRIGGER v26_block BEFORE INSERT ON schedule_snapshots
             WHEN NEW.template_id = 'random-uuid-1'
             BEGIN SELECT RAISE(ABORT, 'blocked for test'); END;`)

    rerunV26(db)

    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(orphan1).c).toBe(3)
    expect(db.prepare('SELECT COUNT(*) c FROM template_overlays WHERE template_id = ?').get(orphan1).c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(orphan2).c).toBe(0)

    const rows = journal(db)
    const skipped = rows.filter((r) => r.outcome === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].orphan_template_id).toBe(orphan1)
    expect(skipped[0].reason).toMatch(/blocked for test/)
    expect(rows.filter((r) => r.outcome === 'retired' && r.camp_id === 'camp2')).toHaveLength(4)
    // Nothing was journalled as retired for the camp that was skipped.
    expect(rows.filter((r) => r.outcome === 'retired' && r.camp_id === 'camp1')).toHaveLength(0)
    db.close()
  })

  // Completion evidence 4 — production was verified clean, so v26 must be a
  // provable no-op there.
  it('leaves a camp with no orphans byte-identically unchanged', () => {
    const db = freshDb()
    seedCamp(db, 'camp1')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run(deriveScheduleTemplateId('camp1'), 'camp1', 'Master Template', 'generated')
    db.prepare(
      `INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id, flags)
       VALUES ('s1', ?, 'grp-camp1', 'act-camp1', 'day-0', 'block-0', '{}')`
    ).run(deriveScheduleTemplateId('camp1'))

    const dump = () =>
      ['template_slots', 'template_overlays', 'schedule_snapshots', 'schedule_templates']
        .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()))
        .join('|')

    const before = dump()
    rerunV26(db)
    expect(dump()).toBe(before)
    expect(journal(db)).toHaveLength(0)
    db.close()
  })

  // An orphan set whose derived id maps to NO template row cannot be preserved:
  // schedule_snapshots.template_id has a real FK, so there is nowhere legal to
  // write the Version. Per ADR §4 those rows are left alone, and the condition
  // is made visible rather than silent.
  it('leaves an orphan set with no owning template alone, and journals why', () => {
    const db = freshDb()
    seedCamp(db, 'camp1')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run(deriveScheduleTemplateId('camp1'), 'camp1', 'Master Template', 'generated')
    const strayId = deriveScheduleTemplateId('camp1', 'manual') // no manual row exists
    db.prepare(
      `INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, flags)
       VALUES ('stray1', ?, 'grp-camp1', 'day-0', 'block-0', '{}')`
    ).run(strayId)

    rerunV26(db)

    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(strayId).c).toBe(1)
    const rows = journal(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('skipped')
    expect(rows[0].orphan_template_id).toBe(strayId)
    expect(rows[0].reason).toMatch(/no owning template/)
    // Not attributed to a guessed camp: there is no template row to read one
    // from, and this is the row support reads when T21 is still blocked.
    expect(rows[0].camp_id).toBeNull()
    expect(rows[0].kind).toBeNull()

    // The condition is permanent, so a second pass must not re-append it.
    rerunV26(db)
    expect(journal(db)).toHaveLength(1)
    db.close()
  })

  // Round-2 finding (Red Hat HIGH-2): skipping a camp is only safe if the camp
  // is retried. The stamp is withheld so the next launch tries again.
  it('retries a camp whose snapshot failed, and completes once the failure is gone', () => {
    const db = freshDb()
    const orphan1 = seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    db.exec(`CREATE TRIGGER v26_block BEFORE INSERT ON schedule_snapshots
             BEGIN SELECT RAISE(ABORT, 'blocked for test'); END;`)

    db.prepare('DELETE FROM schema_migrations WHERE version >= 26').run()
    initSchema(db)

    // Not stamped — otherwise the camp would never be looked at again.
    expect(getSchemaVersion(db)).toBeLessThan(26)
    expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(orphan1).c).toBe(3)

    db.exec('DROP TRIGGER v26_block')
    initSchema(db) // the next launch, with no re-priming

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(orphanSlotCount(db)).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(1)
    db.close()
  })

  // Round-2 finding (Red Hat HIGH-1): camp_id and kind both replicate, so an id
  // derived from them alone would be identical on two devices holding
  // DIFFERENT recovered weeks — and deleting a Version emits a replicating op
  // keyed by that id.
  it('scopes the Version id to this device', () => {
    const dbA = freshDb('v26-devA')
    const dbB = freshDb('v26-devB')
    seedOrphanedCamp(dbA, 'camp1', 'random-uuid-1')
    seedOrphanedCamp(dbB, 'camp1', 'random-uuid-1')
    rerunV26(dbA)
    rerunV26(dbB)

    const idA = dbA.prepare('SELECT id FROM schedule_snapshots').get().id
    const idB = dbB.prepare('SELECT id FROM schedule_snapshots').get().id
    const deviceA = dbA.prepare('SELECT id FROM device_identity').get().id
    expect(idA).toContain(deviceA)
    expect(idA).not.toBe(idB)
    dbA.close()
    dbB.close()
  })

  // Round-2 finding (Red Hat MEDIUM): a rollback followed by a roll-forward
  // must not discard the name the director gave the Version.
  it('keeps a director-supplied name when the Version is rewritten', () => {
    const db = freshDb()
    seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    rerunV26(db)
    const snapId = db.prepare('SELECT id FROM schedule_snapshots').get().id
    db.prepare('UPDATE schedule_snapshots SET name = ? WHERE id = ?').run('Week 3 as it was', snapId)

    rollbackV26(db)
    rerunV26(db)

    const snap = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get(snapId)
    expect(snap.name).toBe('Week 3 as it was')
    // The rewrite is inspectable: the prior row is journalled in full.
    const replaced = journal(db).filter((r) => r.outcome === 'replaced')
    expect(replaced).toHaveLength(1)
    expect(replaced[0].table_name).toBe('schedule_snapshots')
    expect(JSON.parse(replaced[0].row_json).name).toBe('Week 3 as it was')
    db.close()
  })

  it('is idempotent — re-applying mints one Version, not two', () => {
    const db = freshDb()
    seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
    rerunV26(db)
    const snapId = db.prepare('SELECT id FROM schedule_snapshots').get().id
    rerunV26(db)
    const snaps = db.prepare('SELECT id FROM schedule_snapshots').all()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].id).toBe(snapId)
    db.close()
  })

  // Completion evidence 5 — fresh-vs-migrated equivalence, per the precedent in
  // scheduleKind.migration.test.js.
  describe('fresh vs migrated', () => {
    it('produces an identical table list', () => {
      const fresh = freshDb('v26-fresh')
      seedCamp(fresh, 'camp1')

      const migrated = freshDb('v26-migrated')
      seedOrphanedCamp(migrated, 'camp1', 'random-uuid-1')
      rerunV26(migrated)

      expect(tableNames(migrated)).toEqual(tableNames(fresh))
      expect(tableNames(fresh)).toContain('migration_v26_retired_orphan_log')
      expect(getSchemaVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION)
      expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
      fresh.close(); migrated.close()
    })

    it('produces an identical schedule shape up to template id', () => {
      const shape = (db) =>
        db.prepare(
          `SELECT t.kind, COUNT(s.id) AS slots
             FROM schedule_templates t
             LEFT JOIN template_slots s ON s.template_id = t.id
            GROUP BY t.kind ORDER BY t.kind`
        ).all()

      const fresh = freshDb('v26-fresh')
      seedCamp(fresh, 'camp1')
      fresh.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
        .run(deriveScheduleTemplateId('camp1'), 'camp1', 'Master Template', 'generated')
      fresh.prepare(
        `INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, flags)
         VALUES ('s1', ?, 'grp-camp1', 'day-0', 'block-0', '{}')`
      ).run(deriveScheduleTemplateId('camp1'))

      const migrated = freshDb('v26-migrated')
      seedOrphanedCamp(migrated, 'camp1', 'random-uuid-1')
      rerunV26(migrated)

      expect(shape(migrated)).toEqual(shape(fresh))
      expect(orphanSlotCount(migrated)).toBe(0)
      expect(orphanSlotCount(fresh)).toBe(0)
      fresh.close(); migrated.close()
    })
  })

  describe('rollback', () => {
    it('restores every deleted row byte-identically and keeps the Version', () => {
      const db = freshDb()
      const orphanId = seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
      const beforeSlots = JSON.stringify(
        db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all(orphanId)
      )

      rerunV26(db)
      const result = rollbackV26(db)

      expect(result.restored).toBe(3)
      expect(
        JSON.stringify(db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all(orphanId))
      ).toBe(beforeSlots)
      // The planted orphan OVERLAY cannot come back: template_overlays has a
      // real FK to schedule_templates, so SQLite refuses to re-insert it under
      // a parentless template_id. That same FK is why an orphan overlay is
      // unreachable in the field — this fixture had to disable the pragma to
      // create one. The rollback reports it rather than aborting, so the slots,
      // which are the actual subject of v26, are restored regardless.
      expect(result.unrestorable).toBe(1)
      expect(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 26').get()).toBeUndefined()
      // The journal is kept, and the Version stays: removing a Version the
      // director may since have restored from would be its own harm (ADR).
      expect(journal(db).length).toBeGreaterThan(0)
      expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(1)
      db.close()
    })

    it('is idempotent', () => {
      const db = freshDb()
      const orphanId = seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
      rerunV26(db)
      rollbackV26(db)
      const second = rollbackV26(db)
      expect(second.restored).toBe(0)
      expect(db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(orphanId).c).toBe(3)
      db.close()
    })

    it('removes the Version only when explicitly asked', () => {
      const db = freshDb()
      seedOrphanedCamp(db, 'camp1', 'random-uuid-1')
      rerunV26(db)
      rollbackV26(db, { purgeSnapshots: true })
      expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(0)
      db.close()
    })
  })
})
