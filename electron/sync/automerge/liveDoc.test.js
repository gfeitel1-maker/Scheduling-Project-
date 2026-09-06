// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../../db/localDb.js'
import { docPath, loadDoc } from './docStore.js'
import { recordLocalWrite, setUserDataDirGetter, resetForTests } from './liveDoc.js'

let userDataDir
let tmpFile
let db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-livedoc-test-'))
  setUserDataDirGetter(() => userDataDir)

  tmpFile = path.join(os.tmpdir(), `shoresh-livedoc-db-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  resetForTests()
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe('recordLocalWrite', () => {
  it('mirrors a modeled-entity write into the persisted doc, keyed by the db camp id', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(doc.groups.g1.name).toBe('Bunk A')
  })

  it('accumulates multiple writes into the same doc', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    recordLocalWrite(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(doc.groups.g1.name).toBe('Bunk A')
    expect(doc.activities.a1.name).toBe('Swim')
  })

  it('does nothing for an unmodeled entity (e.g. day_overrides) — no doc file is created', () => {
    recordLocalWrite(db, {
      entity: 'day_overrides',
      entity_id: 'd1',
      field: 'reason',
      value: 'holiday',
    })

    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(false)
  })

  it('does nothing for template_slots (bulk-replace only entity)', () => {
    recordLocalWrite(db, {
      entity: 'template_slots',
      entity_id: 's1',
      field: 'activity_id',
      value: 'a1',
    })

    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(false)
  })

  it('does nothing when the db has no camp row yet', () => {
    const freshTmpFile = path.join(os.tmpdir(), `shoresh-livedoc-nocamp-${Date.now()}.sqlite`)
    const freshDb = openLocalDb(freshTmpFile)
    try {
      recordLocalWrite(freshDb, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'X' })
      expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(false)
    } finally {
      freshDb.close()
      fs.unlinkSync(freshTmpFile)
    }
  })

  it('applies DELETE_FIELD by removing the entity row from the doc', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: '__deleted__', value: 1 })

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(doc.groups.g1).toBeUndefined()
  })
})
