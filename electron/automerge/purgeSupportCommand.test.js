// @vitest-environment node
//
// T202: the camper-record purge path. Composes alongside rebuildSupportCommand.js rather than
// overloading it -- see docs/work/tickets/T202-camper-record-purge-path.md and ADR
// 2026-09-17-individual-elective-scheduling.md D10. Fixtures are built against the real
// electron/db/schema.sql columns (campers, elective_preferences, elective_assignments,
// operations), not hand-rolled shapes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import { seedAllFromSqlite } from './seed.js'
import { saveDoc, loadDoc } from '../sync/automerge/docStore.js'
import { sharesGenesis, recordKey } from './campDocument.js'
import { rebuildProjectionFromDocumentAtPath } from './rebuildSupportCommand.js'
import { purgeCamperRecord } from './purgeSupportCommand.js'

let files = []
let dirs = []
function newDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-purge-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return { db: openLocalDb(f), dbPath: f }
}
function newUserDataDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `shoresh-purge-${tag}-`))
  dirs.push(d)
  return d
}

function preMigrationBackups(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.pre-migration-`) && f.endsWith('.bak'))
}

beforeEach(() => { files = []; dirs = [] })
afterEach(() => {
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  for (const d of dirs) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  files = []
  dirs = []
})

function buildCampWithCamper(db, { campId, deviceId, camperId, groupId, prefId, runId, choiceId }) {
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Probe', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device One')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)

  appendOp(db, { entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'groups', entity_id: groupId, field: 'name', value: 'Bunk 1', device_id: deviceId, author_user_id: 'u1' })

  appendOp(db, { entity: 'campers', entity_id: camperId, field: 'camp_id', value: campId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'campers', entity_id: camperId, field: 'display_name', value: 'Sara K', device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'campers', entity_id: camperId, field: 'group_id', value: groupId, device_id: deviceId, author_user_id: 'u1' })

  appendOp(db, { entity: 'elective_preferences', entity_id: prefId, field: 'run_id', value: runId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'elective_preferences', entity_id: prefId, field: 'camper_id', value: camperId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'elective_preferences', entity_id: prefId, field: 'choice_id', value: choiceId, device_id: deviceId, author_user_id: 'u1' })
  appendOp(db, { entity: 'elective_preferences', entity_id: prefId, field: 'rank', value: 1, device_id: deviceId, author_user_id: 'u1' })
}

describe('purgeCamperRecord', () => {
  it('does NOT shred pre-migration backups from an ORDINARY rebuild (negative control)', () => {
    const { db, dbPath } = newDb('negctrl')
    const campId = randomUUID()
    const deviceId = 'device-1'
    buildCampWithCamper(db, {
      campId, deviceId,
      camperId: randomUUID(), groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('negctrl')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const result = rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir })
    expect(fs.existsSync(result.backupPath)).toBe(true)
    expect(preMigrationBackups(dbPath).length).toBe(1)
  })

  it('purges the camper, its dependent rows, this device op-log, and every pre-migration backup', () => {
    const { db, dbPath } = newDb('happy')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    const prefId = randomUUID()
    const groupId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId,
      prefId, runId: randomUUID(), choiceId: randomUUID(),
    })
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('happy')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const priorRebuild = rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir })
    expect(fs.existsSync(priorRebuild.backupPath)).toBe(true)
    expect(preMigrationBackups(dbPath).length).toBe(1)

    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    expect(result.campId).toBe(campId)

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    expect(verifyDb.prepare('SELECT * FROM elective_preferences WHERE camper_id = ?').all(camperId)).toEqual([])
    expect(verifyDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all(camperId)).toEqual([])
    expect(verifyDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all(prefId)).toEqual([])
    expect(verifyDb.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)).toBeTruthy()
    verifyDb.close()

    expect(preMigrationBackups(dbPath).length).toBe(0)

    const newDoc = loadDoc(userDataDir, campId)
    const changes = A.getAllChanges(newDoc)
    const touchesPurgedIds = changes.some((change) => {
      const decoded = A.decodeChange(change)
      return decoded.ops.some(
        (op) => typeof op.key === 'string' && (op.key.includes(camperId) || op.key.includes(prefId))
      )
    })
    expect(touchesPurgedIds).toBe(false)
  })

  it('non-vacuity: purges an operations row that was never materialized into a projection table', () => {
    const { db, dbPath } = newDb('opsonly')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    const groupId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId: randomUUID(), groupId,
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    appendOp(db, { entity: 'campers', entity_id: camperId, field: 'display_name', value: 'Ghost Camper', device_id: deviceId, author_user_id: 'u1' })
    db.prepare('DELETE FROM campers WHERE id = ?').run(camperId)
    expect(db.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    expect(db.prepare('SELECT * FROM operations WHERE entity_id = ?').all(camperId).length).toBeGreaterThan(0)

    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('opsonly')
    saveDoc(userDataDir, campId, doc)
    db.close()

    purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all(camperId)).toEqual([])
    verifyDb.close()
  })

  it('known gap: an untouched peer old document still shares genesis and could reintroduce the camper on merge', () => {
    const { db, dbPath } = newDb('gap')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    const oldPeerDoc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('gap')
    saveDoc(userDataDir, campId, oldPeerDoc)
    db.close()

    purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
    const purgedDoc = loadDoc(userDataDir, campId)

    expect(sharesGenesis(oldPeerDoc)).toBe(true)
    expect(sharesGenesis(purgedDoc)).toBe(true)

    const merged = A.merge(A.clone(purgedDoc), oldPeerDoc)
    const camperKeyPrefix = recordKey(camperId, '')
    const reintroduced = Object.keys(merged.campers || {}).some((k) => k.startsWith(camperKeyPrefix))
    expect(reintroduced).toBe(true)
  })
})
