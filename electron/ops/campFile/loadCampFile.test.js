// @vitest-environment node
//
// THE EQUALITY TEST (ADR section 6). Camp A is built through the real write paths and exported; the file is opened
// into a brand-new camp B; then every exported table of A and B is compared after id normalization, in B's SQLite and
// in B's Automerge document, and the identity that must not cross (users, keys, the camp id itself) is shown absent.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { setUserDataDirGetter, resetForTests, getCurrentDoc, ensureSeeded, flushPendingWrites } from '../../sync/automerge/liveDoc.js'
import { rebuildIntoFreshDb } from '../../automerge/rebuildSupportCommand.js'
import { listRecordIds } from '../../automerge/campDocument.js'
import { appendOp, appendBulkReplaceOp } from '../operations.js'
import { exportCampFile, serializeCampFile } from './exportCampFile.js'
import { validateCampFile } from './validateCampFile.js'
import { loadCampFile, readLoadIncomplete } from './loadCampFile.js'
import { EXPORTED_ENTITIES, LEARNED_TABLES } from './campFileScope.js'
import {
  makeFreshCamp, buildFixtureCamp, putter, normalizedCampSnapshot, tableCounts, wholeDatabaseText,
} from './campFileTestSupport.js'
import { defaultWeekId } from '../../../src/ingest/defaultWeek.js'
import { deriveScheduleTemplateId } from '../scheduleTemplateId.js'

afterAll(() => cleanupTemplatedDbs())

let dir
let dbs
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-campfile-load-'))
  setUserDataDirGetter(() => dir)
  dbs = []
})
afterEach(() => {
  resetForTests()
  for (const d of dbs) d.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
const newDb = () => {
  const { db } = openTemplatedDb()
  dbs.push(db)
  return db
}

// A is built once per test: it is the expensive part, and every test starts from a clean disk.
function buildA() {
  const dbA = newDb()
  const A = makeFreshCamp(dbA, { name: 'Roundtrip camp' })
  const ids = buildFixtureCamp(dbA, A)
  const exported = exportCampFile(dbA, A.campId)
  const text = serializeCampFile(exported)
  const checked = validateCampFile(text)
  expect(checked.ok).toBe(true)
  return { dbA, A, ids, exported, text, file: checked.file }
}

function openInto(file, { prepare, ...options } = {}) {
  const db = newDb()
  const B = makeFreshCamp(db, { name: 'Roundtrip camp' })
  prepare?.(db, B)
  const result = loadCampFile(db, { file, campId: B.campId, author_user_id: B.userId, device_id: B.deviceId, ...options })
  return { db, B, result }
}

function expectEveryTableEqual(snapA, snapB) {
  expect(Object.keys(snapB)).toEqual(Object.keys(snapA))
  for (const table of Object.keys(snapA)) {
    expect({ table, rows: snapB[table] }).toEqual({ table, rows: snapA[table] })
  }
}

describe('open a saved camp into a brand-new camp: the exact round trip', () => {
  it('every exported table, and every learned table, comes out equal after id normalization', () => {
    const { dbA, A, file } = buildA()
    const cpuBefore = process.cpuUsage()
    const { db: dbB, B, result } = openInto(file)
    const cpu = process.cpuUsage(cpuBefore)
    if (process.env.CAMPFILE_CPU_OUT) fs.appendFileSync(process.env.CAMPFILE_CPU_OUT, `load+bootstrap cpu user=${cpu.user / 1000}ms system=${cpu.system / 1000}ms ops=${dbB.prepare("SELECT COUNT(*) AS n FROM operations WHERE client_write_id LIKE 'camp-load:%'").get().n}\n`)

    expect(result).toMatchObject({ ok: true })
    const snapA = normalizedCampSnapshot(dbA, A)
    const snapB = normalizedCampSnapshot(dbB, B)
    expectEveryTableEqual(snapA, snapB)
    expect(result.counts).toEqual(Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, snapA[e].length])))
    for (const e of EXPORTED_ENTITIES) expect(snapB[e].length).toBeGreaterThan(0)
    for (const t of Object.keys(LEARNED_TABLES)) expect(snapB[t].length).toBeGreaterThan(0)
    expect(readLoadIncomplete(dbB)).toBeNull()
    expect(cpu.user + cpu.system).toBeLessThan(120_000_000)
  }, 120_000)

  it('keeps every random id byte for byte, and re-derives the ones that embed the camp id', () => {
    const { ids, file } = buildA()
    const { db: dbB, B } = openInto(file)
    for (const [table, id] of [
      ['groups', ids.g1], ['activities', ids.swim], ['tiers', ids.tierA], ['locations', ids.field], ['schedule_weeks', ids.week2],
      ['schedule_templates', ids.tplWeek2], ['events', ids.eventId], ['camp_maps', ids.mapId], ['schedule_snapshots', ids.snap1],
    ]) {
      expect(dbB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)).toBeTruthy()
    }
    expect(dbB.prepare('SELECT id FROM days_of_operation WHERE day_of_week = 1').get().id).toBe(`day:${B.campId}:1`)
    expect(dbB.prepare('SELECT id FROM schedule_weeks WHERE name = ?').get('Week 1').id).toBe(defaultWeekId(B.campId))
    expect(dbB.prepare("SELECT id FROM schedule_templates WHERE kind = 'manual' AND week_id = ?").get(defaultWeekId(B.campId)).id)
      .toBe(deriveScheduleTemplateId(defaultWeekId(B.campId), 'manual'))
    expect(dbB.prepare("SELECT id FROM locations WHERE name = 'Lake'").get().id).toBe(`location:${B.campId}:Lake`)
    expect(dbB.prepare("SELECT id FROM cohorts WHERE name = 'Main'").get().id).toBe(`cohort:${B.campId}:main`)
  }, 120_000)

  it('adopts the days and Main cohort a fresh camp already owns instead of adding a second set', () => {
    const { file } = buildA()
    const { db: dbB } = openInto(file)
    expect(dbB.prepare('SELECT COUNT(*) AS n FROM days_of_operation').get().n).toBe(file.entities.days_of_operation.length)
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM cohorts WHERE name = 'Main'").get().n).toBe(1)
  }, 120_000)

  it('adopts a default week and its template pair when the fresh camp already has them', () => {
    const { dbA, A, file } = buildA()
    const { db: dbB, B, result } = openInto(file, {
      prepare: (db, camp) => {
        const put = putter(db, camp)
        const week = put('schedule_weeks', defaultWeekId(camp.campId), { name: 'Week 1', sort_order: 0, is_archived: 0 })
        put('schedule_templates', deriveScheduleTemplateId(week, 'generated'), { kind: 'generated', week_id: week, name: 'Generated' })
      },
    })
    expect(result.ok).toBe(true)
    expectEveryTableEqual(normalizedCampSnapshot(dbA, A), normalizedCampSnapshot(dbB, B))
  }, 120_000)

  it('shares no identity with camp A: not its camp id, user, keys, device or credentials appear anywhere in B', () => {
    const { dbA, A, file } = buildA()
    const { db: dbB, B } = openInto(file)
    const bText = wholeDatabaseText(dbB)
    const aSecrets = dbA.prepare('SELECT signing_secret, signing_public_key FROM camps').get()
    const aUser = dbA.prepare('SELECT id, pin_hash, pin_salt, auth_sig FROM users').get()
    const aHostPrivate = dbA.prepare('SELECT private_key FROM host_signing_key').get().private_key
    for (const s of [A.campId, A.userId, A.deviceId, aSecrets.signing_secret, aSecrets.signing_public_key, aUser.pin_hash, aUser.pin_salt, aUser.auth_sig, aHostPrivate]) {
      expect(bText.includes(s)).toBe(false)
    }
    expect(dbB.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(1)
    expect(dbB.prepare('SELECT id FROM users').get().id).toBe(B.userId)
    expect(dbB.prepare('SELECT signing_public_key FROM camps').get().signing_public_key).not.toBe(aSecrets.signing_public_key)
  }, 120_000)

  it('stamps the director who opens the file on every remembered answer, so they stay qualified authors', () => {
    const { file } = buildA()
    const { db: dbB, B } = openInto(file)
    const authors = dbB.prepare('SELECT DISTINCT confirmed_by AS by FROM camp_seedlings').all().map((r) => r.by)
    expect(authors).toEqual([B.userId])
  }, 120_000)

  it('writes through the real primitives with deterministic client write ids, and the document agrees with SQLite', () => {
    const { file } = buildA()
    const { db: dbB, B } = openInto(file)
    const ids = dbB.prepare("SELECT client_write_id FROM operations WHERE client_write_id LIKE 'camp-load:%'").all()
    expect(ids.length).toBeGreaterThan(100)
    expect(new Set(ids.map((r) => r.client_write_id)).size).toBe(ids.length)
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM operations WHERE entity = 'template_slots' AND field = '__bulk_replace__'").get().n).toBe(2)

    flushPendingWrites()
    const doc = getCurrentDoc(dbB) ?? ensureSeeded(dbB)
    expect(listRecordIds(doc, 'groups').length).toBe(file.entities.groups.length)
    const fresh = newDb()
    rebuildIntoFreshDb(fresh, doc, B.campId, 'Roundtrip camp')
    const fromDoc = normalizedCampSnapshot(fresh, B)
    const fromSqlite = normalizedCampSnapshot(dbB, B)
    for (const e of EXPORTED_ENTITIES) expect({ e, rows: fromDoc[e] }).toEqual({ e, rows: fromSqlite[e] })
    expect(tableCounts(fromDoc)).toMatchObject(Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, file.counts[e]])))
  }, 120_000)

  it('opening the same file twice yields two equal camps', () => {
    const { file } = buildA()
    const first = openInto(file)
    const second = openInto(file)
    expectEveryTableEqual(normalizedCampSnapshot(first.db, first.B), normalizedCampSnapshot(second.db, second.B))
  }, 180_000)

  it('saving B again gives back the file for A, after normalization', () => {
    const { A, file } = buildA()
    const { db: dbB, B } = openInto(file)
    const again = exportCampFile(dbB, B.campId)
    const digest12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
    const norm = (f, campId) => {
      let text = JSON.stringify(f)
      for (const row of f.entities.camp_seedlings) text = text.split(digest12(row.id)).join(`digest(${row.id.split(campId).join('<CAMP>')})`)
      const copy = JSON.parse(text.split(campId).join('<CAMP>'))
      delete copy.exportedAt
      for (const rows of Object.values(copy.entities)) rows.sort((a, b) => (a.id < b.id ? -1 : 1))
      for (const rows of Object.values(copy.learned.tables)) rows.sort((a, b) => (a.id < b.id ? -1 : 1))
      return copy
    }
    const strip = (f) => {
      for (const rows of Object.values(f.entities)) for (const row of rows) for (const k of ['payload', 'slots']) if (typeof row[k] === 'string') row[k] = JSON.stringify(JSON.parse(row[k]))
      return f
    }
    const a = strip(norm(file, A.campId))
    const b = strip(norm(again, B.campId))
    for (const e of Object.keys(a.entities)) expect({ e, rows: b.entities[e] }).toEqual({ e, rows: a.entities[e] })
    expect(b.learned).toEqual(a.learned)
    expect(b.counts).toEqual(a.counts)
    expect(b.camp).toEqual(a.camp)
  }, 180_000)
})

describe('a file with nothing in it', () => {
  it('loads when every entity key is simply absent, leaving the fresh camp as bootstrap made it', () => {
    const { file } = buildA()
    const empty = { ...file, entities: {}, learned: { tables: {}, counts: {} }, counts: Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, 0])) }
    const db = newDb()
    const B = makeFreshCamp(db, { name: 'Roundtrip camp' })
    const before = wholeDatabaseText(db)
    const result = loadCampFile(db, { file: empty, campId: B.campId, author_user_id: B.userId, device_id: B.deviceId })
    expect(result).toMatchObject({ ok: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM days_of_operation').get().n).toBe(5)
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(0)
    expect(wholeDatabaseText(db).includes('camp.loaded')).toBe(true)
    expect(before).toBeTruthy()
  }, 60_000)

  it('removes the fresh camp\'s own weekday rows that the saved camp did not have, once the file names any day', () => {
    const { file } = buildA()
    const trimmed = JSON.parse(JSON.stringify(file))
    trimmed.entities.days_of_operation = trimmed.entities.days_of_operation.filter((d) => d.day_of_week <= 3)
    trimmed.counts.days_of_operation = trimmed.entities.days_of_operation.length
    for (const key of ['template_slots', 'schedule_snapshots', 'fixed_events', 'elective_bundle_periods', 'elective_sets', 'special_day_placements']) {
      trimmed.entities[key] = []
      trimmed.counts[key] = 0
    }
    const dropAll = (t) => { trimmed.entities[t] = []; trimmed.counts[t] = 0 }
    for (const t of ['elective_set_activities', 'elective_bundles', 'elective_bundle_tiers', 'special_day_slots', 'special_day_time_blocks', 'special_days', 'event_slots']) dropAll(t)
    const { db, result } = openInto(trimmed)
    expect(result).toMatchObject({ ok: true })
    expect(db.prepare('SELECT day_of_week FROM days_of_operation ORDER BY day_of_week').all().map((r) => r.day_of_week)).toEqual([1, 2, 3])
    expect(result.report.deletedBootstrapRows).toBe(2)
  }, 120_000)
})

describe('refusals and failure', () => {
  it('refuses a camp that already holds setup data, and writes nothing', () => {
    const { file } = buildA()
    const db = newDb()
    const B = makeFreshCamp(db, { name: 'Roundtrip camp' })
    putter(db, B)('groups', 'g-existing', { name: 'Existing bunk' })
    const before = wholeDatabaseText(db)
    const result = loadCampFile(db, { file, campId: B.campId, author_user_id: B.userId, device_id: B.deviceId })
    expect(result).toMatchObject({ ok: false, reason: 'camp_not_empty', detail: { entity: 'groups' } })
    expect(wholeDatabaseText(db)).toBe(before)
    expect(readLoadIncomplete(db)).toBeNull()
  }, 120_000)

  it('refuses to open the same file a second time into the camp it already filled', () => {
    const { file } = buildA()
    const { db, B } = openInto(file)
    const again = loadCampFile(db, { file, campId: B.campId, author_user_id: B.userId, device_id: B.deviceId })
    expect(again).toMatchObject({ ok: false, reason: 'camp_not_empty' })
  }, 120_000)

  it('refuses a campId that is not the camp on this device', () => {
    const { file } = buildA()
    const db = newDb()
    const B = makeFreshCamp(db)
    expect(() => loadCampFile(db, { file, campId: 'some-other-camp', author_user_id: B.userId, device_id: B.deviceId })).toThrow(/camp/)
  })

  it('re-validates what it is handed: a file that was never validated is rejected, not half-loaded', () => {
    const { file } = buildA()
    const db = newDb()
    const B = makeFreshCamp(db)
    const bad = JSON.parse(JSON.stringify(file))
    bad.entities.groups[0].pin_hash = 'x'
    expect(loadCampFile(db, { file: bad, campId: B.campId, author_user_id: B.userId, device_id: B.deviceId })).toMatchObject({ ok: false, reason: 'unknown_field' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(0)
  })

  it('a failure after N writes leaves the load-incomplete marker set, returns load_incomplete, and rolls back every store', () => {
    const { file } = buildA()
    let writes = 0
    const writers = {
      appendOp: (db, op) => {
        writes += 1
        if (writes === 40) throw new Error('disk full (injected)')
        return appendOp(db, op)
      },
      appendBulkReplaceOp,
    }
    const { db, B, result } = openInto(file, { writers })
    expect(result).toMatchObject({ ok: false, reason: 'load_incomplete' })
    expect(result.detail.message).toMatch(/injected/)
    expect(readLoadIncomplete(db)).toMatchObject({ loadId: expect.any(String) })
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM operations WHERE client_write_id LIKE 'camp-load:%'").get().n).toBe(0)
    flushPendingWrites()
    const doc = getCurrentDoc(db) ?? ensureSeeded(db)
    expect(listRecordIds(doc, 'groups')).toEqual([])
    expect(listRecordIds(doc, 'activities')).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM camps').get().n).toBe(1)
    expect(B.campId).toBeTruthy()
  }, 120_000)

  it('a retry on the same fresh camp after a failed load succeeds and clears the marker', () => {
    const { dbA, A, file } = buildA()
    let writes = 0
    const flaky = {
      appendOp: (db, op) => {
        writes += 1
        if (writes === 25) throw new Error('flake')
        return appendOp(db, op)
      },
      appendBulkReplaceOp,
    }
    const { db, B, result } = openInto(file, { writers: flaky })
    expect(result.reason).toBe('load_incomplete')
    const retry = loadCampFile(db, { file, campId: B.campId, author_user_id: B.userId, device_id: B.deviceId })
    expect(retry.ok).toBe(true)
    expect(readLoadIncomplete(db)).toBeNull()
    expectEveryTableEqual(normalizedCampSnapshot(dbA, A), normalizedCampSnapshot(db, B))
  }, 180_000)

  it('a document flush that fails after SQLite committed is a load_incomplete, not an ok, and the marker stays', () => {
    const { file } = buildA()
    const writers = { appendOp, appendBulkReplaceOp, afterEntities: () => setUserDataDirGetter(() => { throw new Error('document store unavailable (injected)') }) }
    const { db, result } = openInto(file, { writers })
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBeGreaterThan(0)
    expect(result).toMatchObject({ ok: false, reason: 'load_incomplete' })
    expect(readLoadIncomplete(db)).not.toBeNull()
  }, 120_000)

  it('a failure while writing the learned tables also leaves the marker set and the camp untouched', () => {
    const { file } = buildA()
    const { db, result } = openInto(file, { writers: { appendOp, appendBulkReplaceOp, afterEntities: () => { throw new Error('learned write failed (injected)') } } })
    expect(result).toMatchObject({ ok: false, reason: 'load_incomplete' })
    expect(readLoadIncomplete(db)).not.toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_aliases').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(0)
  }, 120_000)
})

describe('cohorts are matched by id, never by name', () => {
  const withCohorts = (mutate) => {
    const { exported } = buildA()
    const file = JSON.parse(serializeCampFile(exported))
    mutate(file.entities.cohorts)
    file.counts.cohorts = file.entities.cohorts.length
    return file
  }
  const names = (db) => db.prepare('SELECT name FROM cohorts ORDER BY name, id').all().map((r) => r.name)

  it('two cohorts both named Main (the original and a new one) open as two cohorts', () => {
    const file = withCohorts((rows) => rows.push({ ...rows[0], id: randomUUID() }))
    const { db, result } = openInto(file)
    expect(result.detail).toBeUndefined()
    expect(result).toMatchObject({ ok: true })
    expect(names(db)).toEqual(['Main', 'Main'])
  })

  it('a renamed original main plus a new cohort named Main open as both', () => {
    const file = withCohorts((rows) => { rows.push({ ...rows[0], id: randomUUID() }); rows[0].name = 'Juniors' })
    const { db, result } = openInto(file)
    expect(result).toMatchObject({ ok: true })
    expect(names(db)).toEqual(['Juniors', 'Main'])
    expect(db.prepare("SELECT name FROM cohorts WHERE id LIKE 'cohort:%:main'").get().name).toBe('Juniors')
  })
})
