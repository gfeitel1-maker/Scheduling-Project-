// @vitest-environment node
//
// T376 (docs/adr/2026-10-12-shared-signed-device-roster.md) section 6, tests E-K: revocation through the roster
// with the Host off, forged and overwritten roster entries, no-readmission, the stale-view window, peer-id
// binding, ordering and Host-only enrolment. Real libp2p nodes and Automerge docs; every device joins through the
// harness's real join flow, so rosters come from the Host's login mint, never from hand-inserted rows.
import { describe, it, expect, afterEach } from 'vitest'
import { setupThreeJoinedDevices, AmClient, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { applyWrite, readRecord } from '../../automerge/campDocument.js'
import { hostGenesisSignature } from '../../automerge/genesisTestKit.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { signRosterEntry } from '../../automerge/deviceRosterSignature.js'
import { buildRosterWrites } from '../../automerge/deviceRoster.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { evaluatePairingRequest } from '../../auth/connectionAuth.js'
import { projectAll } from '../../automerge/projector.js'
import { DELETE_FIELD } from '../../ops/operations.js'

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

const frame = (d, claimed = d.deviceId) => ({ type: 'authenticate', device_id: claimed, schemaVersion: CURRENT_SCHEMA_VERSION })
const settle = (p) => p.then((r) => r, (e) => ({ type: 'threw', error: String(e?.message ?? e) }))

async function link(a, b) {
  if (!a.node.getPeers().includes(b.node.peerId)) await a.node.dial(b.node.getMultiaddrs()[0])
  const ab = await settle(a.node.authenticateWith(b.node.peerId, frame(a)))
  const ba = await settle(b.node.authenticateWith(a.node.peerId, frame(b)))
  return { ab, ba, admits: a.node.isPeerAuthenticated(b.node.peerId) && b.node.isPeerAuthenticated(a.node.peerId) }
}

async function reaches(from, to, id, ms = 3000) {
  await from.write({ entity: 'activities', entity_id: id, field: 'name', value: id })
  try { await waitFor(() => !!to.domainRow('activities', id), ms); return true } catch { return false }
}

const rosterOf = (d) => d.db.prepare('SELECT device_id, peer_id FROM roster_cache ORDER BY device_id').all()
const authority = (d, deviceId) => d.db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status

async function writeEntries(device, entries) {
  let doc = device.getDoc()
  for (const e of entries) doc = applyWrite(doc, e)
  await device.node.applyLocal(doc)
}

function authorityEntry(signerDb, id, fields) {
  const signature = fields.kind === 'genesis'
    ? hostGenesisSignature(signerDb, { id, target_device_id: fields.target_device_id, target_peer_id: fields.target_peer_id })
    : signAuthorityEntry(signerDb, { id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
  return Object.entries({ ...fields, ...(signature ? { signature } : {}) }).map(([field, value]) => ({ entity: 'camp_authority_log', entity_id: id, field, value }))
}

// The Host is the founder; it grants admin to `admin`, and every client waits to see it.
async function makeAdmin(host, admin, everyone) {
  const { peerId: hostPeer } = await ensureDeviceIdentity(host.db)
  await writeEntries(host, [
    ...authorityEntry(host.db, 'e-genesis', { kind: 'genesis', target_device_id: host.deviceId, target_peer_id: hostPeer }),
    ...authorityEntry(host.db, 'e-grant', { kind: 'grant', target_device_id: admin.deviceId, target_peer_id: admin.node.peerId, signer_device_id: host.deviceId }),
  ])
  for (const d of everyone) await waitFor(() => authority(d, admin.deviceId) === 'admin', 8000)
}

async function revoke(admin, target) {
  await writeEntries(admin, authorityEntry(admin.db, `e-revoke-${target.deviceId}`, { kind: 'revoke', target_device_id: target.deviceId, signer_device_id: admin.deviceId }))
}

// A device with a libp2p node but no roster entry anywhere: the "stranger" in the forgery tests.
async function startStranger(tmpDir) {
  const s = new AmClient(`${tmpDir}/stranger-${extra.length}.db`)
  s.open()
  await s.start()
  extra.push(s)
  return s
}

function hostSignedWrites(host, { id, deviceId, peerId }) {
  const added_at = new Date().toISOString()
  const campId = host.db.prepare('SELECT id FROM camps LIMIT 1').get().id
  const sig = signRosterEntry(host.db, { id, camp_id: campId, device_id: deviceId, device_peer_id: peerId, added_at })
  return Object.entries({ device_id: deviceId, device_peer_id: peerId, added_at, added_by_device_id: host.deviceId, sig }).map(([field, value]) => ({ entity: 'device_roster', entity_id: id, field, value }))
}

describe('every joined device is rostered by the real join flow', () => {
  it('the Host and all three clients hold all four devices, bound to their real peer ids', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA, clientB, clientC } = rig
    const everyone = [host, clientA, clientB, clientC]
    const expected = everyone.map((d) => ({ device_id: d.deviceId, peer_id: d.node.peerId })).sort((x, y) => (x.device_id < y.device_id ? -1 : 1))
    for (const d of [clientA, clientB, clientC]) await waitFor(() => rosterOf(d).length === 4, 8000)
    expect(rosterOf(host)).toEqual(expected)
    for (const d of [clientA, clientB, clientC]) expect(rosterOf(d)).toEqual(expected)
  }, 90000)
})

describe('E. revocation propagates through the roster with the Host off', () => {
  it('B refuses a removed C on reconnect, evicts a live C, and C edits no longer reach B', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, clientC: c } = rig
    await makeAdmin(host, a, [a, b, c])
    await host.stop()
    expect((await link(b, c)).admits).toBe(true)
    expect(await reaches(c, b, 'e-before-revoke')).toBe(true)
    expect((await link(a, b)).admits).toBe(true)

    await revoke(a, c)
    await waitFor(() => authority(b, c.deviceId) === 'revoked', 8000)
    await waitFor(() => !b.node.isPeerAuthenticated(c.node.peerId), 8000)

    const r = await link(c, b)
    // B has already torn C's connection down (revokePeer), so C's attempt is cut off rather than answered; the refusal
    // reason itself is pinned for peers that hold no live connection in G.
    expect(r.ab.type).not.toBe('auth_ok')
    expect(r.admits).toBe(false)
    expect(await reaches(c, b, 'e-after-revoke', 2000)).toBe(false)
    expect((await link(a, b)).admits).toBe(true)
  }, 120000)
})

describe('F. forged, unsigned and overwritten roster entries', () => {
  it('a stranger is refused until the Host-signed entry for it arrives, and none of the forgeries admit it', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, tmpDir } = rig
    const stranger = await startStranger(tmpDir)
    await stranger.node.dial(b.node.getMultiaddrs()[0])
    const attempt = async () => settle(stranger.node.authenticateWith(b.node.peerId, frame(stranger)))
    const attacker = new AmClient(`${tmpDir}/attacker.db`)
    attacker.open()
    extra.push(attacker)
    const forged = {
      'no signature': hostSignedWrites(host, { id: stranger.deviceId, deviceId: stranger.deviceId, peerId: stranger.node.peerId }).filter((w) => w.field !== 'sig'),
      'signature from the wrong key': (() => {
        const w = hostSignedWrites(host, { id: stranger.deviceId, deviceId: stranger.deviceId, peerId: stranger.node.peerId })
        return w.map((x) => (x.field === 'sig' ? { ...x, value: Buffer.from('x'.repeat(64)).toString('base64url') } : x))
      })(),
      'peer id edited after signing': hostSignedWrites(host, { id: stranger.deviceId, deviceId: stranger.deviceId, peerId: 'someone-else' }).map((x) => (x.field === 'device_peer_id' ? { ...x, value: stranger.node.peerId } : x)),
      'copied under another record id': hostSignedWrites(host, { id: 'other-record', deviceId: stranger.deviceId, peerId: stranger.node.peerId }).map((x) => ({ ...x, entity_id: stranger.deviceId })),
    }
    for (const [name, writes] of Object.entries(forged)) {
      await writeEntries(a, writes)
      await new Promise((r) => setTimeout(r, 400))
      const reply = await attempt()
      expect(reply, name).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
      expect(b.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(stranger.deviceId), name).toBeUndefined()
      await writeEntries(a, writes.map((w) => ({ ...w, field: DELETE_FIELD, value: null })).slice(0, 1))
    }
    // control (non-vacuity): the genuine Host-signed entry admits the same stranger through the same path
    await writeEntries(a, hostSignedWrites(host, { id: stranger.deviceId, deviceId: stranger.deviceId, peerId: stranger.node.peerId }))
    await waitFor(() => b.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(stranger.deviceId), 8000)
    expect((await attempt()).type).not.toBe('auth_failed')
  }, 120000)

  it('F2/F3. a rostered client overwriting or deleting every roster record cannot take the others out', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, clientC: c } = rig
    for (const d of [a, b, c]) await waitFor(() => rosterOf(d).length === 4, 8000)
    await host.stop()
    const doc = a.getDoc()
    const ids = Object.keys(doc.device_roster).map((k) => k.split('\u0000')[0]).filter((v, i, arr) => arr.indexOf(v) === i)
    expect(ids).toHaveLength(4)
    await writeEntries(a, [
      { entity: 'device_roster', entity_id: b.deviceId, field: 'device_peer_id', value: 'overwritten' },
      { entity: 'device_roster', entity_id: c.deviceId, field: DELETE_FIELD, value: null },
    ])
    await new Promise((r) => setTimeout(r, 600))
    expect((await link(b, c)).admits).toBe(true)
    expect(rosterOf(b).find((r) => r.device_id === b.deviceId).peer_id).toBe(b.node.peerId)
    expect(rosterOf(b).find((r) => r.device_id === c.deviceId).peer_id).toBe(c.node.peerId)
  }, 120000)
})

describe('G. a removed device is refused everywhere and cannot come back', () => {
  it('is refused by every peer, its entry cannot be re-signed in, its peer id cannot be re-enrolled, and a rebuild reproduces it', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, clientC: c } = rig
    await makeAdmin(host, a, [a, b, c])
    await revoke(a, c)
    for (const d of [host, a, b]) await waitFor(() => authority(d, c.deviceId) === 'revoked', 8000)

    for (const d of [a, b]) {
      const r = await link(c, d)
      expect(r.ab.reason ?? r.ba.reason).toBe('device_revoked_by_authority')
      expect(r.admits).toBe(false)
    }

    // the Host signs the same device id in again with a fresh timestamp: ignored, still refused
    const resign = hostSignedWrites(host, { id: c.deviceId, deviceId: c.deviceId, peerId: c.node.peerId })
    await writeEntries(host, resign)
    // and signs C's old peer id in under a brand-new device id: dropped by the peer-id rule
    const newId = 'reenrolled-device'
    await writeEntries(host, hostSignedWrites(host, { id: newId, deviceId: newId, peerId: c.node.peerId }))
    await waitFor(() => Object.keys(b.getDoc().device_roster ?? {}).some((k) => k.startsWith(`${newId}\u0000`)), 8000)
    await new Promise((r) => setTimeout(r, 500))
    expect(b.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(newId)).toBeUndefined()
    const claimNew = await settle(c.node.authenticateWith(b.node.peerId, frame(c, newId)))
    expect(claimNew.type).toBe('auth_failed')

    // a pairing request for the old device id is refused by the existing rule
    expect(evaluatePairingRequest(host.db, { device_id: c.deviceId, device_name: 'Old' })).toEqual({ ok: false, reason: 'device_revoked' })

    // rebuild from the document alone (wipe both device-local caches): same roster, same refusals
    const before = rosterOf(b).filter((r) => r.device_id !== c.deviceId)
    b.db.exec('DELETE FROM roster_cache; DELETE FROM authority_cache')
    projectAll(b.db, b.getDoc())
    expect(authority(b, c.deviceId)).toBe('revoked')
    expect(rosterOf(b).filter((r) => r.device_id !== c.deviceId)).toEqual(before)
    expect(b.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(newId)).toBeUndefined()
    expect((await link(c, b)).admits).toBe(false)
  }, 120000)
})

describe('H. the stale-view window is real, bounded, and closes when the revoke arrives', () => {
  it('B keeps admitting C until it learns of the removal; then evicts it, refuses it, and keeps what C wrote meanwhile', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, clientC: c } = rig
    await makeAdmin(host, a, [a, b, c])
    await host.stop()
    expect((await link(a, c)).admits).toBe(true)
    expect((await link(b, c)).admits).toBe(true)

    await revoke(a, c)
    await waitFor(() => !a.node.isPeerAuthenticated(c.node.peerId), 8000)
    // B has not heard (A and B are not linked): the documented window
    expect(authority(b, c.deviceId)).toBeUndefined()
    expect(b.node.isPeerAuthenticated(c.node.peerId)).toBe(true)
    expect(await reaches(c, b, 'h-written-in-the-window')).toBe(true)

    expect((await link(a, b)).admits).toBe(true)
    await waitFor(() => authority(b, c.deviceId) === 'revoked', 8000)
    await waitFor(() => !b.node.isPeerAuthenticated(c.node.peerId), 8000)
    expect((await link(c, b)).admits).toBe(false)
    expect(b.domainRow('activities', 'h-written-in-the-window')).toBeTruthy()
  }, 120000)
})

describe('I. a peer id is bound to its device id', () => {
  it('a rostered device claiming another rostered device id, and a stranger claiming a rostered id, get peer_identity_mismatch', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, clientC: c, tmpDir } = rig
    for (const d of [a, b, c]) await waitFor(() => rosterOf(d).length === 4, 8000)
    await host.stop()
    await c.node.dial(b.node.getMultiaddrs()[0])
    const asA = await settle(c.node.authenticateWith(b.node.peerId, frame(c, a.deviceId)))
    expect(asA).toEqual({ type: 'auth_failed', reason: 'peer_identity_mismatch' })
    const stranger = await startStranger(tmpDir)
    await stranger.node.dial(b.node.getMultiaddrs()[0])
    const asC = await settle(stranger.node.authenticateWith(b.node.peerId, frame(stranger, c.deviceId)))
    expect(asC).toEqual({ type: 'auth_failed', reason: 'peer_identity_mismatch' })
    expect(b.node.isPeerAuthenticated(c.node.peerId)).toBe(false)
  }, 120000)
})

describe('J. a newly enrolled device is admitted by presenting its own entry (R1)', () => {
  it('B has never seen D\'s entry and the Host is off, yet D is admitted and its entry is merged, with no restart and no third device', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientB: b, tmpDir } = rig
    const bDir = `${tmpDir}/ub`
    await b.node.stop()
    const d = new AmClient(`${tmpDir}/clientD.db`)
    d.open()
    extra.push(d)
    await d.join(host)
    await host.stop()
    await b.restart(bDir, rig.campId)
    expect(rosterOf(b).some((r) => r.device_id === d.deviceId)).toBe(false)
    const own = readRecord(d.getDoc(), 'device_roster', d.deviceId)
    const presented = { device_id: own.device_id, device_peer_id: own.device_peer_id, added_at: own.added_at, added_by_device_id: own.added_by_device_id, sig: own.sig }
    await d.node.dial(b.node.getMultiaddrs()[0])
    const reply = await settle(d.node.authenticateWith(b.node.peerId, { ...frame(d), roster_entry: presented }))
    expect(reply.type).toBe('auth_ok')
    expect(rosterOf(b).some((r) => r.device_id === d.deviceId && r.peer_id === d.node.peerId)).toBe(true)
    expect((await link(d, b)).admits).toBe(true)
  }, 120000)
})

describe('K. only the Host can enroll', () => {
  it('a client cannot build a signed entry, and an entry a client writes itself admits nobody', async () => {
    rig = await setupThreeJoinedDevices()
    const { host, clientA: a, clientB: b, tmpDir } = rig
    const stranger = await startStranger(tmpDir)
    expect(buildRosterWrites(a.db, { deviceId: stranger.deviceId, peerId: stranger.node.peerId })).toBeNull()
    await host.stop()
    await writeEntries(a, [
      { entity: 'device_roster', entity_id: stranger.deviceId, field: 'device_id', value: stranger.deviceId },
      { entity: 'device_roster', entity_id: stranger.deviceId, field: 'device_peer_id', value: stranger.node.peerId },
      { entity: 'device_roster', entity_id: stranger.deviceId, field: 'added_at', value: new Date().toISOString() },
      { entity: 'device_roster', entity_id: stranger.deviceId, field: 'sig', value: 'self-signed' },
    ])
    await new Promise((r) => setTimeout(r, 500))
    await stranger.node.dial(b.node.getMultiaddrs()[0])
    expect(await settle(stranger.node.authenticateWith(b.node.peerId, frame(stranger)))).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
  }, 120000)
})
