// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { materializeImportedVersion } from './materializeImportedVersion.js'
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

// A minimal fake syncClient whose write() does exactly what the real
// host-local (no-serverUrl) syncClient.write does: appendOp against the SAME
// db, which both records the op AND materializes it via the projection
// (electron/ops/operations.js appendOp -> applyProjection). This is the
// documented Host-local write path (Governor fact #1) — deterministic and
// side-effect-identical to the real thing, without a WebSocket server.
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
  db.prepare('INSERT INTO anchor_activities (id, camp_id, name) VALUES (?, ?, ?)').run(id, campId, name)
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
      { group_id: groupId, day_id: dayId, time_block_id: blockId, activity_id: activityId, anchor_id: null, is_anchor: false, flags: {} },
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
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(2)
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
