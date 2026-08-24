import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest, listImportEvidence } from './ingest.js'

// D6, docs/adr/2026-08-24-special-day-field-trip-ingest.md. A
// specialDayCandidate is proposal-only: it commits a minimal special_days
// row (id, camp_id, name, sort_order) only when explicitly passed through
// commitIngest's side channel, dedups by name, and stamps inferred/low
// evidence — mirroring anchor_activities' side-channel commit shape.

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ingest-specialdays-${Date.now()}-${Math.random()}.sqlite`)
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

describe('special_days side-channel commit (D6)', () => {
  it('never creates a special_days row unless a candidate is explicitly passed', () => {
    commitIngest(db, { approved: { activities: ['Swim'] }, camp_id: campId, device_id: deviceId })
    expect(db.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(0)
  })

  it('commits an accepted candidate as a minimal openable special_days row', () => {
    const result = commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Field Trip', day: 'Wednesday', support: { operating_groups: 3 } }],
      camp_id: campId,
      device_id: deviceId,
    })
    expect(result.specialDays.created).toBe(1)
    const rows = db.prepare('SELECT * FROM special_days WHERE camp_id = ?').all(campId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ camp_id: campId, name: 'Field Trip', sort_order: 0 })
    expect(rows[0].notes).toBeFalsy()
  })

  it('dedups by name — a re-import of the same candidate writes nothing new', () => {
    commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Field Trip', day: 'Wednesday' }],
      camp_id: campId,
      device_id: deviceId,
    })
    const result = commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Field Trip', day: 'Wednesday' }],
      camp_id: campId,
      device_id: deviceId,
    })
    expect(result.specialDays.created).toBe(0)
    expect(result.specialDays.unchanged).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(1)
  })

  it('dedups against a pre-existing hand-created row of the same name', () => {
    db.prepare('INSERT INTO special_days (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), campId, 'Color War', 0)
    const result = commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Color War', day: 'Friday' }],
      camp_id: campId,
      device_id: deviceId,
    })
    expect(result.specialDays.created).toBe(0)
    expect(result.specialDays.unchanged).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM special_days').get().c).toBe(1)
  })

  it('stamps inferred/low evidence for a created candidate', () => {
    commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Field Trip', day: 'Wednesday', support: { operating_groups: 3 } }],
      camp_id: campId,
      device_id: deviceId,
    })
    const specialDayId = db.prepare('SELECT id FROM special_days WHERE camp_id = ?').get(campId).id
    const evidence = listImportEvidence(db, campId, { entity_type: 'special_days', entity_id: specialDayId })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ tag: 'inferred', confidence: 'low', field: 'name' })
  })

  it('appends sort_order after existing special_days rows', () => {
    db.prepare('INSERT INTO special_days (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), campId, 'Existing Day', 0)
    commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Field Trip', day: 'Wednesday' }],
      camp_id: campId,
      device_id: deviceId,
    })
    const row = db.prepare('SELECT * FROM special_days WHERE name = ?').get('Field Trip')
    expect(row.sort_order).toBe(1)
  })

  it('writes special_days through the op-log (undoable/syncable), not a bare INSERT', () => {
    commitIngest(db, {
      approved: {},
      specialDayCandidates: [{ name: 'Field Trip', day: 'Wednesday' }],
      camp_id: campId,
      device_id: deviceId,
    })
    const ops = db.prepare("SELECT * FROM operations WHERE entity = 'special_days'").all()
    expect(ops.length).toBeGreaterThan(0)
  })
})
