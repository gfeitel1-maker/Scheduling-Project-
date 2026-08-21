// @vitest-environment node
//
// T108 Phase 2 review round 3 (Red Hat, HIGH — re-authoring an existing
// override silently no-ops). day_overrides has UNIQUE(schedule_week_id,
// day_id, group_id, time_block_id); applyProjection's day_overrides
// ensureExists does INSERT OR IGNORE keyed by id, then UPDATE ... WHERE id=?
// (projections.js:806-811). Against the REAL schema (not the mock repo the
// original round-2 useSlotMutations.test.js used), writing a SECOND override
// to the same (week, day, group, block) coordinate with a FRESH id:
//   - INSERT OR IGNORE -> 0 rows (UNIQUE collision on the tuple)
//   - UPDATE WHERE id = <fresh id> -> 0 rows (no row has that id)
// The write silently never persists — the mock repo in useSlotMutations.test.js
// has no UNIQUE constraint at all, so it could never have caught this; that
// gap is exactly why this is a real-schema (SQLite, appendOp -> applyProjection)
// test, mirroring electron/ops/electives.projections.test.js's pattern.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-dayoverrides-projections-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', 'camp-1', 'Bunk 1')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-art', 'camp-1', 'Art')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-boat', 'camp-1', 'Boating')
  db.prepare('INSERT INTO schedule_weeks (id, camp_id, name) VALUES (?, ?, ?)').run('week-1', 'camp-1', 'Week 1')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-1', 'camp-1', 'Monday')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function writeOverrideOps(db, id, fields) {
  for (const [field, value] of Object.entries(fields)) {
    appendOp(db, { entity: 'day_overrides', entity_id: id, field, value, author_user_id: 'user-1', device_id: 'device-1' })
  }
}

const COORD = { schedule_week_id: 'week-1', day_id: 'day-1', group_id: 'grp-1', time_block_id: 'block-1' }

describe('day_overrides projection — re-authoring an existing override (real schema)', () => {
  it('BUG REPRODUCTION: a second write with a FRESH id for the SAME coordinate silently loses the update', () => {
    // First override: swap to Art.
    writeOverrideOps(db, 'ovr-A', { ...COORD, activity_id: 'act-art', kind: 'swap' })
    let rows = db.prepare('SELECT * FROM day_overrides WHERE schedule_week_id = ? AND day_id = ? AND group_id = ? AND time_block_id = ?')
      .all(COORD.schedule_week_id, COORD.day_id, COORD.group_id, COORD.time_block_id)
    expect(rows).toHaveLength(1)
    expect(rows[0].activity_id).toBe('act-art')

    // Re-authoring, exactly as the UNFIXED useSlotMutations.js did: mint a
    // fresh crypto.randomUUID() for the "new" override, same coordinate.
    writeOverrideOps(db, 'ovr-B-fresh-id', { ...COORD, activity_id: 'act-boat', kind: 'swap' })

    rows = db.prepare('SELECT * FROM day_overrides WHERE schedule_week_id = ? AND day_id = ? AND group_id = ? AND time_block_id = ?')
      .all(COORD.schedule_week_id, COORD.day_id, COORD.group_id, COORD.time_block_id)
    // The bug: still exactly one row, still the FIRST override's content —
    // the director's re-edit to Boating vanished with no error anywhere.
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('ovr-A')
    expect(rows[0].activity_id).toBe('act-art') // NOT 'act-boat' — the edit was lost
    // The fresh id itself was never persisted at all.
    expect(db.prepare('SELECT * FROM day_overrides WHERE id = ?').get('ovr-B-fresh-id')).toBeUndefined()
  })

  it('THE FIX: reusing the EXISTING row id for a re-edit of the same coordinate correctly updates in place', () => {
    writeOverrideOps(db, 'ovr-A', { ...COORD, activity_id: 'act-art', kind: 'swap' })

    // Re-authoring the fixed way: look up the existing row's id for this
    // coordinate first (what the app-layer fix now does), reuse it.
    writeOverrideOps(db, 'ovr-A', { activity_id: 'act-boat' })

    const rows = db.prepare('SELECT * FROM day_overrides WHERE schedule_week_id = ? AND day_id = ? AND group_id = ? AND time_block_id = ?')
      .all(COORD.schedule_week_id, COORD.day_id, COORD.group_id, COORD.time_block_id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('ovr-A')
    expect(rows[0].activity_id).toBe('act-boat') // the SECOND override's content, correctly persisted
  })

  it('a PULL re-authored as a SWAP on the same coordinate (id reused) ends up as the swap, not the pull', () => {
    writeOverrideOps(db, 'ovr-A', { ...COORD, activity_id: null, kind: 'pull' })
    let row = db.prepare('SELECT * FROM day_overrides WHERE id = ?').get('ovr-A')
    expect(row.kind).toBe('pull')
    expect(row.activity_id).toBeNull()

    writeOverrideOps(db, 'ovr-A', { activity_id: 'act-art', kind: 'swap' })
    row = db.prepare('SELECT * FROM day_overrides WHERE id = ?').get('ovr-A')
    expect(row.kind).toBe('swap')
    expect(row.activity_id).toBe('act-art')

    const rows = db.prepare('SELECT * FROM day_overrides WHERE schedule_week_id = ? AND day_id = ? AND group_id = ? AND time_block_id = ?')
      .all(COORD.schedule_week_id, COORD.day_id, COORD.group_id, COORD.time_block_id)
    expect(rows).toHaveLength(1)
  })
})
