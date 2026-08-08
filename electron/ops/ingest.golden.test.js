import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'

// GOLDEN-OPS characterization test (ADR 2026-08-08 §Completion-evidence §1).
//
// This pins the EXACT ordered sequence of ops commitIngest writes today, so the
// S0 refactor (buildPlan -> commitPlan) can be proven byte-identical: same ops,
// same fields, same order, same values. It was captured against the UNCHANGED
// commitIngest and must keep passing verbatim after the refactor.
//
// Nondeterministic fields are normalized: every UUID (op id, entity_id,
// client_write_id, and any UUID embedded in a value such as a resolved tier_id
// or a JSON group-id list) is replaced with a stable <uuid:N> token by order of
// first appearance — which preserves EVERY relationship (an entity's create ops
// all share one token; a fixed event's day_id points at the day's token) while
// erasing the raw random value. Timestamps collapse to <ts>. seq is dropped
// because array order already encodes it.

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-golden-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// The full ordered op sequence, canonicalized so it is deterministic run to run
// while keeping the camp_id UUID (which is stable per test) mapped too.
function canonicalOps() {
  const rows = db
    .prepare('SELECT id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id FROM operations ORDER BY seq ASC')
    .all()
  const uuidMap = new Map()
  const tok = (v) => {
    if (typeof v !== 'string') return v
    return v.replace(UUID_RE, (m) => {
      if (!uuidMap.has(m)) uuidMap.set(m, `<uuid:${uuidMap.size}>`)
      return uuidMap.get(m)
    })
  }
  return rows.map((r) => ({
    entity: r.entity,
    entity_id: tok(r.entity_id),
    field: r.field,
    value: tok(r.value),
    author_user_id: r.author_user_id,
    device_id: r.device_id,
    parent_op_id: tok(r.parent_op_id),
    // id/client_write_id are pure per-op randomness; keep them tokenized so a
    // stray leak (e.g. a client_write_id reused as a value) would still show.
    id: tok(r.id),
    client_write_id: tok(r.client_write_id),
    timestamp: '<ts>',
  }))
}

// One representative add-mode import that exercises every field-building arm:
// all six entity types, a bunk filed under its unit (link resolution), an
// activity with a full rule (min/max/priority + name->id group resolution +
// the min floor), and a per-day fixed-event fan-out.
const RICH = {
  approved: {
    cohorts: ['Main'],
    tiers: ['Aleph', 'Bet'],
    groups: ['Bunk 1', 'Bunk 2'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: ['09:00-09:40', 'Block 2'],
    activities: ['Swim', 'Archery'],
  },
  links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Bet' } },
  activityRules: {
    Swim: { eligible_group_names: ['Bunk 1', 'Bunk 2'], min_per_week: 2, max_per_week: 3, priority: 'high' },
    Archery: { eligible_group_names: ['Bunk 1'], min_per_week: 0, max_per_week: 1, priority: 'low' },
  },
  fixedEvents: [{
    name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday', 'Tuesday'],
    scope: { is_all_groups: false, groups: ['Bunk 1'] },
  }],
}

describe('GOLDEN-OPS — add mode writes exactly this op sequence', () => {
  it('is byte-identical to today (normalized)', () => {
    commitIngest(db, {
      ...RICH,
      camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add',
    })
    expect(canonicalOps()).toMatchSnapshot()
  })
})

describe('GOLDEN-OPS — replace mode writes exactly this op sequence', () => {
  it('is byte-identical to today (normalized), teardown then create', () => {
    // Seed a small prior schedule so replaceScope emits real teardown ops.
    const cohortId = 'co-seed'
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortId, campId, 'Main')
    const tierId = randomUUID()
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(tierId, campId, 'OldUnit', cohortId)
    const groupId = randomUUID()
    db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'OldBunk', tierId)
    const dayId = randomUUID()
    db.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, ?, ?)').run(dayId, campId, 'Monday', 1)
    const blockId = randomUUID()
    db.prepare('INSERT INTO time_blocks (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(blockId, campId, 'Old Block', cohortId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, 'OldSwim')

    commitIngest(db, {
      approved: {
        tiers: ['Aleph'],
        groups: ['Bunk 1'],
        days_of_operation: ['Monday'],
        time_blocks: ['09:00-09:40'],
        activities: ['Swim'],
      },
      links: { groups: { 'Bunk 1': 'Aleph' } },
      activityRules: { Swim: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'high' } },
      camp_id: campId, cohort_id: cohortId, author_user_id: 'u1', device_id: deviceId, mode: 'replace',
    })
    expect(canonicalOps()).toMatchSnapshot()
  })
})
