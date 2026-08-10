// C1b — fixed-event (anchor) slot-identity drift → read-only MOVED signal.
// docs/work/tickets/C1b-anchor-slot-drift-moved-signal.md
// docs/adr/2026-08-10-ingestion-reconciliation-semantics.md (Phase C, C1b)
//
// A director who moves a live anchor to a new day/time-block via AnchorsScreen
// (saveAnchor mutates day_id/time_block_id on the same entity_id) and then
// re-imports the ORIGINAL source file (still showing the old slot) used to get
// a silent duplicate anchor at the old slot (T72's recognize-then-skip only
// matches on EXACT slot identity, so a drifted live row is invisible to it).
//
// C1b adds a read-only set-cardinality pre-pass, computed per (cohort_id,
// normalizeName(name)) group after the live-anchor scan + teardown: when
// exactly one live slot in a group is unmatched by the file AND exactly one
// file slot in that group is unmatched by live rows, report the file slot as
// MOVED (outcome.fixedEvents.moved) and suppress its create. Any other
// cardinality falls through to existing create/skip/reject behavior untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { appendOp, DELETE_FIELD } from './operations.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-c1b-${Date.now()}-${Math.random()}.sqlite`)
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

const anchorCount = () => db.prepare('SELECT COUNT(*) c FROM anchor_activities WHERE camp_id = ?').get(campId).c
const anchorRows = () => db.prepare('SELECT * FROM anchor_activities WHERE camp_id = ?').all(campId)
const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })

// Human-authored move — mirrors AnchorsScreen.jsx's saveAnchor, which mutates
// day_id/time_block_id on the SAME entity_id (cohort_id never changes).
const moveAnchor = (anchorId, { day_id, time_block_id }) => {
  for (const [field, value] of Object.entries({ day_id, time_block_id })) {
    appendOp(db, {
      entity: 'anchor_activities',
      entity_id: anchorId,
      field,
      value,
      author_user_id: 'u1',
      device_id: deviceId,
      parent_op_id: null,
      client_write_id: randomUUID(),
      source: 'human',
    })
  }
}

const deleteAnchor = (anchorId) => {
  appendOp(db, {
    entity: 'anchor_activities',
    entity_id: anchorId,
    field: DELETE_FIELD,
    value: 1,
    author_user_id: 'u1',
    device_id: deviceId,
    parent_op_id: null,
    client_write_id: randomUUID(),
    source: 'human',
  })
}

const BASE = {
  approved: {
    groups: ['Bunk 1'],
    days_of_operation: ['Monday', 'Tuesday', 'Wednesday'],
    time_blocks: ['09:00-09:40', '10:00-10:40'],
    activities: ['Swim'],
  },
}
const MIFKAD_MON_9 = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: true, groups: [] },
}
const MIFKAD_MON_TUE_9 = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday', 'Tuesday'],
  scope: { is_all_groups: true, groups: [] },
}

describe('C1b — anchor slot-identity drift MOVED signal', () => {
  it('case 1: simple 1:1 move (time_block only) → MOVED, no duplicate create', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    expect(anchorCount()).toBe(1)
    const [anchor] = anchorRows()
    const monday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Monday').id
    const block2 = db.prepare("SELECT id FROM time_blocks WHERE camp_id = ? AND name = ?").get(campId, '10:00-10:40').id
    moveAnchor(anchor.id, { day_id: monday, time_block_id: block2 })

    const second = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.moved).toEqual([
      { name: 'Mifkad', reason: 'moved from Monday/09:00-09:40 to Monday/10:00-10:40' },
    ])
    expect(anchorCount()).toBe(1) // NO duplicate at the old slot
  })

  it('case 2: simple 1:1 move (day changed) → MOVED, no duplicate create', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    const [anchor] = anchorRows()
    const tue = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday').id
    moveAnchor(anchor.id, { day_id: tue, time_block_id: anchor.time_block_id })

    const second = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.moved).toEqual([
      { name: 'Mifkad', reason: 'moved from Monday/09:00-09:40 to Tuesday/09:00-09:40' },
    ])
    expect(anchorCount()).toBe(1)
  })

  it('case 3: two same-named events both unchanged → 0 moved, 0 created (T72 two-a-day regression guard)', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    expect(anchorCount()).toBe(2)

    const second = commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.unchanged).toBe(2)
    expect(second.fixedEvents.moved).toEqual([])
    expect(anchorCount()).toBe(2)
  })

  it('case 4: two same-named, one moved one unchanged → exactly 1 MOVED, other unchanged, 0 created', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    const rows = anchorRows()
    const monday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Monday').id
    const mondayAnchor = rows.find((r) => r.day_id === monday)
    const wednesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Wednesday').id
    moveAnchor(mondayAnchor.id, { day_id: wednesday, time_block_id: mondayAnchor.time_block_id })

    const second = commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.unchanged).toBe(1) // Tuesday untouched
    expect(second.fixedEvents.moved).toEqual([
      { name: 'Mifkad', reason: 'moved from Monday/09:00-09:40 to Wednesday/09:00-09:40' },
    ])
    expect(anchorCount()).toBe(2)
  })

  it('case 5: genuine second occurrence added, cardinality 0:1 → CREATE, never MOVED', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    expect(anchorCount()).toBe(1)

    // File now ALSO includes Tuesday — Monday recognized unchanged, Tuesday
    // has no live counterpart to pair with (liveUnmatched is empty), so it
    // must create, not be guessed as a move.
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    expect(second.fixedEvents.created).toBe(1)
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(second.fixedEvents.moved).toEqual([])
    expect(anchorCount()).toBe(2)
  })

  it('case 6: ambiguous N:M fan-out → NO guessed MOVED; unmatched file slots proceed to normal create', () => {
    // Live: Monday+Tuesday (both 09:00). File: Monday (unchanged) + Wednesday + a
    // second time block Tuesday@10:00 — 2 file-unmatched vs 1 live-unmatched.
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    expect(anchorCount()).toBe(2)
    const rows = anchorRows()
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday').id
    const tuesdayAnchor = rows.find((r) => r.day_id === tuesday)
    deleteAnchor(tuesdayAnchor.id) // remove via non-human path check: use human delete so it's a genuine live removal outside re-import scope
    // After delete, live = {Monday}. rejectedSlots would include Tuesday@09:00
    // (human DELETE_FIELD) — the file re-requests Monday, Wednesday, and Tuesday
    // at a different block, giving liveUnmatched=0 (Monday matches) and 3
    // file-unmatched entries (Wednesday, Tuesday@10:00 — Tuesday@09:00 is
    // rejected, not a create candidate).
    const messy = {
      name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday', 'Wednesday'],
      scope: { is_all_groups: true, groups: [] },
    }
    const messy2 = {
      name: 'Mifkad', time_block: '10:00-10:40', days: ['Tuesday'],
      scope: { is_all_groups: true, groups: [] },
    }
    const third = commit({ ...BASE, fixedEvents: [messy, messy2] })
    expect(third.fixedEvents.moved).toEqual([])
    expect(third.fixedEvents.created).toBe(2) // Wednesday@09:00 + Tuesday@10:00
    expect(third.fixedEvents.rejected).toEqual([]) // Tuesday@09:00 not re-requested this time
    expect(anchorCount()).toBe(3)
  })

  it('case 7: tombstone never reinterpreted as move source', () => {
    // Two unrelated live Mifkad rows: Monday and Tuesday.
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    const rows = anchorRows()
    const monday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Monday').id
    const mondayAnchor = rows.find((r) => r.day_id === monday)
    deleteAnchor(mondayAnchor.id) // director deliberately deletes Monday's Mifkad
    expect(anchorCount()).toBe(1) // only Tuesday live

    // Re-import the ORIGINAL file: Monday is a tombstoned slot (rejected), and
    // Tuesday is live-matched. liveUnmatched={} (Tuesday matches), fileUnmatched
    // would be {Monday} but Monday is a rejected tombstone — must NOT be
    // reinterpreted as a move source (there's no liveUnmatched to pair it with
    // anyway, but the ordering/exclusion must hold regardless).
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_MON_TUE_9] })
    expect(second.fixedEvents.moved).toEqual([])
    expect(second.fixedEvents.rejected).toEqual([{ name: 'Mifkad' }])
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })

  it('case 8: replace-mode inert — clean create at original slot, 0 moved', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    const [anchor] = anchorRows()
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday').id
    moveAnchor(anchor.id, { day_id: tuesday, time_block_id: anchor.time_block_id })

    // Replace mode tears down all anchors first (post-teardown liveSlots is
    // empty by construction), so the predicate is inert.
    const replaced = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9], mode: 'replace' })
    expect(replaced.fixedEvents.moved).toEqual([])
    expect(replaced.fixedEvents.created).toBe(1)
    expect(anchorCount()).toBe(1)
    expect(anchorRows()[0].day_id).not.toBe(tuesday) // recreated at the file's Monday slot
  })

  it('case 9: idempotency — running the same move-detection twice yields identical MOVED report, 0 created both runs', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    const [anchor] = anchorRows()
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday').id
    moveAnchor(anchor.id, { day_id: tuesday, time_block_id: anchor.time_block_id })

    const run1 = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    const run2 = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    expect(run1.fixedEvents.created).toBe(0)
    expect(run2.fixedEvents.created).toBe(0)
    expect(run1.fixedEvents.moved).toEqual(run2.fixedEvents.moved)
    expect(run1.fixedEvents.moved).toEqual([
      { name: 'Mifkad', reason: 'moved from Monday/09:00-09:40 to Tuesday/09:00-09:40' },
    ])
    expect(anchorCount()).toBe(1)
  })

  it('case 10: cohort-scoping — predicate must not pair across cohorts', () => {
    const cohortA = randomUUID()
    const cohortB = randomUUID()
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortA, campId, 'Cohort A')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortB, campId, 'Cohort B')

    const withCohort = (cohort_id, extra) => commitIngest(db, {
      camp_id: campId, cohort_id, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra,
    })

    // Cohort A: live anchor at Monday. Cohort B: live anchor at Tuesday. Both
    // same normalized name — must not be treated as a cross-cohort move.
    withCohort(cohortA, { ...BASE, fixedEvents: [MIFKAD_MON_9] })
    const tuesdayOnly = { name: 'Mifkad', time_block: '09:00-09:40', days: ['Tuesday'], scope: { is_all_groups: true, groups: [] } }
    withCohort(cohortB, { ...BASE, fixedEvents: [tuesdayOnly] })

    // Re-import cohort A's original file with a NEW day requested (Wednesday)
    // — must create there, not pretend cohort B's Tuesday row is cohort A's
    // move source.
    const wednesdayOnly = { name: 'Mifkad', time_block: '09:00-09:40', days: ['Wednesday'], scope: { is_all_groups: true, groups: [] } }
    const result = withCohort(cohortA, { ...BASE, fixedEvents: [MIFKAD_MON_9, wednesdayOnly] })
    expect(result.fixedEvents.moved).toEqual([])
    expect(result.fixedEvents.created).toBe(1) // Wednesday only
    expect(result.fixedEvents.unchanged).toBe(1) // Monday
  })

  it('case 11: group-scope changed alongside a valid 1:1 move → reason carries only day/time_block delta', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    const [anchor] = anchorRows()
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday').id
    moveAnchor(anchor.id, { day_id: tuesday, time_block_id: anchor.time_block_id })

    // Re-import with a DIFFERENT scope (single group instead of all-groups) at
    // the original Monday slot — group-scope is not part of slot identity
    // (ADR §1), so this is still the same move pairing, and the reason string
    // must not mention groups.
    const scopedMifkad = {
      name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
      scope: { is_all_groups: false, groups: ['Bunk 1'] },
    }
    const second = commit({ ...BASE, fixedEvents: [scopedMifkad] })
    expect(second.fixedEvents.moved).toEqual([
      { name: 'Mifkad', reason: 'moved from Monday/09:00-09:40 to Tuesday/09:00-09:40' },
    ])
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })
})
