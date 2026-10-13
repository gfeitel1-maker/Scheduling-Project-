// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { setUserDataDirGetter, resetForTests } from '../../sync/automerge/liveDoc.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { exportCampFile, serializeCampFile } from './exportCampFile.js'
import { EXPORTED_ENTITIES, LEARNED_TABLES, fileFieldsOf } from './campFileScope.js'
import { makeFreshCamp, buildFixtureCamp } from './campFileTestSupport.js'

afterAll(() => cleanupTemplatedDbs())

let dir
let db
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-campfile-export-'))
  setUserDataDirGetter(() => dir)
  db = openTemplatedDb().db
})
afterEach(() => {
  resetForTests()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const camp = makeFreshCamp(db, { name: 'Export camp' })
  const ids = buildFixtureCamp(db, camp)
  return { camp, ids }
}

describe('exportCampFile', () => {
  it('writes the envelope: format, version, schema version, camp name, per-entity counts, every exported entity', () => {
    const { camp } = fixture()
    const file = exportCampFile(db, camp.campId, { appVersion: '9.9.9' })
    expect(file.format).toBe('shoresh-camp')
    expect(file.version).toBe(1)
    expect(file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(file.appVersion).toBe('9.9.9')
    expect(typeof file.exportedAt).toBe('string')
    expect(file.camp).toEqual({ name: 'Export camp' })
    expect(Object.keys(file.entities)).toEqual(EXPORTED_ENTITIES)
    for (const e of EXPORTED_ENTITIES) expect(file.counts[e]).toBe(file.entities[e].length)
    expect(Object.keys(file.learned.tables).sort()).toEqual(Object.keys(LEARNED_TABLES).sort())
    for (const t of Object.keys(LEARNED_TABLES)) expect(file.learned.counts[t]).toBe(file.learned.tables[t].length)
  })

  it('exports real rows for every entity the fixture fills, and for every learned table', () => {
    const { camp } = fixture()
    const file = exportCampFile(db, camp.campId)
    const empty = EXPORTED_ENTITIES.filter((e) => file.entities[e].length === 0)
    expect(empty).toEqual([])
    for (const t of Object.keys(LEARNED_TABLES)) expect(file.learned.tables[t].length).toBeGreaterThan(0)
  })

  it('a row holds only its id and its declared file fields, never camp_id or a user id', () => {
    const { camp } = fixture()
    const file = exportCampFile(db, camp.campId)
    for (const e of EXPORTED_ENTITIES) {
      const allowed = new Set(['id', ...fileFieldsOf(e)])
      for (const row of file.entities[e]) expect(Object.keys(row).filter((k) => !allowed.has(k))).toEqual([])
    }
    for (const [t, spec] of Object.entries(LEARNED_TABLES)) {
      const allowed = new Set(spec.columns)
      for (const row of file.learned.tables[t]) expect(Object.keys(row).filter((k) => !allowed.has(k))).toEqual([])
    }
  })

  it('carries no secret, credential, user id or signing key anywhere in the file text', () => {
    const { camp } = fixture()
    const text = serializeCampFile(exportCampFile(db, camp.campId))
    const secrets = db.prepare('SELECT signing_secret, signing_public_key FROM camps').get()
    const user = db.prepare('SELECT id, pin_hash, pin_salt, auth_sig FROM users').get()
    const hostPrivate = db.prepare('SELECT private_key FROM host_signing_key').get().private_key
    for (const s of [secrets.signing_secret, secrets.signing_public_key, user.id, user.pin_hash, user.pin_salt, user.auth_sig, hostPrivate, camp.deviceId]) {
      expect(s && text.includes(s)).toBeFalsy()
    }
    expect(text.includes('"users"')).toBe(false)
    expect(text.includes('"campers"')).toBe(false)
    expect(text.includes('pin_hash')).toBe(false)
  })

  it('is deterministic: two exports differ only in exportedAt', () => {
    const { camp } = fixture()
    const a = exportCampFile(db, camp.campId, { now: () => '2026-10-13T00:00:00.000Z' })
    const b = exportCampFile(db, camp.campId, { now: () => '2026-10-13T00:00:00.000Z' })
    expect(serializeCampFile(a)).toBe(serializeCampFile(b))
  })

  it('refuses a camp id that is not this database camp', () => {
    const { camp } = fixture()
    expect(() => exportCampFile(db, `${camp.campId}-other`)).toThrow(/camp/)
  })

  it('never lets a dangling reference out: a nullable one is nulled, a required one drops its row, both reported', () => {
    const { camp, ids } = fixture()
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM locations WHERE id = ?').run(ids.field)
    db.prepare('DELETE FROM groups WHERE id = ?').run(ids.g2)
    db.prepare('DELETE FROM events WHERE id = ?').run(ids.eventId2)
    const report = {}
    const file = exportCampFile(db, camp.campId, { report })
    const swimEvent = file.entities.fixed_events.find((r) => r.name === 'Davening')
    expect(swimEvent.location_id).toBeNull()
    expect(JSON.parse(file.entities.activities.find((r) => r.name === 'Archery').eligible_group_ids)).toEqual([ids.g1])
    expect(file.entities.event_groups.some((r) => r.event_id === ids.eventId2)).toBe(false)
    expect(file.entities.event_slots.some((r) => r.event_id === ids.eventId2)).toBe(false)
    expect(file.counts.event_slots).toBe(file.entities.event_slots.length)
    expect(report.nulledReferences).toBeGreaterThan(0)
    expect(report.droppedRows).toBeGreaterThan(0)
  })
})
