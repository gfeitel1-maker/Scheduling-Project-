// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — mints `camp_authority_log`
// entries into the shared document. Deliberately thin: every field is written through the SAME
// generic appendOp path every other MODELED_ENTITIES entity uses (campDocument.js's
// EXTRA_MODELED_ENTITIES comment explains why no PROJECTIONS registration is needed) — this module
// only computes the entry id, signs the entry's fixed fields with the ACTING device's own
// device_identity_key, and appends each field as its own op, all inside one runAtomic boundary.
//
// Only two writer-chosen `kind`s exist: 'genesis' (signed by the camp key, written once at camp
// bootstrap) and the signed pair 'grant'/'revoke'. There is no writer-chosen 'revoke-vote' — see
// campDocument.js's EXTRA_MODELED_ENTITIES comment for why that collapse is faithful to the ADR
// (the replay, not the writer, decides whether a 'revoke' is an immediate removal or a vote).
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic } from '../ops/operations.js'
import { signAuthorityEntry } from './authorityLogSignature.js'
import { signGenesisEntry } from './genesisSignature.js'

// An entry is defined by ONE Automerge change that writes all of its signed fields and its signature together
// (authorityReplay.js's signedEntries reads nothing else), so it is written inside runAtomic, which applies the
// whole run to the document as a single change. A target peer id that is not yet known is written as ''.
function writeEntry(db, { entryId, fields, deviceId }) {
  runAtomic(db, () => {
    for (const [field, value] of Object.entries(fields)) {
      appendOp(db, { entity: 'camp_authority_log', entity_id: entryId, field, value, device_id: deviceId })
    }
  })
}

/** The genesis entry, written once at camp bootstrap and signed with the Host's camp signing key. */
export function mintGenesisEntry(db, { founderDeviceId, founderPeerId, campId }) {
  const entryId = randomUUID()
  const peerId = founderPeerId ?? ''
  const signature = signGenesisEntry(db, { id: entryId, camp_id: campId, target_device_id: founderDeviceId, target_peer_id: peerId })
  writeEntry(db, {
    entryId,
    deviceId: founderDeviceId,
    fields: { kind: 'genesis', target_device_id: founderDeviceId, target_peer_id: peerId, signature },
  })
  return entryId
}

/** A signed 'grant' entry — the acting (signer) device grants admin status to a target device. */
export function mintGrantEntry(db, { targetDeviceId, targetPeerId, signerDeviceId }) {
  const entryId = randomUUID()
  const peerId = targetPeerId ?? ''
  // `id` is bound into the signature (authorityLogSignature.js) — a genuine signed tuple cannot
  // be replayed under a DIFFERENT record id to resurrect a device a later revoke removed.
  const signature = signAuthorityEntry(db, { id: entryId, kind: 'grant', target_device_id: targetDeviceId, target_peer_id: peerId, signer_device_id: signerDeviceId })
  writeEntry(db, {
    entryId,
    deviceId: signerDeviceId,
    fields: { kind: 'grant', target_device_id: targetDeviceId, target_peer_id: peerId, signer_device_id: signerDeviceId, signature },
  })
  return entryId
}

/**
 * A signed 'revoke' entry — the acting (signer) device casts ITS signature against a target
 * device. The replay (authorityReplay.js), on every peer, independently re-derives whether this
 * is an immediate removal (target not currently admin) or a vote toward quorum (target IS
 * currently admin/founder) — never trusted from how the writer framed it.
 */
export function mintRevokeEntry(db, { targetDeviceId, signerDeviceId }) {
  const entryId = randomUUID()
  const signature = signAuthorityEntry(db, { id: entryId, kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
  writeEntry(db, {
    entryId,
    deviceId: signerDeviceId,
    fields: { kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId, signature },
  })
  return entryId
}
