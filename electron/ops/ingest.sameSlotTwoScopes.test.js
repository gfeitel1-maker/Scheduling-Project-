// F1 (synthetic-15 scorecard): two inferred events sharing name/block/day with
// different group sets must not lose the second group set at commit. The slot key is
// scope-blind (docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md),
// so the scopes are unioned per slot before the one row per slot is written.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'

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
const rows = () => db.prepare('SELECT fe.*, d.label day FROM fixed_events fe JOIN days_of_operation d ON d.id = fe.day_id WHERE fe.camp_id = ?').all(campId)
const groupName = () => new Map(db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId).map((g) => [g.id, g.name]))
const scopeOf = (r) => JSON.parse(r.group_ids).map((id) => groupName().get(id)).sort()

const INPUT = {
  approved: {
    groups: ['Otters 1', 'Otters 2', 'Otters 3'],
    days_of_operation: ['Monday', 'Thursday'],
    time_blocks: ['10:00-10:45'],
    activities: ['Swim'],
  },
  fixedEvents: [
    { name: 'Lunch', time_block: '10:00-10:45', days: ['Monday', 'Thursday'], scope: { is_all_groups: false, groups: ['Otters 3'] } },
    { name: 'Lunch', time_block: '10:00-10:45', days: ['Monday'], scope: { is_all_groups: false, groups: ['Otters 1', 'Otters 2'] } },
  ],
}

describe('F1 - same name/block/day, two group sets', () => {
  it('keeps both group sets on the shared day', () => {
    commit(INPUT)
    const mon = rows().filter((r) => r.day === 'Monday')
    expect(mon).toHaveLength(1)
    expect(scopeOf(mon[0])).toEqual(['Otters 1', 'Otters 2', 'Otters 3'])
    const thu = rows().filter((r) => r.day === 'Thursday')
    expect(scopeOf(thu[0])).toEqual(['Otters 3'])
  })

  it('is order-independent', () => {
    commit({ ...INPUT, fixedEvents: [...INPUT.fixedEvents].reverse() })
    const mon = rows().find((r) => r.day === 'Monday')
    expect(scopeOf(mon)).toEqual(['Otters 1', 'Otters 2', 'Otters 3'])
  })

  it('Keep re-import of the same input writes nothing new and reports no scope drift', () => {
    commit(INPUT)
    const before = rows().length
    const second = commit(INPUT)
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.scopeChanged).toEqual([])
    expect(rows()).toHaveLength(before)
  })
})
