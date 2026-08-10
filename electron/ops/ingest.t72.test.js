// T72 — fixed-event (anchor) re-import is idempotent.
// docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md
//
// The fixed-event loop in commitPlan used to mint a fresh anchor per resolved
// day UNCONDITIONALLY, duplicating anchor_activities on every re-import. T72
// makes it recognize-then-skip on slot identity
// (camp_id, cohort_id, day_id, time_block_id, normalizeName(name)).
//
// Evidence covered:
//   #1 same set re-imported → ZERO new anchor rows, ZERO anchor ops
//   #2 a genuinely-new fixed event (new slot key) still creates on re-import

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { restoreEntity } from './restore.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-t72-${Date.now()}-${Math.random()}.sqlite`)
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
const anchorOpCount = () => db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'anchor_activities'").get().c
const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })

const BASE = {
  approved: {
    groups: ['Bunk 1'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: ['09:00-09:40'],
    activities: ['Swim'],
  },
}
const MIFKAD = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday', 'Tuesday'],
  scope: { is_all_groups: true, groups: [] },
}

describe('T72 — fixed-event re-import idempotency', () => {
  it('re-importing the SAME set writes zero new anchor rows and zero anchor ops', () => {
    const first = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(first.fixedEvents.created).toBe(2) // per-day fan-out: Monday + Tuesday
    expect(first.fixedEvents.unchanged).toBe(0)
    expect(anchorCount()).toBe(2)
    const anchorsAfterFirst = anchorCount()
    const anchorOpsAfterFirst = anchorOpCount()

    const second = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.unchanged).toBe(2)
    expect(anchorCount()).toBe(anchorsAfterFirst) // no new rows
    expect(anchorOpCount()).toBe(anchorOpsAfterFirst) // no new anchor ops
  })

  it('a genuinely NEW fixed event (new slot key) still creates on re-import', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(anchorCount()).toBe(2)

    // Same Mifkad slot re-recognized (skip) + a new event in a new block.
    const withNew = commit({
      approved: { ...BASE.approved, time_blocks: ['09:00-09:40', 'Block 2'] },
      fixedEvents: [
        MIFKAD,
        { name: 'Nikayon', time_block: 'Block 2', days: ['Monday'], scope: { is_all_groups: true, groups: [] } },
      ],
    })
    expect(withNew.fixedEvents.created).toBe(1) // only Nikayon/Monday
    expect(withNew.fixedEvents.unchanged).toBe(2) // the two Mifkad rows
    expect(anchorCount()).toBe(3)
  })

  it('a director-deleted fixed event STAYS deleted across re-import (rejection tombstone)', () => {
    const first = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(first.fixedEvents.created).toBe(2)
    expect(anchorCount()).toBe(2)

    const [{ id: mondayAnchorId }] = db
      .prepare("SELECT id FROM anchor_activities WHERE camp_id = ? ORDER BY day_id LIMIT 1")
      .all(campId)
    appendOp(db, {
      entity: 'anchor_activities',
      entity_id: mondayAnchorId,
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'u1',
      device_id: deviceId,
      parent_op_id: null,
      client_write_id: randomUUID(),
      source: 'human',
    })
    expect(anchorCount()).toBe(1)

    const second = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.rejected).toEqual([{ name: 'Mifkad' }])
    expect(anchorCount()).toBe(1)

    const third = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(third.fixedEvents.created).toBe(0)
    expect(third.fixedEvents.rejected).toEqual([{ name: 'Mifkad' }])
    expect(anchorCount()).toBe(1)
  })

  it('a never-deleted fixed event still creates then goes unchanged (control)', () => {
    const first = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(first.fixedEvents.created).toBe(2)
    expect(first.fixedEvents.rejected).toEqual([])

    const second = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.unchanged).toBe(2)
    expect(second.fixedEvents.rejected).toEqual([])
  })

  it('replace-mode teardown does NOT tombstone the re-created anchor', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(anchorCount()).toBe(2)

    const replaced = commit({ ...BASE, fixedEvents: [MIFKAD], mode: 'replace' })
    expect(replaced.fixedEvents.created).toBe(2)
    expect(replaced.fixedEvents.rejected).toEqual([])
    expect(anchorCount()).toBe(2)
  })

  it('restoring a rejected anchor is an escape hatch: re-import sees it live, not rejected', () => {
    commit({ ...BASE, fixedEvents: [MIFKAD] })
    const [{ id: mondayAnchorId }] = db
      .prepare("SELECT id FROM anchor_activities WHERE camp_id = ? ORDER BY day_id LIMIT 1")
      .all(campId)
    appendOp(db, {
      entity: 'anchor_activities',
      entity_id: mondayAnchorId,
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'u1',
      device_id: deviceId,
      parent_op_id: null,
      client_write_id: randomUUID(),
      source: 'human',
    })
    expect(anchorCount()).toBe(1)

    const restored = restoreEntity(db, { entity: 'anchor_activities', entity_id: mondayAnchorId, author_user_id: 'u1', device_id: deviceId })
    expect(restored.ok).toBe(true)
    expect(anchorCount()).toBe(2)

    const reimported = commit({ ...BASE, fixedEvents: [MIFKAD] })
    expect(reimported.fixedEvents.created).toBe(0)
    expect(reimported.fixedEvents.rejected).toEqual([])
    expect(reimported.fixedEvents.unchanged).toBe(2)
    expect(anchorCount()).toBe(2)
  })
})
