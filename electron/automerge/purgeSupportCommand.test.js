// @vitest-environment node
//
// T202: the camper-record purge path. Composes alongside rebuildSupportCommand.js rather than
// overloading it -- see docs/work/tickets/T202-camper-record-purge-path.md and ADR
// 2026-09-17-individual-elective-scheduling.md D10. Fixtures are built against the real
// electron/db/schema.sql columns (campers, elective_preferences, elective_assignments,
// operations), not hand-rolled shapes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import * as seedModule from './seed.js'
import { seedAllFromSqlite } from './seed.js'
import { saveDoc, loadDoc } from '../sync/automerge/docStore.js'
import { sharesGenesis, recordKey } from './campDocument.js'
import { projectAll } from './projector.js'
import {
  rebuildProjectionFromDocumentAtPath,
  rebuildProjectionFromDocumentAtPathCore,
  RebuildRefusalError,
} from './rebuildSupportCommand.js'
import { purgeCamperRecord } from './purgeSupportCommand.js'
import { acquireSupportCommandLock } from './supportCommandLock.js'
import { signTombstone } from './tombstoneSignature.js'
import * as hostKeyPreservation from './hostKeyPreservation.js'

// T233 (docs/adr/2026-09-19-multi-device-erasure-propagation.md): purgeCamperRecord is now
// Host-only — it refuses to run at all without a host_signing_key row (see the new describe block
// below for that refusal itself). Every OTHER test in this file exercises a purge that must
// actually succeed, so each needs a real Host key installed on the fixture db first.
function installHostKey(db, campId) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
  const privateKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex')
  db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(publicKeyHex, privateKeyHex, new Date().toISOString())
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(publicKeyHex, campId)
  return { publicKeyHex, privateKeyHex }
}

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

    // installHostKey AFTER the ordinary prior rebuild above, which (correctly, for an ORDINARY
    // rebuild) wipes any signing key — this simulates the Host having already bootstrapped its
    // key before running the purge that follows.
    const postRebuildDb = openLocalDb(dbPath)
    installHostKey(postRebuildDb, campId)
    postRebuildDb.close()

    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    expect(result.campId).toBe(campId)
    // T233: the return value carries the minted tombstone and an honest propagation-pending flag
    // — this purge erases the record LOCALLY; fleet propagation depends on the tombstone reaching
    // at least one live peer, which purgeCamperRecord cannot itself confirm.
    expect(result.tombstone).toEqual({ id: camperId, entity: 'campers', version: 1 })
    expect(result.propagationPending).toBe(true)

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    expect(verifyDb.prepare('SELECT * FROM elective_preferences WHERE camper_id = ?').all(camperId)).toEqual([])
    expect(verifyDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all(camperId)).toEqual([])
    expect(verifyDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all(prefId)).toEqual([])
    expect(verifyDb.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)).toBeTruthy()
    // T233: the tombstone itself IS a real row, by design — logical erasure (owner: "invisible
    // forever") is what this ticket delivers, not physical byte-erasure (out of scope; see the
    // ADR's "erasure guarantee" section).
    expect(verifyDb.prepare('SELECT id, entity, version FROM tombstones WHERE id = ?').get(camperId)).toEqual({
      id: camperId, entity: 'campers', version: 1,
    })
    // Host key preserved across the purge (T233 S1) — the same key that minted the tombstone
    // above, so the tombstone's own signature still verifies with the post-purge public key.
    expect(verifyDb.prepare('SELECT 1 FROM host_signing_key WHERE id = 1').get()).toBeTruthy()
    verifyDb.close()

    expect(preMigrationBackups(dbPath).length).toBe(0)

    const newDoc = loadDoc(userDataDir, campId)
    const changes = A.getAllChanges(newDoc)
    // prefId (the elective_preferences row's OWN id) must never appear anywhere in the fresh
    // document's history — that record and everything under its id is genuinely gone. camperId is
    // NOT checked the same way here: it deliberately persists forever as the tombstone's own id
    // (accepted, opaque, PII-free — owner ruling, see the ADR's "erasure guarantee" section) even
    // though the camper record itself is gone from every collection that describes a person.
    const touchesPrefId = changes.some((change) => {
      const decoded = A.decodeChange(change)
      return decoded.ops.some((op) => typeof op.key === 'string' && op.key.includes(prefId))
    })
    expect(touchesPrefId).toBe(false)
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
    installHostKey(db, campId)

    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('opsonly')
    saveDoc(userDataDir, campId, doc)
    db.close()

    purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all(camperId)).toEqual([])
    verifyDb.close()
  })

  // T233 CLOSURE OF T202'S KNOWN GAP (docs/adr/2026-09-19-multi-device-erasure-propagation.md).
  // Before T233: a stale peer's ordinary merge reintroduced the purged camper's ROW into SQLite —
  // this exact test used to assert `reintroduced` (at the projection level) was `true`. After
  // T233: the record's flat fields still merge back into the DOCUMENT (Automerge has no op-level
  // delete — this is the accepted "logical, not physical, erasure" — see the ADR's "erasure
  // guarantee" section), but the signed tombstone ALSO merges back in, and PROJECTING that merged
  // document refuses to ever materialize the camper again. The reintroduction is refused where it
  // actually matters: in what the app ever shows.
  it('T233: a stale peer merging its pre-purge document back in is REFUSED at projection — the camper never reappears', () => {
    const { db, dbPath } = newDb('gap')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    installHostKey(db, campId)
    const oldPeerDoc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('gap')
    saveDoc(userDataDir, campId, oldPeerDoc)
    db.close()

    purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
    const purgedDoc = loadDoc(userDataDir, campId)

    expect(sharesGenesis(oldPeerDoc)).toBe(true)
    expect(sharesGenesis(purgedDoc)).toBe(true)

    const merged = A.merge(A.clone(purgedDoc), oldPeerDoc)
    // The document-level fact hasn't changed: the stale peer's flat camper fields DO merge back
    // in — Automerge has no op-level delete, and this is exactly the residual-bytes reality the
    // ADR accepts (logical, not physical, erasure).
    const camperKeyPrefix = recordKey(camperId, '')
    const reintroducedInDoc = Object.keys(merged.campers || {}).some((k) => k.startsWith(camperKeyPrefix))
    expect(reintroducedInDoc).toBe(true)

    // The projection-level fact IS what T233 changes: projecting the merged document must NOT
    // resurrect the camper — the tombstone (which merged back in alongside the stale row) gates it.
    const projDb = openLocalDb(dbPath)
    projectAll(projDb, merged)
    expect(projDb.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    projDb.close()
  })

  it('round 2 FIX1: rolls back the deletes when something fails after them, inside one transaction (no split state)', () => {
    const { db, dbPath } = newDb('atomic')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    const prefId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId, runId: randomUUID(), choiceId: randomUUID(),
    })
    installHostKey(db, campId)
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('atomic')
    saveDoc(userDataDir, campId, doc)
    db.close()

    // Force a failure AFTER the deletes would already have auto-committed under the old
    // (non-transactional) code, but which the transaction must still be able to roll back.
    const spy = vi.spyOn(seedModule, 'seedAllFromSqlite').mockImplementationOnce(() => {
      throw new Error('forced failure inside the purge transaction')
    })

    try {
      expect(() => purgeCamperRecord({ dbPath, userDataDir, entityId: camperId }))
        .toThrow(/forced failure inside the purge transaction/)
    } finally {
      spy.mockRestore()
    }

    // No split state: the camper and its dependent row are STILL present, exactly as before the
    // failed attempt. A non-transactional implementation would have committed the deletes before
    // the forced throw and left this assertion failing.
    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeTruthy()
    expect(verifyDb.prepare('SELECT * FROM elective_preferences WHERE camper_id = ?').all(camperId).length).toBeGreaterThan(0)
    // T233: the tombstone insert is INSIDE the same transaction as the deletes — a rollback must
    // undo it too, or a failed purge would leave a signed tombstone denying a camper that was
    // never actually removed.
    expect(verifyDb.prepare('SELECT * FROM tombstones WHERE id = ?').get(camperId)).toBeUndefined()
    verifyDb.close()

    // Idempotent re-run: retrying with the real implementation now succeeds and actually purges.
    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
    expect(result.campId).toBe(campId)
    const verifyDb2 = openLocalDb(dbPath)
    expect(verifyDb2.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    verifyDb2.close()
  })

  it('round 2 FIX2: purging a camper still erases camp-wide host-only state that is NOT identity (pinned, not silent)', () => {
    const { db, dbPath } = newDb('collateral')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    // conflicts is a genuinely HOST-ONLY table (never in MODELED_ENTITIES/DIRECT_CAMP_ENTITIES —
    // electron/ops/campScopedEntities.js), unlike schedule_snapshots (which IS document-replicated
    // and correctly survives a rebuild via seedAllFromSqlite). It is NOT device-identity, so unlike
    // the signing/identity keys (see the 5b preservation tests below) it is still lost on purge —
    // that accepted collateral is pinned here so it can't silently change.
    const conflictId = randomUUID()
    db.prepare(
      'INSERT INTO conflicts (id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(conflictId, 'campers', camperId, 'display_name', '{}', '{}', 'op1', new Date().toISOString())
    // Host key required: the merged purge is Host-only (T233). Preservation of that key is asserted
    // by the dedicated 5b tests below, not here — this test pins only the non-identity collateral.
    installHostKey(db, campId)

    expect(db.prepare('SELECT * FROM conflicts WHERE id = ?').get(conflictId)).toBeTruthy()

    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('collateral')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    // The collateral is real and must be surfaced on the result, not silently dropped.
    expect(result.notRecoverable).toMatch(/operations table/)

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM conflicts WHERE id = ?').get(conflictId)).toBeUndefined()
    verifyDb.close()
  })

  // ---- 5b: the signing/identity keys are PRESERVED across a purge (T202 follow-up) ----

  it('5b: preserves host_signing_key, device_identity_key, and camps.signing_public_key byte-identical', () => {
    const { db, dbPath } = newDb('preserve')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    // A REAL Ed25519 host key: T233's purge actually SIGNS a tombstone with it, so a placeholder
    // hex string would throw at createPrivateKey. installHostKey also mirrors the public half into
    // camps.signing_public_key (localAuth.js ensureHostSigningKey behavior), which projector.js
    // excludes from the document so it must be preserved out-of-band across the rebuild.
    const { publicKeyHex: hostPub, privateKeyHex: hostPriv } = installHostKey(db, campId)
    const peerId = '12D3KooWFakePeerIdForTest'
    const devPriv = 'c'.repeat(72)
    const devCreated = new Date().toISOString()
    db.prepare('INSERT INTO device_identity_key (id, peer_id, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run(peerId, devPriv, devCreated)

    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('preserve')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    // The result reports exactly which artifacts were restored — never the key bytes themselves.
    expect(result.keysRestored).toEqual({
      hostSigningKey: true,
      deviceIdentityKey: true,
      campsSigningPublicKey: true,
    })

    const verifyDb = openLocalDb(dbPath)
    const host = verifyDb.prepare('SELECT public_key, private_key, created_at FROM host_signing_key WHERE id = 1').get()
    expect(host.public_key).toBe(hostPub)
    expect(host.private_key).toBe(hostPriv)
    expect(host.created_at).toBeTruthy()
    const dev = verifyDb.prepare('SELECT peer_id, private_key, created_at FROM device_identity_key WHERE id = 1').get()
    expect(dev).toEqual({ peer_id: peerId, private_key: devPriv, created_at: devCreated })
    // camps.signing_public_key survives AND stays matched to the preserved host public key, so this
    // device can verify its own tokens immediately — no dependence on a later lazy backfill.
    expect(verifyDb.prepare('SELECT signing_public_key FROM camps LIMIT 1').get().signing_public_key).toBe(hostPub)
    verifyDb.close()
  })

  it('5b: does NOT preserve camps.signing_secret (retired legacy HMAC field — deliberately inert loss)', () => {
    const { db, dbPath } = newDb('secret')
    const campId = randomUUID()
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId: 'device-1', camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    // buildCampWithCamper already sets signing_secret to 'a'.repeat(64).
    expect(db.prepare('SELECT signing_secret FROM camps LIMIT 1').get().signing_secret).toBe('a'.repeat(64))
    installHostKey(db, campId) // real Ed25519 key so the Host-only purge can sign its tombstone
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('secret')
    saveDoc(userDataDir, campId, doc)
    db.close()

    purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })

    const verifyDb = openLocalDb(dbPath)
    // signing_secret is never in the document and is deliberately not preserved, so it comes back
    // empty. This pins the deliberate exclusion so it can't quietly start being preserved.
    expect(verifyDb.prepare('SELECT signing_secret FROM camps LIMIT 1').get().signing_secret).toBeNull()
    verifyDb.close()
  })

  // NOTE (T233 merge): #514's "a Client (no host_signing_key) skips that artifact without error"
  // test was REMOVED here. Its premise — a Client running purgeCamperRecord — is impossible under
  // T233's Host-only refusal (a device with no host_signing_key is refused before any key work), and
  // that refusal is covered by the dedicated Host-only-purge test below. The graceful "skip a missing
  // artifact" behavior of restorePreservableKeys is still unit-tested in hostKeyPreservation.test.js.

  it('FIX3: a crash between rebuild and key-restore leaves the pre-migration backup holding the original key', () => {
    const { db, dbPath } = newDb('crashwindow')
    const campId = randomUUID()
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId: 'device-1', camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    const { publicKeyHex: hostPub, privateKeyHex: hostPriv } = installHostKey(db, campId) // real key: the purge signs a tombstone
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('crashwindow')
    saveDoc(userDataDir, campId, doc)
    db.close()

    // Force a crash AFTER the rebuild has completed but BEFORE restore finishes. Shredding the
    // backups must NOT have run yet, so the backup — which still holds the original host_signing_key
    // (it was copied from the pre-rebuild db) — survives as a manual recovery source.
    const spy = vi.spyOn(hostKeyPreservation, 'restorePreservableKeys').mockImplementationOnce(() => {
      throw new Error('forced crash between rebuild and key-restore')
    })
    try {
      // The thrown error names the purge context and where the keys still live, and chains the
      // original failure as `cause` rather than swallowing it.
      let thrown
      try {
        purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown.message).toMatch(/keys were NOT restored after the purge rebuild/)
      expect(thrown.message).toMatch(/pre-migration backup/)
      expect(thrown.cause).toBeInstanceOf(Error)
      expect(thrown.cause.message).toMatch(/forced crash between rebuild and key-restore/)
    } finally {
      spy.mockRestore()
    }

    const backups = preMigrationBackups(dbPath)
    expect(backups.length).toBeGreaterThan(0)
    const backupPath = path.join(path.dirname(dbPath), backups[0])
    const backupDb = openLocalDb(backupPath)
    const recovered = backupDb.prepare('SELECT public_key, private_key FROM host_signing_key WHERE id = 1').get()
    backupDb.close()
    files.push(backupPath)
    expect(recovered).toEqual({ public_key: hostPub, private_key: hostPriv })
  })

  it('round 2 FIX4: refuses a whole-device purge when the id has no camper row and no operations history', () => {
    const { db, dbPath } = newDb('norow')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const realCamperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId: realCamperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    installHostKey(db, campId)
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('norow')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const bogusId = randomUUID()
    expect(() => purgeCamperRecord({ dbPath, userDataDir, entityId: bogusId })).toThrow(RebuildRefusalError)
    expect(() => purgeCamperRecord({ dbPath, userDataDir, entityId: bogusId })).toThrow(/no camper record or operations history/)

    // No whole-device rebuild ran: no pre-migration backup was created, and the real camper is
    // untouched.
    expect(preMigrationBackups(dbPath).length).toBe(0)
    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM campers WHERE id = ?').get(realCamperId)).toBeTruthy()
    verifyDb.close()
  })

  // T233 S1: Host-only purge enforcement (Red Hat R3 + Security F4) — only the Host holds
  // host_signing_key, so only the Host can mint the signed tombstone. A purge on a non-Host
  // device (e.g. a Client, or a Host that hasn't yet been through bootstrapCamp's key-minting)
  // must be refused OUTRIGHT, before any mutation — never a local "success" that mints no
  // tombstone, which would reproduce the exact reintroduction gap this ticket closes.
  it('T233: refuses a purge on a device with no host_signing_key row — no mutation, no tombstone, camper untouched', () => {
    const { db, dbPath } = newDb('nohost')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    // Deliberately NO installHostKey(db, campId) here — this is a Client device.
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('nohost')
    saveDoc(userDataDir, campId, doc)
    db.close()

    expect(() => purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })).toThrow(RebuildRefusalError)
    expect(() => purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })).toThrow(/only the Host can mint/)

    // No mutation at all: no backup, no tombstone, the camper fully intact.
    expect(preMigrationBackups(dbPath).length).toBe(0)
    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeTruthy()
    expect(verifyDb.prepare('SELECT * FROM tombstones WHERE id = ?').get(camperId)).toBeUndefined()
    verifyDb.close()
  })

  // T233 round 2, finding 1: a crash between rebuildProjectionFromDocumentAtPathCore's wipe (which
  // destroys host_signing_key/device_identity_key/camps.signing_secret on the LIVE db) and
  // purgeCamperRecord's own in-memory key restore must not permanently destroy the Host's signing
  // key, and a re-run afterward must recover and complete rather than tripping the Host-only
  // refusal (which would otherwise brick the Host — see the module header's "re-run to recover"
  // guarantee).
  it('T233 round 2 finding 1: recovers the signing key from a pre-migration backup after a simulated crash between rebuild and key restore, and completes on re-run', () => {
    const { db, dbPath } = newDb('crash')
    const campId = randomUUID()
    const deviceId = 'device-1'
    const camperId = randomUUID()
    const prefId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId, camperId, groupId: randomUUID(),
      prefId, runId: randomUUID(), choiceId: randomUUID(),
    })
    const { publicKeyHex } = installHostKey(db, campId)
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('crash')
    saveDoc(userDataDir, campId, doc)
    db.close()

    // Manually reproduce the state a real purge reaches right before it crashes: the transaction
    // (deletes + signed tombstone insert + document regen) has committed and the fresh document has
    // been saved, but the SQLite rebuild step is about to run. Then run ONLY that rebuild step
    // directly (bypassing purgeCamperRecord) — this is the exact moment a real crash would land:
    // AFTER rebuildProjectionFromDocumentAtPathCore has wiped host_signing_key (and written a
    // `.pre-migration-*.bak` of the still-key-intact db beforehand) but BEFORE any key restore runs.
    const preRebuildDb = openLocalDb(dbPath)
    preRebuildDb.prepare('DELETE FROM elective_preferences WHERE camper_id = ?').run(camperId)
    preRebuildDb.prepare('DELETE FROM campers WHERE id = ?').run(camperId)
    const sig = signTombstone(preRebuildDb, { id: camperId, entity: 'campers', version: 1 })
    preRebuildDb
      .prepare('INSERT OR REPLACE INTO tombstones (id, entity, version, sig, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(camperId, 'campers', 1, sig, new Date().toISOString())
    const freshDoc = seedAllFromSqlite(preRebuildDb, undefined)
    preRebuildDb.close()
    saveDoc(userDataDir, campId, freshDoc)

    // The crash: run the rebuild core directly, then STOP — no key restore, exactly the window
    // finding 1 describes. This also produces the `.bak` (of the just-mutated, still-key-intact db)
    // that the recovery path must read.
    rebuildProjectionFromDocumentAtPathCore({ dbPath, userDataDir })
    expect(preMigrationBackups(dbPath).length).toBeGreaterThan(0)
    const crashedDb = openLocalDb(dbPath)
    expect(crashedDb.prepare('SELECT 1 FROM host_signing_key WHERE id = 1').get()).toBeUndefined()
    crashedDb.close()

    // The re-run: purgeCamperRecord with the SAME entityId must NOT refuse — it must recover the
    // key from the backup, then complete (finishing the key-restore/reproject/shred tail).
    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
    expect(result.campId).toBe(campId)

    const verifyDb = openLocalDb(dbPath)
    const restoredKey = verifyDb.prepare('SELECT public_key FROM host_signing_key WHERE id = 1').get()
    expect(restoredKey).toBeTruthy()
    expect(restoredKey.public_key).toBe(publicKeyHex)
    expect(verifyDb.prepare('SELECT * FROM campers WHERE id = ?').get(camperId)).toBeUndefined()
    expect(verifyDb.prepare('SELECT id, entity, version FROM tombstones WHERE id = ?').get(camperId)).toEqual({
      id: camperId, entity: 'campers', version: 1,
    })
    verifyDb.close()

    // A genuine non-Host device — no key, and no recoverable backup at all — must still be refused.
    const { db: freshNonHostDb, dbPath: freshNonHostPath } = newDb('crash-nonhost')
    const freshCampId = randomUUID()
    const freshCamperId = randomUUID()
    buildCampWithCamper(freshNonHostDb, {
      campId: freshCampId, deviceId: 'device-2', camperId: freshCamperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    const freshDoc2 = seedAllFromSqlite(freshNonHostDb)
    const freshUserDataDir = newUserDataDir('crash-nonhost')
    saveDoc(freshUserDataDir, freshCampId, freshDoc2)
    freshNonHostDb.close()
    expect(() => purgeCamperRecord({ dbPath: freshNonHostPath, userDataDir: freshUserDataDir, entityId: freshCamperId }))
      .toThrow(/only the Host can mint/)
  })

  // T233 round 2, finding 2: a per-device purge/regen serialization lock. Two purge invocations
  // against the same dbPath must not interleave — the second must either wait for the first or be
  // refused deterministically, never run concurrently against the same file.
  it('T233 round 2 finding 2: a second purge against the same dbPath while the lock is held is refused deterministically', () => {
    const { db, dbPath } = newDb('lock')
    const campId = randomUUID()
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId: 'device-1', camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    installHostKey(db, campId)
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('lock')
    saveDoc(userDataDir, campId, doc)
    db.close()

    // Hold the lock ourselves, simulating another purge/rebuild already in flight.
    const release = acquireSupportCommandLock(dbPath)
    try {
      expect(() => purgeCamperRecord({ dbPath, userDataDir, entityId: camperId, lockOptions: { timeoutMs: 50, pollMs: 10 } }))
        .toThrow(/another purge or rebuild is already running/)
    } finally {
      release()
    }

    // Once released, an ordinary purge proceeds normally.
    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
    expect(result.campId).toBe(campId)
  })
})
