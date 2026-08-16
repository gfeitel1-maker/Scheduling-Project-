// @vitest-environment node
//
// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
//
// The seams the ADR's completion evidence names, in its order:
//   1. the count, counted and shown before the action, and re-counted at it
//   2. a version saved for each affected route BEFORE a single slot is removed,
//      and a failure to save it aborting the whole delete
//   3. the three per-entity semantics, which are not one operation
//   4. no message attributing a foreign-key failure to the connection
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { previewDelete, deleteRecord, CLEARABLE_ENTITIES } from './deleteRecord.js'

const files = []
let db

const session = { author_user_id: 'user1', device_id: 'device1' }

beforeEach(() => {
  const file = path.join(os.tmpdir(), `shoresh-delrec-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user1', 'camp1', 'Ruth', 'hash', 'salt', 'admin')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device1', 'Lakeside iPad')
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function write(entity, entity_id, field, value) {
  return appendOp(db, { entity, entity_id, field, value, ...session })
}

// A camp with two real routes and a full week per group, built through the
// ordinary write path so the rows are exactly what the app would produce.
function seedCamp({ groups = ['Bunk 1', 'Bunk 2'], days = 5, blocks = 5 } = {}) {
  const ids = { groups: {}, days: [], blocks: [], activities: {}, templates: {} }

  for (const kind of ['generated', 'manual']) {
    const tid = `template-${kind}`
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run(tid, 'camp1', kind, kind)
    ids.templates[kind] = tid
  }

  for (const name of groups) {
    const id = `group-${name.replace(/\s/g, '-')}`
    write('groups', id, 'camp_id', 'camp1')
    write('groups', id, 'name', name)
    ids.groups[name] = id
  }

  for (let d = 0; d < days; d++) {
    const id = `day-${d}`
    write('days_of_operation', id, 'camp_id', 'camp1')
    write('days_of_operation', id, 'label', `Day ${d}`)
    ids.days.push(id)
  }

  for (let b = 0; b < blocks; b++) {
    const id = `block-${b}`
    write('time_blocks', id, 'camp_id', 'camp1')
    write('time_blocks', id, 'name', `Block ${b}`)
    ids.blocks.push(id)
  }

  for (const name of ['Archery', 'Swim']) {
    const id = `activity-${name}`
    write('activities', id, 'camp_id', 'camp1')
    write('activities', id, 'name', name)
    ids.activities[name] = id
  }

  const insert = db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const tid of Object.values(ids.templates)) {
    for (const name of groups) {
      for (const day of ids.days) {
        for (const block of ids.blocks) {
          insert.run(
            `slot-${tid}-${ids.groups[name]}-${day}-${block}`,
            tid,
            ids.groups[name],
            ids.activities.Archery,
            day,
            block
          )
        }
      }
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// 1. The count
// ---------------------------------------------------------------------------

describe('the count', () => {
  it('counts rows, not routes — a week in each of two routes is both', () => {
    const ids = seedCamp()
    const preview = previewDelete(db, { entity: 'groups', entity_id: ids.groups['Bunk 1'] })
    expect(preview.slot_count).toBe(50)
    expect(preview.routes.map((r) => r.kind).sort()).toEqual(['generated', 'manual'])
    expect(preview.routes.every((r) => r.count === 25)).toBe(true)
    expect(preview.name).toBe('Bunk 1')
  })

  it('preview and the delete agree, because they share one query', () => {
    const ids = seedCamp()
    const preview = previewDelete(db, { entity: 'groups', entity_id: ids.groups['Bunk 1'] })
    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: preview.slot_count,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(result.cleared).toBe(preview.slot_count)
  })

  it('aborts when the count changed since the director was shown it', () => {
    const ids = seedCamp()
    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: 49,
      ...session,
    })
    expect(result.error).toBe('count-changed')
    expect(result.slot_count).toBe(50)
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(ids.groups['Bunk 1'])).toBeTruthy()
    expect(
      db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(ids.groups['Bunk 1']).n
    ).toBe(50)
  })

  it('a record no schedule uses still deletes', () => {
    const ids = seedCamp()
    const preview = previewDelete(db, { entity: 'activities', entity_id: ids.activities.Swim })
    expect(preview.slot_count).toBe(0)
    const result = deleteRecord(db, {
      entity: 'activities',
      entity_id: ids.activities.Swim,
      expected_slot_count: 0,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT 1 FROM activities WHERE id = ?').get(ids.activities.Swim)).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// 2. The version comes first, and its failure aborts
// ---------------------------------------------------------------------------

describe('the version is saved before anything is destroyed', () => {
  it('saves one version per affected route, each holding the WHOLE route', () => {
    const ids = seedCamp()
    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: 50,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(result.snapshots).toHaveLength(2)

    const saved = db.prepare('SELECT * FROM schedule_snapshots ORDER BY template_id').all()
    expect(saved).toHaveLength(2)
    for (const snap of saved) {
      const slots = JSON.parse(snap.slots)
      // 50 per route: BOTH groups, not only the deleted one. A partial payload
      // would restore this group's week by deleting the other group's.
      expect(slots).toHaveLength(50)
      expect(slots.filter((s) => s.group_id === ids.groups['Bunk 1'])).toHaveLength(25)
      expect(slots.filter((s) => s.group_id === ids.groups['Bunk 2'])).toHaveLength(25)
      expect(snap.is_auto).toBe(1)
      expect(snap.created_at).not.toBe('')
    }
  })

  it('the version records the week as it was, before the rows went', () => {
    const ids = seedCamp()
    deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: 50,
      ...session,
    })
    const snap = db.prepare('SELECT slots FROM schedule_snapshots LIMIT 1').get()
    const slots = JSON.parse(snap.slots)
    expect(slots.some((s) => s.group_id === ids.groups['Bunk 1'])).toBe(true)
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(ids.groups['Bunk 1']).n).toBe(0)
  })

  it('template_id is written FIRST, or the row never materializes', () => {
    const ids = seedCamp()
    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: 50,
      ...session,
    })
    const snapshotId = result.snapshots[0].id
    const firstOp = db
      .prepare('SELECT field FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC LIMIT 1')
      .get('schedule_snapshots', snapshotId)
    expect(firstOp.field).toBe('template_id')
  })

  it('a failed save aborts the delete and destroys nothing', () => {
    const ids = seedCamp()
    const groupId = ids.groups['Bunk 1']
    const realPrepare = db.prepare.bind(db)
    // Make the verification read come back with no payload — the exact shape of
    // the already-observed "snapshot saved, slots NULL" failure.
    db.prepare = (sql) => {
      if (sql.includes('SELECT template_id, slots FROM schedule_snapshots')) {
        return { get: () => ({ template_id: 'x', slots: null }) }
      }
      return realPrepare(sql)
    }
    let result
    try {
      result = deleteRecord(db, { entity: 'groups', entity_id: groupId, expected_slot_count: 50, ...session })
    } finally {
      db.prepare = realPrepare
    }
    expect(result.error).toBe('snapshot-failed')
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(groupId).n).toBe(50)
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n).toBe(0)
    expect(
      db.prepare('SELECT COUNT(*) n FROM operations WHERE entity = ?').get('schedule_snapshots').n
    ).toBe(0)
  })

  it('refuses to destroy slots it cannot protect', () => {
    const ids = seedCamp()
    // A template_id with slots but no schedule_templates row — the drift the
    // dev camp already contains. There is no route to restore these into.
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run('slot-ghost', 'template-ghost', ids.groups['Bunk 1'], ids.days[0], ids.blocks[0])

    const preview = previewDelete(db, { entity: 'groups', entity_id: ids.groups['Bunk 1'] })
    expect(preview.unprotected_count).toBe(1)

    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: preview.slot_count,
      ...session,
    })
    expect(result.error).toBe('unprotected-slots')
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(ids.groups['Bunk 1'])).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Three semantics, not one
// ---------------------------------------------------------------------------

describe('deleting an activity empties the cells and keeps them', () => {
  it('nulls activity_id, leaves the grid otherwise intact, saves no version', () => {
    const ids = seedCamp()
    const before = db.prepare('SELECT COUNT(*) n FROM template_slots').get().n

    const preview = previewDelete(db, { entity: 'activities', entity_id: ids.activities.Archery })
    expect(preview.destructive).toBe(false)
    expect(preview.slot_count).toBe(100)

    const result = deleteRecord(db, {
      entity: 'activities',
      entity_id: ids.activities.Archery,
      expected_slot_count: 100,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots').get().n).toBe(before)
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots WHERE activity_id IS NOT NULL').get().n).toBe(0)
    expect(db.prepare('SELECT 1 FROM activities WHERE id = ?').get(ids.activities.Archery)).toBeFalsy()
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n).toBe(0)
  })

  it('clears another activity naming it as the rainy-day alternative', () => {
    const ids = seedCamp()
    write('activities', ids.activities.Swim, 'weather_alternative_id', ids.activities.Archery)
    const preview = previewDelete(db, { entity: 'activities', entity_id: ids.activities.Archery })
    expect(preview.weather_dependent_count).toBe(1)

    const result = deleteRecord(db, {
      entity: 'activities',
      entity_id: ids.activities.Archery,
      expected_slot_count: 100,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(
      db.prepare('SELECT weather_alternative_id FROM activities WHERE id = ?').get(ids.activities.Swim)
        .weather_alternative_id
    ).toBeNull()
  })
})

describe('deleting a group removes its week', () => {
  it('deletes the slot rows, the other group keeps its own', () => {
    const ids = seedCamp()
    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: 50,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(ids.groups['Bunk 1']).n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(ids.groups['Bunk 2']).n).toBe(50)
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(ids.groups['Bunk 1'])).toBeFalsy()
  })

  it('every removed row is recorded as its own op, so a peer replays rather than re-derives', () => {
    const ids = seedCamp()
    deleteRecord(db, { entity: 'groups', entity_id: ids.groups['Bunk 1'], expected_slot_count: 50, ...session })
    const slotDeletes = db
      .prepare('SELECT COUNT(*) n FROM operations WHERE entity = ? AND field = ?')
      .get('template_slots', DELETE_FIELD).n
    expect(slotDeletes).toBe(50)
  })

  it('the parent delete is the LAST op, so a peer applying in order never violates its own FK', () => {
    const ids = seedCamp()
    const result = deleteRecord(db, {
      entity: 'groups',
      entity_id: ids.groups['Bunk 1'],
      expected_slot_count: 50,
      ...session,
    })
    const last = result.ops[result.ops.length - 1]
    expect(last.entity).toBe('groups')
    expect(last.field).toBe(DELETE_FIELD)
    const maxSeq = Math.max(...result.ops.map((o) => o.seq))
    expect(last.seq).toBe(maxSeq)
  })
})

describe('deleting a day removes it from the week', () => {
  it('removes anchors, overlays, and the slot rows no foreign key protects', () => {
    const ids = seedCamp()
    write('anchor_activities', 'anchor-1', 'camp_id', 'camp1')
    write('anchor_activities', 'anchor-1', 'day_id', ids.days[0])
    db.prepare(
      'INSERT INTO template_overlays (id, template_id, day_id, label) VALUES (?, ?, ?, ?)'
    ).run('overlay-1', ids.templates.manual, ids.days[0], 'Trip')

    const preview = previewDelete(db, { entity: 'days_of_operation', entity_id: ids.days[0] })
    expect(preview.destructive).toBe(true)
    expect(preview.anchor_count).toBe(1)
    expect(preview.overlay_count).toBe(1)
    expect(preview.slot_count).toBe(20)

    const result = deleteRecord(db, {
      entity: 'days_of_operation',
      entity_id: ids.days[0],
      expected_slot_count: 20,
      ...session,
    })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT 1 FROM days_of_operation WHERE id = ?').get(ids.days[0])).toBeFalsy()
    expect(db.prepare('SELECT COUNT(*) n FROM anchor_activities WHERE day_id = ?').get(ids.days[0]).n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM template_overlays WHERE day_id = ?').get(ids.days[0]).n).toBe(0)
    // The orphans a day delete leaves behind today.
    expect(db.prepare('SELECT COUNT(*) n FROM template_slots WHERE day_id = ?').get(ids.days[0]).n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. Boundaries
// ---------------------------------------------------------------------------

describe('boundaries', () => {
  it('refuses an entity this module does not own', () => {
    expect(previewDelete(db, { entity: 'users', entity_id: 'user1' }).error).toBe('not-clearable')
    expect(deleteRecord(db, { entity: 'users', entity_id: 'user1', ...session }).error).toBe('not-clearable')
  })

  it('refuses a record that is not there', () => {
    expect(previewDelete(db, { entity: 'groups', entity_id: 'nope' }).error).toBe('no-record')
    expect(deleteRecord(db, { entity: 'groups', entity_id: 'nope', ...session }).error).toBe('no-record')
  })

  it('owns exactly the four entities the ADRs name (M3c adds locations)', () => {
    expect([...CLEARABLE_ENTITIES].sort()).toEqual(['activities', 'days_of_operation', 'groups', 'locations'])
  })
})
