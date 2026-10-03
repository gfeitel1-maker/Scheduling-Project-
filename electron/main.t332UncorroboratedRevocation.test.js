// @vitest-environment node
//
// Amendment 2026-10-03b (docs/adr/2026-10-02-distributed-revocation-authority.md's "closing the
// two-device residual" section) — the recovery affordance for a blind revoke: a device X that
// calls revokeDevice(A) with NO prior authority_cache knowledge of A now durably records that
// the stamp was applied blind (devices.revoked_without_authority_knowledge = 1), and a new IPC
// action (clearUncorroboratedRevocation) lets a director manually clear ONLY that local
// devices.revoked_at — never authority_cache or the document — so A's real history can arrive.
//
// RED-before-green: written and run BEFORE the schema column/handler exist, so every test here
// must fail (no such column / no such function) before this round's changes land.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey, issueCampToken } from './auth/localAuth.js'
import { makeHandlers } from './main.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from './automerge/authorityLog.js'
import { projectEntity } from './automerge/projector.js'
import { getCurrentDoc, setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'
import { ensureDeviceIdentity } from './auth/deviceIdentity.js'
import { evaluateAuthenticate } from './auth/connectionAuth.js'

let db, founderDeviceId, userDataDir, sharedPeerId

function localTestWrite(byDeviceId) {
  return async (args) => {
    const { appendOp } = await import('./ops/operations.js')
    return { status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: byDeviceId, parent_op_id: null }) }
  }
}

function insertDevice(id, { authorized = true } = {}) {
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, ?, ?)"
  ).run(id, id, authorized ? 'authorized' : 'pending', authorized ? new Date().toISOString() : null)
}

function deviceRow(id) {
  return db.prepare('SELECT revoked_at, revoked_without_authority_knowledge, pairing_status FROM devices WHERE id = ?').get(id)
}

function authorityCacheStatus(id) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(id)?.status ?? null
}

function projectAuthority() {
  projectEntity(db, getCurrentDoc(db), 'camp_authority_log')
}

async function seedFounderCamp() {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'T332 Residual Camp', 'a'.repeat(64))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  insertDevice(founderDeviceId)
  const founder = await createUser(db, { camp_id: campId, name: 'Founder', pin: '135790', role: 'admin' }, localTestWrite(founderDeviceId))
  db.prepare('UPDATE devices SET authorized_by_user_id = ? WHERE id = ?').run(founder.id, founderDeviceId)
  const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
  sharedPeerId = founderPeerId
  mintGenesisEntry(db, { founderDeviceId, founderPeerId })
  projectAuthority()
  return { campId, founder }
}

async function grantAdmin({ campId, name, pin, deviceId }) {
  insertDevice(deviceId)
  await createUser(db, { camp_id: campId, name, pin, role: 'admin' }, localTestWrite(founderDeviceId))
  mintGrantEntry(db, { targetDeviceId: deviceId, targetPeerId: sharedPeerId, signerDeviceId: founderDeviceId })
  projectAuthority()
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t332residual-'))
  setUserDataDirGetter(() => userDataDir)
  const templated = openTemplatedDb()
  db = templated.db
  founderDeviceId = getOrCreateDeviceId(db)
})

afterEach(() => {
  resetLiveDocForTests()
  try { db.close() } catch { /* already closed */ }
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

afterAll(() => {
  cleanupTemplatedDbs()
})

describe('Amendment 2026-10-03b — the two-device residual recovery', () => {
  it('a blind revoke (no prior authority knowledge) sets revoked_without_authority_knowledge = 1', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    const targetA = 'device-a-unsynced'
    insertDevice(targetA)
    // founderDeviceId has NO prior authority_cache row for targetA at all — the exact
    // two-device-deadlock case (X has never synced A's grant).
    expect(authorityCacheStatus(targetA)).toBeNull()

    const result = handlers.revokeDevice({ token, deviceId: targetA, reason: 'blind' })
    expect(result).toEqual({ deviceId: targetA, revoked: true })

    const row = deviceRow(targetA)
    expect(row.revoked_at).toEqual(expect.any(String))
    expect(row.revoked_without_authority_knowledge).toBe(1)
  })

  it('the flag is set once and never self-reinforces (repeat revoke does not overwrite it)', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    const targetA = 'device-a-repeat'
    insertDevice(targetA)
    handlers.revokeDevice({ token, deviceId: targetA, reason: 'first' })
    // By now authority_cache for targetA is self-confirmed 'revoked' from the first call's own
    // mint — so this repeat call's OWN pre-mint read sees a prior row (status 'revoked'), which
    // is "known and already revoked," not "no authority knowledge at all."
    expect(authorityCacheStatus(targetA)).toBe('revoked')

    handlers.revokeDevice({ token, deviceId: targetA, reason: 'second' })
    const row = deviceRow(targetA)
    // The marker specifically is what must never self-reinforce (the amendment's own sketch's
    // CASE WHEN guard applies to THIS column only — revoked_at itself and revocation_reason are
    // re-stamped on every call, same as before this amendment; only the marker is protected).
    expect(row.revoked_without_authority_knowledge).toBe(1) // never cleared or re-set to null
  })

  it('a genuinely quorum-revoked admin never gets the marker set at all', async () => {
    const { campId } = await seedFounderCamp()
    const admin2 = 'device-admin2-quorum'
    const admin3 = 'device-admin3-quorum'
    await grantAdmin({ campId, name: 'Admin2', pin: '246813', deviceId: admin2 })
    await grantAdmin({ campId, name: 'Admin3', pin: '357914', deviceId: admin3 })

    const handlers2 = makeHandlers(db, admin2, { getAutomergeSyncNode: () => null })
    await handlers2.chooseMode({ mode: 'client' })
    const { token: admin2Token } = await handlers2.login({ name: 'Admin2', pin: '246813' })
    handlers2.revokeDevice({ token: admin2Token, deviceId: admin3, reason: 'vote 1 of 2' })
    expect(deviceRow(admin3).revoked_without_authority_knowledge).toBeNull() // known admin — not "no knowledge"

    mintRevokeEntry(db, { targetDeviceId: admin3, signerDeviceId: founderDeviceId })
    projectAuthority()
    expect(authorityCacheStatus(admin3)).toBe('revoked')

    // The founder's own second-vote call ALSO sees a prior row (status now 'revoked' from the
    // first vote) — still not "no knowledge," so the marker stays unset even on this call.
    const handlersF = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlersF.chooseMode({ mode: 'host' })
    const { token: founderToken } = await handlersF.login({ name: 'Founder', pin: '135790' })
    handlersF.revokeDevice({ token: founderToken, deviceId: admin3, reason: 'vote 2 of 2' })
    expect(deviceRow(admin3).revoked_without_authority_knowledge).toBeNull()
  })

  it('clearUncorroboratedRevocation clears the blind stamp and marker; the connection admission effect is observed, not assumed', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    const targetA = 'device-a-recoverable'
    insertDevice(targetA)
    handlers.revokeDevice({ token, deviceId: targetA, reason: 'blind' })
    expect(deviceRow(targetA).revoked_without_authority_knowledge).toBe(1)

    const result = handlers.clearUncorroboratedRevocation({ token, deviceId: targetA })
    expect(result).toEqual({ deviceId: targetA, cleared: true })

    const row = deviceRow(targetA)
    expect(row.revoked_at).toBeNull()
    expect(row.revoked_without_authority_knowledge).toBeNull()
    expect(row.pairing_status).toBe('authorized')

    // clearUncorroboratedRevocation's own doc promises it never touches authority_cache — this
    // device's own earlier mint already self-confirmed targetA as 'revoked' there, unchanged.
    expect(authorityCacheStatus(targetA)).toBe('revoked')

    // OBSERVED, not assumed: does clearing devices.revoked_at actually let targetA authenticate
    // to this device again? authority_cache for targetA is STILL 'revoked' on this db (clearing
    // never touched it) — evaluateAuthenticate's own Gate A denies on authority_cache 'revoked'
    // UNCONDITIONALLY, before the legacy devices.revoked_at check this amendment's recovery
    // action clears is ever reached. Recording the actual result here rather than assuming the
    // amendment's own prose is self-consistent with the gate code as it stands.
    const targetAToken = issueCampToken(db, randomUUID(), targetA)
    const authResult = evaluateAuthenticate(db, { token: targetAToken, device_id: targetA })
    console.log('[amendment 2026-10-03b residual check] post-clear evaluateAuthenticate result:', authResult)
  })

  it('clearUncorroboratedRevocation refuses a genuinely quorum-revoked device (no readmission)', async () => {
    const { campId } = await seedFounderCamp()
    const admin2 = 'device-admin2-noreadmit'
    const admin3 = 'device-admin3-noreadmit'
    await grantAdmin({ campId, name: 'Admin2NR', pin: '246813', deviceId: admin2 })
    await grantAdmin({ campId, name: 'Admin3NR', pin: '357914', deviceId: admin3 })

    const handlers2 = makeHandlers(db, admin2, { getAutomergeSyncNode: () => null })
    await handlers2.chooseMode({ mode: 'client' })
    const { token: admin2Token } = await handlers2.login({ name: 'Admin2NR', pin: '246813' })
    handlers2.revokeDevice({ token: admin2Token, deviceId: admin3, reason: 'vote 1 of 2' })

    // The SECOND (deciding) vote, through the real handler on a different admin — matching
    // electron/main.authorityEndToEnd.test.js's own quorum-test pattern — so devices.revoked_at
    // actually gets stamped on THIS device, not just authority_cache (a vote arriving only via
    // a raw document write, with no local revokeDevice call, never touches devices.revoked_at at
    // all — there is no mechanism that retroactively stamps it from a passive sync event).
    const handlersF = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlersF.chooseMode({ mode: 'host' })
    const { token: founderToken } = await handlersF.login({ name: 'Founder', pin: '135790' })
    handlersF.revokeDevice({ token: founderToken, deviceId: admin3, reason: 'vote 2 of 2' })

    expect(authorityCacheStatus(admin3)).toBe('revoked')
    expect(deviceRow(admin3).revoked_without_authority_knowledge).toBeNull()
    expect(deviceRow(admin3).revoked_at).toEqual(expect.any(String))

    expect(() => handlersF.clearUncorroboratedRevocation({ token: founderToken, deviceId: admin3 }))
      .toThrow('this device was revoked with authority knowledge and cannot be cleared this way')
    expect(deviceRow(admin3).revoked_at).toEqual(expect.any(String)) // unchanged, still revoked
  })

  it('clearUncorroboratedRevocation refuses an already-corroborated ordinary revoke (no prior-row flag, repeat call)', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    // Simulate an ordinary device that was ALREADY known (e.g. a prior revoke from another
    // device already landed in this device's authority_cache) before this call ever minted
    // anything — the "known and already revoked" case, not "no authority knowledge at all."
    const targetB = 'device-b-known'
    insertDevice(targetB)
    mintRevokeEntry(db, { targetDeviceId: targetB, signerDeviceId: founderDeviceId })
    projectAuthority()
    expect(authorityCacheStatus(targetB)).toBe('revoked')

    handlers.revokeDevice({ token, deviceId: targetB, reason: 'already known' })
    expect(deviceRow(targetB).revoked_without_authority_knowledge).toBeNull()

    expect(() => handlers.clearUncorroboratedRevocation({ token, deviceId: targetB }))
      .toThrow('this device was revoked with authority knowledge and cannot be cleared this way')
  })

  it('clearUncorroboratedRevocation is idempotent against a double-call after the first clear succeeds', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    const targetA = 'device-a-double-clear'
    insertDevice(targetA)
    handlers.revokeDevice({ token, deviceId: targetA, reason: 'blind' })
    handlers.clearUncorroboratedRevocation({ token, deviceId: targetA })

    expect(() => handlers.clearUncorroboratedRevocation({ token, deviceId: targetA }))
      .toThrow('device is not currently revoked')
  })

  it('an ordinary device revoke is unchanged: immediate removal, revoked_at stamped as today', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    const ordinary = 'device-ordinary-unchanged'
    insertDevice(ordinary)
    const result = handlers.revokeDevice({ token, deviceId: ordinary })
    expect(result).toEqual({ deviceId: ordinary, revoked: true })
    const row = deviceRow(ordinary)
    expect(row.revoked_at).toEqual(expect.any(String))
    expect(row.pairing_status).toBe('revoked')
  })
})
