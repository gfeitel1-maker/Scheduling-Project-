// @vitest-environment node
//
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md (M3c)
//
// The seams the ADR names as load-bearing:
//   D1: the merge transaction — re-points every activity + exclusion from
//       loser to winner, sets the winner's capacity, deletes the loser, all
//       in ONE transaction; a failure mid-way leaves neither half applied.
//   D2: `locations` in CLEARABLE_ENTITIES — a plain delete nulls
//       activities.location_id (never a stray winner reference).
//   D4: restore-after-merge — restoring the loser from Trash comes back
//       EMPTY (not re-bound to the activities it used to have), and does not
//       collide with the winner because near-duplicate names always differ.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { previewDelete, deleteRecord, mergeLocation, CLEARABLE_ENTITIES } from './deleteRecord.js'
import { restoreEntity } from './restore.js'

const files = []
let db

const session = { author_user_id: 'user1', device_id: 'device1' }

beforeEach(() => {
  const file = path.join(os.tmpdir(), `shoresh-locmerge-${Date.now()}-${Math.random()}.sqlite`)
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

function seedLocation(id, name, capacity) {
  write('locations', id, 'camp_id', 'camp1')
  write('locations', id, 'name', name)
  write('locations', id, 'capacity', capacity)
  return id
}

function seedActivity(id, name, location_id, maxGroups = 1) {
  write('activities', id, 'camp_id', 'camp1')
  write('activities', id, 'name', name)
  if (location_id) write('activities', id, 'location_id', location_id)
  write('activities', id, 'max_groups_per_slot', maxGroups)
  return id
}

function locationIdOf(activityId) {
  return db.prepare('SELECT location_id FROM activities WHERE id = ?').get(activityId).location_id
}

// ---------------------------------------------------------------------------
// D2 — locations joins CLEARABLE_ENTITIES; previewDelete's shape
// ---------------------------------------------------------------------------

describe('previewDelete for locations (D2/D5 — bound-activity count + rows, never routes/slot_count)', () => {
  it('reports ref_count and the bound activity rows, nothing schedule-shaped', () => {
    seedLocation('loc-pool', 'Pool', 3)
    seedActivity('a1', 'Swim Lessons', 'loc-pool', 1)
    seedActivity('a2', 'Free Swim', 'loc-pool', 3)

    const preview = previewDelete(db, { entity: 'locations', entity_id: 'loc-pool' })
    expect(preview.ok).toBe(true)
    expect(preview.name).toBe('Pool')
    expect(preview.ref_count).toBe(2)
    expect(preview.activities.map((a) => a.id).sort()).toEqual(['a1', 'a2'])
    expect(preview).not.toHaveProperty('slot_count')
    expect(preview).not.toHaveProperty('routes')
  })

  it('a place nothing uses previews at zero', () => {
    seedLocation('loc-gym', 'Gym', 1)
    const preview = previewDelete(db, { entity: 'locations', entity_id: 'loc-gym' })
    expect(preview.ref_count).toBe(0)
    expect(preview.activities).toEqual([])
  })

  it('refuses a location that is not there', () => {
    expect(previewDelete(db, { entity: 'locations', entity_id: 'nope' }).error).toBe('no-record')
  })
})

describe('plain delete of a location (D2) — nulls activities.location_id, never a stray winner ref', () => {
  it('clears every bound activity to null and deletes exclusion rows outright', () => {
    seedLocation('loc-pool', 'Pool', 3)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')
    seedActivity('a2', 'Free Swim', 'loc-pool')
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run('week1', 'camp1', 'Week 1', 0)
    db.prepare('INSERT INTO week_location_exclusions (id, week_id, location_id) VALUES (?, ?, ?)')
      .run('excl1', 'week1', 'loc-pool')

    const result = deleteRecord(db, { entity: 'locations', entity_id: 'loc-pool', expected_slot_count: 2, ...session })
    expect(result.ok).toBe(true)
    expect(result.cleared).toBe(2)
    expect(result.reassigned_activity_ids).toEqual([])

    expect(locationIdOf('a1')).toBeNull()
    expect(locationIdOf('a2')).toBeNull()
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeFalsy()
    expect(db.prepare('SELECT 1 FROM week_location_exclusions WHERE id = ?').get('excl1')).toBeFalsy()
  })

  it('aborts when the ref count drifted since the director was shown it', () => {
    seedLocation('loc-pool', 'Pool', 3)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')
    seedActivity('a2', 'Free Swim', 'loc-pool')

    const result = deleteRecord(db, { entity: 'locations', entity_id: 'loc-pool', expected_slot_count: 1, ...session })
    expect(result.error).toBe('count-changed')
    expect(result.ref_count).toBe(2)
    expect(locationIdOf('a1')).toBe('loc-pool')
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// D1 — the merge transaction
// ---------------------------------------------------------------------------

describe('mergeLocation (D1) — re-points activities + exclusions to the winner, deletes the loser, atomically', () => {
  it('re-points every bound activity, sets the winner capacity, and deletes the loser in one transaction', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    seedActivity('a1', 'Swim Lessons', 'loc-pool', 1)
    seedActivity('a2', 'Free Swim', 'loc-pool', 3)

    const result = mergeLocation(db, {
      loser_id: 'loc-pool',
      winner_id: 'loc-Pool',
      winner_capacity: 3,
      expected_ref_count: 2,
      ...session,
    })

    expect(result.ok).toBe(true)
    expect(result.cleared).toBe(2)
    expect(result.reassigned_activity_ids.sort()).toEqual(['a1', 'a2'])

    expect(locationIdOf('a1')).toBe('loc-Pool')
    expect(locationIdOf('a2')).toBe('loc-Pool')
    expect(db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity).toBe(3)
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeFalsy()
  })

  it('re-points week_location_exclusions to the winner rather than deleting them', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run('week1', 'camp1', 'Week 1', 0)
    db.prepare('INSERT INTO week_location_exclusions (id, week_id, location_id) VALUES (?, ?, ?)')
      .run('excl1', 'week1', 'loc-pool')

    const result = mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-Pool', expected_ref_count: 0, ...session })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT location_id FROM week_location_exclusions WHERE id = ?').get('excl1').location_id).toBe(
      'loc-Pool'
    )
  })

  it('the loser delete is the LAST op, carrying the highest seq', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')

    const result = mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-Pool', expected_ref_count: 1, ...session })
    const last = result.ops[result.ops.length - 1]
    expect(last.entity).toBe('locations')
    expect(last.entity_id).toBe('loc-pool')
    expect(last.field).toBe(DELETE_FIELD)
    const maxSeq = Math.max(...result.ops.map((o) => o.seq))
    expect(last.seq).toBe(maxSeq)
  })

  it('aborts on a ref-count drift, leaving neither the activities nor the loser touched', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')
    seedActivity('a2', 'Free Swim', 'loc-pool')

    const result = mergeLocation(db, {
      loser_id: 'loc-pool',
      winner_id: 'loc-Pool',
      expected_ref_count: 1, // a peer bound a2 to loc-pool after the director's preview
      ...session,
    })
    expect(result.error).toBe('count-changed')
    expect(locationIdOf('a1')).toBe('loc-pool')
    expect(locationIdOf('a2')).toBe('loc-pool')
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeTruthy()
  })

  it('refuses a winner that does not exist, touching nothing', () => {
    seedLocation('loc-pool', 'pool', 1)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')

    const result = mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'no-such-place', ...session })
    expect(result.error).toBe('no-winner')
    expect(locationIdOf('a1')).toBe('loc-pool')
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeTruthy()
  })

  it('refuses merging a location into itself', () => {
    seedLocation('loc-pool', 'pool', 1)
    const result = mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-pool', ...session })
    expect(result.error).toBe('invalid-winner')
  })

  // Security finding: the UI's CapacityStepper floors at 1, but that is a
  // renderer-side courtesy, not a guarantee — the WS/IPC sink accepted
  // winner_capacity <= 0 unclamped, corrupting M2's occupancy math on every
  // device it replicates to. The migration's own backfill floors with
  // Math.max(1, ...) (localDb.js); the merge sink must mirror that at the
  // trust boundary.
  it('floors winner_capacity at 1 rather than writing 0 or a negative number', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)

    const zeroResult = mergeLocation(db, {
      loser_id: 'loc-pool',
      winner_id: 'loc-Pool',
      winner_capacity: 0,
      ...session,
    })
    expect(zeroResult.ok).toBe(true)
    expect(db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity).toBe(1)
  })

  it('floors a negative winner_capacity at 1', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)

    const negativeResult = mergeLocation(db, {
      loser_id: 'loc-pool',
      winner_id: 'loc-Pool',
      winner_capacity: -5,
      ...session,
    })
    expect(negativeResult.ok).toBe(true)
    expect(db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity).toBe(1)
  })

  it('leaves the winner capacity untouched when winner_capacity is not supplied (null/undefined semantic preserved)', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)

    const result = mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-Pool', ...session })
    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity).toBe(3)
  })

  it('a failure partway through the transaction leaves NEITHER half applied', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')
    seedActivity('a2', 'Free Swim', 'loc-pool')

    const realPrepare = db.prepare.bind(db)
    // The loser DELETE is the last statement in the transaction — forcing it
    // to throw proves everything written before it (both re-points) rolls
    // back too, not just the statement that failed.
    db.prepare = (sql) => {
      if (sql === 'DELETE FROM locations WHERE id = ?') {
        return { run: () => { throw new Error('disk full') } }
      }
      return realPrepare(sql)
    }

    let threw = false
    try {
      mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-Pool', expected_ref_count: 2, ...session })
    } catch {
      threw = true
    } finally {
      db.prepare = realPrepare
    }

    expect(threw).toBe(true)
    // Neither re-point committed — both activities are exactly where they started.
    expect(locationIdOf('a1')).toBe('loc-pool')
    expect(locationIdOf('a2')).toBe('loc-pool')
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeTruthy()
    // The winner's own capacity (seeded at 3, no winner_capacity passed to
    // this call) is untouched by the aborted attempt.
    expect(db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// D4 — restore-after-merge, the load-bearing correctness argument
// ---------------------------------------------------------------------------

describe('restore-after-merge (D4) — the restored loser comes back empty, no collision with the winner', () => {
  it('restoring the loser does not re-bind the activities that were re-pointed to the winner', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    seedActivity('a1', 'Swim Lessons', 'loc-pool')
    seedActivity('a2', 'Free Swim', 'loc-pool')

    mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-Pool', winner_capacity: 3, expected_ref_count: 2, ...session })
    expect(locationIdOf('a1')).toBe('loc-Pool')
    expect(locationIdOf('a2')).toBe('loc-Pool')

    const restored = restoreEntity(db, { entity: 'locations', entity_id: 'loc-pool', ...session })
    expect(restored.ok).toBe(true)

    // The place exists again...
    const row = db.prepare('SELECT name FROM locations WHERE id = ?').get('loc-pool')
    expect(row.name).toBe('pool')
    // ...but empty: restore re-emits only the loser's OWN fields, never
    // touches activities.location_id. The activities stay on the winner.
    expect(locationIdOf('a1')).toBe('loc-Pool')
    expect(locationIdOf('a2')).toBe('loc-Pool')
  })

  it('does not collide with the winner — case-different names never trigger #68’s unique-field guard', () => {
    seedLocation('loc-Pool', 'Pool', 3)
    seedLocation('loc-pool', 'pool', 1)
    mergeLocation(db, { loser_id: 'loc-pool', winner_id: 'loc-Pool', expected_ref_count: 0, ...session })

    const restored = restoreEntity(db, { entity: 'locations', entity_id: 'loc-pool', ...session })
    expect(restored.ok).toBe(true)
    expect(restored.error).toBeUndefined()
    // Both rows coexist afterward — merge did not destroy the winner, and
    // restore did not refuse on a name collision (they differ by case).
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-Pool')).toBeTruthy()
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')).toBeTruthy()
  })
})

describe('CLEARABLE_ENTITIES includes locations (D2)', () => {
  it('locations is clearable', () => {
    expect(CLEARABLE_ENTITIES.has('locations')).toBe(true)
  })
})
