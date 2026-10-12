// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { materializeImportedVersion, cleanSourceFileName } from './materializeImportedVersion.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'
import { deriveSpecialDayActivityId } from './electiveDerivedIds.js'
import { leftOutPlacements } from '../../src/ingest/leftOutPlacements.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function makeDb() {
  const file = path.join(os.tmpdir(), `shoresh-matimport-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

const deviceId = 'device-1'
const authorUserId = 'u1'

// A minimal fake write client whose write() does exactly what the real local
// write client does (electron/sync/localWriteClient.js's createLocalWriteClient):
// appendOp against the SAME db, which both records the op AND materializes it
// via the projection (electron/ops/operations.js appendOp -> applyProjection).
// Deterministic and side-effect-identical to the real thing.
//
// _Prior: this described the real collaborator as "the host-local (no-serverUrl)
// syncClient.write", and said the fake avoided needing "a WebSocket server".
// syncClient.js and the WS server were both deleted at the Stage 6 cutover;
// there is no serverUrl variant to distinguish a host-local write from any
// other, because every write is local now._
function fakeSyncClient(db) {
  return {
    async write({ entity, entity_id, field, value, author_user_id: opAuthor }) {
      const op = appendOp(db, { entity, entity_id, field, value, author_user_id: opAuthor, device_id: deviceId })
      return { status: 'applied', op }
    },
  }
}

function seedCamp(db) {
  const campId = randomUUID()
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES (?, 'Camp', ?)").run(campId, 'a'.repeat(64))
  db.prepare("INSERT INTO devices (id, name) VALUES (?, 'Test Device')").run(deviceId)
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(authorUserId, campId)
  return campId
}

function seedWeek(db, campId, name = 'Week 1') {
  const weekId = randomUUID()
  db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)').run(weekId, campId, name)
  return weekId
}

function seedGroup(db, campId, name) {
  const id = randomUUID()
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
  return id
}

function seedDay(db, campId, label) {
  const id = randomUUID()
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run(id, campId, label)
  return id
}

function seedBlock(db, campId, name) {
  const id = randomUUID()
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
  return id
}

// T219: position N runs (9+N):00 to (10+N):00, so consecutive positions are back to back.
function orderBlock(db, id, position) {
  const hh = (h) => String(h).padStart(2, '0') + ':00'
  db.prepare('UPDATE time_blocks SET sort_order = ?, start_time = ?, end_time = ? WHERE id = ?').run(position, hh(9 + position), hh(10 + position), id)
}

function seedActivity(db, campId, name) {
  const id = randomUUID()
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
  return id
}

function seedAnchor(db, campId, name) {
  const id = randomUUID()
  db.prepare('INSERT INTO fixed_events (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
  return id
}

function seedCatalog(db, campId) {
  const groupId = seedGroup(db, campId, 'Bunk 1')
  const dayId = seedDay(db, campId, 'Monday')
  const blockId = seedBlock(db, campId, '09:00')
  const activityId = seedActivity(db, campId, 'Swim')
  const anchorId = seedAnchor(db, campId, 'Lunch')
  return { groupId, dayId, blockId, activityId, anchorId }
}

describe('materializeImportedVersion', () => {
  it('does not save another version when the slots equal the latest one of the same name (re-import of the same file)', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]
    const args = { campId, authorUserId, placements, sourceFileName: 'campB.txt' }

    const first = await materializeImportedVersion(db, fakeSyncClient(db), args)
    const second = await materializeImportedVersion(db, fakeSyncClient(db), args)

    expect(first.created).toBe(true)
    expect(first.versionName).toBe('Imported from campB.txt')
    expect(second.created).toBe(false)
    expect(second.unchanged).toBe(true)
    // one per candidate route, and no more after the second run
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(2)
  })

  it('still saves a version when the same file name now yields different slots', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    const swim = { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }
    const lunch = { ...swim, activityName: 'Lunch' }
    await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements: [swim], sourceFileName: 'campB.txt' })
    const second = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements: [swim, lunch], sourceFileName: 'campB.txt' })

    expect(second.created).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(4)
  })

  it('does not un-archive or duplicate Week 1 when every week is archived (Red Hat #1)', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedCatalog(db, campId)
    const archivedId = `schedule-week:${campId}:1`
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, 'Week 1', 0, 1)").run(archivedId, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]
    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })
    expect(result.created).toBe(false)
    expect(result.allWeeksArchived).toBe(true)
    const weeks = db.prepare('SELECT id, is_archived FROM schedule_weeks WHERE camp_id = ?').all(campId)
    expect(weeks).toEqual([{ id: archivedId, is_archived: 1 }])
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(0)
  })

  it('returns created:false with unresolvedCount when no schedule_weeks row exists', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]
    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })
    expect(result.created).toBe(false)
    expect(result.unresolvedCount).toBe(1)
    expect(result.unresolvedNames).toEqual(['Swim'])
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(0)
  })

  it('mints the manual schedule_templates row when none exists and attaches the snapshot to it', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    const weekId = seedWeek(db, campId)
    seedCatalog(db, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]

    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(result.created).toBe(true)
    const templateId = deriveScheduleTemplateId(weekId, 'manual')
    const template = db.prepare('SELECT * FROM schedule_templates WHERE id = ?').get(templateId)
    expect(template).toBeTruthy()
    expect(template.kind).toBe('manual')
    const snap = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get(result.snapshotId)
    expect(snap.template_id).toBe(templateId)
  })

  it('reuses an existing manual schedule_templates row rather than minting a second one', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    const weekId = seedWeek(db, campId)
    seedCatalog(db, campId)
    const templateId = deriveScheduleTemplateId(weekId, 'manual')
    db.prepare("INSERT INTO schedule_templates (id, camp_id, week_id, name, kind) VALUES (?, ?, ?, '', 'manual')").run(templateId, campId, weekId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]

    await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    const count = db.prepare("SELECT COUNT(*) c FROM schedule_templates WHERE week_id = ? AND kind = 'manual'").get(weekId).c
    expect(count).toBe(1)
  })

  it('writes one schedule_snapshots row with correct slots JSON when all placements resolve', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    const { groupId, dayId, blockId, activityId } = seedCatalog(db, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]

    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(result.unresolvedCount).toBe(0)
    const snap = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get(result.snapshotId)
    expect(snap.name).toBe('Imported schedule')
    expect(JSON.parse(snap.slots)).toEqual([
      { group_id: groupId, day_id: dayId, time_block_id: blockId, activity_id: activityId, fixed_event_id: null, is_fixed_event: false, flags: {} },
    ])
  })

  it('writes no schedule_snapshots row when 0 of N placements resolve', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Nonexistent' }]

    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(result.created).toBe(false)
    expect(result.unresolvedCount).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(0)
  })

  it('reports each left-out placement with its day, group and 12-hour block time', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    db.prepare("UPDATE time_blocks SET start_time = '13:35', end_time = '14:20' WHERE camp_id = ?").run(campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Nonexistent' }]

    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(result.unresolvedItems).toEqual([
      { activityName: 'Nonexistent', groupName: 'Bunk 1', dayName: 'Monday', blockText: '09:00 (1:35 PM – 2:20 PM)', reason: 'activity' },
    ])
  })

  it('writes only the resolved slots and reports unresolvedNames when some resolve and some do not', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    const placements = [
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' },
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Nonexistent' },
    ]

    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(result.created).toBe(true)
    expect(result.unresolvedCount).toBe(1)
    expect(result.unresolvedNames).toEqual(['Nonexistent'])
    const snap = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get(result.snapshotId)
    expect(JSON.parse(snap.slots)).toHaveLength(1)
  })

  it('re-running the same call twice saves one version per route, not two', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]

    await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })
    const r2 = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(r2.created).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(2)
  })

  it('cleanSourceFileName: strips paths, caps a long name, and rejects non-strings', () => {
    expect(cleanSourceFileName('campB-by-day.txt')).toBe('campB-by-day.txt')
    expect(cleanSourceFileName('/Users/x/docs\\sub/campB.txt')).toBe('campB.txt')
    const long = cleanSourceFileName('a'.repeat(300) + '.txt')
    expect(long.length).toBe(120)
    expect(long.endsWith('…')).toBe(true)
    for (const bad of [null, undefined, 42, {}, ['a.txt'], '', '   ']) expect(cleanSourceFileName(bad)).toBeNull()
  })

  it('returns created:false immediately with no writes when placements is empty', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements: [] })
    expect(result).toEqual({ created: false, snapshotId: null, unresolvedCount: 0, unresolvedNames: [] })
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_templates').get().c).toBe(0)
  })

  describe('elective cells', () => {
    const electiveCell = (groupName, electiveSetName) => ({ groupName, dayName: 'Monday', blockLabel: '09:00', electiveSetName, activityName: electiveSetName, choices: [] })

    it('writes elective cells into the version with the live elective_set_id', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      const { groupId, dayId, blockId } = seedCatalog(db, campId)
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')

      const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements: [electiveCell('Bunk 1', 'Chugim')] })

      expect(result.unresolvedCount).toBe(0)
      expect(result.electiveCellCount).toBe(1)
      const snap = db.prepare('SELECT slots FROM schedule_snapshots WHERE id = ?').get(result.snapshotId)
      expect(JSON.parse(snap.slots)).toEqual([
        { group_id: groupId, day_id: dayId, time_block_id: blockId, elective_set_id: setId, activity_id: null, fixed_event_id: null, is_fixed_event: false, flags: {} },
      ])
    })

    // T219: a chug printed in two adjacent blocks is one double-period session.
    it('marks an elective held in adjacent blocks as one span and links each choice across it with a bundle', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedGroup(db, campId, 'Bunk 1')
      seedGroup(db, campId, 'Bunk 2')
      const dayId = seedDay(db, campId, 'Monday')
      const b1 = seedBlock(db, campId, '09:00')
      const b2 = seedBlock(db, campId, '10:00')
      orderBlock(db, b1, 0)
      orderBlock(db, b2, 1)
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')
      const pottery = seedActivity(db, campId, 'Pottery')
      const drama = seedActivity(db, campId, 'Drama')
      for (const a of [pottery, drama]) {
        db.prepare("INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES (?, ?, ?, 'potential')").run(randomUUID(), setId, a)
      }
      const cell = (g, block) => ({ groupName: g, dayName: 'Monday', blockLabel: block, electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] })
      const placements = [cell('Bunk 1', '09:00'), cell('Bunk 1', '10:00'), cell('Bunk 2', '09:00'), cell('Bunk 2', '10:00')]

      const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

      const slots = JSON.parse(db.prepare('SELECT slots FROM schedule_snapshots WHERE id = ?').get(result.snapshotId).slots)
      expect(slots.map((s) => [s.time_block_id === b1 ? 'b1' : 'b2', s.is_span_head]).sort()).toEqual([['b1', true], ['b1', true], ['b2', false], ['b2', false]])
      const bundles = db.prepare('SELECT id, activity_id, elective_set_id FROM elective_bundles').all()
      expect(bundles.map((b) => b.activity_id).sort()).toEqual([pottery, drama].sort())
      expect(bundles.every((b) => b.elective_set_id === setId)).toBe(true)
      for (const b of bundles) {
        const periods = db.prepare('SELECT day_id, time_block_id FROM elective_bundle_periods WHERE bundle_id = ?').all(b.id)
        expect(periods.map((p) => [p.day_id, p.time_block_id]).sort()).toEqual([[dayId, b1], [dayId, b2]].sort())
      }

      // A re-import converges: no second bundle, no second period.
      await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })
      expect(db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c).toBe(2)
      expect(db.prepare('SELECT COUNT(*) c FROM elective_bundle_periods').get().c).toBe(4)
    })

    it('two separate spans of one set on one day get separate bundles', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedGroup(db, campId, 'Bunk 1')
      seedDay(db, campId, 'Monday')
      const ids = ['09:00', '10:00', '11:00', '12:00', '13:00'].map((n, i) => {
        const id = seedBlock(db, campId, n)
        orderBlock(db, id, i)
        return id
      })
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')
      db.prepare("INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES (?, ?, ?, 'potential')").run(randomUUID(), setId, seedActivity(db, campId, 'Pottery'))
      const cell = (block) => ({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: block, electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] })

      await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements: ['09:00', '10:00', '12:00', '13:00'].map(cell) })

      const sets = db.prepare('SELECT id FROM elective_bundles').all().map((b) =>
        db.prepare('SELECT time_block_id FROM elective_bundle_periods WHERE bundle_id = ?').all(b.id).map((p) => ids.indexOf(p.time_block_id)).sort().join(','))
      expect(sets.sort()).toEqual(['0,1', '3,4'])
    })

    // Red Hat #4: bundles of one choice that share a period are refused by the solver's linked tier
    // (bundleOverlap.js), and a bundle's periods name no group. So a set whose groups hold it in
    // differing runs on one day is not linked at all, and the version says so.
    it('does not link a set whose groups hold it in overlapping, differing runs on one day', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedGroup(db, campId, 'Bunk 1')
      seedGroup(db, campId, 'Bunk 2')
      seedDay(db, campId, 'Monday')
      ;['09:00', '10:00', '11:00'].forEach((n, i) => {
        const id = seedBlock(db, campId, n)
        orderBlock(db, id, i)
      })
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')
      db.prepare("INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES (?, ?, ?, 'potential')").run(randomUUID(), setId, seedActivity(db, campId, 'Pottery'))
      const cell = (g, block) => ({ groupName: g, dayName: 'Monday', blockLabel: block, electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] })

      const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements: [cell('Bunk 1', '09:00'), cell('Bunk 1', '10:00'), cell('Bunk 2', '10:00'), cell('Bunk 2', '11:00')] })

      expect(result.created).toBe(true)
      expect(db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c).toBe(0)
      expect(result.unlinkedSpans).toEqual([{ electiveSetName: 'Chugim', dayName: 'Monday' }])
    })

    // Red Hat #5: a failed bundle write must not cost the version, and is reported, not swallowed.
    it('saves the version when a bundle write fails, and reports the failure', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedGroup(db, campId, 'Bunk 1')
      seedDay(db, campId, 'Monday')
      ;['09:00', '10:00'].forEach((n, i) => {
        const id = seedBlock(db, campId, n)
        orderBlock(db, id, i)
      })
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')
      db.prepare("INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES (?, ?, ?, 'potential')").run(randomUUID(), setId, seedActivity(db, campId, 'Pottery'))
      const ok = fakeSyncClient(db)
      const failing = { async write(args) { if (args.entity === 'elective_bundles') throw new Error('disk full'); return ok.write(args) } }
      const cell = (block) => ({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: block, electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] })

      const result = await materializeImportedVersion(db, failing, { campId, authorUserId, placements: [cell('09:00'), cell('10:00')] })

      expect(result.created).toBe(true)
      expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(2)
      expect(result.linkFailed).toMatch(/disk full/)
    })

    // Keeper ruling: a director's deletion survives a re-import of the same file (a Keep
    // re-import asks nothing and undoes nothing), as "Don't add" and "Keep mine" do.
    it('does not bring back a bundle or a period the director deleted, on re-import', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedGroup(db, campId, 'Bunk 1')
      seedDay(db, campId, 'Monday')
      ;['09:00', '10:00', '11:00'].forEach((n, i) => orderBlock(db, seedBlock(db, campId, n), i))
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')
      for (const name of ['Pottery', 'Drama']) {
        db.prepare("INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES (?, ?, ?, 'potential')").run(randomUUID(), setId, seedActivity(db, campId, name))
      }
      const cell = (block) => ({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: block, electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] })
      const placements = ['09:00', '10:00', '11:00'].map(cell)
      await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })
      const [gone, kept] = db.prepare('SELECT id FROM elective_bundles ORDER BY id').all().map((r) => r.id)
      const del = (entity, id) => appendOp(db, { entity, entity_id: id, field: DELETE_FIELD, value: null, author_user_id: authorUserId, device_id: deviceId, source: 'human' })
      for (const p of db.prepare('SELECT id FROM elective_bundle_periods WHERE bundle_id = ?').all(gone)) del('elective_bundle_periods', p.id)
      del('elective_bundles', gone)
      const droppedPeriod = db.prepare('SELECT id FROM elective_bundle_periods WHERE bundle_id = ? ORDER BY id LIMIT 1').get(kept).id
      del('elective_bundle_periods', droppedPeriod)

      await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements, sourceFileName: 'again.txt' })

      expect(db.prepare('SELECT id FROM elective_bundles').all().map((r) => r.id)).toEqual([kept])
      expect(db.prepare('SELECT 1 FROM elective_bundle_periods WHERE id = ?').get(droppedPeriod)).toBeUndefined()
      expect(db.prepare('SELECT COUNT(*) c FROM elective_bundle_periods WHERE bundle_id = ?').get(kept).c).toBe(2)
    })

    // T375: two devices importing the same file write the same bundle name, even when one of them
    // holds an unsynced rename of a choice. The label comes from the file, never the local catalog.
    it("names a bundle from the file's choice and day text, not this device's renamed activity", async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedGroup(db, campId, 'Bunk 1')
      seedDay(db, campId, 'Monday')
      ;['09:00', '10:00'].forEach((n, i) => orderBlock(db, seedBlock(db, campId, n), i))
      const setId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Chugim')
      // The import minted this choice under its derived id; this device has since renamed it.
      const potteryId = deriveSpecialDayActivityId(campId, 'Pottery')
      db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(potteryId, campId, 'Ceramics')
      db.prepare("INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES (?, ?, ?, 'potential')").run(randomUUID(), setId, potteryId)
      const cell = (block) => ({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: block, electiveSetName: 'Chugim', activityName: 'Chugim', choices: [] })

      await materializeImportedVersion(db, fakeSyncClient(db), {
        campId, authorUserId, placements: [cell('09:00'), cell('10:00')],
        electiveChoiceLabels: [{ name: 'Chugim', choices: ['Pottery'] }],
      })

      expect(db.prepare('SELECT name FROM elective_bundles').all().map((r) => r.name)).toEqual(['Pottery — Monday'])
    })

    it('a held import (no elective set written) yields zero elective slots and one left-out entry per name, without throwing', async () => {
      const db = makeDb()
      const campId = seedCamp(db)
      seedWeek(db, campId)
      seedCatalog(db, campId)
      seedGroup(db, campId, 'Bunk 2')
      const placements = [electiveCell('Bunk 1', 'Chugim'), electiveCell('Bunk 2', 'Chugim'), electiveCell('Bunk 1', 'Electives')]

      const result = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

      expect(result.created).toBe(false)
      expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(0)
      const leftOut = leftOutPlacements(result)
      expect(leftOut.entries.map((e) => e.name).sort()).toEqual(['Chugim', 'Electives'])
    })
  })
})
