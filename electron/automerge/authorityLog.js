// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — mints `camp_authority_log`
// entries into the shared document. Deliberately thin: every field is written through the SAME
// generic appendOp path every other MODELED_ENTITIES entity uses (campDocument.js's
// EXTRA_MODELED_ENTITIES comment explains why no PROJECTIONS registration is needed) — this module
// only computes the entry id, signs the entry's fixed fields with the ACTING device's own
// device_identity_key, and appends each field as its own op, mirroring how any other multi-field
// row gets written one field at a time (e.g. ScheduleScreen's writeFields()).
//
// Only two writer-chosen `kind`s exist: 'genesis' (axiomatic, unsigned, written once at camp
// bootstrap) and the signed pair 'grant'/'revoke'. There is no writer-chosen 'revoke-vote' — see
// campDocument.js's EXTRA_MODELED_ENTITIES comment for why that collapse is faithful to the ADR
// (the replay, not the writer, decides whether a 'revoke' is an immediate removal or a vote).
import { randomUUID } from 'node:crypto'
import { appendOp } from '../ops/operations.js'
import { signAuthorityEntry } from './authorityLogSignature.js'

function writeField(db, { entryId, field, value, deviceId }) {
  appendOp(db, { entity: 'camp_authority_log', entity_id: entryId, field, value, device_id: deviceId })
}

/** The axiomatic genesis entry — no signature, written once at camp bootstrap. */
export function mintGenesisEntry(db, { founderDeviceId, founderPeerId }) {
  const entryId = randomUUID()
  writeField(db, { entryId, field: 'kind', value: 'genesis', deviceId: founderDeviceId })
  writeField(db, { entryId, field: 'target_device_id', value: founderDeviceId, deviceId: founderDeviceId })
  writeField(db, { entryId, field: 'target_peer_id', value: founderPeerId, deviceId: founderDeviceId })
  return entryId
}

/** A signed 'grant' entry — the acting (signer) device grants admin status to a target device. */
export function mintGrantEntry(db, { targetDeviceId, targetPeerId, signerDeviceId }) {
  const entryId = randomUUID()
  const signature = signAuthorityEntry(db, { kind: 'grant', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
  writeField(db, { entryId, field: 'kind', value: 'grant', deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'target_device_id', value: targetDeviceId, deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'target_peer_id', value: targetPeerId, deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'signer_device_id', value: signerDeviceId, deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'signature', value: signature, deviceId: signerDeviceId })
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
  const signature = signAuthorityEntry(db, { kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
  writeField(db, { entryId, field: 'kind', value: 'revoke', deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'target_device_id', value: targetDeviceId, deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'signer_device_id', value: signerDeviceId, deviceId: signerDeviceId })
  writeField(db, { entryId, field: 'signature', value: signature, deviceId: signerDeviceId })
  return entryId
}
