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
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import * as seedModule from './seed.js'
import { seedAllFromSqlite } from './seed.js'
import { saveDoc, loadDoc } from '../sync/automerge/docStore.js'
import { sharesGenesis, recordKey } from './campDocument.js'
import { rebuildProjectionFromDocumentAtPath, RebuildRefusalError } from './rebuildSupportCommand.js'
import { purgeCamperRecord } from './purgeSupportCommand.js'
import * as hostKeyPreservation from './hostKeyPreservation.js'

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
    const hostPub = 'a'.repeat(64)
    const hostPriv = 'b'.repeat(64)
    const hostCreated = new Date().toISOString()
    db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run(hostPub, hostPriv, hostCreated)
    // camps.signing_public_key mirrors the host public key (localAuth.js ensureHostSigningKey) and
    // is excluded from the document (projector.js), so it must be preserved out-of-band or it comes
    // back genuinely empty after a rebuild.
    db.prepare('UPDATE camps SET signing_public_key = ?').run(hostPub)
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
    expect(host).toEqual({ public_key: hostPub, private_key: hostPriv, created_at: hostCreated })
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

  it('5b: a Client (no host_signing_key row) skips that artifact without error', () => {
    const { db, dbPath } = newDb('client')
    const campId = randomUUID()
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId: 'device-1', camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    // A Client holds no host_signing_key, but does hold a device_identity_key and receives
    // camps.signing_public_key via its login/join reply.
    const clientPub = 'd'.repeat(64)
    db.prepare('UPDATE camps SET signing_public_key = ?').run(clientPub)
    db.prepare('INSERT INTO device_identity_key (id, peer_id, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run('12D3KooWClientPeer', 'e'.repeat(72), new Date().toISOString())
    const doc = seedAllFromSqlite(db)
    const userDataDir = newUserDataDir('client')
    saveDoc(userDataDir, campId, doc)
    db.close()

    const result = purgeCamperRecord({ dbPath, userDataDir, entityId: camperId })
    expect(result.keysRestored).toEqual({
      hostSigningKey: false,
      deviceIdentityKey: true,
      campsSigningPublicKey: true,
    })

    const verifyDb = openLocalDb(dbPath)
    expect(verifyDb.prepare('SELECT * FROM host_signing_key WHERE id = 1').get()).toBeUndefined()
    expect(verifyDb.prepare('SELECT signing_public_key FROM camps LIMIT 1').get().signing_public_key).toBe(clientPub)
    verifyDb.close()
  })

  it('FIX3: a crash between rebuild and key-restore leaves the pre-migration backup holding the original key', () => {
    const { db, dbPath } = newDb('crashwindow')
    const campId = randomUUID()
    const camperId = randomUUID()
    buildCampWithCamper(db, {
      campId, deviceId: 'device-1', camperId, groupId: randomUUID(),
      prefId: randomUUID(), runId: randomUUID(), choiceId: randomUUID(),
    })
    const hostPub = 'a'.repeat(64)
    const hostPriv = 'b'.repeat(64)
    db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run(hostPub, hostPriv, new Date().toISOString())
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
})
