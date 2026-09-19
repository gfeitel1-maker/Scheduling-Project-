// @vitest-environment node
//
// T233 (docs/adr/2026-09-19-multi-device-erasure-propagation.md), S2 — the projection-time
// admission gate for signed purge tombstones. Mirrors projector.test.js's fixture shape
// (real openLocalDb schema) and upsertUsersEntity's own test style for the sibling
// signed-credential pattern.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { projectAll } from './projector.js'
import { signTombstone } from './tombstoneSignature.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-tombstone-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  return db
}

function installHostKey(db) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
  const privateKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex')
  db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(publicKeyHex, privateKeyHex, new Date().toISOString())
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(publicKeyHex, 'camp-1')
  return { publicKeyHex, privateKeyHex }
}

function tombstoneDoc(doc, db, { id, entity, version }) {
  const sig = signTombstone(db, { id, entity, version })
  let d = doc
  d = applyWrite(d, { entity: 'tombstones', entity_id: id, field: 'entity', value: entity })
  d = applyWrite(d, { entity: 'tombstones', entity_id: id, field: 'version', value: version })
  d = applyWrite(d, { entity: 'tombstones', entity_id: id, field: 'sig', value: sig })
  return d
}

function putCamper(doc, camperId) {
  let d = doc
  d = applyWrite(d, { entity: 'campers', entity_id: camperId, field: 'camp_id', value: 'camp-1' })
  d = applyWrite(d, { entity: 'campers', entity_id: camperId, field: 'display_name', value: 'Sara K' })
  return d
}

let db
beforeEach(() => { db = freshDb('proj') })
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('projector — tombstone admission gate (T233)', () => {
  it('a valid, monotonic, Host-signed tombstone suppresses and deletes the tombstoned camper', () => {
    installHostKey(db)
    const camperId = 'camper-1'
    let doc = createEmptyDoc()
    doc = putCamper(doc, camperId)
    doc = tombstoneDoc(doc, db, { id: camperId, entity: 'campers', version: 1 })

    projectAll(db, doc)

    expect(db.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    expect(db.prepare('SELECT * FROM tombstones WHERE id = ?').get(camperId)).toBeTruthy()
  })

  it('an unsigned/forged tombstone is refused — the camper still projects', () => {
    installHostKey(db)
    const camperId = 'camper-2'
    let doc = createEmptyDoc()
    doc = putCamper(doc, camperId)
    // Forge: sign then tamper the entity_id the tombstone is written under vs. what was signed.
    let d = doc
    d = applyWrite(d, { entity: 'tombstones', entity_id: camperId, field: 'entity', value: 'campers' })
    d = applyWrite(d, { entity: 'tombstones', entity_id: camperId, field: 'version', value: 1 })
    d = applyWrite(d, { entity: 'tombstones', entity_id: camperId, field: 'sig', value: 'forged-signature-not-base64url-valid' })
    doc = d

    projectAll(db, doc)

    expect(db.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeTruthy()
    expect(db.prepare('SELECT * FROM tombstones WHERE id = ?').get(camperId)).toBeUndefined()
    const denied = db.prepare("SELECT * FROM audit_events WHERE target_id = ? AND outcome = 'deny'").get(camperId)
    expect(denied).toBeTruthy()
  })

  it('a stale (lower-version) tombstone is refused once a newer one has already projected', () => {
    installHostKey(db)
    const camperId = 'camper-3'
    let doc = createEmptyDoc()
    doc = putCamper(doc, camperId)
    doc = tombstoneDoc(doc, db, { id: camperId, entity: 'campers', version: 5 })
    projectAll(db, doc)
    expect(db.prepare('SELECT version FROM tombstones WHERE id = ?').get(camperId).version).toBe(5)

    // A stale, lower-version tombstone for the SAME id arrives (e.g. a replay). Still verifies
    // (it is genuinely Host-signed for version 2), but must be refused as non-monotonic.
    doc = tombstoneDoc(doc, db, { id: camperId, entity: 'campers', version: 2 })
    projectAll(db, doc)

    expect(db.prepare('SELECT version FROM tombstones WHERE id = ?').get(camperId).version).toBe(5)
  })

  it('elective_preferences/elective_assignments rows for a tombstoned camper are also suppressed and deleted', () => {
    installHostKey(db)
    const camperId = 'camper-4'
    const runId = 'run-1'
    const prefId = 'pref-1'
    const assignId = 'assign-1'
    let doc = createEmptyDoc()
    doc = putCamper(doc, camperId)
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: runId, field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: runId, field: 'name', value: 'Run 1' })
    doc = applyWrite(doc, { entity: 'elective_preferences', entity_id: prefId, field: 'run_id', value: runId })
    doc = applyWrite(doc, { entity: 'elective_preferences', entity_id: prefId, field: 'camper_id', value: camperId })
    doc = applyWrite(doc, { entity: 'elective_assignments', entity_id: assignId, field: 'run_id', value: runId })
    doc = applyWrite(doc, { entity: 'elective_assignments', entity_id: assignId, field: 'camper_id', value: camperId })
    doc = tombstoneDoc(doc, db, { id: camperId, entity: 'campers', version: 1 })

    projectAll(db, doc)

    expect(db.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    expect(db.prepare('SELECT * FROM elective_preferences WHERE id = ?').get(prefId)).toBeUndefined()
    expect(db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(assignId)).toBeUndefined()
  })

  it('no signing key on this device: an unverifiable tombstone is skipped (keep-last-known), camper still projects', () => {
    // Deliberately no installHostKey(db) — camps.signing_public_key stays NULL.
    const camperId = 'camper-5'
    let doc = createEmptyDoc()
    doc = putCamper(doc, camperId)
    doc = applyWrite(doc, { entity: 'tombstones', entity_id: camperId, field: 'entity', value: 'campers' })
    doc = applyWrite(doc, { entity: 'tombstones', entity_id: camperId, field: 'version', value: 1 })
    doc = applyWrite(doc, { entity: 'tombstones', entity_id: camperId, field: 'sig', value: 'anything' })

    projectAll(db, doc)

    expect(db.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeTruthy()
    expect(db.prepare('SELECT * FROM tombstones WHERE id = ?').get(camperId)).toBeUndefined()
  })
})
