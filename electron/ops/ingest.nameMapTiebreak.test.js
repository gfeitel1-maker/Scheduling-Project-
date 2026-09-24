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
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp } from './operations.js'
import { commitIngest } from './ingest.js'
import { nameMap } from './materializeImportedVersion.js'

// node:crypto's module namespace is not configurable in ESM (vi.spyOn throws
// "Cannot redefine property"), so randomUUID can only be swapped via vi.mock.
// randomUUIDOverride is a vi.hoisted() indirection cell: the mock factory
// below reads it on every call, and a single test can point it at a
// deterministic implementation without affecting every other test in this
// file (which get the real randomUUID via importOriginal).
const { randomUUIDOverride } = vi.hoisted(() => ({ randomUUIDOverride: { impl: null } }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, randomUUID: (...args) => (randomUUIDOverride.impl ?? actual.randomUUID)(...args) }
})

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

// Regression: commitCreate's own name-map registration block (~1414-1422)
// used to unconditionally .set() into the SAME maps seedNameMaps just
// carefully seeded first-write-wins — so a row created WITHIN this same
// ingest run silently evicted the already-established lowest-id winner for
// every later lookup in that run (the group->tier link, resolveFieldWrite,
// fixed-event scoping). Fixed by guarding every registration with the same
// `if (!map.has(key))` seedNameMaps uses, so a row born this run only ever
// claims a name slot no live row already holds.
describe('T252 round 2 — commitCreate must not evict an already-seeded name-map winner', () => {
  it('groupIdByName: a group created THIS run does not evict the established lowest-id "Bunk 1", and a fixed event scoped to it still resolves to the established row', () => {
    const idLow = 'aaaaaaaa-0000-0000-0000-0000000000g1'
    const idHigh = 'zzzzzzzz-0000-0000-0000-0000000000g2'
    const { db, file, campId } = makeCampDb()
    openDbs.push({ db, file })

    // commitIngest mints the new group's id (and every op's client_write_id)
    // via randomUUID() internally — the test has no way to pass an id in.
    // An unstubbed randomUUID is a real UUIDv4: its first hex character is
    // uniform over 0-9a-f, so roughly 10/16 of runs produce an id that sorts
    // BELOW "aaaaaaaa..." and would (if the guard were broken) evict idLow —
    // and about 6/16 sort above it and would pass even with a broken guard.
    // That is exactly the flakiness class CI hit in the sibling mock test:
    // the assertion's outcome depended on where an unstubbed random id
    // happened to land. Stub randomUUID to values that deterministically
    // sort BELOW idLow (leading "00000000-" < leading "aaaaaaaa-"), and make
    // each call unique so findOpByClientWriteId's client_write_id dedup does
    // not treat the second op in a call as an already-applied retry.
    let uuidCounter = 0
    randomUUIDOverride.impl = () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`

    // Two live rows already share the exact raw name "Bunk 1" (a legal
    // post-merge state under v73's relaxed UNIQUE). seedNameMaps() has
    // already established idLow as the map's winner by the time commitPlan
    // reaches the toCreate loop.
    createRow(db, 'groups', idHigh, { name: 'Bunk 1' }, campId)
    createRow(db, 'groups', idLow, { name: 'Bunk 1' }, campId)

    createRow(db, 'days_of_operation', randomUUID(), { label: 'Monday', day_of_week: 1 }, campId)
    createRow(db, 'time_blocks', randomUUID(), { name: '09:00-09:30' }, campId)

    // A raw-different name ("BUNK 1") that normalizes the same as the two
    // live rows is genuinely ambiguous (normalize-collision) but is NOT a
    // raw-exact duplicate of either candidate, so a director's pinned
    // 'create' choice creates it cleanly rather than re-holding.
    const result = commitIngest(db, {
      approved: { groups: ['BUNK 1'] },
      resolutions: [{ entity: 'groups', name: 'BUNK 1', reason: 'ambiguous_identity', choice: 'create' }],
      fixedEvents: [{
        name: 'Mifkad', time_block: '09:00-09:30', days: ['Monday'],
        scope: { is_all_groups: false, groups: ['Bunk 1'] },
      }],
      camp_id: campId, device_id: deviceId, author_user_id: 'u1',
    })

    expect(result.held).toBe(false)
    const newGroup = db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'BUNK 1')
    expect(newGroup).toBeTruthy()
    expect(newGroup.id).not.toBe(idLow)
    expect(newGroup.id).not.toBe(idHigh)

    const anchor = db.prepare('SELECT * FROM anchor_activities WHERE camp_id = ?').get(campId)
    const anchorGroups = anchor.group_ids ?? anchor.scope_groups ?? ''
    // Established lowest-id row still wins the "bunk 1" slot; the row
    // created this same run must never have claimed it.
    expect(anchorGroups).toContain(idLow)
    expect(anchorGroups).not.toContain(newGroup.id)
    // Confirms the stub actually produced a lower-sorting id — otherwise this
    // test would pass vacuously regardless of whether the guard works.
    expect(newGroup.id < idLow).toBe(true)

    randomUUIDOverride.impl = null
  })
})
