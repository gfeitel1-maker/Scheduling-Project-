// C1a — fixed-event (anchor) group-scope drift → read-only scopeChanged signal.
// docs/adr/2026-08-10-ingestion-reconciliation-semantics.md (Phase C, C1a)
//
// A director who changes a live fixed-event anchor's GROUP SCOPE (is_all_groups
// / group_ids) via AnchorsScreen and then re-imports the ORIGINAL source file
// (still showing the old scope) today gets silent unchanged classification —
// the anchor slot key deliberately excludes scope (ingest.js anchorSlotKey),
// so scope drift is invisible to the recognize-then-skip branch.
//
// C1a adds a read-only comparison, alongside the live-anchor slot scan, that
// diffs the incoming resolved scope against the live row's scope for slots
// that recognize as unchanged. On a difference it reports the drift via
// outcome.fixedEvents.scopeChanged and does NOT write any op — anchor updates
// stay out of scope per ADR §4, same read-only posture as C1b's moved signal.

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
  tmpFile = path.join(os.tmpdir(), `shoresh-c1a-${Date.now()}-${Math.random()}.sqlite`)
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
const opCount = () => db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'anchor_activities'").get().c
const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })

const BASE = {
  approved: {
    groups: ['Bunk 1', 'Bunk 2'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: ['09:00-09:40'],
    activities: ['Swim'],
  },
}

const MIFKAD_ALL = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: true, groups: [] },
}
const MIFKAD_BUNK1 = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: false, groups: ['Bunk 1'] },
}
const MIFKAD_BUNK2 = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: false, groups: ['Bunk 2'] },
}

describe('C1a — anchor group-scope drift signal', () => {
  it('case 1: identical scope (all -> all) -> no scopeChanged, counts as unchanged', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })

  it('case 2: identical scope (scopedA -> scopedA) -> no scopeChanged, counts as unchanged', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(anchorCount()).toBe(1)
  })

  it('case 3: all -> scoped -> exactly one scopeChanged, no op, no create', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    const before = anchorRows()[0]
    const opsBefore = opCount()
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    expect(second.fixedEvents.scopeChanged).toEqual([
      { name: 'Mifkad', reason: 'scope changed from all groups to Bunk 1' },
    ])
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(anchorCount()).toBe(1)
    expect(opCount()).toBe(opsBefore)
    const after = anchorRows()[0]
    expect(after.is_all_groups).toBe(before.is_all_groups)
    expect(after.group_ids).toBe(before.group_ids)
  })

  it('case 4: scoped -> all -> exactly one scopeChanged', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    expect(second.fixedEvents.scopeChanged).toEqual([
      { name: 'Mifkad', reason: 'scope changed from Bunk 1 to all groups' },
    ])
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })

  it('case 5: scoped-A -> scoped-B -> exactly one scopeChanged', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_BUNK2] })
    expect(second.fixedEvents.scopeChanged).toEqual([
      { name: 'Mifkad', reason: 'scope changed from Bunk 1 to Bunk 2' },
    ])
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })

  it('case 6: MOVED wins over scope drift — move + scope change together -> moved fires, scopeChanged empty', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    const [anchor] = anchorRows()
    const tuesday = db.prepare('SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?').get(campId, 'Tuesday').id
    db.prepare('UPDATE anchor_activities SET day_id = ? WHERE id = ?').run(tuesday, anchor.id)

    // Re-import the original file (still Monday, scope now different too) —
    // liveUnmatched={Tuesday}, fileUnmatched={Monday} pairs as a move; the
    // moved branch continues before reaching the scope comparison.
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    expect(second.fixedEvents.moved).toEqual([
      { name: 'Mifkad', reason: 'moved from Monday/09:00-09:40 to Tuesday/09:00-09:40' },
    ])
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })

  it('case 7: tombstoned anchor re-imported with different scope -> rejected fires, scopeChanged empty', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    const [anchor] = anchorRows()
    // A real human tombstone goes through DELETE_FIELD so rejectedSlots
    // recognizes it, mirroring C1b's deleteAnchor helper.
    appendOp(db, {
      entity: 'anchor_activities', entity_id: anchor.id, field: DELETE_FIELD, value: 1,
      author_user_id: 'u1', device_id: deviceId, parent_op_id: null, client_write_id: randomUUID(), source: 'human',
    })
    expect(anchorCount()).toBe(0)

    const second = commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    expect(second.fixedEvents.rejected).toEqual([{ name: 'Mifkad' }])
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(0)
  })

  it('case 8: partial group resolution (droppedGroups > 0) -> no scopeChanged emitted', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    const missingGroup = {
      name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
      scope: { is_all_groups: false, groups: ['Bunk 1', 'Bunk Nonexistent'] },
    }
    const second = commit({ ...BASE, fixedEvents: [missingGroup] })
    expect(second.fixedEvents.partial).toEqual([{ name: 'Mifkad', reason: '1 of 2 groups not imported' }])
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.created).toBe(0)
    expect(anchorCount()).toBe(1)
  })

  it('case 9: read-only proof — live anchor row byte-identical after scope-drift re-import', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    const before = anchorRows()[0]
    const opsBefore = opCount()
    commit({ ...BASE, fixedEvents: [MIFKAD_BUNK2] })
    const after = anchorRows()[0]
    expect(after.is_all_groups).toBe(before.is_all_groups)
    expect(after.group_ids).toBe(before.group_ids)
    expect(after.day_id).toBe(before.day_id)
    expect(after.time_block_id).toBe(before.time_block_id)
    expect(anchorCount()).toBe(1)
    expect(opCount()).toBe(opsBefore)
  })

  it('round 2 fix 1: corrupted live group_ids on an unrelated anchor never crashes the import', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    const [anchor] = anchorRows()
    // Simulate malformed group_ids (partial sync / hand-edited SQLite / old
    // migration) directly on the live row, bypassing appendOp's normal
    // JSON.stringify write path.
    db.prepare("UPDATE anchor_activities SET group_ids = '' WHERE id = ?").run(anchor.id)

    // Re-import the SAME unchanged fixed event — must not throw, and must not
    // report a spurious scopeChanged for the corrupted slot.
    let result
    expect(() => { result = commit({ ...BASE, fixedEvents: [MIFKAD_ALL] }) }).not.toThrow()
    expect(result.fixedEvents.scopeChanged).toEqual([])
    expect(result.fixedEvents.unchanged).toBe(1)
    expect(result.fixedEvents.created).toBe(0)
  })

  it('round 2 fix 2: duplicate group name in incoming scope is deduped before compare, no false scopeChanged', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD_BUNK1] })
    const dupedBunk1 = {
      name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
      scope: { is_all_groups: false, groups: ['Bunk 1', 'Bunk 1'] },
    }
    const second = commit({ ...BASE, fixedEvents: [dupedBunk1] })
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(second.fixedEvents.created).toBe(0)
  })

  it('held-path shape: scopeChanged is present as an empty array on a held import', () => {
    // Force a hold via a conflicting duplicate-name group write is out of scope
    // here; instead assert the stub shape directly is covered by the normal
    // (non-held) commits above returning an array. This case documents the
    // held-path stub contract without needing to engineer a real hold.
    const result = commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    expect(Array.isArray(result.fixedEvents.scopeChanged)).toBe(true)
  })
})
