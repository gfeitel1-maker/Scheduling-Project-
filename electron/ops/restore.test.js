// @vitest-environment node
//
// docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md
//
// The seams this file exists for, in the ADR's own order of importance:
//   1. the entity allowlist, ENFORCED here rather than hidden in the UI
//   2. re-emitting last-known field values rebuilds the record exactly
//   3. children are reported, never restored implicitly
//   4. getEntityHistory never returns pin material
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { PROJECTIONS } from './projections.js'
import { RESTORABLE_ENTITIES, RESTORE_DECISIONS, restoreEntity } from './restore.js'
import { listDeleted, getEntityHistory } from './trash.js'

const files = []
let db

beforeEach(() => {
  const file = path.join(os.tmpdir(), `shoresh-restore-${Date.now()}-${Math.random()}.sqlite`)
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
  return appendOp(db, { entity, entity_id, field, value, author_user_id: 'user1', device_id: 'device1' })
}

function makeGroup(id, { name = 'Aleph', tier_id = null, availability = 'all' } = {}) {
  write('groups', id, 'camp_id', 'camp1')
  write('groups', id, 'name', name)
  if (tier_id) write('groups', id, 'tier_id', tier_id)
  write('groups', id, 'availability', availability)
}

function del(entity, entity_id) {
  return write(entity, entity_id, DELETE_FIELD, 1)
}

const session = { author_user_id: 'user1', device_id: 'device1' }

// ---------------------------------------------------------------------------
// 1. The allowlist
// ---------------------------------------------------------------------------

describe('the restore allowlist is enforced, not merely documented', () => {
  it('refuses users — a restore would re-emit pin_hash and pin_salt as replicating ops', () => {
    write('users', 'user2', 'camp_id', 'camp1')
    write('users', 'user2', 'name', 'Removed Person')
    write('users', 'user2', 'pin_hash', 'secret-hash')
    write('users', 'user2', 'pin_salt', 'secret-salt')
    write('users', 'user2', 'role', 'staff')
    del('users', 'user2')

    const opsBefore = db.prepare('SELECT COUNT(*) c FROM operations').get().c
    const result = restoreEntity(db, { entity: 'users', entity_id: 'user2', ...session })

    expect(result).toEqual({ error: 'not-restorable' })
    // Refused BEFORE the log is read, so no path reaches a user's history.
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsBefore)
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get('user2').c).toBe(0)
  })

  it.each(['camps', 'devices', 'schedule_templates', 'template_slots', 'schedule_snapshots'])(
    'refuses %s',
    (entity) => {
      expect(restoreEntity(db, { entity, entity_id: 'x', ...session })).toEqual({ error: 'not-restorable' })
    }
  )

  it('refuses an entity nobody has ever heard of, rather than falling through', () => {
    expect(restoreEntity(db, { entity: 'wat', entity_id: 'x', ...session })).toEqual({ error: 'not-restorable' })
  })

  it('accepts exactly the setup entities the ADR names (incl. v32 locations)', () => {
    expect([...RESTORABLE_ENTITIES].sort()).toEqual([
      'activities',
      'anchor_activities',
      'cohorts',
      'day_override_templates',
      'days_of_operation',
      'groups',
      'locations',
      'tiers',
      'time_blocks',
    ])
  })

  // The guard the ADR asks for by name: a new entity joining the projection
  // registry must come with a deliberate decision about restorability, not
  // inherit one by omission.
  it('fails if a projected entity has no recorded restorability decision', () => {
    const undecided = Object.keys(PROJECTIONS).filter((e) => !(e in RESTORE_DECISIONS))
    expect(undecided).toEqual([])
  })

  it('records every decision as an explicit yes or no that matches the allowlist', () => {
    for (const [entity, decision] of Object.entries(RESTORE_DECISIONS)) {
      expect(typeof decision).toBe('string')
      expect(RESTORABLE_ENTITIES.has(entity)).toBe(decision === 'restorable')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Rebuilding the record
// ---------------------------------------------------------------------------

describe('restoring rebuilds the record from its last-known field values', () => {
  it('returns every field as it was immediately before the delete', () => {
    write('tiers', 't1', 'camp_id', 'camp1')
    write('tiers', 't1', 'name', 'Unit B')
    makeGroup('g1', { name: 'Aleph', tier_id: 't1', availability: 'all' })
    write('groups', 'g1', 'name', 'Aleph Renamed')
    write('groups', 'g1', 'availability', 'morning')
    const before = db.prepare('SELECT * FROM groups WHERE id = ?').get('g1')

    del('groups', 'g1')
    expect(db.prepare('SELECT * FROM groups WHERE id = ?').get('g1')).toBeUndefined()

    const result = restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT * FROM groups WHERE id = ?').get('g1')).toEqual(before)
  })

  it('writes camp_id first, so the projection camp guard sees a consistent row', () => {
    makeGroup('g1')
    del('groups', 'g1')

    const result = restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })

    expect(result.ops[0].field).toBe('camp_id')
    expect(result.restored_fields).toBe(result.ops.length)
  })

  it('never re-emits the sentinel fields', () => {
    makeGroup('g1')
    del('groups', 'g1')

    const result = restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })

    expect(result.ops.map((o) => o.field)).not.toContain('__deleted__')
    expect(result.ops.map((o) => o.field)).not.toContain('__bulk_replace__')
  })

  it('refuses a record that is not deleted, and writes nothing', () => {
    makeGroup('g1')
    const opsBefore = db.prepare('SELECT COUNT(*) c FROM operations').get().c

    expect(restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })).toEqual({ error: 'not-deleted' })
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsBefore)
  })

  it('refuses a record whose creation op is absent, rather than restoring a shell', () => {
    // The Client-history case the ADR is guarding against: a delete arrived,
    // but the ops that built the record never did.
    del('groups', 'ghost')
    const opsBefore = db.prepare('SELECT COUNT(*) c FROM operations').get().c

    expect(restoreEntity(db, { entity: 'groups', entity_id: 'ghost', ...session })).toEqual({ error: 'no-history' })
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsBefore)
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(0)
  })

  it('restores twice to one record, not two', () => {
    makeGroup('g1')
    del('groups', 'g1')

    restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })
    const after = db.prepare('SELECT * FROM groups WHERE id = ?').get('g1')
    // The second call finds a live record and declines — which is what makes
    // a double drain safe (see the drain path in syncClient).
    expect(restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })).toEqual({ error: 'not-deleted' })
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(1)
    expect(db.prepare('SELECT * FROM groups WHERE id = ?').get('g1')).toEqual(after)
  })
})

// ---------------------------------------------------------------------------
// 3. Children
// ---------------------------------------------------------------------------

describe('children are reported, never restored implicitly', () => {
  beforeEach(() => {
    write('tiers', 't1', 'camp_id', 'camp1')
    write('tiers', 't1', 'name', 'Unit B')
    makeGroup('g1', { name: 'Aleph', tier_id: 't1' })
    makeGroup('g2', { name: 'Bet', tier_id: 't1' })
  })

  it('leaves deleted children deleted and names them in the result', () => {
    del('groups', 'g1')
    del('groups', 'g2')
    del('tiers', 't1')

    const result = restoreEntity(db, { entity: 'tiers', entity_id: 't1', ...session })

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(0)
    expect(result.deleted_children).toEqual(
      expect.arrayContaining([
        { entity: 'groups', entity_id: 'g1', name: 'Aleph' },
        { entity: 'groups', entity_id: 'g2', name: 'Bet' },
      ])
    )
    expect(result.deleted_children).toHaveLength(2)
  })

  it('does not report a child that is still live', () => {
    del('groups', 'g1')
    del('tiers', 't1')

    const result = restoreEntity(db, { entity: 'tiers', entity_id: 't1', ...session })

    expect(result.deleted_children.map((c) => c.entity_id)).toEqual(['g1'])
  })

  it('restores a child whose parent is still deleted, producing a tolerated orphan', () => {
    del('groups', 'g1')
    del('tiers', 't1')

    const result = restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT tier_id FROM groups WHERE id = ?').get('g1').tier_id).toBe('t1')
    expect(db.prepare('SELECT COUNT(*) c FROM tiers').get().c).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The trash list
// ---------------------------------------------------------------------------

describe('listDeleted', () => {
  it('shows the record by its last known name, with who deleted it and when', () => {
    makeGroup('g1', { name: 'Aleph' })
    write('groups', 'g1', 'name', 'Aleph Renamed')
    del('groups', 'g1')

    const rows = listDeleted(db)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entity: 'groups',
      entity_id: 'g1',
      name: 'Aleph Renamed',
      deleted_by_user_id: 'user1',
      deleted_by_name: 'Ruth',
      deleted_on_device_name: 'Lakeside iPad',
    })
    expect(typeof rows[0].deleted_at).toBe('string')
  })

  it('uses the label for a day, which has no name column', () => {
    write('days_of_operation', 'd1', 'camp_id', 'camp1')
    write('days_of_operation', 'd1', 'label', 'Monday')
    del('days_of_operation', 'd1')

    expect(listDeleted(db)[0].name).toBe('Monday')
  })

  it('excludes a record that was deleted and then restored', () => {
    makeGroup('g1')
    del('groups', 'g1')
    expect(listDeleted(db)).toHaveLength(1)

    restoreEntity(db, { entity: 'groups', entity_id: 'g1', ...session })

    expect(listDeleted(db)).toEqual([])
  })

  it('excludes entities that cannot be restored, so nothing is offered that would be refused', () => {
    write('users', 'user2', 'camp_id', 'camp1')
    write('users', 'user2', 'name', 'Removed Person')
    del('users', 'user2')

    expect(listDeleted(db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. History, and the read boundary on pin material
// ---------------------------------------------------------------------------

describe('getEntityHistory', () => {
  it('never returns pin material, for any caller', () => {
    write('users', 'user2', 'camp_id', 'camp1')
    write('users', 'user2', 'name', 'Sam')
    write('users', 'user2', 'pin_hash', 'secret-hash')
    write('users', 'user2', 'pin_salt', 'secret-salt')
    write('users', 'user2', 'pin_hash', 'second-secret-hash')

    const history = getEntityHistory(db, { entity: 'users', entity_id: 'user2' })
    const serialized = JSON.stringify(history)

    expect(serialized).not.toContain('secret-hash')
    expect(serialized).not.toContain('secret-salt')
    expect(serialized).not.toContain('second-secret-hash')
    // The change itself is still visible — only the value is withheld.
    const pinRows = history.filter((h) => h.field === 'pin_hash')
    expect(pinRows).toHaveLength(2)
    for (const row of pinRows) {
      expect('value' in row).toBe(false)
      expect('previous_value' in row).toBe(false)
      expect(row.author_name).toBe('Ruth')
    }
  })

  it('derives previous_value across three sequential writes to the same field', () => {
    makeGroup('g1', { name: 'One' })
    write('groups', 'g1', 'name', 'Two')
    write('groups', 'g1', 'name', 'Three')

    const names = getEntityHistory(db, { entity: 'groups', entity_id: 'g1' }).filter((h) => h.field === 'name')

    expect(names.map((h) => [h.previous_value, h.value])).toEqual([
      [null, 'One'],
      ['One', 'Two'],
      ['Two', 'Three'],
    ])
  })

  it('reads ascending by seq and names the author and the device', () => {
    makeGroup('g1')

    const history = getEntityHistory(db, { entity: 'groups', entity_id: 'g1' })

    expect(history.map((h) => h.seq)).toEqual([...history.map((h) => h.seq)].sort((a, b) => a - b))
    expect(history[0].author_name).toBe('Ruth')
    expect(history[0].device_name).toBe('Lakeside iPad')
  })

  it('includes the delete itself', () => {
    makeGroup('g1')
    del('groups', 'g1')

    const history = getEntityHistory(db, { entity: 'groups', entity_id: 'g1' })

    expect(history[history.length - 1].field).toBe('__deleted__')
  })
})
