// @vitest-environment node
//
// Deleting a group must not leave recurring/fixed events that target nobody.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { previewDelete, deleteRecord } from './deleteRecord.js'
import { restoreEntity } from './restore.js'

afterAll(() => {
  cleanupTemplatedDbs()
})

const files = []
let db
const session = { author_user_id: 'user1', device_id: 'device1' }

beforeEach(() => {
  const t = openTemplatedDb()
  files.push(t.file)
  db = t.db
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user1', 'camp1', 'Ruth', 'hash', 'salt', 'admin')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device1', 'iPad')
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})

const write = (entity, id, field, value) => appendOp(db, { entity, entity_id: id, field, value, ...session })

function group(id, name) {
  write('groups', id, 'camp_id', 'camp1')
  write('groups', id, 'name', name)
}

function event(id, { kind = 'recurring', all = 0, groupIds = null } = {}) {
  write('fixed_events', id, 'camp_id', 'camp1')
  write('fixed_events', id, 'name', id)
  write('fixed_events', id, 'kind', kind)
  write('fixed_events', id, 'is_all_groups', all)
  if (groupIds) write('fixed_events', id, 'group_ids', JSON.stringify(groupIds))
}

const live = (id) => db.prepare('SELECT * FROM fixed_events WHERE id = ?').get(id)
const multiIds = () => JSON.parse(live('multi').group_ids)

function seed() {
  group('b2', 'Badger 2')
  group('b3', 'Badger 3')
  event('music', { groupIds: ['b2'] })
  event('sports', { groupIds: ['b2'] })
  event('multi', { groupIds: ['b2', 'b3'] })
  event('everyone', { all: 1 })
  event('other', { groupIds: ['b3'] })
}

// Setup edits happened earlier in real life; the delete's own ops are what restore must find.
const del = () => {
  db.prepare("UPDATE operations SET timestamp = '2020-01-01T00:00:00.000Z'").run()
  return deleteRecord(db, { entity: 'groups', entity_id: 'b2', ...session })
}

describe('deleting a group and the events that target only it', () => {
  it('the preview counts the sole-target events by kind', () => {
    seed()
    const p = previewDelete(db, { entity: 'groups', entity_id: 'b2' })
    expect(p.fixed_event_count).toBe(2)
    expect(p.fixed_event_kind_counts).toEqual({ fixed: 0, recurring: 2 })
  })

  it('trashes both sole-target events', () => {
    seed()
    expect(del().ok).toBe(true)
    expect(live('music')).toBeUndefined()
    expect(live('sports')).toBeUndefined()
    expect(live('other')).toBeTruthy()
  })

  it('a multi-group event loses only that group', () => {
    seed()
    del()
    expect(multiIds()).toEqual(['b3'])
  })

  it('an every-group event is left alone', () => {
    seed()
    del()
    expect(live('everyone').is_all_groups).toBe(1)
  })

  it('leaves no event targeting zero groups', () => {
    seed()
    del()
    const orphans = db.prepare('SELECT * FROM fixed_events').all().filter((e) => {
      if (e.is_all_groups) return false
      const g = e.group_ids ? JSON.parse(e.group_ids) : []
      const u = e.unit_ids ? JSON.parse(e.unit_ids) : []
      return g.length === 0 && u.length === 0 && !e.unit_id
    })
    expect(orphans).toEqual([])
  })

  it('a division-scoped event is untouched', () => {
    seed()
    write('fixed_events', 'div', 'camp_id', 'camp1')
    write('fixed_events', 'div', 'kind', 'recurring')
    write('fixed_events', 'div', 'is_all_groups', 0)
    write('fixed_events', 'div', 'unit_ids', JSON.stringify(['tier1']))
    del()
    expect(live('div')).toBeTruthy()
  })
})

describe('restoring the group', () => {
  it('brings back its sole-target events and re-adds it to the multi-group event', () => {
    seed()
    del()
    const r = restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(r.ok).toBe(true)
    expect(live('music')).toBeTruthy()
    expect(live('sports')).toBeTruthy()
    expect(multiIds()).toEqual(['b2', 'b3'])
    expect(r.group_events).toEqual({ restored: 2, readded: 1, not_readded: 0, gone: 0, failed: 0 })
  })

  it('does not resurrect an event deleted deliberately before the group', () => {
    seed()
    write('fixed_events', 'music', DELETE_FIELD, 1)
    del()
    restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(live('music')).toBeUndefined()
    expect(live('sports')).toBeTruthy()
  })

  it('reports honestly when the multi-group event was edited since', () => {
    seed()
    del()
    write('fixed_events', 'multi', 'group_ids', JSON.stringify(['b3', 'b9']))
    const r = restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(multiIds()).toEqual(['b3', 'b9'])
    expect(r.group_events.not_readded).toBe(1)
  })

  it('a hand-deleted event is not brought back by a later group delete with no events of its own', () => {
    group('b2', 'Badger 2')
    event('music', { groupIds: ['b2'] })
    write('fixed_events', 'music', DELETE_FIELD, 1)
    deleteRecord(db, { entity: 'groups', entity_id: 'b2', ...session })
    const r = restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(live('music')).toBeUndefined()
    expect(r.group_events.restored).toBe(0)
  })

  it('counts and reports an event that fails to restore, and still restores the rest', () => {
    seed()
    del()
    db.prepare("DELETE FROM operations WHERE entity_id = 'sports' AND field = 'camp_id'").run()
    const r = restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(r.group_events.failed).toBe(1)
    expect(r.group_events.restored).toBe(1)
    expect(live('music')).toBeTruthy()
  })

  it('says the event row is gone, not that it changed', () => {
    seed()
    del()
    write('fixed_events', 'multi', DELETE_FIELD, 1)
    const r = restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(r.group_events.gone).toBe(1)
    expect(r.group_events.not_readded).toBe(0)
  })
})

describe('restoring a cascaded event on its own', () => {
  it('is refused while its only group is still deleted, naming the group', () => {
    seed()
    del()
    const r = restoreEntity(db, { entity: 'fixed_events', entity_id: 'music', ...session })
    expect(r.error).toBe('group-deleted')
    expect(r.group_name).toBe('Badger 2')
    expect(live('music')).toBeUndefined()
  })
})

const setTier = (id, tier) => write('groups', id, 'tier_id', tier)

function divisionEvent(id, unitIds, kind = 'recurring') {
  write('fixed_events', id, 'camp_id', 'camp1')
  write('fixed_events', id, 'name', id)
  write('fixed_events', id, 'kind', kind)
  write('fixed_events', id, 'is_all_groups', 0)
  write('fixed_events', id, 'unit_ids', JSON.stringify(unitIds))
}

describe('a division-scoped event when its division loses a group', () => {
  it('is trashed with the division\'s last group and restored with it', () => {
    group('b2', 'Badger 2')
    setTier('b2', 'tier1')
    divisionEvent('div', ['tier1'])
    const p = previewDelete(db, { entity: 'groups', entity_id: 'b2' })
    expect(p.fixed_event_count).toBe(1)
    del()
    expect(live('div')).toBeUndefined()
    const r = restoreEntity(db, { entity: 'groups', entity_id: 'b2', ...session })
    expect(r.ok).toBe(true)
    expect(live('div')).toBeTruthy()
    expect(JSON.parse(live('div').unit_ids)).toEqual(['tier1'])
    expect(r.group_events.restored).toBe(1)
  })

  it('restoring it on its own is refused while its division has no live group', () => {
    group('b2', 'Badger 2')
    setTier('b2', 'tier1')
    divisionEvent('div', ['tier1'])
    del()
    const r = restoreEntity(db, { entity: 'fixed_events', entity_id: 'div', ...session })
    expect(r.error).toBe('group-deleted')
    expect(r.group_name).toBe('Badger 2')
    expect(live('div')).toBeUndefined()
  })

  it('is untouched while the division still has another group', () => {
    group('b2', 'Badger 2')
    group('b3', 'Badger 3')
    setTier('b2', 'tier1')
    setTier('b3', 'tier1')
    divisionEvent('div', ['tier1'])
    const before = live('div')
    del()
    expect(live('div')).toEqual(before)
  })

  it('is untouched when another of its divisions still has groups', () => {
    group('b2', 'Badger 2')
    group('c1', 'Cub 1')
    setTier('b2', 'tier1')
    setTier('c1', 'tier2')
    divisionEvent('div', ['tier1', 'tier2'])
    del()
    expect(live('div')).toBeTruthy()
  })
})

describe('the delete preview and the delete agree', () => {
  const snapshot = () => new Map(db.prepare('SELECT id, group_ids FROM fixed_events').all().map((r) => [r.id, r.group_ids]))

  const fixtures = {
    'sole-group event': () => { group('b2', 'B2'); event('e', { groupIds: ['b2'] }) },
    'multi-group event': () => { group('b2', 'B2'); group('b3', 'B3'); event('e', { groupIds: ['b2', 'b3'] }) },
    'all-groups event': () => { group('b2', 'B2'); event('e', { all: 1 }) },
    'division event losing its last group': () => { group('b2', 'B2'); setTier('b2', 't1'); divisionEvent('e', ['t1']) },
    'division event with groups remaining': () => {
      group('b2', 'B2'); group('b3', 'B3'); setTier('b2', 't1'); setTier('b3', 't1'); divisionEvent('e', ['t1'])
    },
    'all of the above at once': () => {
      group('b2', 'B2'); group('b3', 'B3'); group('c1', 'C1')
      setTier('b2', 't1'); setTier('b3', 't2'); setTier('c1', 't2')
      event('sole', { groupIds: ['b2'] }); event('multi', { groupIds: ['b2', 'b3'] }); event('all', { all: 1 })
      divisionEvent('divLast', ['t1']); divisionEvent('divRemain', ['t2'])
    },
  }

  for (const [label, build] of Object.entries(fixtures)) {
    it(`counts exactly what is trashed and modified: ${label}`, () => {
      build()
      const p = previewDelete(db, { entity: 'groups', entity_id: 'b2' })
      const before = snapshot()
      const kindOf = new Map(db.prepare('SELECT id, kind FROM fixed_events').all().map((r) => [r.id, r.kind]))
      del()
      const after = snapshot()
      const trashed = [...before.keys()].filter((id) => !after.has(id))
      const modified = [...before.keys()].filter((id) => after.has(id) && after.get(id) !== before.get(id))
      expect(p.fixed_event_count).toBe(trashed.length)
      expect(p.fixed_event_trimmed_count).toBe(modified.length)
      const kinds = { fixed: 0, recurring: 0 }
      for (const id of trashed) kinds[kindOf.get(id) === 'recurring' ? 'recurring' : 'fixed'] += 1
      expect(p.fixed_event_kind_counts).toEqual(kinds)
    })
  }
})
