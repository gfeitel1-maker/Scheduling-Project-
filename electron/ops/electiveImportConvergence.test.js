import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { applyProjection } from './projections.js'
import { commitIngest } from './ingest.js'

// T371: two devices importing the same file must converge on the same
// elective set and activity rows, not a named set plus a nameless stub.

afterAll(() => cleanupTemplatedDbs?.())

const CAMP = 'camp-t371'

function device(id) {
  const t = openTemplatedDb()
  t.db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(CAMP, 'Camp', 'a'.repeat(64))
  t.db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(id, id)
  return t
}

function importInto(db, deviceId) {
  commitIngest(db, {
    approved: {}, camp_id: CAMP, device_id: deviceId,
    confirmedElectiveSets: [{ name: 'Chugim', choices: ['Swim', 'Fishing'] }],
  })
}

function replay(from, to) {
  for (const op of from.prepare('SELECT * FROM operations ORDER BY seq ASC').all()) {
    try { applyProjection(to, op) } catch { /* a colliding op is dropped, as the merge path does */ }
  }
}

describe('T371 two devices import the same electives', () => {
  it('converge on one named set, one activity per choice, one join row per pair', () => {
    const a = device('dev-a')
    const b = device('dev-b')
    importInto(a.db, 'dev-a')
    importInto(b.db, 'dev-b')
    replay(a.db, b.db)
    replay(b.db, a.db)
    for (const { db } of [a, b]) {
      expect(db.prepare('SELECT name FROM elective_sets').all().map((r) => r.name)).toEqual(['Chugim'])
      expect(db.prepare("SELECT COUNT(*) c FROM elective_sets WHERE name = ''").get().c).toBe(0)
      expect(db.prepare('SELECT name FROM activities ORDER BY name').all().map((r) => r.name)).toEqual(['Fishing', 'Swim'])
      expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(2)
      expect(db.prepare('SELECT COUNT(DISTINCT elective_set_id || activity_id) c FROM elective_set_activities').get().c).toBe(2)
    }
    for (const t of [a, b]) { t.db.close(); if (fs.existsSync(t.file)) fs.unlinkSync(t.file) }
  })
})
