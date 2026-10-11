// "Keep mine" blocks ONLY the field the director kept. The row's other changes still apply.
// reason 'stale' + choice 'keep' is what applyResolutions (renderer) emits for a declined update card.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'

afterAll(() => { cleanupTemplatedDbs() })
let db, tmpFile, campId

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const commit = (extra) => commitIngest(db, { camp_id: campId, device_id: 'device-1', author_user_id: 'u1', ...extra })
const swim = () => db.prepare('SELECT min_per_week, max_per_week FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Swim')
const rule = (min, max) => ({ Swim: { eligible_group_names: ['Bunk 1'], min_per_week: min, max_per_week: max, priority: 'high' } })

function seed() {
  commit({ approved: { tiers: ['Aleph'], groups: ['Bunk 1'], activities: ['Swim'] }, links: { groups: { 'Bunk 1': 'Aleph' } }, activityRules: rule(1, 3) })
}

describe('a kept field is not written; the row’s other changes are', () => {
  it('Keep mine on max_per_week leaves max alone while the accepted min_per_week change lands', () => {
    seed()
    expect(swim()).toEqual({ min_per_week: 1, max_per_week: 3 })
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: rule(2, 4),
      resolutions: [{ entity: 'activities', name: 'Swim', field: 'max_per_week', reason: 'stale', choice: 'keep' }],
    })
    expect(res.held).toBe(false)
    expect(swim()).toEqual({ min_per_week: 2, max_per_week: 3 })
  })

  it('a mixed answer keeps min_per_week and takes the file’s max_per_week', () => {
    seed()
    const res = commit({
      approved: { activities: ['Swim'] },
      activityRules: rule(2, 4),
      resolutions: [{ entity: 'activities', name: 'Swim', field: 'min_per_week', reason: 'stale', choice: 'keep' }],
    })
    expect(res.held).toBe(false)
    expect(swim()).toEqual({ min_per_week: 1, max_per_week: 4 })
  })

  it('without the resolution both fields change (the control)', () => {
    seed()
    commit({ approved: { activities: ['Swim'] }, activityRules: rule(2, 4) })
    expect(swim()).toEqual({ min_per_week: 2, max_per_week: 4 })
  })
})
