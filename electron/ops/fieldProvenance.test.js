// @vitest-environment node
//
// docs/adr/2026-09-09-field-provenance-in-the-document.md.
//
// The defect this closes was not found by unit tests — 5,000 of them passed
// while it was live. It was found by asking what `applyWrite` actually carries
// between devices, after an integration test for the op-log control it replaced
// was deleted with the WebSocket layer. So these tests are written against the
// DIRECTOR'S outcome ("does the correction survive?") rather than against the
// mechanism, which is what the previous coverage got wrong.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { isHumanOwned } from './fieldProvenance.js'
import {
  createEmptyDoc,
  applyWrite,
  isHumanEdited,
  provenanceKey,
  PROVENANCE_COLLECTION,
  HUMAN_PROVENANCE,
} from '../automerge/campDocument.js'
import { seedDocFromSqlite } from '../automerge/seed.js'

// The record/provenance key delimiter, built rather than typed. A literal NUL in
// a source file makes plain `grep` treat it as binary and SILENTLY return zero
// matches — see docs/current/CRDT_SECURITY_GAPS.md's note on the same trap in
// reconcile.js. Constructing it keeps this file searchable.
const NUL = String.fromCharCode(0)

let db
let dbFile
let campId

beforeEach(() => {
  dbFile = path.join(os.tmpdir(), `shoresh-prov-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(dbFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run('device-1', 'This device', new Date().toISOString(), randomBytes(32).toString('hex'))
})

afterEach(() => {
  try { db?.close() } catch { /* already closed */ }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try { fs.rmSync(f, { force: true }) } catch { /* best effort */ }
  }
})

describe('provenance in the document', () => {
  it('marks a human write and leaves an import write unmarked', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: 'human' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a2', field: 'name', value: 'Archery', source: 'import' })

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(true)
    expect(isHumanEdited(doc, 'activities', 'a2', 'name')).toBe(false)
  })

  it('treats a NULL source as human, matching the op-log rule', () => {
    // ADR 2026-08-08-s2a §2: an unlabelled write counts as a hand edit, and
    // appendOp defaults `source = null`. Reversing this would quietly unprotect
    // every op that does not name a source — most of them. Pinned because the
    // failure is invisible: nothing errors, edits just stop being protected.
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: null })

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(true)
  })

  it('CLEARS the marker when an import later takes ownership', () => {
    // A director accepting an imported value (S2b stale-accept passes
    // source:'import') hands the field back to the importer. A marker that only
    // accumulated would freeze the field against every future re-import.
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: 'human' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swimming', source: 'import' })

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(false)
  })

  it('leaves ownership unchanged when source is omitted', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: 'human' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim Team' })

    // A caller that does not know must not silently claim either side.
    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(true)
  })

  it('drops a record\'s markers when the record is deleted', () => {
    // Otherwise a later record reusing the same id inherits a hand-edited claim
    // it never earned.
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: 'human' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: '__deleted__', value: null })

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(false)
    expect(Object.keys(doc[PROVENANCE_COLLECTION])).toHaveLength(0)
  })

  it('keys markers per field, not per record', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', source: 'human' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'category', value: 'water', source: 'import' })

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(true)
    expect(isHumanEdited(doc, 'activities', 'a1', 'category')).toBe(false)
  })

  it('stores nothing for import-only data (sparse)', () => {
    let doc = createEmptyDoc()
    for (let i = 0; i < 25; i++) {
      doc = applyWrite(doc, { entity: 'activities', entity_id: `a${i}`, field: 'name', value: `A${i}`, source: 'import' })
    }
    // The collection grows with what a director has corrected, not with the
    // size of the camp.
    expect(Object.keys(doc[PROVENANCE_COLLECTION])).toHaveLength(0)
  })

  it('uses a key that cannot collide with a record key', () => {
    // Provenance lives in its OWN collection, so its 3-part key never reaches
    // splitRecordKey (which splits on the LAST delimiter and would otherwise
    // mis-parse it into a bogus entity id).
    const key = provenanceKey('activities', 'a1', 'name')
    expect(key.split(NUL)).toEqual(['activities', 'a1', 'name'])
    let doc = applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: 'a1', field: 'name', value: 'v', source: 'human' })
    expect(doc[PROVENANCE_COLLECTION][key]).toBe(HUMAN_PROVENANCE)
    // and the entity collection is untouched by it
    expect(Object.keys(doc.activities)).toEqual([`a1${NUL}name`])
  })
})

describe('seeding carries existing op-log provenance', () => {
  it('protects a hand edit that predates the document', () => {
    // Without this, cutover is where a Host's accumulated corrections lose their
    // protection: rows arrive with no marker, everything reads as import-owned,
    // and the next re-import overwrites months of work.
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1', source: 'import' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim Team', author_user_id: null, device_id: 'device-1', source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: 'a2', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1', source: 'import' })
    appendOp(db, { entity: 'activities', entity_id: 'a2', field: 'name', value: 'Archery', author_user_id: null, device_id: 'device-1', source: 'import' })

    const doc = seedDocFromSqlite(db, createEmptyDoc(), 'activities')

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(true)
    expect(isHumanEdited(doc, 'activities', 'a2', 'name')).toBe(false)
  })

  it('carries a NULL-source op in as human', () => {
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', author_user_id: null, device_id: 'device-1' })

    const doc = seedDocFromSqlite(db, createEmptyDoc(), 'activities')

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(true)
  })

  it('respects the LATEST op, not any op', () => {
    // A field hand-edited and then re-imported is import-owned.
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1', source: 'import' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim Team', author_user_id: null, device_id: 'device-1', source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swimming', author_user_id: null, device_id: 'device-1', source: 'import' })

    const doc = seedDocFromSqlite(db, createEmptyDoc(), 'activities')

    expect(isHumanEdited(doc, 'activities', 'a1', 'name')).toBe(false)
  })
})

describe('isHumanOwned — the question ingest actually asks', () => {
  it('answers from the op-log when there is no document', () => {
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1', source: 'import' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim Team', author_user_id: null, device_id: 'device-1', source: 'human' })

    expect(isHumanOwned(db, 'activities', 'a1', 'name')).toBe(true)
  })

  it('reports not-human for a field nothing has written', () => {
    expect(isHumanOwned(db, 'activities', 'nope', 'name')).toBe(false)
  })

  it('treats a NULL-source op as human', () => {
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', author_user_id: null, device_id: 'device-1' })

    expect(isHumanOwned(db, 'activities', 'a1', 'name')).toBe(true)
  })

  it('reports not-human once an import takes the field back', () => {
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: campId, author_user_id: null, device_id: 'device-1', source: 'import' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim Team', author_user_id: null, device_id: 'device-1', source: 'human' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swimming', author_user_id: null, device_id: 'device-1', source: 'import' })

    expect(isHumanOwned(db, 'activities', 'a1', 'name')).toBe(false)
  })
})
