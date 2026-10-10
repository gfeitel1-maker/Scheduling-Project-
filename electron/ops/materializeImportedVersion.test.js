// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { materializeImportedVersion, cleanSourceFileName } from './materializeImportedVersion.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'

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
      { activityName: 'Nonexistent', groupName: 'Bunk 1', dayName: 'Monday', blockText: '09:00 (1:35–2:20 PM)', reason: 'activity' },
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

  it('re-running the same call twice creates two separate schedule_snapshots rows', async () => {
    const db = makeDb()
    const campId = seedCamp(db)
    seedWeek(db, campId)
    seedCatalog(db, campId)
    const placements = [{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00', activityName: 'Swim' }]

    const r1 = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })
    const r2 = await materializeImportedVersion(db, fakeSyncClient(db), { campId, authorUserId, placements })

    expect(r1.snapshotId).not.toBe(r2.snapshotId)
    // one version per candidate route (manual + generated) per import
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(4)
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
})
