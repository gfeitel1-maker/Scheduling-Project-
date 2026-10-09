// F1 of docs/work/security/2026-10-09-wan-ladder-assessment.md, round 2 design: the rendezvous
// namespace and address key are rotated whenever the camp's revocation set changes, by ONE
// elected device, keyed to the same revocation digest the T335 rotating mDNS tag uses.
//
// - `camps.rendezvousRotatedFor` records the revocation digest the current secrets were minted
//   for. A device whose verified view of the revocation set differs from it, and which is the
//   elected rotator, rotates. Every device runs the check (after each projection and on doc load),
//   so a revocation that arrives by merge (quorum, concurrent revokes) is covered the same way as
//   a local one, and concurrent revokes of X and Y re-rotate once the merge shows both.
// - ELECTED rotator: the lowest device id among currently granted admins. Deterministic on every
//   device, so the camp does not churn N rotations per revocation.
// - A camp that never enabled rendezvous (no namespace minted) is skipped: nothing to rotate.
import * as A from '@automerge/automerge'
import { recordKey, readRecord } from '../../automerge/campDocument.js'
import { createAuthorityReplayContext, createVerifiedEntryTrust } from '../../automerge/authorityReplay.js'
import { revocationDigest, encodeRevokedIds } from '../../automerge/authorityRevocationDigest.js'
import { createHash } from 'node:crypto'
import { readRendezvousNamespace, rotateRendezvousNamespace } from './rendezvousNamespace.js'
import { rotateRendezvousAddressKey } from './rendezvousAddressKey.js'
import { getCurrentDoc, setCurrentDoc } from './liveDoc.js'
import { recordDeviceHealthEvent, DEVICE_HEALTH } from '../../ops/deviceHealthEvents.js'

export const ROTATED_FOR_FIELD = 'rendezvousRotatedFor'
export const RENDEZVOUS_FIELDS = Object.freeze(['rendezvousDiscovery', 'rendezvousAddressKey', ROTATED_FOR_FIELD])
const EMPTY_REVOCATION_DIGEST = createHash('sha256').update(encodeRevokedIds([])).digest('hex')

export function readRotatedFor(doc, campId) {
  return readRecord(doc, 'camps', campId)?.[ROTATED_FOR_FIELD] ?? EMPTY_REVOCATION_DIGEST
}

export function electedRotator(doc) {
  const isEntryTrusted = createVerifiedEntryTrust(A, doc)
  const { grantedSet } = createAuthorityReplayContext(A, doc, { isEntryTrusted }).currentState()
  return [...grantedSet].sort()[0] ?? null
}

/** Pure: returns { doc, rotated, reason }. Never writes unless this device is the elected rotator. */
export function checkRendezvousRotation(doc, { campId, deviceId, randomBytes } = {}) {
  if (!doc || !campId || !readRendezvousNamespace(doc, campId)) return { doc, rotated: false, reason: 'never-enabled' }
  const digest = revocationDigest(A, doc, { isEntryTrusted: createVerifiedEntryTrust(A, doc) })
  if (readRotatedFor(doc, campId) === digest) return { doc, rotated: false, reason: 'current' }
  if (electedRotator(doc) !== deviceId) return { doc, rotated: false, reason: 'not-elected' }
  const opts = randomBytes ? { randomBytes } : {}
  let next = rotateRendezvousNamespace(doc, campId, opts).doc
  next = rotateRendezvousAddressKey(next, campId, opts).doc
  next = A.change(next, (d) => { d.camps[recordKey(campId, ROTATED_FOR_FIELD)] = digest })
  return { doc: next, rotated: true, reason: 'rotated' }
}

/**
 * Runs the check against this device's live document and, on a rotation, stores it and
 * broadcasts it. `broadcast` is required whenever a sync node is running; passing a node without
 * it is a wiring defect and is reported, never silently skipped. A failure is logged AND recorded
 * as a device-health event (owner rule: surface every write failure).
 */
export function runRendezvousRotation(db, { deviceId, broadcast }) {
  const campId = db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
  try {
    const result = checkRendezvousRotation(getCurrentDoc(db), { campId, deviceId })
    if (!result.rotated) return result
    setCurrentDoc(db, result.doc)
    if (broadcast !== null) {
      if (typeof broadcast !== 'function') throw new Error('rendezvous rotation: broadcast is not a function')
      broadcast()
    }
    return result
  } catch (err) {
    console.error(`rendezvous rotation failed: ${err?.message ?? err}`)
    recordDeviceHealthEvent(db, {
      campId,
      kind: DEVICE_HEALTH.RENDEZVOUS_ROTATION_FAILED,
      detail: JSON.stringify({ error: String(err?.message ?? err) }),
    })
    return { rotated: false, reason: 'failed', error: err }
  }
}
