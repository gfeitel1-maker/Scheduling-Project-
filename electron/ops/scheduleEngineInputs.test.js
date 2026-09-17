// T193 Defect A: scheduleEngineInputs.js must assemble electiveSetActivities
// and events, or a headless caller (MCP schedule_state) that threads these
// straight into buildSchedule() can never resolve an elective offering's or
// an event's location — the overlay rows would come back but occupancy
// would still silently be missing, a second falsely-clean result.
//
// T206: this file's subject is no longer a hand-copied mirror of
// useScheduleData.js's load() — both now call the one implementation in
// ./scheduleInputNormalization.js, whose own test covers the shared
// filter/sort/de-dupe/parse rules. What is still worth asserting HERE, and is
// not covered there, is the DB-backed half: that these two lists survive the
// real listEntities join (elective_set_activities is parent-scoped through
// elective_sets.camp_id, not a camp_id column) and reach the caller.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { assembleScheduleEngineInputs } from './scheduleEngineInputs.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-engine-inputs-'))
}

describe('assembleScheduleEngineInputs', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('includes electiveSetActivities and events scoped to this camp', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const dbPath = path.join(dir, 'shoresh.sqlite')
    const db = openLocalDb(dbPath)
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))

    const locId = randomUUID()
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(locId, campId, 'Waterfront', 1)

    const activityId = randomUUID()
    db.prepare(
      'INSERT INTO activities (id, camp_id, name, priority, span_blocks, max_groups_per_slot, min_per_week, max_per_week, same_tier_only, eligible_tier_ids, eligible_group_ids, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(activityId, campId, 'Waterfront Swim', 'low', 1, 1, 0, 5, 0, '[]', '[]', locId)

    const electiveSetId = randomUUID()
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(electiveSetId, campId, 'Waterfront Choice')
    db.prepare('INSERT INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)')
      .run(randomUUID(), electiveSetId, activityId)

    const eventId = randomUUID()
    db.prepare('INSERT INTO events (id, camp_id, name, location_id) VALUES (?, ?, ?, ?)').run(eventId, campId, 'Color War', locId)

    const inputs = assembleScheduleEngineInputs(db, campId)
    db.close()

    expect(inputs.electiveSetActivities).toEqual([
      expect.objectContaining({ elective_set_id: electiveSetId, activity_id: activityId }),
    ])
    expect(inputs.events).toEqual([
      expect.objectContaining({ id: eventId, name: 'Color War', location_id: locId }),
    ])
  })
})
