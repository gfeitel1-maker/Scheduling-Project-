// T73 — resolution-aware re-commit of a HELD import.
// docs/adr/2026-08-08-t73-held-import-resolution-recommit.md
//
// A held import wrote nothing; the director resolves each conflict and re-submits
// the ORIGINAL inputs plus a `resolutions` payload. commitIngest re-runs
// buildPlan→commitPlan honoring the picks, and the import commits IN FULL or
// re-holds. Covers the ADR "Completion evidence" list:
//   #1 ambiguous → existing: label binds to that entity, no dup
//   #2 ambiguous → create: a genuinely-new raw name creates; raw dup re-holds
//   #3 stale → accept: writes source:'import', parent = the live human op
//   #4 stale → keep: no op, human value intact
//   #5 all-or-nothing: unresolved re-holds (zero ops); fully-resolved commits whole
//   #6 Article V: a peer deleting a pinned 'existing' candidate re-holds

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp } from './operations.js'
import { commitIngest } from './ingest.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-t73-${Date.now()}-${Math.random()}.sqlite`)
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

const opCount = () => db.prepare('SELECT COUNT(*) c FROM operations').get().c
const activityCount = () => db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ?').get(campId).c
const commit = (extra) => commitIngest(db, { camp_id: campId, device_id: deviceId, author_user_id: 'u1', ...extra })

// Seed a live activity directly on the op-log with a chosen raw name so a
// normalize-collision (two rows normalizing alike) can be constructed.
function seedActivity(id, name) {
  appendOp(db, { entity: 'activities', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'activities', entity_id: id, field: 'name', value: name, device_id: deviceId, source: 'import' })
}
// Monday → fieldsFor derives day_of_week 1; seed it so the ONLY field in play
// on a re-import is the caller-chosen sort_order (day_of_week matches, no delta).
function seedDay(id, label, sort_order, sortSource) {
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'label', value: label, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'day_of_week', value: 1, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: sort_order, device_id: deviceId, source: sortSource })
}
const dayField = (id, field) => db.prepare(`SELECT ${field} AS v FROM days_of_operation WHERE id = ?`).get(id)?.v

// ---------------------------------------------------------------------------
// ambiguous_identity resolution
// ---------------------------------------------------------------------------
describe('ambiguous_identity re-commit', () => {
  it('unresolved: an ambiguous import holds and writes nothing', () => {
    seedActivity('art-1', 'Art')
    seedActivity('art-2', 'art ')
    const before = opCount()
    const res = commit({ approved: { activities: ['Art'] } })
    expect(res.held).toBe(true)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0].reason).toBe('ambiguous_identity')
    expect(opCount()).toBe(before)
  })

  it('resolved → existing: the label binds to that entity, no new row', () => {
    seedActivity('art-1', 'Art')
    seedActivity('art-2', 'art ')
    const before = activityCount()
    const res = commit({
      approved: { activities: ['Art'] },
      resolutions: [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'art-1' }],
    })
    expect(res.held).toBe(false)
    expect(activityCount()).toBe(before) // no dup minted (unchanged against art-1)
  })

  it('resolved → create: a genuinely-new raw name creates cleanly', () => {
    // Candidates normalize alike but neither RAW-equals the incoming "Art".
    seedActivity('art-1', 'art ')
    seedActivity('art-2', 'ART')
    const before = activityCount()
    const res = commit({
      approved: { activities: ['Art'] },
      resolutions: [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'create' }],
    })
    expect(res.held).toBe(false)
    expect(activityCount()).toBe(before + 1)
    expect(db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Art').c).toBe(1)
  })

  it('resolved → create but a raw-name duplicate exists: re-holds, never throws UNIQUE', () => {
    seedActivity('art-1', 'Art')  // exact raw match for the incoming "Art"
    seedActivity('art-2', 'art ')
    const before = opCount()
    const res = commit({
      approved: { activities: ['Art'] },
      resolutions: [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'create' }],
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
  })

  it('Article V: a pinned existing candidate deleted by a peer re-holds', () => {
    // Three colliding candidates so the ambiguity REMAINS after one is deleted.
    seedActivity('art-1', 'Art')
    seedActivity('art-2', 'art ')
    seedActivity('art-3', 'ART')
    // Peer deletes the candidate the director pinned, between preview and re-commit.
    appendOp(db, { entity: 'activities', entity_id: 'art-1', field: '__deleted__', value: 1, device_id: deviceId })
    const before = opCount()
    const res = commit({
      approved: { activities: ['Art'] },
      resolutions: [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'art-1' }],
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// stale resolution
// ---------------------------------------------------------------------------
describe('stale re-commit', () => {
  it('accept: writes the import value with source:import, parented on the human op', () => {
    const id = randomUUID()
    seedDay(id, 'Monday', 3, 'human')  // human sort_order 3
    const humanOp = latestOp(db, 'days_of_operation', id, 'sort_order')

    // S2c: the recognized diff reads only the fields the source explicitly
    // carries — a re-import proposing sort_order 1 against a human-set 3 → stale.
    const monday = { name: 'Monday', fields: { sort_order: 1 } }
    const held = commit({ approved: { days_of_operation: [monday] } })
    expect(held.held).toBe(true)
    expect(held.conflicts[0].reason).toBe('stale')

    const res = commit({
      approved: { days_of_operation: [monday] },
      resolutions: [{ entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'accept' }],
    })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(dayField(id, 'sort_order')).toBe(1)
    const latest = latestOp(db, 'days_of_operation', id, 'sort_order')
    expect(latest.source).toBe('import')
    expect(latest.parent_op_id).toBe(humanOp.id)
  })

  it('keep: no op for that field, the human value is intact', () => {
    const id = randomUUID()
    seedDay(id, 'Monday', 3, 'human')
    const before = opCount()

    const res = commit({
      approved: { days_of_operation: [{ name: 'Monday', fields: { sort_order: 1 } }] },
      resolutions: [{ entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'keep' }],
    })
    expect(res.held).toBe(false)
    expect(opCount()).toBe(before)          // nothing written for the kept field
    expect(dayField(id, 'sort_order')).toBe(3)
  })

  it('accepted field decays to import-owned: a second re-import updates quietly', () => {
    const id = randomUUID()
    seedDay(id, 'Monday', 3, 'human')
    const monday = { name: 'Monday', fields: { sort_order: 1 } }
    commit({
      approved: { days_of_operation: [monday] },
      resolutions: [{ entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'accept' }],
    })
    // Now sort_order is import-owned; move it via an import path and re-import.
    appendOp(db, { entity: 'days_of_operation', entity_id: id, field: 'sort_order', value: 9, device_id: deviceId, source: 'import' })
    const quiet = commit({ approved: { days_of_operation: [monday] } })
    expect(quiet.held).toBe(false)
    expect(quiet.updated).toBe(1)
    expect(dayField(id, 'sort_order')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// all-or-nothing: a fully-resolved held import commits the WHOLE import
// ---------------------------------------------------------------------------
describe('hold-the-whole atomicity', () => {
  it('a resolution that leaves another conflict unresolved re-holds the whole import', () => {
    // Two ambiguous activities; resolve only one → the other still holds all.
    seedActivity('art-1', 'Art')
    seedActivity('art-2', 'art ')
    seedActivity('rope-1', 'Ropes')
    seedActivity('rope-2', 'ropes ')
    const before = opCount()
    const res = commit({
      approved: { activities: ['Art', 'Ropes'], days_of_operation: ['Tuesday'] },
      resolutions: [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'art-1' }],
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)  // NOTHING written — not even the clean new day
    expect(db.prepare("SELECT COUNT(*) c FROM days_of_operation WHERE label = 'Tuesday'").get().c).toBe(0)
  })

  it('fully resolved: the whole import (including a clean new item) commits together', () => {
    seedActivity('art-1', 'Art')
    seedActivity('art-2', 'art ')
    const res = commit({
      approved: { activities: ['Art'], days_of_operation: ['Tuesday'] },
      resolutions: [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'art-1' }],
    })
    expect(res.held).toBe(false)
    // The clean new day landed because the whole import was un-held.
    expect(db.prepare("SELECT COUNT(*) c FROM days_of_operation WHERE label = 'Tuesday' AND camp_id = ?").get(campId).c).toBe(1)
  })
})
