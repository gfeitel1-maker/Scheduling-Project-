// @vitest-environment node
//
// T205 round 2, FIX 2's required end-to-end proof: two devices, each holding
// the SAME pre-existing document (both duplicate days_of_operation rows
// already synced BEFORE either device runs the v70 migration — the actual
// shape a real duplicate-onboarding camp is in at upgrade time), each
// independently migrate + resolve, and the RESULT — read back from the
// documents themselves, merged, not from which functions were called — is one
// surviving row per weekday with the loser tombstoned.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb, initSchema } from './localDb.js'
import { resolvePendingDomainStateMigrations } from './migrationDomainState.js'
import { createEmptyDoc, applyWrite, readRecord, listRecordIds } from '../automerge/campDocument.js'
import { saveDoc as saveDocToDisk } from '../sync/automerge/docStore.js'
import { setUserDataDirGetter, resetForTests, ensureSeeded, getDocIfLoaded } from '../sync/automerge/liveDoc.js'

const CAMP_ID = 'shared-camp'
const SURVIVOR_ID = 'aaaa-legacy' // lexicographically smaller than LOSER_ID — FIX 3's fallback rule
const LOSER_ID = 'zzzz-legacy'

const cleanupPaths = []

afterEach(() => {
  resetForTests()
  for (const p of cleanupPaths.splice(0)) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  }
})

function buildPreExistingDoc() {
  let doc = createEmptyDoc()
  for (const [id, label] of [[SURVIVOR_ID, 'Monday'], [LOSER_ID, 'Monday (dup)']]) {
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: CAMP_ID })
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: id, field: 'label', value: label })
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: id, field: 'day_of_week', value: 1 })
  }
  return doc
}

// Runs one "device": pre-seeds its userDataDir with the SAME already-synced
// document (both duplicate rows present), builds a SQLite db in the SAME
// duplicate shape, migrates (dedupes + records the marker), resolves
// (authors the document tombstone for the recorded loser), and returns the
// resulting document.
function runDevice(deviceId) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `shoresh-resolve-2dev-${deviceId}-`))
  cleanupPaths.push(userDataDir)
  setUserDataDirGetter(() => userDataDir)
  saveDocToDisk(userDataDir, CAMP_ID, buildPreExistingDoc(), null)

  const sqliteFile = path.join(os.tmpdir(), `shoresh-resolve-2dev-${deviceId}-${Date.now()}-${Math.random()}.sqlite`)
  cleanupPaths.push(sqliteFile)
  const db = openLocalDb(sqliteFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device')
  db.exec('DROP TABLE days_of_operation')
  db.exec(`
    CREATE TABLE days_of_operation (
      id TEXT PRIMARY KEY, camp_id TEXT NOT NULL REFERENCES camps(id),
      label TEXT NOT NULL, day_of_week INTEGER, sort_order INTEGER
    )
  `)
  db.prepare('DELETE FROM schema_migrations WHERE version >= 70').run()
  db.prepare(
    "INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, 'Monday', 1)"
  ).run(SURVIVOR_ID, CAMP_ID)
  db.prepare(
    "INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, 'Monday (dup)', 1)"
  ).run(LOSER_ID, CAMP_ID)

  initSchema(db) // v70 migration: dedupes SQLite, records the marker with LOSER_ID
  ensureSeeded(db) // loads the PRE-EXISTING document from disk (both rows still present)
  const resolvedVersions = resolvePendingDomainStateMigrations(db, { device_id: deviceId })

  const doc = getDocIfLoaded(db)
  db.close()
  return { doc, resolvedVersions }
}

describe('T205 round 2 FIX 2: two-device document-routed resolve converges', () => {
  it('each device independently tombstones the SAME loser in its own document', () => {
    const a = runDevice('device-a')
    expect(a.resolvedVersions).toEqual([70])
    expect(readRecord(a.doc, 'days_of_operation', LOSER_ID)).toBeNull()
    expect(readRecord(a.doc, 'days_of_operation', SURVIVOR_ID)).toBeTruthy()

    const b = runDevice('device-b')
    expect(b.resolvedVersions).toEqual([70])
    expect(readRecord(b.doc, 'days_of_operation', LOSER_ID)).toBeNull()
    expect(readRecord(b.doc, 'days_of_operation', SURVIVOR_ID)).toBeTruthy()
  })

  it('merging both devices\' resulting documents yields exactly ONE surviving row per weekday, loser gone', () => {
    const a = runDevice('device-a')
    const b = runDevice('device-b')

    const merged = A.merge(A.clone(a.doc), b.doc)

    const ids = listRecordIds(merged, 'days_of_operation')
    expect(ids.sort()).toEqual([SURVIVOR_ID])
    expect(readRecord(merged, 'days_of_operation', LOSER_ID)).toBeNull()
    expect(readRecord(merged, 'days_of_operation', SURVIVOR_ID).day_of_week).toBe(1)
  })
})
