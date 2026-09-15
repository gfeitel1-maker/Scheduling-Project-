// @vitest-environment node
//
// T161: the support-command wrapper around the T151 rebuild property —
// precondition refusals (each one loud and specific, never a half-work
// result) plus the backup-then-report behavior a human runs this for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import { commitIngest } from '../ops/ingest.js'
import { seedAllFromSqlite } from './seed.js'
import { saveDoc, docPath } from '../sync/automerge/docStore.js'
import {
  validateRebuildSource,
  rebuildIntoFreshDb,
  rebuildProjectionFromDocumentAtPath,
  RebuildRefusalError,
} from './rebuildSupportCommand.js'

let files = []
let dirs = []
function newDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-rebuild-support-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return { db: openLocalDb(f), dbPath: f }
}
function newUserDataDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `shoresh-rebuild-support-${tag}-`))
  dirs.push(d)
  return d
}

// Same shape as rebuildFromDocument.test.js's buildRichCamp, trimmed to what
// this file's tests actually need to assert on (a real import plus one
// ordinary write) — the full richness (parent-scoped children, bulk-replace,
// tombstones) is already covered there; this file is about the refusal
// surface and the wrapper's backup/report behavior, not re-proving the
// projection property itself.
function buildCamp(db, campId, deviceId) {
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Probe', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device One')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
  commitIngest(db, {
    approved: {
      cohorts: ['Main'], tiers: ['Aleph'], groups: ['Bunk 1'],
      days_of_operation: ['Monday'], time_blocks: ['09:00-09:40'],
      activities: ['Swim'],
    },
    links: { groups: { 'Bunk 1': 'Aleph' } },
    activityRules: { Swim: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 1, priority: 'high' } },
    fixedEvents: [],
    camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add',
  })
  const locId = randomUUID()
  appendOp(db, { entity: 'locations', entity_id: locId, field: 'camp_id', value: campId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'locations', entity_id: locId, field: 'name', value: 'Lake', device_id: deviceId, author_user_id: 'u1' })
}

beforeEach(() => { files = []; dirs = [] })
afterEach(() => {
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  for (const d of dirs) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  files = []
  dirs = []
})

describe('validateRebuildSource — precondition refusals', () => {
  it('refuses a database with no camps row at all', () => {
    const { db } = newDb('no-camps')
    expect(() => validateRebuildSource(db, {})).toThrow(RebuildRefusalError)
    expect(() => validateRebuildSource(db, {})).toThrow(/no camps row/)
    db.close()
  })

  it('refuses when no document was found (doc is null)', () => {
    const { db } = newDb('no-doc-source')
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Probe')
    expect(() => validateRebuildSource(db, null)).toThrow(RebuildRefusalError)
    expect(() => validateRebuildSource(db, null)).toThrow(/no Automerge document file/)
    db.close()
  })

  it('refuses a document that does not share this camp\'s genesis', () => {
    const { db } = newDb('genesis-mismatch')
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Probe')
    const foreignDoc = A.init() // never derived from genesisDoc(); no shared history
    expect(() => validateRebuildSource(db, foreignDoc)).toThrow(RebuildRefusalError)
    expect(() => validateRebuildSource(db, foreignDoc)).toThrow(/does not share this camp's genesis/)
    db.close()
  })

  it("refuses when the camps row id does not match the document's camp", () => {
    const { db: otherDb } = newDb('other-source')
    const otherCampId = randomUUID()
    buildCamp(otherDb, otherCampId, 'device-1')
    const otherDoc = seedAllFromSqlite(otherDb)
    otherDb.close()

    const { db } = newDb('mismatch-target')
    const thisCampId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(thisCampId, 'Camp Probe')

    expect(() => validateRebuildSource(db, otherDoc)).toThrow(RebuildRefusalError)
    expect(() => validateRebuildSource(db, otherDoc)).toThrow(/does not match the camp the document holds/)
    db.close()
  })

  it('returns campId/campName on success', () => {
    const { db } = newDb('happy-validate')
    const campId = randomUUID()
    buildCamp(db, campId, 'device-1')
    const doc = seedAllFromSqlite(db)
    expect(validateRebuildSource(db, doc)).toEqual({ campId, campName: 'Camp Probe' })
    db.close()
  })
})

describe('rebuildIntoFreshDb — the T151 property, from this module\'s own entry point', () => {
  it('projects a rich camp into a genuinely fresh database and reports row counts before/after', () => {
    const { db: source } = newDb('happy-source')
    const campId = randomUUID()
    buildCamp(source, campId, 'device-1')
    const doc = seedAllFromSqlite(source)
    const expectedLocations = source.prepare('SELECT id, name FROM locations ORDER BY id').all()
    source.close()

    const { db: fresh } = newDb('happy-fresh')
    const result = rebuildIntoFreshDb(fresh, doc, campId, 'Camp Probe')

    expect(result.ok).toBe(true)
    expect(result.campId).toBe(campId)
    expect(result.before.locations).toBe(0)
    expect(result.after.locations).toBe(1)
    expect(fresh.prepare('SELECT id, name FROM locations ORDER BY id').all()).toEqual(expectedLocations)
    expect(result.notRecoverable).toMatch(/operations table/)
    expect(result.notRecoverable).toMatch(/Trash/)
    expect(result.notRecoverable).toMatch(/signing_secret/)
    expect(result.notRecoverable).toMatch(/cannot VERIFY credential changes/) // T165: rebuilt device credential-verify guidance
    fresh.close()
  })
})

describe('rebuildProjectionFromDocumentAtPath — file-path wrapper', () => {
  it('backs up the SQLite file, deletes and recreates it, and reports row counts before/after', () => {
    const { db, dbPath } = newDb('wrapper-happy')
    const campId = randomUUID()
    buildCamp(db, campId, 'device-1')
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('wrapper-happy')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const result = rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir })

    expect(result.ok).toBe(true)
    expect(result.before.locations).toBe(0) // fresh db before projection
    expect(result.after.locations).toBe(1)
    expect(fs.existsSync(result.backupPath)).toBe(true)
    expect(result.docPath).toBe(docPath(userDataDir, campId))

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT COUNT(*) AS n FROM locations').get().n).toBe(1)
    expect(verifyDb.prepare('SELECT id, name FROM camps').get()).toEqual({ id: campId, name: 'Camp Probe' })
    verifyDb.close()
    fs.unlinkSync(result.backupPath)
  })

  it('refuses without touching or backing up the database when no document file exists for this camp', () => {
    const { db, dbPath } = newDb('wrapper-no-doc')
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Probe')
    db.close()
    const userDataDir = newUserDataDir('wrapper-no-doc')

    expect(() => rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir })).toThrow(/no Automerge document file/)

    const dirEntries = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.startsWith(path.basename(dbPath)))
    expect(dirEntries.some((f) => f.includes('pre-migration'))).toBe(false)
  })

  it('refuses without touching or backing up the database when there is no camps row', () => {
    const { dbPath } = newDb('wrapper-no-camps')
    const userDataDir = newUserDataDir('wrapper-no-camps')

    expect(() => rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir })).toThrow(/no camps row/)

    // No pre-migration backup was written — only the db file itself (plus
    // SQLite's own WAL/SHM sidecars, unrelated to this rebuild) remain.
    const dirEntries = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.startsWith(path.basename(dbPath)))
    expect(dirEntries.some((f) => f.includes('pre-migration'))).toBe(false)
  })
})
