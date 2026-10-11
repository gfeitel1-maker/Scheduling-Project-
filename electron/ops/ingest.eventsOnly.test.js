// T364 / T365: time_blocks.events_only through the normal import path. A fresh import or a re-import
// sets it on a short block that holds a fixed event; a re-import clears an IMPORT-set flag whose event
// is gone; a flag the director wrote is never touched. Who set it is read from the op-log source of
// the flag's last write, so no new column.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import { appendOp } from './operations.js'

afterAll(() => cleanupTemplatedDbs())
let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})
afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })
const flag = (name) => db.prepare('SELECT id, events_only FROM time_blocks WHERE camp_id = ? AND name = ?').get(campId, name)

const APPROVED = {
  groups: ['Otters 1', 'Otters 2'],
  days_of_operation: ['Monday'],
  time_blocks: ['08:50-09:00', '09:05-09:50'],
  activities: ['Swim'],
}
const FLAG_RAISING = { name: 'Flag Raising', time_block: '08:50-09:00', days: ['Monday'], scope: { is_all_groups: true, groups: [] } }
const directorWrites = (id, value) => appendOp(db, {
  entity: 'time_blocks', entity_id: id, field: 'events_only', value, source: 'human', author_user_id: 'u1', device_id: deviceId,
})

describe('T365 - events_only is set through the normal import path (no backfill)', () => {
  it('a fresh import flags the short block that holds an event and no other block', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    expect(flag('08:50-09:00').events_only).toBe(1)
    expect(flag('09:05-09:50').events_only).toBe(0)
  })

  it('a re-import flags an existing short block the director never touched', () => {
    commit({ approved: APPROVED, fixedEvents: [] })
    expect(flag('08:50-09:00').events_only).toBe(0)
    const second = commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    expect(flag('08:50-09:00').events_only).toBe(1)
    expect(second.updated).toBeGreaterThan(0)
  })

  it('a re-import of the same input changes nothing', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    const second = commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    expect(second.updated).toBe(0)
    expect(flag('08:50-09:00').events_only).toBe(1)
  })
})

const PLAIN = { '08:50-09:00': 'Swim' }

describe('T364 - a stale import-set flag is cleared; a director-set flag never is', () => {
  it('clears the flag on a block the file now prints as a plain schedulable block', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    commit({ approved: APPROVED, fixedEvents: [], shortBlockPrints: PLAIN })
    expect(flag('08:50-09:00').events_only).toBe(0)
  })

  it('keeps the flag when the block is absent from the recurring list but is not a plain block (one-off, trip, unticked event)', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    commit({ approved: APPROVED, fixedEvents: [], shortBlockPrints: [] })
    expect(flag('08:50-09:00').events_only).toBe(1)
  })

  it('keeps the flag when the caller carries no schedulable-block information', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    commit({ approved: APPROVED, fixedEvents: [] })
    expect(flag('08:50-09:00').events_only).toBe(1)
  })

  it('sets the flag from the live row\'s stored times, not its name', () => {
    commit({ approved: APPROVED, fixedEvents: [] })
    const id = flag('08:50-09:00').id
    appendOp(db, { entity: 'time_blocks', entity_id: id, field: 'end_time', value: '09:30', source: 'human', author_user_id: 'u1', device_id: deviceId })
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    expect(flag('08:50-09:00').events_only).toBe(0)
  })

  it('leaves the flag alone when the caller carries no fixed-event information', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    commit({ approved: APPROVED })
    expect(flag('08:50-09:00').events_only).toBe(1)
  })

  it('keeps a flag the director turned on when the event is gone', () => {
    commit({ approved: APPROVED, fixedEvents: [] })
    directorWrites(flag('08:50-09:00').id, 1)
    commit({ approved: APPROVED, fixedEvents: [], shortBlockPrints: PLAIN })
    expect(flag('08:50-09:00').events_only).toBe(1)
  })

  it('a block created by hand and never toggled has no source: import may set it, never clear it', () => {
    commit({ approved: APPROVED, fixedEvents: [] })
    db.prepare('UPDATE time_blocks SET events_only = 1 WHERE camp_id = ? AND name = ?').run(campId, '08:50-09:00')
    commit({ approved: APPROVED, fixedEvents: [], shortBlockPrints: PLAIN })
    expect(flag('08:50-09:00').events_only).toBe(1)
  })

  it('keeps a flag the director turned off even though the event is present', () => {
    commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    directorWrites(flag('08:50-09:00').id, 0)
    const second = commit({ approved: APPROVED, fixedEvents: [FLAG_RAISING] })
    expect(flag('08:50-09:00').events_only).toBe(0)
    expect(second.conflicts).toEqual([])
  })
})
