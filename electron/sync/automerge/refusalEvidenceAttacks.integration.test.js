// @vitest-environment node
//
// A peer's refusal can hand a device real Automerge changes, never entries to re-author. These are the attacks a
// revoked admin (clientB, "D") or a foreign camp mounts through a refusal, against a stale healthy device (clientA, "H").
// The refusing Host is made to lie via collectRevocationEvidence; what H does with the claim is the real code.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as A from '@automerge/automerge'

const lie = vi.hoisted(() => ({ build: null, db: null }))
vi.mock('./removalEvidence.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, collectRevocationEvidence: (...args) => (lie.build ? lie.build(...args) : real.collectRevocationEvidence(...args)) }
})
vi.mock('../../auth/connectionAuth.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, evaluateAuthenticate: (...args) => (lie.db && args[0] === lie.db ? { ok: false, code: 4403, reason: 'device_revoked_by_authority' } : real.evaluateAuthenticate(...args)) }
})

import { setupTwoJoinedDevices, AmHost, makeTmpDir, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { startSyncNode } from './syncNode.js'
import { applyWrite, readRecord } from '../../automerge/campDocument.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { isRemovedFromCamp } from './selfRemoval.js'
import { rosterDevice } from './rosterTestSupport.js'

let rigs = []
let dirs = []
afterEach(async () => {
  lie.build = null
  lie.db = null
  for (const r of rigs) await Promise.all([r.host.stop(), r.clientA.stop(), r.clientB?.stop()].filter(Boolean))
  rigs = []
  cleanupDirs(dirs)
  dirs = []
})

const settleMs = (ms) => new Promise((r) => setTimeout(r, ms))
const fieldWrites = (id, fields) => Object.entries(fields).map(([field, value]) => ({ entity: 'camp_authority_log', entity_id: id, field, value }))
const withEntry = (doc, id, fields) => fieldWrites(id, fields).reduce((d, w) => applyWrite(d, w), doc)
const signed = (signerDb, signerDeviceId, kind, targetDeviceId, extra = {}) => {
  const id = randomUUID()
  const base = { kind, target_device_id: targetDeviceId, signer_device_id: signerDeviceId, ...extra }
  return { id, fields: { ...base, signature: signAuthorityEntry(signerDb, { id, ...base }) } }
}
const toB64 = (changes) => changes.map((c) => Buffer.from(c).toString('base64'))

async function rig() {
  const rejections = []
  const r = await setupTwoJoinedDevices({ clientANode: (opts) => startSyncNode({ ...opts, onAuthRejected: (peerId, reply, info) => rejections.push({ reply, info }) }) })
  rigs.push(r)
  const { host, clientA, clientB } = r
  await host.node.applyLocal(withEntry(host.node.getDoc(), randomUUID(), { kind: 'genesis', target_device_id: host.deviceId, target_peer_id: host.node.peerId }))
  await waitFor(() => Object.keys(clientA.node.getDoc().camp_authority_log ?? {}).length > 0, 8000)
  const grantB = signed(host.db, host.deviceId, 'grant', clientB.deviceId, { target_peer_id: clientB.node.peerId })
  await host.node.applyLocal(withEntry(host.node.getDoc(), grantB.id, grantB.fields))
  await waitFor(() => readRecord(clientA.node.getDoc(), 'camp_authority_log', grantB.id), 8000)
  return { ...r, rejections, grantB }
}

// The Host revokes D (R) while H is cut off, so H never receives R; the refused H then dials into the lying Host.
async function hostRevokesDWhileHIsCutOff(r) {
  const { host, clientA, clientB } = r
  host.node.revokePeer(clientA.node.peerId)
  const revokeD = signed(host.db, host.deviceId, 'revoke', clientB.deviceId)
  await host.node.applyLocal(withEntry(host.node.getDoc(), revokeD.id, revokeD.fields))
  return revokeD
}
async function hostRefusesH(r) {
  const { host, clientA } = r
  lie.db = host.db
  await settleMs(400)
  await host.node.dial(clientA.node.getMultiaddrs()[0])
  await host.node.authenticateWith(clientA.node.peerId, { type: 'authenticate', device_id: host.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION }).catch(() => {})
}
const statusOf = (db, deviceId) => db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status

describe('(A) a revoked ex-admin forges a revoke of the healthy device', () => {
  it('H stays signed in: D\'s revoke of H, written after D\'s own revocation, never counts', async () => {
    const r = await rig()
    const { clientA, clientB, rejections } = r
    await hostRevokesDWhileHIsCutOff(r)
    const forgery = signed(clientB.db, clientB.deviceId, 'revoke', clientA.deviceId)
    lie.build = (doc, deviceId, peerHeads) => ATTACK_A(r, forgery, peerHeads)
    const headsBefore = A.getHeads(clientA.node.getDoc())
    const seen = rejections.length
    await hostRefusesH(r)
    await waitFor(() => rejections.length > seen, 10000)
    await settleMs(500)
    expect(isRemovedFromCamp(clientA.db)).toBe(false)
    expect(readRecord(clientA.node.getDoc(), 'camp_authority_log', forgery.id)).toBeFalsy()
    expect(A.getHeads(clientA.node.getDoc())).toEqual(headsBefore)
    expect(statusOf(clientA.db, clientA.deviceId)).not.toBe('revoked')
    expect(rejections.at(-1).info).toEqual({ removed: false })
  }, 90000)
})

describe('(G) a revoked admin backdates a revoke of the healthy device', () => {
  it('H already knows D is revoked: a revoke D wrote before its own revocation does not remove H', async () => {
    const r = await rig()
    const { host, clientA, clientB, rejections } = r
    const forgery = signed(clientB.db, clientB.deviceId, 'revoke', clientA.deviceId)
    const forkWithForgery = withEntry(A.clone(host.node.getDoc()), forgery.id, forgery.fields)
    const revokeD = signed(host.db, host.deviceId, 'revoke', clientB.deviceId)
    await host.node.applyLocal(withEntry(host.node.getDoc(), revokeD.id, revokeD.fields))
    await waitFor(() => statusOf(clientA.db, clientB.deviceId) === 'revoked', 10000)
    lie.build = (doc, deviceId, peerHeads) => ({ changes: toB64(sinceOf(forkWithForgery, peerHeads)) })
    const seen = rejections.length
    await hostRefusesH(r)
    await waitFor(() => rejections.length > seen, 10000)
    await settleMs(500)
    expect(isRemovedFromCamp(clientA.db)).toBe(false)
    expect(readRecord(clientA.node.getDoc(), 'camp_authority_log', forgery.id)).toBeFalsy()
    expect(statusOf(clientA.db, clientA.deviceId)).not.toBe('revoked')
  }, 90000)
})

describe('(B) a revoked admin smuggles a post-revoke grant for an attacker', () => {
  it('the attacker is not an admin on H', async () => {
    const r = await rig()
    const { clientA, clientB, rejections } = r
    rosterDevice(clientA.db, 'attacker-x', '12D3KooWattackerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
    await hostRevokesDWhileHIsCutOff(r)
    const smuggled = signed(clientB.db, clientB.deviceId, 'grant', 'attacker-x', { target_peer_id: '12D3KooWattackerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
    lie.build = (doc, deviceId, peerHeads) => ATTACK_B(r, smuggled, peerHeads)
    const seen = rejections.length
    await hostRefusesH(r)
    await waitFor(() => rejections.length > seen, 10000)
    await settleMs(500)
    expect(statusOf(clientA.db, 'attacker-x')).toBeUndefined()
    expect(readRecord(clientA.node.getDoc(), 'camp_authority_log', smuggled.id)).toBeFalsy()
    expect(isRemovedFromCamp(clientA.db)).toBe(false)
  }, 90000)
})

describe('(E) another camp\'s changes in a refusal', () => {
  it('are rejected before applying: H\'s document is untouched', async () => {
    const r = await rig()
    const { clientA, rejections } = r
    const foreignDir = makeTmpDir(); dirs.push(foreignDir)
    const foreign = new AmHost(`${foreignDir}/host.db`)
    await foreign.start()
    await foreign.bootstrap({ campName: 'Other Camp' })
    const foreignRevoke = signed(foreign.db, foreign.deviceId, 'revoke', clientA.deviceId)
    const foreignDoc = withEntry(foreign.node.getDoc(), foreignRevoke.id, foreignRevoke.fields)
    await hostRevokesDWhileHIsCutOff(r)
    lie.build = () => ATTACK_E(foreignDoc)
    const headsBefore = A.getHeads(clientA.node.getDoc())
    const seen = rejections.length
    await hostRefusesH(r)
    await waitFor(() => rejections.length > seen, 10000)
    await settleMs(500)
    expect(A.getHeads(clientA.node.getDoc())).toEqual(headsBefore)
    expect(isRemovedFromCamp(clientA.db)).toBe(false)
    await foreign.stop()
  }, 90000)
})

const hostDocPlus = (r, entry) => withEntry(A.clone(r.host.node.getDoc()), entry.id, entry.fields)
const sinceOf = (doc, peerHeads) => A.getChangesSince(doc, (peerHeads ?? []).filter((h) => A.hasHeads(doc, [h])))
// What a lying refuser sends: REAL changes (the Host's document, plus the attacker's own entry written on top of it).
const ATTACK_A = (r, forgery, peerHeads) => ({ changes: toB64(sinceOf(hostDocPlus(r, forgery), peerHeads)) })
const ATTACK_B = (r, smuggled, peerHeads) => ({ changes: toB64(sinceOf(hostDocPlus(r, smuggled), peerHeads)) })
const ATTACK_E = (foreignDoc) => ({ changes: toB64(A.getAllChanges(foreignDoc)) })

