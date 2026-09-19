// T205 round 2, FIX 1 (Red Hat HIGH): commitCreate's days_of_operation path
// still minted crypto.randomUUID() — the ONE call site Part A's deterministic-id
// fix (src/utils/seedDays.js) never reached. A day CREATED BY IMPORT therefore
// (a) had day_of_week NULL at creation (defect 1, reopened) and (b) two devices
// importing the same weekday would mint DIFFERENT ids (the exact duplication
// the deterministic-id prevention exists to close). Modeled on
// electron/ops/ingest.locationRoundtrip.test.js's cross-device invariant test.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { deriveDayId } from './dayId.js'

const deviceId = 'device-1'
const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function seedCampDb(campId) {
  const file = path.join(os.tmpdir(), `shoresh-ingest-day-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const d = openLocalDb(file)
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
  return d
}

describe('T205 round 2: days_of_operation import mints a deterministic id', () => {
  it('stamps day_of_week at creation (not NULL) for an imported weekday', () => {
    const campId = randomUUID()
    const db = seedCampDb(campId)

    commitIngest(db, { approved: { days_of_operation: ['Monday'] }, camp_id: campId, device_id: deviceId })

    const row = db.prepare('SELECT id, day_of_week FROM days_of_operation WHERE camp_id = ?').get(campId)
    expect(row).toBeTruthy()
    expect(row.day_of_week).toBe(1)
    expect(row.id).toBe(deriveDayId(campId, 1))
    db.close()
  })

  it('two independent devices importing the same weekday converge to ONE id', () => {
    const sharedCampId = randomUUID()
    const dbA = seedCampDb(sharedCampId)
    const dbB = seedCampDb(sharedCampId)

    const importInput = { approved: { days_of_operation: ['Monday'] }, camp_id: sharedCampId, device_id: deviceId }
    commitIngest(dbA, importInput)
    commitIngest(dbB, importInput)

    const daysA = dbA.prepare('SELECT id, day_of_week FROM days_of_operation WHERE camp_id = ?').all(sharedCampId)
    const daysB = dbB.prepare('SELECT id, day_of_week FROM days_of_operation WHERE camp_id = ?').all(sharedCampId)
    expect(daysA).toEqual(daysB)
    expect(daysA).toHaveLength(1)
    expect(daysA[0].id).toBe(deriveDayId(sharedCampId, 1))
    dbA.close()
    dbB.close()
  })
})
