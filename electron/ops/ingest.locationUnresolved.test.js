// docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-conflict-triage-coverage.md
//
// The update-path location_unresolved hold, its two director resolutions
// ("use existing" / "not a place"), and the remembered-decision table that
// makes "not a place" persist across imports so the same word never holds
// twice. See electron/ops/locationWordDecisions.test.js for the module's own
// unit tests; this file is the ingest-integration seam.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-loc-unresolved-${Date.now()}-${Math.random()}.sqlite`)
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
const commit = (extra) => commitIngest(db, { camp_id: campId, device_id: deviceId, author_user_id: 'u1', ...extra })
const actId = (name) => db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, name)?.id
const activityField = (id, field) => db.prepare(`SELECT ${field} AS v FROM activities WHERE id = ?`).get(id)?.v

function seedSwim() {
  return commit({ approved: { activities: ['Swim'] } })
}

describe('location_unresolved (update path)', () => {
  it('an unresolvable location word holds the whole import, not just the field', () => {
    seedSwim()
    const before = opCount()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Barn' } },
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
    const c = res.conflicts.find((x) => x.reason === 'location_unresolved')
    expect(c).toBeTruthy()
    expect(c.fields.location.to).toBe('Barn')
  })

  it('resolution choice "existing" binds the field to the chosen location id', () => {
    seedSwim()
    commit({ approved: { locations: ['Lake'] } })
    const lakeId = db.prepare('SELECT id FROM locations WHERE camp_id = ? AND name = ?').get(campId, 'Lake').id
    const id = actId('Swim')

    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Barn' } },
      resolutions: [
        { entity: 'activities', name: 'Swim', reason: 'location_unresolved', field: 'location', choice: 'existing', location_id: lakeId },
      ],
    })
    expect(res.held).toBe(false)
    expect(activityField(id, 'location_id')).toBe(lakeId)
  })

  it('resolution choice "not_a_place" resolves the field to null and records the decision', () => {
    seedSwim()
    const id = actId('Swim')

    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Barn' } },
      resolutions: [
        { entity: 'activities', name: 'Swim', reason: 'location_unresolved', field: 'location', choice: 'not_a_place' },
      ],
    })
    expect(res.held).toBe(false)
    expect(activityField(id, 'location_id')).toBe(null)

    const row = db.prepare('SELECT * FROM location_word_decisions WHERE camp_id = ?').get(campId)
    expect(row.word_key).toBe('barn')
    expect(row.decision).toBe('not_a_place')
  })

  it('a remembered "not a place" decision is consulted BEFORE the hold on a later import — same word never holds twice', () => {
    seedSwim()
    commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Barn' } },
      resolutions: [
        { entity: 'activities', name: 'Swim', reason: 'location_unresolved', field: 'location', choice: 'not_a_place' },
      ],
    })

    const id = actId('Swim')
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'barn' } }, // case/whitespace-different, same word
    })
    expect(res.held).toBe(false)
    expect(res.conflicts?.some((c) => c.reason === 'location_unresolved')).toBeFalsy()
    expect(activityField(id, 'location_id')).toBe(null)
  })

  it('a numeric room word is treated identically to a named one — no special-casing', () => {
    seedSwim()
    const before = opCount()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: '301' } },
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
    expect(res.conflicts.some((c) => c.reason === 'location_unresolved')).toBe(true)
  })
})

describe('location_unresolved (create path) — "existing" resolution binds too', () => {
  it('resolution choice "existing" binds a brand-new activity to the chosen location id', () => {
    commit({ approved: { locations: ['Lake'] } })
    const lakeId = db.prepare('SELECT id FROM locations WHERE camp_id = ? AND name = ?').get(campId, 'Lake').id
    const res = commit({
      approved: { activities: ['Archery'] },
      activityRules: { Archery: { location: 'Range' } },
      resolutions: [
        { entity: 'activities', name: 'Archery', reason: 'location_unresolved', field: 'location', choice: 'existing', location_id: lakeId },
      ],
    })
    expect(res.held).toBe(false)
    const id = actId('Archery')
    expect(id).toBeTruthy()
    expect(activityField(id, 'location_id')).toBe(lakeId)
  })
})

describe('location_unresolved (create path) — must not ask twice either', () => {
  it('a remembered "not a place" decision is consulted on a brand-new activity CREATE, not just an update — the import completes with location unset', () => {
    // Record the decision via the update path first (Swim already exists).
    seedSwim()
    commit({
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Barn' } },
      resolutions: [
        { entity: 'activities', name: 'Swim', reason: 'location_unresolved', field: 'location', choice: 'not_a_place' },
      ],
    })
    expect(db.prepare('SELECT COUNT(*) c FROM location_word_decisions WHERE camp_id = ?').get(campId).c).toBe(1)

    // A later import creates a BRAND NEW activity naming the same declined word.
    const res = commit({
      approved: { activities: ['Archery'] },
      activityRules: { Archery: { location: 'barn' } }, // case/whitespace-different, same word
    })

    expect(res.held).toBe(false)
    expect(res.conflicts?.some((c) => c.reason === 'location_unresolved')).toBeFalsy()
    const id = actId('Archery')
    expect(id).toBeTruthy()
    expect(activityField(id, 'location_id')).toBe(null)
  })
})
