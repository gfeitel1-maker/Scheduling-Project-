// @vitest-environment node
//
// A peer's refusal is never a verdict (selfRemoval.js): a device shows "access removed" only when ITS OWN
// authority state says it is revoked. Real libp2p nodes through the harness's real join flow. The refusing peer is
// the real Host, except in the forgery cases, where collectRevocationEvidence is overridden to make the Host lie.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const lie = vi.hoisted(() => ({ evidence: null, reason: null, db: null }))
vi.mock('./removalEvidence.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, collectRevocationEvidence: (...args) => lie.evidence ?? real.collectRevocationEvidence(...args) }
})

vi.mock('../../auth/connectionAuth.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, evaluateAuthenticate: (...args) => (lie.reason && args[0] === lie.db ? { ok: false, code: 4403, reason: lie.reason } : real.evaluateAuthenticate(...args)) }
})

import { setupTwoJoinedDevices, AmHost, makeTmpDir, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { startSyncNode } from './syncNode.js'
import { applyWrite } from '../../automerge/campDocument.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { isRemovedFromCamp } from './selfRemoval.js'

let rigs = []
let dirs = []
afterEach(async () => {
  lie.evidence = null
  lie.reason = null
  lie.db = null
  for (const r of rigs) await Promise.all([r.host.stop(), r.clientA.stop(), r.clientB?.stop()].filter(Boolean))
  rigs = []
  cleanupDirs(dirs)
  dirs = []
})

function watching() {
  const rejections = []
  const startSyncNodeOverride = (opts) => startSyncNode({ ...opts, onAuthRejected: (peerId, reply, info) => rejections.push({ reply, info }) })
  return { rejections, startSyncNodeOverride }
}

async function rigWithWatchingClientA() {
  const { rejections, startSyncNodeOverride } = watching()
  const rig = await setupTwoJoinedDevices({ clientANode: startSyncNodeOverride })
  rigs.push(rig)
  lie.db = rig.host.db
  return { rig, rejections }
}

const writesFor = (entity, id, fields) => Object.entries(fields).map(([field, value]) => ({ entity, entity_id: id, field, value }))
async function writeAuthorityEntry(host, id, fields) {
  let doc = host.node.getDoc()
  for (const w of writesFor('camp_authority_log', id, fields)) doc = applyWrite(doc, w)
  await host.node.applyLocal(doc)
}
async function genesisOnEveryone(rig) {
  const { host, clientA } = rig
  await writeAuthorityEntry(host, randomUUID(), { kind: 'genesis', target_device_id: host.deviceId, target_peer_id: host.node.peerId })
  await waitFor(() => clientA.db.prepare('SELECT 1 FROM applied_authority_log').get() || clientA.db.prepare("SELECT 1 FROM roster_cache").get(), 3000).catch(() => {})
  await waitFor(() => Object.keys(clientA.node.getDoc().camp_authority_log ?? {}).length > 0, 8000)
}
const signedRevoke = (signerDb, signerDeviceId, targetDeviceId, id = randomUUID()) => ({
  id, kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId,
  signature: signAuthorityEntry(signerDb, { id, kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId }),
})
const settleMs = (ms) => new Promise((r) => setTimeout(r, ms))
// The Host refuses clientA the way it does a removed device: drop its admission and connection; clientA retries once.
async function hostEvictsClientA(rig) {
  const { host, clientA } = rig
  host.node.revokePeer(clientA.node.peerId)
  await settleMs(400)
  await host.node.dial(clientA.node.getMultiaddrs()[0])
  // The Host authenticating to clientA makes clientA authenticate back, which is what the Host then refuses.
  await host.node.authenticateWith(clientA.node.peerId, { type: 'authenticate', device_id: host.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION }).catch(() => {})
}

describe('(a) a peer that merely does not know us', () => {
  it('device_not_authorized while this device is trusted: no removal, renderer told nothing', async () => {
    const { rig, rejections } = await rigWithWatchingClientA()
    for (const reason of ['device_not_authorized', 'device_not_found', 'peer_identity_mismatch']) {
      lie.reason = reason
      const seen = rejections.length
      await hostEvictsClientA(rig)
      await waitFor(() => rejections.length > seen, 8000)
      expect(rejections.at(-1).reply.reason).toBe(reason)
      expect(rejections.at(-1).info, reason).toEqual({ removed: false })
      expect(isRemovedFromCamp(rig.clientA.db), reason).toBe(false)
      await settleMs(1200)
    }
  }, 60000)
})

describe('(b) a revocation claim with no signed revocation', () => {
  it('device_revoked from the legacy stamp alone (no authority entry exists): stays signed in', async () => {
    const { rig, rejections } = await rigWithWatchingClientA()
    rig.host.db.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), rig.clientA.deviceId)
    await hostEvictsClientA(rig)
    await waitFor(() => rejections.length > 0, 8000)
    expect(rejections[0].reply.reason).toBe('device_revoked')
    expect(rejections[0].reply.evidence).toBeUndefined()
    expect(isRemovedFromCamp(rig.clientA.db)).toBe(false)
    expect(rejections[0].info).toEqual({ removed: false })
  }, 60000)

  it('a peer that lies: device_revoked_by_authority with an empty evidence list: stays signed in', async () => {
    const { rig, rejections } = await rigWithWatchingClientA()
    rig.host.db.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), rig.clientA.deviceId)
    lie.reason = 'device_revoked_by_authority'
    lie.evidence = []
    await hostEvictsClientA(rig)
    await waitFor(() => rejections.length > 0, 8000)
    expect(isRemovedFromCamp(rig.clientA.db)).toBe(false)
    expect(rejections[0].info).toEqual({ removed: false })
  }, 60000)
})

describe('(c) forged, wrong-camp or non-admin-signed revocation evidence', () => {
  it('is ignored: signature forged, entry re-targeted, signed by a non-admin, signed by another camp\'s admin, oversized list', async () => {
    const { rig, rejections } = await rigWithWatchingClientA()
    await genesisOnEveryone(rig)
    const { host, clientA, clientB } = rig
    rig.host.db.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), clientA.deviceId)

    const foreignDir = makeTmpDir(); dirs.push(foreignDir)
    const foreign = new AmHost(`${foreignDir}/host.db`)
    await foreign.start()
    await foreign.bootstrap({ campName: 'Other Camp' })

    const genuine = signedRevoke(host.db, host.deviceId, clientA.deviceId)
    const variants = {
      forgedSignature: [{ ...genuine, signature: genuine.signature.slice(0, -4) + 'AAAA' }],
      retargeted: [{ ...signedRevoke(host.db, host.deviceId, clientB.deviceId), target_device_id: clientA.deviceId }],
      signedByNonAdmin: [signedRevoke(clientB.db, clientB.deviceId, clientA.deviceId)],
      signedByForeignCampAdmin: [signedRevoke(foreign.db, foreign.deviceId, clientA.deviceId)],
      unsigned: [{ ...genuine, signature: '' }],
      oversized: Array.from({ length: 50 }, () => genuine),
      notAList: { ...genuine },
    }
    for (const [name, evidence] of Object.entries(variants)) {
      lie.reason = 'device_revoked_by_authority'
      lie.evidence = evidence
      const seen = rejections.length
      await hostEvictsClientA(rig)
      await waitFor(() => rejections.length > seen, 8000)
      expect(isRemovedFromCamp(clientA.db), name).toBe(false)
      expect(rejections.at(-1).info, name).toEqual({ removed: false })
      expect(clientA.db.prepare("SELECT 1 FROM authority_cache WHERE device_id = ? AND status = 'revoked'").get(clientA.deviceId), name).toBeUndefined()
      await settleMs(1500)
    }
    await foreign.stop()
  }, 120000)
})

describe('(d) a genuinely revoked device learns it from the refusal', () => {
  it('admin signs a revoke on the Host; the device (cut off before it could sync it) verifies the evidence in the refusal, merges it and records the removal', async () => {
    const { rig, rejections } = await rigWithWatchingClientA()
    await genesisOnEveryone(rig)
    const { host, clientA } = rig
    expect(isRemovedFromCamp(clientA.db)).toBe(false)

    // revokeDevice's order: the Host revokes (entry in its document) and evicts; the device never receives the entry by sync.
    host.node.revokePeer(clientA.node.peerId)
    const entry = signedRevoke(host.db, host.deviceId, clientA.deviceId)
    host.db.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), clientA.deviceId)
    const { id, ...fields } = entry
    await writeAuthorityEntry(host, id, fields)
    expect(host.db.prepare("SELECT status FROM authority_cache WHERE device_id = ?").get(clientA.deviceId)?.status).toBe('revoked')

    await hostEvictsClientA(rig)
    await waitFor(() => isRemovedFromCamp(clientA.db), 15000)
    expect(rejections.at(-1).reply.reason).toBe('device_revoked_by_authority')
    expect(rejections.at(-1).reply.evidence).toHaveLength(1)
    expect(rejections.at(-1).info).toEqual({ removed: true })
    expect(clientA.db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(clientA.deviceId).status).toBe('revoked')
  }, 60000)
})

describe('(g) the revoking admin is one the refused device has never heard of', () => {
  it('the refusal ships the signer\'s grant; the device verifies the chain (peer id from its own roster), merges it and records the removal', async () => {
    const { rig, rejections } = await rigWithWatchingClientA()
    await genesisOnEveryone(rig)
    const { host, clientA, clientB } = rig
    host.node.revokePeer(clientA.node.peerId)
    const grantId = randomUUID()
    await writeAuthorityEntry(host, grantId, {
      kind: 'grant', target_device_id: clientB.deviceId, target_peer_id: clientB.node.peerId, signer_device_id: host.deviceId,
      signature: signAuthorityEntry(host.db, { id: grantId, kind: 'grant', target_device_id: clientB.deviceId, signer_device_id: host.deviceId }),
    })
    const { id, ...fields } = signedRevoke(clientB.db, clientB.deviceId, clientA.deviceId)
    await writeAuthorityEntry(host, id, fields)
    host.db.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), clientA.deviceId)
    expect(clientA.node.getDoc().camp_authority_log?.[grantId]).toBeUndefined()
    expect(clientA.db.prepare('SELECT 1 FROM roster_cache WHERE device_id = ?').get(clientB.deviceId)).toBeTruthy()

    await hostEvictsClientA(rig)
    await waitFor(() => isRemovedFromCamp(clientA.db), 15000)
    expect(rejections.at(-1).info).toEqual({ removed: true })
  }, 60000)
})

describe('(f) a throwing renderer notification', () => {
  it('never becomes an unhandled rejection', async () => {
    const unhandled = []
    const onUnhandled = (e) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    let called = 0
    const rig = await setupTwoJoinedDevices({ clientANode: (opts) => startSyncNode({ ...opts, onAuthRejected: () => { called++; throw new Error('window destroyed') } }) })
    rigs.push(rig)
    lie.db = rig.host.db
    lie.reason = 'device_not_authorized'
    await genesisOnEveryone(rig)
    await hostEvictsClientA(rig)
    await waitFor(() => called > 0, 8000)
    await settleMs(500)
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
  }, 60000)
})

describe('(g2) evidence unit', () => {
  it('a grant claim whose signer is not an admin here is not adopted', async () => {
    const { rig } = await rigWithWatchingClientA()
    await genesisOnEveryone(rig)
    const { clientA } = rig
    const { verifiedEvidenceWrites } = await import('./removalEvidence.js')
    expect(verifiedEvidenceWrites(clientA.node.getDoc(), clientA.deviceId, [{ id: 'x', kind: 'grant', target_device_id: 'z', signer_device_id: 'nobody', signature: 'sig' }], new Map([['z', 'p']]))).toEqual([])
  }, 60000)
})
