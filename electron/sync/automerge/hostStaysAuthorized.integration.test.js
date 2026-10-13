// @vitest-environment node
//
// V1 blocker (final audit step 13): the host looked "signed out / access removed" right after pairing a new
// device. Pins, on real libp2p nodes and the harness's real join flow (approve, first login, roster enrollment):
// (1) pairing a device leaves the HOST's own trust rows untouched and authorize() still allows the host, also
// after 30s of simulated time and a redial; (2) a device of a DIFFERENT camp on the same network is refused
// before any sync byte flows, changes nothing on the host, and the host stays authorized. The renderer-side half
// of the fix (a peer's "not on my roster" must not read as "you were removed") is in syncStarter.test.js.
import { describe, it, expect, afterEach, vi } from 'vitest'

const refuse = vi.hoisted(() => ({ db: null }))
vi.mock('../../auth/connectionAuth.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, evaluateAuthenticate: (...args) => (refuse.db && args[0] === refuse.db ? { ok: false, code: 4403, reason: 'device_not_authorized' } : real.evaluateAuthenticate(...args)) }
})
import { AmHost, AmClient, setupTwoJoinedDevices, makeTmpDir, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { attemptLogin } from '../../auth/localAuth.js'
import { authorize } from '../../auth/authorize.js'
import { rosterDevice } from './rosterTestSupport.js'
import { readRecord } from '../../automerge/campDocument.js'
import { startSyncNode } from './syncNode.js'
import { isRemovedFromCamp } from './selfRemoval.js'

const realNow = Date.now
let offsetMs = 0
Date.now = () => realNow() + offsetMs

let rig
let extras = []
let extraDirs = []
afterEach(async () => {
  offsetMs = 0
  refuse.db = null
  await Promise.all(extras.map((c) => c.stop()))
  extras = []
  cleanupDirs(extraDirs)
  extraDirs = []
  if (rig) {
    await Promise.all([rig.host.stop(), rig.clientA.stop(), rig.clientB.stop()])
    cleanupDirs([rig.tmpDir])
    rig = null
  }
})

const settle = (p) => p.then((r) => r, (e) => ({ type: 'threw', error: String(e?.message ?? e) }))
const frame = (d, entry) => ({ type: 'authenticate', device_id: d.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION, ...(entry ? { roster_entry: entry } : {}) })

// main.js's bootstrapCamp stamps the Host's own devices row authorized before anyone pairs.
function authorizeHostRow(host) {
  host.db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), host.deviceId)
}
const hostTrust = (host) => ({
  device: host.db.prepare('SELECT id, authorized_at, revoked_at, revoked_by_user_id, revocation_reason, pairing_status, device_secret_identifier FROM devices WHERE id = ?').get(host.deviceId),
  roster: host.db.prepare('SELECT device_id, peer_id FROM roster_cache WHERE device_id = ?').all(host.deviceId),
  authority: host.db.prepare('SELECT device_id, status FROM authority_cache WHERE device_id = ?').all(host.deviceId),
})
const allowed = (host) => {
  const login = attemptLogin(host.db, { name: 'admin', pin: '1234', deviceId: host.deviceId })
  return authorize({ db: host.db, token: login.token, action: 'users.read' })
}

describe('pairing a new device leaves the host authorized', () => {
  it('approve + first login + roster enrollment + 30s + redial: the host\'s own device row, roster and authority entries are unchanged and authorize() allows', async () => {
    const tmpDir = makeTmpDir()
    const host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()
    authorizeHostRow(host)
    const before = hostTrust(host)
    expect(before.device.authorized_at).toBeTruthy()
    expect(allowed(host).allowed).toBe(true)

    const clientA = new AmClient(`${tmpDir}/clientA.db`); clientA.open(); await clientA.join(host)
    const clientB = new AmClient(`${tmpDir}/clientB.db`); clientB.open(); await clientB.join(host)
    rig = { tmpDir, host, clientA, clientB }

    expect(hostTrust(host)).toEqual(before)
    expect(allowed(host).allowed).toBe(true)

    offsetMs = 31_000
    for (const c of [clientA, clientB]) {
      await settle(c.node.authenticateWith(host.node.peerId, frame(c)))
      await settle(host.node.authenticateWith(c.node.peerId, frame(host)))
    }
    await new Promise((r) => setTimeout(r, 1500))
    expect(hostTrust(host)).toEqual(before)
    const res = allowed(host)
    expect(res).toMatchObject({ allowed: true, deviceId: host.deviceId })
  }, 120000)
})

describe('a joining device that has no roster yet refuses its own host', () => {
  it('the host is not removed, signed out or notified; then host and device sync both ways', async () => {
    const hostRejections = []
    rig = await setupTwoJoinedDevices({ hostNode: (opts) => startSyncNode({ ...opts, onAuthRejected: (peerId, reply, info) => hostRejections.push({ reply, info }) }) })
    const { host, clientB } = rig
    authorizeHostRow(host)
    const before = hostTrust(host)

    refuse.db = clientB.db
    host.node.revokePeer(clientB.node.peerId)
    await waitFor(() => hostRejections.length > 0, 10000)
    expect(hostRejections[0].reply).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
    expect(hostRejections[0].info).toEqual({ removed: false })
    expect(isRemovedFromCamp(host.db)).toBe(false)
    expect(hostTrust(host)).toEqual(before)
    expect(allowed(host).allowed).toBe(true)

    refuse.db = null
    await new Promise((r) => setTimeout(r, 1500))
    await clientB.node.dial(host.node.getMultiaddrs()[0])
    const r1 = await settle(host.node.authenticateWith(clientB.node.peerId, frame(host)))
    const r2 = await settle(clientB.node.authenticateWith(host.node.peerId, frame(clientB)))
    await waitFor(() => host.node.isPeerAuthenticated(clientB.node.peerId), 15000).catch(() => { throw new Error('host never re-admitted B ' + JSON.stringify([r1, r2])) })
    await waitFor(() => clientB.node.isPeerAuthenticated(host.node.peerId), 15000).catch(() => { throw new Error('B never re-admitted host') })
    await clientB.write({ entity: 'activities', entity_id: 'from-b', field: 'name', value: 'b' })
    await host.write({ entity: 'activities', entity_id: 'from-host', field: 'name', value: 'h' })
    await waitFor(() => host.domainRow('activities', 'from-b') && clientB.domainRow('activities', 'from-host'), 15000)
    expect(isRemovedFromCamp(host.db)).toBe(false)
    expect(hostTrust(host)).toEqual(before)
    expect(allowed(host).allowed).toBe(true)
  }, 120000)
})

describe('a device of a different camp', () => {
  it('is never admitted, syncs nothing in either direction, changes nothing on the host, and the host stays authorized', async () => {
    rig = await setupTwoJoinedDevices()
    const { host } = rig
    authorizeHostRow(host)
    const before = hostTrust(host)
    const rosterBefore = host.db.prepare('SELECT device_id, peer_id FROM roster_cache ORDER BY device_id').all()
    const authorityBefore = host.db.prepare('SELECT device_id, status FROM authority_cache ORDER BY device_id').all()

    const foreignDir = makeTmpDir(); extraDirs.push(foreignDir)
    const foreign = new AmHost(`${foreignDir}/host.db`)
    await foreign.start(); extras.push(foreign)
    const foreignCamp = await foreign.bootstrap({ campName: 'Other Camp' })
    expect(foreignCamp.campId).not.toBe(rig.campId)
    foreign.db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), foreign.deviceId)

    const ownEntry = readRecord(foreign.node.getDoc(), 'device_roster', foreign.deviceId)
    const entry = { device_id: ownEntry.device_id, device_peer_id: ownEntry.device_peer_id, added_at: ownEntry.added_at, added_by_device_id: ownEntry.added_by_device_id, sig: ownEntry.sig }

    await foreign.node.dial(host.node.getMultiaddrs()[0])
    const bare = await settle(foreign.node.authenticateWith(host.node.peerId, frame(foreign)))
    const withOwnCampEntry = await settle(foreign.node.authenticateWith(host.node.peerId, frame(foreign, entry)))
    expect(bare).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
    expect(withOwnCampEntry).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
    expect(host.node.isPeerAuthenticated(foreign.node.peerId)).toBe(false)

    await foreign.write({ entity: 'activities', entity_id: 'foreign-edit', field: 'name', value: 'x' })
    await host.write({ entity: 'activities', entity_id: 'host-edit', field: 'name', value: 'y' })
    await new Promise((r) => setTimeout(r, 2500))
    expect(host.domainRow('activities', 'foreign-edit')).toBeFalsy()
    expect(foreign.domainRow('activities', 'host-edit')).toBeFalsy()
    expect(host.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(foreign.deviceId)).toBeUndefined()
    expect(host.db.prepare('SELECT 1 FROM devices WHERE id = ? AND authorized_at IS NOT NULL').get(foreign.deviceId)).toBeUndefined()
    expect(host.db.prepare('SELECT device_id, peer_id FROM roster_cache ORDER BY device_id').all()).toEqual(rosterBefore)
    expect(host.db.prepare('SELECT device_id, status FROM authority_cache ORDER BY device_id').all()).toEqual(authorityBefore)
    expect(hostTrust(host)).toEqual(before)
    expect(allowed(host).allowed).toBe(true)
  }, 120000)
})

describe('non-vacuity plants', () => {
  it('the host-state snapshot and authorize() DO notice a stamped revoke on the host\'s own row', async () => {
    const tmpDir = makeTmpDir(); extraDirs.push(tmpDir)
    const host = new AmHost(`${tmpDir}/host.db`)
    await host.start(); extras.push(host)
    await host.bootstrap()
    authorizeHostRow(host)
    const before = hostTrust(host)
    expect(allowed(host).allowed).toBe(true)
    host.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), host.deviceId)
    expect(hostTrust(host)).not.toEqual(before)
    expect(allowed(host)).toEqual({ allowed: false, reason: 'device_revoked' })
  }, 60000)

  it('the foreign-camp rig CAN admit and sync once the host\'s roster holds the foreign device (so the refusal above is the gate, not the rig)', async () => {
    rig = await setupTwoJoinedDevices()
    const { host } = rig
    const foreignDir = makeTmpDir(); extraDirs.push(foreignDir)
    const foreign = new AmHost(`${foreignDir}/host.db`)
    await foreign.start(); extras.push(foreign)
    await foreign.bootstrap({ campName: 'Other Camp' })
    await foreign.node.dial(host.node.getMultiaddrs()[0])
    rosterDevice(host.db, foreign.deviceId, foreign.node.peerId)
    const reply = await settle(foreign.node.authenticateWith(host.node.peerId, frame(foreign)))
    expect(reply.type).toBe('auth_ok')
    expect(host.node.isPeerAuthenticated(foreign.node.peerId)).toBe(true)
  }, 60000)
})
