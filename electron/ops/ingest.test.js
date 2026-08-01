import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest, INGESTIBLE_ENTITIES } from './ingest.js'
import { INGESTIBLE_ENTITIES as RENDERER_WHITELIST } from '../../src/ingest/extractEntities.js'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2, §4.
//
// The two guarantees this file exists for: only setup entities can be created,
// and an import either lands completely or not at all.

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ingest-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  // operations.device_id and .author_user_id are real foreign keys — an op
  // cannot be written by a device or a person the camp has never seen.
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c

describe('the whitelist (ADR §2)', () => {
  it('matches the renderer\'s list exactly', () => {
    // Two lists that can drift are one list too many: the preview would offer
    // something the writer refuses, or worse, the other way round.
    expect([...INGESTIBLE_ENTITIES].sort()).toEqual([...RENDERER_WHITELIST].sort())
  })

  it('refuses to create placements, loudly rather than silently', () => {
    // The placements are right there in every parsed grid. A silent skip would
    // hide a caller that has misunderstood the scope.
    expect(() => commitIngest(db, {
      approved: { activities: ['Swim'], template_slots: [{ id: 's1' }] },
      camp_id: campId, device_id: deviceId,
    })).toThrow(/template_slots cannot be created by an import/)
  })

  it('writes no template_slots row even when asked', () => {
    try {
      commitIngest(db, { approved: { template_slots: ['x'] }, camp_id: campId, device_id: deviceId })
    } catch { /* expected */ }
    expect(count('template_slots')).toBe(0)
  })

  it('refuses anchor_activities, which look like setup but are not', () => {
    expect(() => commitIngest(db, {
      approved: { anchor_activities: ['Flagpole'] }, camp_id: campId, device_id: deviceId,
    })).toThrow(/cannot be created by an import/)
  })
})

describe('creating the approved records', () => {
  it('creates what the director confirmed, and nothing else', () => {
    const result = commitIngest(db, {
      approved: {
        groups: ['Bunk 1', 'Bunk 2'],
        activities: ['Swim', 'Archery', 'Drama'],
        days_of_operation: ['Monday', 'Tuesday'],
      },
      camp_id: campId, device_id: deviceId,
    })

    expect(result.total).toBe(7)
    expect(count('groups')).toBe(2)
    expect(count('activities')).toBe(3)
    expect(count('days_of_operation')).toBe(2)
    expect(count('time_blocks')).toBe(0)
  })

  it('derives the day of the week rather than asking the director for it', () => {
    commitIngest(db, { approved: { days_of_operation: ['Wednesday'] }, camp_id: campId, device_id: deviceId })
    const row = db.prepare('SELECT label, day_of_week FROM days_of_operation').get()
    expect(row.label).toBe('Wednesday')
    expect(row.day_of_week).toBe(3)
  })

  it('parses a period label into a start and end time', () => {
    commitIngest(db, { approved: { time_blocks: ['08:40–09:00'] }, camp_id: campId, device_id: deviceId })
    const row = db.prepare('SELECT name, start_time, end_time FROM time_blocks').get()
    expect(row.start_time).toBe('08:40')
    expect(row.end_time).toBe('09:00')
  })

  it('keeps a period whose label is not a time range, without inventing times', () => {
    commitIngest(db, { approved: { time_blocks: ['Block 2'] }, camp_id: campId, device_id: deviceId })
    const row = db.prepare('SELECT name, start_time, end_time FROM time_blocks').get()
    expect(row.name).toBe('Block 2')
    expect(row.start_time).toBeNull()
  })

  it('records every creation in the op log, so the import is inspectable', () => {
    commitIngest(db, { approved: { activities: ['Swim'] }, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
    const ops = db.prepare("SELECT * FROM operations WHERE entity = 'activities'").all()
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.every((o) => o.author_user_id === 'u1')).toBe(true)
  })

  it('ignores blank names rather than creating empty records', () => {
    const result = commitIngest(db, {
      approved: { activities: ['Swim', '', '   ', null] }, camp_id: campId, device_id: deviceId,
    })
    expect(result.total).toBe(1)
    expect(count('activities')).toBe(1)
  })
})

describe('all or nothing (ADR §4)', () => {
  it('leaves the camp untouched when a write fails partway through', () => {
    // T16: "a partial ingest that half-populates a camp is worse than one that
    // fails cleanly."
    //
    // The failure injected here is a real one rather than a mock: an activity
    // that already exists collides with UNIQUE(camp_id, name). That is not
    // hypothetical — it is what happens when someone adds a record in another
    // window between the preview and the confirm.
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'Drama')

    expect(() => commitIngest(db, {
      approved: { groups: ['Bunk 1', 'Bunk 2'], activities: ['Swim', 'Archery', 'Drama'] },
      camp_id: campId, device_id: deviceId,
    })).toThrow()

    // Nothing at all — not the groups, not the two activities that would have
    // succeeded, not the ops. Only the row that was there before.
    expect(count('groups')).toBe(0)
    expect(count('activities')).toBe(1)
    expect(db.prepare("SELECT name FROM activities").get().name).toBe('Drama')
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity IN ('groups','activities')").get().c).toBe(0)
  })

  it('refuses to run without a camp', () => {
    expect(() => commitIngest(db, { approved: { activities: ['Swim'] }, device_id: deviceId })).toThrow(/camp_id/)
  })

  it('refuses to run with nothing to commit', () => {
    expect(() => commitIngest(db, { approved: null, camp_id: campId, device_id: deviceId })).toThrow(/nothing to commit/)
  })
})
