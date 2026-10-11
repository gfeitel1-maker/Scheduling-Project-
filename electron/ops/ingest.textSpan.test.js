// F5 (docs/work/evidence/2026-10-11-synthetic-15-scorecard.md): a multi-block
// span read from a text grid (src/ingest/textSpans.js) reaches activities.span_blocks.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'

afterAll(() => { cleanupTemplatedDbs() })

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
  db?.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const activity = (name) => db.prepare('SELECT * FROM activities WHERE camp_id = ? AND name = ?').get(campId, name)
const commit = (rules) => commitIngest(db, {
  approved: { groups: ['Group 1', 'Group 2'], activities: Object.keys(rules) },
  activityRules: rules, camp_id: campId, device_id: deviceId,
})

describe('text-grid span reaches activities.span_blocks', () => {
  it('writes span_blocks and the session count from the rule', () => {
    commit({
      'Ropes Course': { eligible_group_names: ['Group 1', 'Group 2'], min_per_week: 1, max_per_week: 3, span_blocks: 2 },
      Swim: { eligible_group_names: ['Group 1', 'Group 2'], min_per_week: 2, max_per_week: 4 },
    })
    expect(activity('Ropes Course').span_blocks).toBe(2)
    expect(activity('Ropes Course').min_per_week).toBe(1)
    expect(activity('Swim').span_blocks).toBeNull()
  })

  it('refuses a span that is not an integer of at least 2', () => {
    commit({ Hike: { eligible_group_names: ['Group 1', 'Group 2'], min_per_week: 1, max_per_week: 3, span_blocks: 1.5 } })
    expect(activity('Hike').span_blocks).toBeNull()
  })
})
