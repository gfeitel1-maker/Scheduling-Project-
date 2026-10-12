// @vitest-environment node
//
// T376 R1 (docs/adr/2026-10-12-shared-signed-device-roster.md): a Host-signed roster entry is self-certifying. A
// device may present its OWN entry on the authenticate frame; the verifier checks the Host signature, that the entry
// binds the Noise-authenticated peer id and the claimed device id, and that the device is not revoked, then admits
// the device and merges the entry into its document. Real libp2p nodes, real join flow, Host off.
import { describe, it, expect, afterEach } from 'vitest'
import { setupThreeJoinedDevices, AmClient, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { readRecord } from '../../automerge/campDocument.js'
import { signRosterEntry } from '../../automerge/deviceRosterSignature.js'

let rig
let extra = []
afterEach(async () => {
  await Promise.all(extra.map((c) => c.stop()))
  extra = []
  if (rig) {
    await Promise.all([rig.host.stop(), rig.clientA.stop(), rig.clientB.stop(), rig.clientC?.stop()])
    cleanupDirs([rig.tmpDir])
    rig = null
  }
})

const settle = (p) => p.then((r) => r, (e) => ({ type: 'threw', error: String(e?.message ?? e) }))
const ownEntry = (d) => {
  const r = readRecord(d.getDoc(), 'device_roster', d.deviceId)
  return { device_id: r.device_id, device_peer_id: r.device_peer_id, added_at: r.added_at, added_by_device_id: r.added_by_device_id, sig: r.sig }
}
const frameWith = (claimed, entry) => ({ type: 'authenticate', device_id: claimed, schemaVersion: CURRENT_SCHEMA_VERSION, ...(entry ? { roster_entry: entry } : {}) })
const inCache = (d, deviceId) => !!d.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(deviceId)

// D joins via the Host while B is down, the Host goes off, and B comes back without D's entry.
async function newcomerUnknownToB() {
  rig = await setupThreeJoinedDevices()
  const { host, clientB: b, tmpDir } = rig
  await b.node.stop()
  const d = new AmClient(`${tmpDir}/clientD.db`)
  d.open()
  extra.push(d)
  await d.join(host)
  await waitFor(() => inCache(d, d.deviceId), 8000)
  await host.stop()
  await b.restart(`${tmpDir}/ub`, rig.campId)
  expect(inCache(b, d.deviceId)).toBe(false)
  await d.node.dial(b.node.getMultiaddrs()[0])
  return { d, b }
}

describe('R1. a device presents its own Host-signed roster entry', () => {
  it('admits a brand-new device the verifier has never seen, merges its entry, and syncs', async () => {
    const { d, b } = await newcomerUnknownToB()
    const reply = await settle(d.node.authenticateWith(b.node.peerId, frameWith(d.deviceId, ownEntry(d))))
    expect(reply.type).toBe('auth_ok')
    expect(b.node.isPeerAuthenticated(d.node.peerId)).toBe(true)
    expect(inCache(b, d.deviceId)).toBe(true)
    expect(readRecord(b.getDoc(), 'device_roster', d.deviceId)?.sig).toBe(ownEntry(d).sig)
    await settle(b.node.authenticateWith(d.node.peerId, frameWith(b.deviceId, ownEntry(b))))
    await d.write({ entity: 'activities', entity_id: 'r1-edit', field: 'name', value: 'x' })
    await waitFor(() => !!b.domainRow('activities', 'r1-edit'), 5000)
  }, 120000)

})

// A stranger never auto-authenticates (it has no camp, so it trusts nobody), so each attempt below is the only one.
async function strangerWithHostSignedEntry() {
  rig = await setupThreeJoinedDevices()
  const { host, clientB: b, tmpDir } = rig
  const stranger = new AmClient(`${tmpDir}/stranger-${extra.length}.db`)
  stranger.open()
  await stranger.start()
  extra.push(stranger)
  const campId = host.db.prepare('SELECT id FROM camps LIMIT 1').get().id
  const added_at = new Date().toISOString()
  const sig = signRosterEntry(host.db, { id: stranger.deviceId, camp_id: campId, device_id: stranger.deviceId, device_peer_id: stranger.node.peerId, added_at })
  const entry = { device_id: stranger.deviceId, device_peer_id: stranger.node.peerId, added_at, added_by_device_id: host.deviceId, sig }
  await host.stop()
  await stranger.node.dial(b.node.getMultiaddrs()[0])
  return { stranger, b, entry }
}

describe('R1 negatives (each has a genuine twin that admits)', () => {
  it('admits the genuine entry, refuses the same entry edited', async () => {
    const { stranger, b, entry } = await strangerWithHostSignedEntry()
    const forged = { ...entry, added_at: new Date(0).toISOString() }
    expect(await settle(stranger.node.authenticateWith(b.node.peerId, frameWith(stranger.deviceId, forged)))).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
    expect(inCache(b, stranger.deviceId)).toBe(false)
    expect(readRecord(b.getDoc(), 'device_roster', stranger.deviceId)).toBeFalsy()
    expect((await settle(stranger.node.authenticateWith(b.node.peerId, frameWith(stranger.deviceId, entry)))).type).toBe('auth_ok')
    expect(inCache(b, stranger.deviceId)).toBe(true)
  }, 120000)

  it('refuses the genuine entry of a revoked device', async () => {
    const { stranger, b, entry } = await strangerWithHostSignedEntry()
    b.db.prepare("INSERT OR REPLACE INTO authority_cache (device_id, status, updated_at) VALUES (?, 'revoked', ?)").run(stranger.deviceId, new Date().toISOString())
    const reply = await settle(stranger.node.authenticateWith(b.node.peerId, frameWith(stranger.deviceId, entry)))
    expect(reply.type).toBe('auth_failed')
    expect(inCache(b, stranger.deviceId)).toBe(false)
    expect(readRecord(b.getDoc(), 'device_roster', stranger.deviceId)).toBeFalsy()
    b.db.prepare('DELETE FROM authority_cache WHERE device_id = ?').run(stranger.deviceId)
    expect((await settle(stranger.node.authenticateWith(b.node.peerId, frameWith(stranger.deviceId, entry)))).type).toBe('auth_ok')
  }, 120000)

  it('refuses a genuine entry presented from a different Noise peer', async () => {
    const { stranger, b, entry } = await strangerWithHostSignedEntry()
    const thief = new AmClient(`${rig.tmpDir}/thief.db`)
    thief.open()
    await thief.start()
    extra.push(thief)
    await thief.node.dial(b.node.getMultiaddrs()[0])
    const reply = await settle(thief.node.authenticateWith(b.node.peerId, frameWith(stranger.deviceId, entry)))
    expect(reply.type).toBe('auth_failed')
    expect(b.node.isPeerAuthenticated(thief.node.peerId)).toBe(false)
    expect(inCache(b, stranger.deviceId)).toBe(false)
    expect((await settle(stranger.node.authenticateWith(b.node.peerId, frameWith(stranger.deviceId, entry)))).type).toBe('auth_ok')
  }, 120000)
})
