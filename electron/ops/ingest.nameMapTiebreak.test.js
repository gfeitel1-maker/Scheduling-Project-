// T252 — deterministic lowest-id tie-break on the name->id maps.
//
// Schema v73 relaxed the UNIQUE constraint on ten tables, so two rows can now
// legitimately share a name (a merge collision, or a director typing a
// duplicate on purpose). seedNameMaps() in ingest.js and nameMap() in
// materializeImportedVersion.js key a Map by normalized name over an
// UNORDERED `SELECT` — before this fix, last-row-wins, and SQLite gives no
// guarantee that two devices which received the same rows via merge in a
// different physical order return them in the same order. The fix: every
// site sorts by id ASC and uses first-write-wins, so the lowest id always
// claims the map slot regardless of row return order.
//
// Fixtures go through the real write path (appendOp -> applyProjection /
// commitIngest), never a hand-built Map, per the ticket's evidence rule.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp } from './operations.js'
import { commitIngest } from './ingest.js'
import { nameMap } from './materializeImportedVersion.js'

const deviceId = 'device-1'

function makeCampDb() {
  const { db, file } = openTemplatedDb()
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
  return { db, file, campId }
}

const openDbs = []
afterEach(() => {
  for (const { db, file } of openDbs.splice(0)) {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix)
    }
  }
  cleanupTemplatedDbs()
})

function createRow(db, entity, id, fields, campId) {
  appendOp(db, { entity, entity_id: id, field: 'camp_id', value: campId, author_user_id: 'u1', device_id: deviceId })
  for (const [field, value] of Object.entries(fields)) {
    appendOp(db, { entity, entity_id: id, field, value, author_user_id: 'u1', device_id: deviceId })
  }
}

describe('T252 — nameMap() (materializeImportedVersion.js) resolves duplicates to the lowest id', () => {
  it('produces a byte-identical map from two opposite insertion orders', () => {
    // id-a < id-b lexicographically (locations.id is TEXT).
    const idA = 'aaaaaaaa-0000-0000-0000-000000000001'
    const idB = 'bbbbbbbb-0000-0000-0000-000000000002'

    const { db: dbForward, file: fileForward, campId: campForward } = makeCampDb()
    openDbs.push({ db: dbForward, file: fileForward })
    createRow(dbForward, 'groups', idA, { name: 'Bunk 1' }, campForward)
    createRow(dbForward, 'groups', idB, { name: 'Bunk 1' }, campForward)

    const { db: dbReverse, file: fileReverse, campId: campReverse } = makeCampDb()
    openDbs.push({ db: dbReverse, file: fileReverse })
    createRow(dbReverse, 'groups', idB, { name: 'Bunk 1' }, campReverse)
    createRow(dbReverse, 'groups', idA, { name: 'Bunk 1' }, campReverse)

    const mapForward = nameMap(dbForward, 'groups', campForward)
    const mapReverse = nameMap(dbReverse, 'groups', campReverse)

    expect(mapForward.get('bunk 1')).toBe(idA)
    expect(mapReverse.get('bunk 1')).toBe(idA)
    expect([...mapForward.entries()]).toEqual([...mapReverse.entries()])
  })

  // Non-vacuity: a naive fix that sorted but forgot first-write-wins (kept
  // plain `.set()`, so the LAST row in ORDER BY id ASC overwrites) would
  // still pass a test that only checks "same result both orders" if it
  // sorted consistently — the defect this guard must also catch is
  // "sorted the wrong direction" (highest id wins instead of lowest).
  it('plants the wrong-direction defect: asserting the id is the MINIMUM, not just consistent', () => {
    const idLow = 'aaaaaaaa-0000-0000-0000-000000000001'
    const idHigh = 'zzzzzzzz-0000-0000-0000-000000000009'
    const { db, file, campId } = makeCampDb()
    openDbs.push({ db, file })
    createRow(db, 'groups', idHigh, { name: 'Bunk 1' }, campId)
    createRow(db, 'groups', idLow, { name: 'Bunk 1' }, campId)

    const map = nameMap(db, 'groups', campId)
    // A tie-break that consistently picked the HIGHEST id would fail this
    // assertion even though it is perfectly order-independent — proving the
    // test checks "lowest wins", not merely "some deterministic winner".
    expect(map.get('bunk 1')).toBe(idLow)
    expect(map.get('bunk 1')).not.toBe(idHigh)
  })
})

describe('T252 — ingest.js seedNameMaps sites resolve duplicates to the lowest id', () => {
  it('locationIdByName: an activity naming an ambiguous location resolves to the lowest location id, regardless of insertion order', () => {
    const idA = 'aaaaaaaa-0000-0000-0000-000000000001'
    const idB = 'bbbbbbbb-0000-0000-0000-000000000002'

    const { db: dbForward, file: fileForward, campId: campForward } = makeCampDb()
    openDbs.push({ db: dbForward, file: fileForward })
    createRow(dbForward, 'locations', idA, { name: 'Pool' }, campForward)
    createRow(dbForward, 'locations', idB, { name: 'Pool' }, campForward)

    const { db: dbReverse, file: fileReverse, campId: campReverse } = makeCampDb()
    openDbs.push({ db: dbReverse, file: fileReverse })
    createRow(dbReverse, 'locations', idB, { name: 'Pool' }, campReverse)
    createRow(dbReverse, 'locations', idA, { name: 'Pool' }, campReverse)

    const resultForward = commitIngest(dbForward, {
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Pool' } },
      camp_id: campForward, device_id: deviceId, author_user_id: 'u1',
    })
    const resultReverse = commitIngest(dbReverse, {
      approved: { activities: ['Swim'] },
      activityRules: { Swim: { location: 'Pool' } },
      camp_id: campReverse, device_id: deviceId, author_user_id: 'u1',
    })

    expect(resultForward.held).toBe(false)
    expect(resultReverse.held).toBe(false)
    const swimForward = dbForward.prepare('SELECT location_id FROM activities WHERE camp_id = ? AND name = ?').get(campForward, 'Swim')
    const swimReverse = dbReverse.prepare('SELECT location_id FROM activities WHERE camp_id = ? AND name = ?').get(campReverse, 'Swim')
    expect(swimForward.location_id).toBe(idA)
    expect(swimReverse.location_id).toBe(idA)
  })

  // days_of_operation keeps its hard UNIQUE(camp_id, day_of_week) constraint
  // (only the ten tables T241 names were relaxed), so a duplicate day row
  // cannot be built through the normal write path here — dayIdByName's tie
  // break is exercised only by reading its identical code (T252 §3 calls it
  // "transiently ambiguous while a conflict is open", not independently
  // reproducible through appendOp). This test covers the two sites that
  // CAN be reproduced this way: blockIdByName and groupIdByName.
  it('blockIdByName/groupIdByName: a fixed-event anchor resolves ambiguous names to the lowest id in both insertion orders', () => {
    const blockLow = 'aaaaaaaa-0000-0000-0000-0000000000b1'
    const blockHigh = 'zzzzzzzz-0000-0000-0000-0000000000b2'
    const groupLow = 'aaaaaaaa-0000-0000-0000-0000000000g1'
    const groupHigh = 'zzzzzzzz-0000-0000-0000-0000000000g2'

    function seedAmbiguous(db, campId, order) {
      createRow(db, 'days_of_operation', randomUUID(), { label: 'Monday', day_of_week: 1 }, campId)
      const blockIds = order === 'forward' ? [blockLow, blockHigh] : [blockHigh, blockLow]
      for (const id of blockIds) createRow(db, 'time_blocks', id, { name: '09:00-09:30' }, campId)
      const groupIds = order === 'forward' ? [groupLow, groupHigh] : [groupHigh, groupLow]
      for (const id of groupIds) createRow(db, 'groups', id, { name: 'Bunk 1' }, campId)
    }

    const { db: dbForward, file: fileForward, campId: campForward } = makeCampDb()
    openDbs.push({ db: dbForward, file: fileForward })
    seedAmbiguous(dbForward, campForward, 'forward')

    const { db: dbReverse, file: fileReverse, campId: campReverse } = makeCampDb()
    openDbs.push({ db: dbReverse, file: fileReverse })
    seedAmbiguous(dbReverse, campReverse, 'reverse')

    const fixedEvents = [{
      name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
      scope: { is_all_groups: false, groups: ['Bunk 1'] },
    }]

    commitIngest(dbForward, { approved: {}, fixedEvents, camp_id: campForward, device_id: deviceId, author_user_id: 'u1' })
    commitIngest(dbReverse, { approved: {}, fixedEvents, camp_id: campReverse, device_id: deviceId, author_user_id: 'u1' })

    const anchorForward = dbForward.prepare('SELECT * FROM anchor_activities WHERE camp_id = ?').get(campForward)
    const anchorReverse = dbReverse.prepare('SELECT * FROM anchor_activities WHERE camp_id = ?').get(campReverse)

    expect(anchorForward.time_block_id).toBe(blockLow)
    expect(anchorReverse.time_block_id).toBe(blockLow)
    expect(anchorForward.group_ids ?? anchorForward.scope_groups ?? '').toEqual(anchorReverse.group_ids ?? anchorReverse.scope_groups ?? '')
  })
})
