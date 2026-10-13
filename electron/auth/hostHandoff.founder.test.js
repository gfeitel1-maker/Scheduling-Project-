// @vitest-environment node
//
// Amendment 2026-10-13 (docs/adr/2026-10-02-distributed-revocation-authority.md): the founder is the genesis signed by
// the camp key. A host handoff moves the PRIVATE half of that key and leaves camps.signing_public_key (the root every
// device checks genesis against) and camp_authority_log untouched, so founder and admin state do not change on either
// device, and the new Host's own grants (it is an admin by grant) still apply.
import * as Automerge from '@automerge/automerge'
import { describe, it, expect, afterAll } from 'vitest'
import { cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { createHostHandoff } from './hostHandoff.js'
import { makeHandoffPair } from './hostHandoffTestSupport.js'
import { createEmptyDoc, applyWrite } from '../automerge/campDocument.js'
import { signAuthorityEntry } from '../automerge/authorityLogSignature.js'
import { signGenesisEntry, readCampRoot } from '../automerge/genesisSignature.js'
import { createAuthorityReplayContext, createVerifiedEntryTrust } from '../automerge/authorityReplay.js'

afterAll(() => cleanupTemplatedDbs())

function put(doc, id, fields) {
  let d = doc
  for (const [field, value] of Object.entries(fields)) d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  return d
}

describe('host handoff and the camp-signed genesis', () => {
  it('leaves the founder and admin set unchanged on both devices, and the new Host grants still apply', async () => {
    const { campId, H, S } = await makeHandoffPair()
    const gSig = signGenesisEntry(H.db, { id: 'g', camp_id: campId, target_device_id: H.deviceId, target_peer_id: H.identity.peerId })
    let doc = put(createEmptyDoc(), 'g', { kind: 'genesis', target_device_id: H.deviceId, target_peer_id: H.identity.peerId, signature: gSig })
    const grantS = signAuthorityEntry(H.db, { id: 'grant-s', kind: 'grant', target_device_id: S.deviceId, signer_device_id: H.deviceId })
    doc = put(doc, 'grant-s', { kind: 'grant', target_device_id: S.deviceId, target_peer_id: S.identity.peerId, signer_device_id: H.deviceId, signature: grantS })

    const state = (root, d) => {
      const ctx = createAuthorityReplayContext(Automerge, d, { root, isEntryTrusted: createVerifiedEntryTrust(Automerge, d, root) })
      return { founder: ctx.founderDeviceId, admins: [...ctx.currentState().grantedSet].sort() }
    }
    const before = { h: state(readCampRoot(H.db), doc), s: state(readCampRoot(S.db), doc) }
    expect(before.h).toEqual(before.s)
    expect(before.h.founder).toBe(H.deviceId)

    const clock = { t: Date.parse('2026-10-09T12:00:00Z') }
    for (const side of [H, S]) {
      side.svc = createHostHandoff({ db: side.db, deviceId: side.deviceId, getDeviceIdentity: async () => side.identity, now: () => clock.t, relaunch: () => {} })
    }
    const send = (from, to, msg) => to.svc.handle(msg, { peerDeviceId: from.deviceId })
    const offer = H.svc.offer(S.deviceId)
    await send(H, S, offer.msg)
    const accept = await S.svc.accept()
    const key = await send(S, H, accept.msg)
    const stored = await send(H, S, key.reply)
    const commit = await send(S, H, stored.reply)
    const done = await send(H, S, commit.reply)
    expect(done.reply.type).toBe('DONE')
    expect(S.db.prepare('SELECT 1 FROM host_signing_key').get()).toBeTruthy()
    expect(H.db.prepare('SELECT 1 FROM host_signing_key').get()).toBeUndefined()

    expect({ h: state(readCampRoot(H.db), doc), s: state(readCampRoot(S.db), doc) }).toEqual(before)

    const grantNew = signAuthorityEntry(S.db, { id: 'grant-new', kind: 'grant', target_device_id: 'new-device', signer_device_id: S.deviceId })
    doc = put(doc, 'grant-new', { kind: 'grant', target_device_id: 'new-device', target_peer_id: 'peer-new', signer_device_id: S.deviceId, signature: grantNew })
    const after = { h: state(readCampRoot(H.db), doc), s: state(readCampRoot(S.db), doc) }
    expect(after.h).toEqual(after.s)
    expect(after.h.founder).toBe(H.deviceId)
    expect(after.h.admins).toEqual([H.deviceId, S.deviceId, 'new-device'].sort())
  })
})
