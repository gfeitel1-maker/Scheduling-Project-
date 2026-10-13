// @vitest-environment node
//
// A "removed" mark is only ever as true as this device's OWN authority state (selfRemoval.js). When that state later says
// the device is NOT revoked (a re-grant supersedes the revoke), the mark must clear by itself: no re-pair, the renderer is
// told, and sync resumes. A device whose own state still says revoked stays removed. Real libp2p nodes, real join flow.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'

import { setupTwoJoinedDevices, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { startSyncNode } from './syncNode.js'
import { applyWrite, readRecord } from '../../automerge/campDocument.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { isRemovedFromCamp } from './selfRemoval.js'

let rigs = []
afterEach(async () => {
  for (const r of rigs) await Promise.all([r.host.stop(), r.clientA.stop(), r.clientB?.stop()].filter(Boolean))
  rigs = []
})

const settleMs = (ms) => new Promise((r) => setTimeout(r, ms))
const writesFor = (entity, id, fields) => Object.entries(fields).map(([field, value]) => ({ entity, entity_id: id, field, value }))
async function writeEntry(host, id, fields) {
  let doc = host.node.getDoc()
  for (const w of writesFor('camp_authority_log', id, fields)) doc = applyWrite(doc, w)
  await host.node.applyLocal(doc)
}
const signed = (kind, signerDb, signerId, targetId, extra = {}) => {
  const id = randomUUID()
  return { id, fields: { kind, target_device_id: targetId, signer_device_id: signerId, ...extra, signature: signAuthorityEntry(signerDb, { id, kind, target_device_id: targetId, signer_device_id: signerId }) } }
}
async function hostEvictsClientA(rig) {
  const { host, clientA } = rig
  host.node.revokePeer(clientA.node.peerId)
  await settleMs(400)
  await host.node.dial(clientA.node.getMultiaddrs()[0])
  await host.node.authenticateWith(clientA.node.peerId, { type: 'authenticate', device_id: host.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION }).catch(() => {})
}

async function rigWithClientAMarkedRemoved() {
  const rejections = []
  const restored = []
  const rig = await setupTwoJoinedDevices({
    clientANode: (opts) => startSyncNode({ ...opts, onAuthRejected: (p, reply, info) => rejections.push(info), onRemovalCleared: () => restored.push(true), removedRetryMs: 0 }),
  })
  rigs.push(rig)
  const { host, clientA } = rig
  const genesisId = randomUUID()
  await writeEntry(host, genesisId, { kind: 'genesis', target_device_id: host.deviceId, target_peer_id: host.node.peerId })
  await waitFor(() => Object.keys(clientA.node.getDoc().camp_authority_log ?? {}).length > 0, 8000)
  host.node.revokePeer(clientA.node.peerId)
  const revoke = signed('revoke', host.db, host.deviceId, clientA.deviceId)
  host.db.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), clientA.deviceId)
  await writeEntry(host, revoke.id, revoke.fields)
  await hostEvictsClientA(rig)
  await waitFor(() => isRemovedFromCamp(clientA.db), 15000)
  return { rig, rejections, restored }
}

describe('a false "removed" heals itself', () => {
  it('a re-grant supersedes the revoke: the mark clears, the renderer is told, and the device syncs again, with no re-pair', async () => {
    const { rig, restored } = await rigWithClientAMarkedRemoved()
    const { host, clientA } = rig
    const grant = signed('grant', host.db, host.deviceId, clientA.deviceId, { target_peer_id: clientA.node.peerId })
    await writeEntry(host, grant.id, grant.fields)
    await host.node.dial(clientA.node.getMultiaddrs()[0])
    await host.node.authenticateWith(clientA.node.peerId, { type: 'authenticate', device_id: host.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION }).catch(() => {})

    await waitFor(() => !isRemovedFromCamp(clientA.db), 20000)
    expect(restored.length).toBeGreaterThan(0)
    expect(clientA.db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(clientA.deviceId).status).toBe('admin')

    const actId = randomUUID()
    await host.node.applyLocal(applyWrite(host.node.getDoc(), { entity: 'activities', entity_id: actId, field: 'name', value: 'After heal' }))
    await waitFor(() => readRecord(clientA.node.getDoc(), 'activities', actId)?.name === 'After heal', 20000)
  }, 90000)

  it('control: a device whose own authority state still says revoked stays removed through further refusals', async () => {
    const { rig, restored } = await rigWithClientAMarkedRemoved()
    await hostEvictsClientA(rig)
    await settleMs(3000)
    expect(isRemovedFromCamp(rig.clientA.db)).toBe(true)
    expect(restored).toEqual([])
  }, 90000)
})
