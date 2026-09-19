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
import { createEmptyDoc, applyWrite, BULK_REPLACE_MODELED_ENTITIES } from './campDocument.js'
import { projectAll, TOMBSTONE_DENYLISTED_ENTITIES } from './projector.js'
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

  it('T233 round 2 finding 3: a doc-known record whose camper_id field has not yet arrived, but whose SQLite copy already has it, is still deleted for a tombstoned camper', () => {
    installHostKey(db)
    const camperId = 'camper-6'
    const prefId = 'pref-partial'
    // SQLite already holds the FULL row, as a genuine local write would produce (an app screen
    // writes an entity's fields to SQLite via applyProjection's per-field hot path, which does
    // NOT consult the tombstone denylist at all — only projectAll's upsertEntity does).
    db.prepare('INSERT INTO elective_preferences (id, run_id, camper_id, rank) VALUES (?, ?, ?, ?)')
      .run(prefId, 'run-x', camperId, 1)

    let doc = createEmptyDoc()
    doc = putCamper(doc, camperId)
    // The doc DOES know this record's id (only run_id has landed) — camper_id has not arrived yet
    // (fields arrive one at a time on the wire, same reasoning the tombstone fields above rely
    // on). Before this fix, NEITHER existing mechanism caught this: the per-row denylist check
    // reads row.camper_id from the DOC (undefined here, so the gate never fires), and
    // deleteReconcileEntity's generic non-doc-row cleanup does not fire either, because the id IS
    // a known doc record — only camper_id is missing. The row's camper_id in SQLITE is already
    // set, though, which is exactly what the new denylist sweep reads instead of the doc.
    doc = applyWrite(doc, { entity: 'elective_preferences', entity_id: prefId, field: 'run_id', value: 'run-x' })
    doc = tombstoneDoc(doc, db, { id: camperId, entity: 'campers', version: 1 })

    projectAll(db, doc)

    expect(db.prepare('SELECT * FROM elective_preferences WHERE id = ?').get(prefId)).toBeUndefined()
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

  it('T233 round 2 finding 4: no entity is ever both tombstone-denylisted and bulk-replace-modeled', () => {
    // upsertEntity (projector.js) returns after the BULK_REPLACE_MODELED_ENTITIES branch, BEFORE
    // the tombstone denylist gate runs — a future bulk-replace entity added to
    // TOMBSTONE_DENYLISTED_ENTITIES would silently bypass tombstone gating. Today the sets are
    // disjoint (harmless), but nothing enforced that. This pins the invariant so a silent
    // regression fails a test instead of shipping a bypass.
    for (const entity of Object.keys(TOMBSTONE_DENYLISTED_ENTITIES)) {
      expect(BULK_REPLACE_MODELED_ENTITIES.has(entity)).toBe(false)
    }
  })
})
