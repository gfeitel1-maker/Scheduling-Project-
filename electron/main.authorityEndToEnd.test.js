// @vitest-environment node
//
// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the END-TO-END proof the
// Governor asked for: a director's REAL action (electron/main.js's revokeDevice handler, called
// exactly as the renderer calls it, with a real admin session token and requireAuthorized gate)
// must actually drive the mechanism, not just leave tested-but-dormant mint functions sitting
// unused. This is the same class of defect T329 was failed on (a mechanism that never fires on
// the real path) — this test exists to prove THIS round closes it.
//
// Two real libp2p nodes (same two-node harness as syncNode.test.js/T328's pattern), because the
// whole point is proving Gate B (handleSyncMessage) actually refuses a revoked peer on the
// PRODUCTION sync path — a mock transport cannot exercise that. Camp/user/devices setup mirrors
// main.test.js's own proven seedCampAndUser + chooseMode + login pattern (bootstrapCamp's full
// codepath is not used here, to keep this test's own transport/doc wiring independent and
// debuggable — the genesis mint bootstrapCamp performs is reproduced directly below instead).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as A from '@automerge/automerge'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

const { openLocalDb } = await import('./db/localDb.js')
const { makeHandlers } = await import('./main.js')
const { startSyncNode } = await import('./sync/automerge/syncNode.js')
const { createEmptyDoc, applyWrite } = await import('./automerge/campDocument.js')
const { setUserDataDirGetter, resetForTests: resetLiveDocForTests } = await import('./sync/automerge/liveDoc.js')
const { ensureHostSigningKey, createUser } = await import('./auth/localAuth.js')
const { mintGenesisEntry, mintGrantEntry } = await import('./automerge/authorityLog.js')
const { projectEntity } = await import('./automerge/projector.js')
const { CURRENT_SCHEMA_VERSION } = await import('./db/localDb.js')
const { ensureDeviceIdentity } = await import('./auth/deviceIdentity.js')
const { signAuthorityEntry } = await import('./automerge/authorityLogSignature.js')

const files = []
let userDataDir

function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-e2e-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-e2e-'))
  setUserDataDirGetter(() => userDataDir)
})

afterEach(() => {
  resetLiveDocForTests()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

async function waitFor(predicate, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function authorityCacheStatus(db, deviceId) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status ?? null
}

function activityRow(db, id) {
  return db.prepare('SELECT id, name FROM activities WHERE id = ?').get(id)
}

// Test-only write function matching syncClient's write() signature — mirrors main.test.js's own
// localTestWrite() helper, used only to seed the admin user directly (bypassing bootstrapCamp).
function localTestWrite(db, byDeviceId) {
  return async ({ entity, entity_id, field, value }) => {
    const { appendOp } = await import('./ops/operations.js')
    return { status: 'applied', op: appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: byDeviceId, parent_op_id: null }) }
  }
}

async function seedCampAndAdmin(db, { campId, deviceId, name, pin }) {
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, deviceId)
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'E2E Camp', 'a'.repeat(64))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  const user = await createUser(db, { camp_id: campId, name, pin, role: 'admin' }, localTestWrite(db, deviceId))
  db.prepare(
    "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), user.id, deviceId)
  return { campId, user }
}

describe('T331 end-to-end — a director\'s real revokeDevice action drives Gate B', () => {
  let dbF, dbB, nodes
  beforeEach(() => {
    dbF = freshDb('founder')
    dbB = freshDb('target')
    nodes = []
  })
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()))
    for (const db of [dbF, dbB]) {
      try { db.close() } catch { /* already closed */ }
    }
  })

  it('an ordinary device, revoked through the REAL revokeDevice handler, is refused on Gate B\'s production sync path', async () => {
    const genesis = createEmptyDoc()
    const f = await startSyncNode({ deviceId: 'device-f', db: dbF, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(f, b)

    await f.dial(b.getMultiaddrs()[0])
    await waitFor(() => f.getPeers().length > 0)

    const campId = randomUUID()
    await seedCampAndAdmin(dbF, { campId, deviceId: 'device-f', name: 'Director', pin: '135790' })
    const pub = dbF.prepare('SELECT signing_public_key FROM camps LIMIT 1').get().signing_public_key
    dbB.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run(campId, 'E2E Camp', pub)

    // The axiomatic genesis entry (what bootstrapCamp now mints for real — see electron/main.js) —
    // reproduced directly here: device-f, by virtue of being the device that created this camp, is
    // the founder.
    mintGenesisEntry(dbF, { founderDeviceId: 'device-f', founderPeerId: f.peerId.toString() })
    projectEntity(dbF, f.getDoc(), 'camp_authority_log')

    db_insertDevicesRow(dbF, 'device-b')
    db_insertDevicesRow(dbB, 'device-f')
    db_insertDevicesRow(dbB, 'device-b')

    const { issueCampToken } = await import('./auth/localAuth.js')
    const tokenF = issueCampToken(dbF, 'user-f', 'device-f')
    const tokenB = issueCampToken(dbF, 'user-b', 'device-b')
    await f.authenticateWith(b.peerId, { type: 'authenticate', token: tokenF, device_id: 'device-f', schemaVersion: CURRENT_SCHEMA_VERSION })
    await b.authenticateWith(f.peerId, { type: 'authenticate', token: tokenB, device_id: 'device-b', schemaVersion: CURRENT_SCHEMA_VERSION })
    await waitFor(() => f.isPeerAuthenticated(b.peerId.toString()) && b.isPeerAuthenticated(f.peerId.toString()))
    await new Promise((r) => setTimeout(r, 150))

    const handlersF = makeHandlers(dbF, 'device-f', { getAutomergeSyncNode: () => f })
    const { token: adminToken } = await handlersF.login({ name: 'Director', pin: '135790' })

    // Prove the channel genuinely works BEFORE revocation — the contrast that makes the "after"
    // assertion meaningful rather than a tautology (a channel that never worked can't prove
    // anything was refused).
    const beforeChange = applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'before-revoke', field: 'name', value: 'Fine' })
    await b.applyLocal(beforeChange)
    await waitFor(() => activityRow(dbF, 'before-revoke')?.name === 'Fine')

    // The director's REAL action.
    const result = handlersF.revokeDevice({ token: adminToken, deviceId: 'device-b', reason: 'e2e' })
    expect(result.revoked).toBe(true)

    // The mint + local projection the real handler now performs (this round's wiring) must have
    // landed: a signed revoke entry in the document, replayed into device F's OWN authority_cache.
    await waitFor(() => authorityCacheStatus(dbF, 'device-b') === 'revoked')
    const loggedEntry = dbF.prepare(
      "SELECT kind, signer_device_id FROM applied_authority_log WHERE target_device_id = 'device-b'"
    ).get()
    expect(loggedEntry).toEqual({ kind: 'revoke', signer_device_id: 'device-f' })

    // End-to-end behavioral proof: device B's connection is no longer admitted on device F's
    // transport (bindOrVerifyPeerIdentity's TOFU bind had already recorded device-b's peer id at
    // authenticate time, so BOTH the pre-existing single-target eviction the Host-local
    // revokeDevice path already had, AND the new distributed Gate B, now cooperate to close this
    // — the ADR builds alongside that mechanism, not in place of it). A dedicated, narrower proof
    // that Gate B SPECIFICALLY (not the pre-existing eviction) refuses a revoked peer on the
    // production sync path already exists from the prior round
    // (electron/sync/automerge/syncNode.test.js's "T331 gate B" test, which never calls
    // revokeDevice at all — it drives authority_cache directly to isolate the gate).
    expect(f.isPeerAuthenticated(b.peerId.toString())).toBe(false)
    const changed = applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'should-not-land', field: 'name', value: 'Refused' })
    await b.applyLocal(changed)
    await new Promise((r) => setTimeout(r, 300))
    expect(activityRow(dbF, 'should-not-land')).toBeUndefined()
  })
})

describe('T331 end-to-end — N=3 admin-target quorum, driven through the REAL revokeDevice handler', () => {
  let dbF, keyA, keyB
  beforeEach(() => {
    dbF = freshDb('quorum-founder')
    keyA = freshDb('quorum-keyholder-a') // holds target device-a's own real identity key only
    keyB = freshDb('quorum-keyholder-b') // holds the OTHER admin (device-b)'s own real identity key
  })
  afterEach(() => {
    for (const db of [dbF, keyA, keyB]) {
      try { db.close() } catch { /* already closed */ }
    }
  })

  it('N=3: one admin\'s revokeDevice vote alone does NOT remove the target admin; the second other admin\'s vote DOES', async () => {
    const campId = randomUUID()
    await seedCampAndAdmin(dbF, { campId, deviceId: 'device-f', name: 'Director', pin: '246810' })

    // Founder, per the ADR, is axiomatic at genesis.
    const { getCurrentDoc } = await import('./sync/automerge/liveDoc.js')
    const { peerId: founderPeerId } = await ensureDeviceIdentity(dbF)
    mintGenesisEntry(dbF, { founderDeviceId: 'device-f', founderPeerId })
    projectEntity(dbF, getCurrentDoc(dbF), 'camp_authority_log')

    // device-a (the target) and device-b (the second admin) each hold their OWN real
    // device_identity_key — on SEPARATE dbs, since the key table is a device-local singleton —
    // granted admin by the founder. The grant entries land in dbF's own document (the founder
    // mints them; there is no live connection needed for a grant/vote to be minted — only for it
    // to reach ANOTHER peer, which this test does not need, since every evaluation below reads
    // dbF's OWN authority_cache).
    const { peerId: aPeerId } = await ensureDeviceIdentity(keyA)
    const { peerId: bPeerId } = await ensureDeviceIdentity(keyB)
    mintGrantEntry(dbF, { targetDeviceId: 'device-a', targetPeerId: aPeerId, signerDeviceId: 'device-f' })
    mintGrantEntry(dbF, { targetDeviceId: 'device-b', targetPeerId: bPeerId, signerDeviceId: 'device-f' })
    projectEntity(dbF, getCurrentDoc(dbF), 'camp_authority_log')
    // N=3 (device-f, device-a, device-b) established.
    expect(authorityCacheStatus(dbF, 'device-a')).toBe('admin')

    db_insertDevicesRow(dbF, 'device-a')
    db_insertDevicesRow(dbF, 'device-b')
    const handlersF = makeHandlers(dbF, 'device-f', { getAutomergeSyncNode: () => null })
    const { token: adminToken } = await handlersF.login({ name: 'Director', pin: '246810' })

    // Vote 1 — the director's REAL action, through the REAL revokeDevice handler. N=3, threshold
    // over the 2 OTHER admins (device-f, device-b) is floor((3-1)/2)+1 = 2. One vote is NOT enough.
    const result1 = handlersF.revokeDevice({ token: adminToken, deviceId: 'device-a', reason: 'vote 1 of 2' })
    // T332 fold-in (Red Hat HIGH, Art. V) — the Host-local devices.revoked_at write is now
    // gated on the real quorum state, not written optimistically: one vote against an
    // admin/founder target must not report (or render) "revoked" yet.
    expect(result1.revoked).toBe(false)
    expect(authorityCacheStatus(dbF, 'device-a')).toBe('admin') // the DISTRIBUTED quorum has not been met yet.
    expect(
      dbF.prepare("SELECT COUNT(*) c FROM applied_authority_log WHERE target_device_id = 'device-a' AND kind = 'revoke'").get().c
    ).toBe(1)

    // Vote 2 — device-b's own vote. A real, independently-keyed admin device signs its own
    // 'revoke' entry against the target, landing directly in dbF's document (standing in for what
    // would arrive via a real sync merge from device-b's own node — authorityProjection.test.js's
    // multi-device-signer pattern; the signature itself is genuine, signed with device-b's own
    // private key, never dbF's).
    const entryId = randomUUID()
    const sig = signAuthorityEntry(keyB, { id: entryId, kind: 'revoke', target_device_id: 'device-a', signer_device_id: 'device-b' })
    const { appendOp } = await import('./ops/operations.js')
    appendOp(dbF, { entity: 'camp_authority_log', entity_id: entryId, field: 'kind', value: 'revoke', device_id: 'device-b' })
    appendOp(dbF, { entity: 'camp_authority_log', entity_id: entryId, field: 'target_device_id', value: 'device-a', device_id: 'device-b' })
    appendOp(dbF, { entity: 'camp_authority_log', entity_id: entryId, field: 'signer_device_id', value: 'device-b', device_id: 'device-b' })
    appendOp(dbF, { entity: 'camp_authority_log', entity_id: entryId, field: 'signature', value: sig, device_id: 'device-b' })
    projectEntity(dbF, getCurrentDoc(dbF), 'camp_authority_log')

    expect(authorityCacheStatus(dbF, 'device-a')).toBe('revoked')
    expect(
      dbF.prepare("SELECT COUNT(*) c FROM applied_authority_log WHERE target_device_id = 'device-a' AND kind = 'revoke'").get().c
    ).toBe(2)
  })
})

function db_insertDevicesRow(db, id) {
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
  ).run(id, id, new Date().toISOString())
}
