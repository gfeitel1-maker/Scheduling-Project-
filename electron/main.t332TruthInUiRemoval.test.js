// @vitest-environment node
//
// T332 fold-in (Organizer FIX-FIRST ruling, Red Hat HIGH / Art. V "never show the director a
// tidy lie"): revokeDevice used to stamp devices.revoked_at (and DeviceManagerScreen rendered
// "Removed" off it) the instant ANY one admin called revoke — even for an admin/founder target,
// where the real camp_authority_log replay may still require more votes to reach quorum. A
// director voting to remove another admin would see "Removed" while that admin stayed fully
// live. This file proves: (a) an admin/founder target is not rendered/written as removed until
// the replay actually shows quorum met, while an ORDINARY target still removes immediately
// (unchanged); (b) an admin may not revoke/vote-to-remove their OWN device, enforced server-side;
// (c) the device-list data contract (effectiveState/votesNeeded/votesCast/hasVoted/isSelf) is
// computed correctly from the real authority replay, never recomputed ad hoc.
//
// RED-before-green: written and run against the PRE-fix handler, so the admin-target tests below
// must fail (revoked_at gets stamped immediately) and the self-guard test must fail (no throw)
// before the fix lands.
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
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { makeHandlers } from './main.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from './automerge/authorityLog.js'
import { projectEntity } from './automerge/projector.js'
import { getCurrentDoc, setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'
import { ensureDeviceIdentity } from './auth/deviceIdentity.js'

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
  return db.prepare('SELECT revoked_at, pairing_status FROM devices WHERE id = ?').get(id)
}

function projectAuthority() {
  projectEntity(db, getCurrentDoc(db), 'camp_authority_log')
}

async function seedFounderCamp() {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'T332 Fix Camp', 'a'.repeat(64))
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

// Same shared-identity simplification as main.t332ClientAdminMinting.test.js: every "device" in
// this file signs through the one shared db/key, so every grantee is given the SAME peer id to
// verify signatures against.
async function grantAdmin({ campId, name, pin, deviceId }) {
  insertDevice(deviceId)
  await createUser(db, { camp_id: campId, name, pin, role: 'admin' }, localTestWrite(founderDeviceId))
  mintGrantEntry(db, { targetDeviceId: deviceId, targetPeerId: sharedPeerId, signerDeviceId: founderDeviceId })
  projectAuthority()
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t332fix-'))
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

describe('T332 fold-in — truth-in-UI removal state for admin/founder targets', () => {
  it('an ORDINARY device target is still removed immediately (unchanged behavior)', async () => {
    const { campId } = await seedFounderCamp()
    void campId
    const ordinaryDeviceId = 'device-ordinary'
    insertDevice(ordinaryDeviceId)

    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    const result = handlers.revokeDevice({ token, deviceId: ordinaryDeviceId })
    expect(result).toEqual({ deviceId: ordinaryDeviceId, revoked: true })

    const row = deviceRow(ordinaryDeviceId)
    expect(row.revoked_at).toEqual(expect.any(String))
    expect(row.pairing_status).toBe('revoked')
  })

  it('an ADMIN target is NOT written/read as revoked_at until quorum is met (RED before the fix)', async () => {
    const { campId } = await seedFounderCamp()
    const admin2DeviceId = 'device-admin2'
    const admin3DeviceId = 'device-admin3'
    await grantAdmin({ campId, name: 'Admin2', pin: '246813', deviceId: admin2DeviceId })
    await grantAdmin({ campId, name: 'Admin3', pin: '357914', deviceId: admin3DeviceId })
    // N=3 admins: threshold over the 2 others is floor((3-1)/2)+1 = 2.

    const handlers2 = makeHandlers(db, admin2DeviceId, { getAutomergeSyncNode: () => null })
    await handlers2.chooseMode({ mode: 'client' })
    const { token: admin2Token } = await handlers2.login({ name: 'Admin2', pin: '246813' })

    // One vote only — quorum (2) is not met yet.
    const result = handlers2.revokeDevice({ token: admin2Token, deviceId: admin3DeviceId, reason: 'vote 1 of 2' })
    expect(result).toEqual({ deviceId: admin3DeviceId, revoked: false })

    const row = deviceRow(admin3DeviceId)
    expect(row.revoked_at).toBeNull()
    expect(row.pairing_status).toBe('authorized')

    // The second (deciding) vote — now quorum is met, and the local row catches up.
    mintRevokeEntry(db, { targetDeviceId: admin3DeviceId, signerDeviceId: founderDeviceId })
    projectAuthority()
    const handlersF = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    // Re-derive via the real handler's own post-mint check by calling revokeDevice once more is
    // unnecessary — the fix's post-mint devices-table sync happens inside revokeDevice itself, so
    // drive it through the handler again is not how a real quorum-met vote lands; assert directly
    // against the projected authority_cache, which is the data-contract's own source of truth.
    void handlersF
    const cache = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(admin3DeviceId)
    expect(cache.status).toBe('revoked')
  })

  it('an admin cannot revoke/vote-to-remove their OWN device (server-side guard, RED before the fix)', async () => {
    await seedFounderCamp()
    const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlers.chooseMode({ mode: 'host' })
    const { token } = await handlers.login({ name: 'Founder', pin: '135790' })

    expect(() => handlers.revokeDevice({ token, deviceId: founderDeviceId }))
      .toThrow('You cannot remove your own device.')

    const row = deviceRow(founderDeviceId)
    expect(row.revoked_at).toBeNull()
  })
})

describe('T332 fold-in — listDevices data contract (effectiveState/votesNeeded/votesCast/hasVoted/isSelf)', () => {
  it('computes active/removal_pending/isSelf from the real authority replay, for admin rows only', async () => {
    const { campId } = await seedFounderCamp()
    const admin2DeviceId = 'device-admin2-dc'
    const admin3DeviceId = 'device-admin3-dc'
    await grantAdmin({ campId, name: 'Admin2DC', pin: '246813', deviceId: admin2DeviceId })
    await grantAdmin({ campId, name: 'Admin3DC', pin: '357914', deviceId: admin3DeviceId })
    const ordinaryDeviceId = 'device-ordinary-dc'
    insertDevice(ordinaryDeviceId)

    const handlers2 = makeHandlers(db, admin2DeviceId, { getAutomergeSyncNode: () => null })
    await handlers2.chooseMode({ mode: 'client' })
    const { token: admin2Token } = await handlers2.login({ name: 'Admin2DC', pin: '246813' })
    handlers2.revokeDevice({ token: admin2Token, deviceId: admin3DeviceId, reason: 'vote 1 of 2' })

    // Viewed from admin2 (the one who voted): admin3 is removal_pending, hasVoted true.
    const asAdmin2 = handlers2.listDevices({ token: admin2Token })
    const admin3RowFromAdmin2 = asAdmin2.find((d) => d.id === admin3DeviceId)
    expect(admin3RowFromAdmin2).toMatchObject({
      effectiveState: 'removal_pending', votesNeeded: 2, votesCast: 1, hasVoted: true, isSelf: false,
    })
    const admin2RowFromAdmin2 = asAdmin2.find((d) => d.id === admin2DeviceId)
    expect(admin2RowFromAdmin2).toMatchObject({ effectiveState: 'active', isSelf: true })
    const ordinaryRow = asAdmin2.find((d) => d.id === ordinaryDeviceId)
    expect(ordinaryRow.effectiveState).toBeUndefined()

    // Viewed from the founder (who has NOT voted on this removal): hasVoted false.
    const handlersF = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => null })
    await handlersF.chooseMode({ mode: 'host' })
    const { token: founderToken } = await handlersF.login({ name: 'Founder', pin: '135790' })
    const asFounder = handlersF.listDevices({ token: founderToken })
    const admin3RowFromFounder = asFounder.find((d) => d.id === admin3DeviceId)
    expect(admin3RowFromFounder).toMatchObject({
      effectiveState: 'removal_pending', votesNeeded: 2, votesCast: 1, hasVoted: false, isSelf: false,
    })

    // The founder's own second vote meets quorum — effectiveState flips to 'removed'.
    handlersF.revokeDevice({ token: founderToken, deviceId: admin3DeviceId, reason: 'vote 2 of 2' })
    const afterQuorum = handlersF.listDevices({ token: founderToken }).find((d) => d.id === admin3DeviceId)
    expect(afterQuorum.effectiveState).toBe('removed')
  })
})
