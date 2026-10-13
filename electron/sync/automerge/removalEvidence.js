// The evidence a refusal carries, and how the refused device checks it.
//
// A genuinely revoked device is refused by every peer, so ordinary sync can never deliver the revocation to it. The
// refusal itself therefore carries the signed `camp_authority_log` revoke entries that name the refused device. The
// refused device never takes the peer's word: it accepts an entry only if the signer is an admin in ITS OWN authority
// state (a signer it has not heard of is proven by the signed grants shipped with the refusal, each checked the same
// way), the signature verifies against the peer id that own state holds for the signer, and a revoke names this
// device. Accepted entries are merged into its own document; only if its re-derived authority_cache then says
// 'revoked' does it record the removal. Wrong-camp, forged, unsigned and non-admin-signed claims verify against
// nothing and are dropped.
import * as A from '@automerge/automerge'
import { AUTHORITY_LOG_ENTITY, createVerifiedEntryTrust, currentAuthorityState, currentRevokedDeviceIds, resolveAuthorityPeerIds, isCompleteEntry } from '../../automerge/authorityReplay.js'
import { verifyAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { applyWrite, listRecordIds, readRecord } from '../../automerge/campDocument.js'

export const MAX_REVOCATION_EVIDENCE = 8
const MAX_REVOKES = 4
const MAX_FIELD_LENGTH = 200
export const REVOCATION_REFUSAL_REASONS = new Set(['device_revoked', 'device_revoked_by_authority'])
const ENTRY_FIELDS = ['id', 'kind', 'target_device_id', 'signer_device_id', 'signature']

/**
 * Refusing side: the signed revoke entries in `doc` that name `deviceId`, plus the signed admin grants that make each
 * revoking signer an admin (so a device that never heard of that admin can still verify), bounded.
 */
export function collectRevocationEvidence(doc, deviceId) {
  if (!doc || typeof deviceId !== 'string' || !deviceId) return []
  const isTrusted = createVerifiedEntryTrust(A, doc)
  const entries = []
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY).sort()) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    const entry = { id, ...row }
    if (entry.kind === 'genesis' || !isTrusted(entry)) continue
    entries.push(entry)
  }
  const pick = (entry) => Object.fromEntries(ENTRY_FIELDS.map((f) => [f, entry[f]]))
  const out = entries.filter((e) => e.kind === 'revoke' && e.target_device_id === deviceId).slice(0, MAX_REVOKES).map(pick)
  const wanted = new Set(out.map((e) => e.signer_device_id))
  const seen = new Set()
  while (wanted.size && out.length < MAX_REVOCATION_EVIDENCE) {
    const signer = wanted.values().next().value
    wanted.delete(signer)
    if (seen.has(signer)) continue
    seen.add(signer)
    for (const grant of entries.filter((e) => e.kind === 'grant' && e.target_device_id === signer)) {
      if (out.length >= MAX_REVOCATION_EVIDENCE) break
      out.push(pick(grant))
      wanted.add(grant.signer_device_id)
    }
  }
  return out
}

/**
 * Refused side: the document writes for every claimed entry that verifies against `doc` (this device's own
 * document), resolving chains to a fixed point: a revoke naming this device must be signed by an admin, and a grant is
 * adopted only when its signer is already an admin here and it is for a device that is not already known revoked. A
 * grant's target peer id is NEVER taken from the claim (it is not covered by the signature); it comes from
 * `rosterPeerIds`, this device's own verified roster. Entries already held are skipped. Returns [] for anything
 * malformed or unverifiable.
 */
export function verifiedEvidenceWrites(doc, deviceId, evidence, rosterPeerIds = new Map()) {
  if (!doc || !Array.isArray(evidence) || evidence.length > MAX_REVOCATION_EVIDENCE) return []
  const pending = evidence.filter((claim) =>
    claim && typeof claim === 'object' &&
    ENTRY_FIELDS.every((f) => typeof claim[f] === 'string' && claim[f].length > 0 && claim[f].length <= MAX_FIELD_LENGTH) &&
    claim.signer_device_id !== deviceId &&
    ((claim.kind === 'revoke' && claim.target_device_id === deviceId) || claim.kind === 'grant'))
  const writes = []
  let working = A.clone(doc)
  for (let progress = true; progress && pending.length;) {
    progress = false
    const peerIdByDevice = resolveAuthorityPeerIds(A, working)
    if (peerIdByDevice.size === 0) return []
    const { admins } = currentAuthorityState(A, working)
    const revoked = new Set(currentRevokedDeviceIds(A, working, { isEntryTrusted: createVerifiedEntryTrust(A, working) }))
    for (const claim of [...pending]) {
      if (!admins.has(claim.signer_device_id)) continue
      const signerPeerId = peerIdByDevice.get(claim.signer_device_id)
      if (!signerPeerId || !verifyAuthorityEntry(signerPeerId, claim, claim.signature)) continue
      pending.splice(pending.indexOf(claim), 1)
      if (readRecord(working, AUTHORITY_LOG_ENTITY, claim.id)) continue
      const fields = Object.fromEntries(ENTRY_FIELDS.filter((f) => f !== 'id').map((f) => [f, claim[f]]))
      if (claim.kind === 'grant') {
        const targetPeerId = rosterPeerIds.get(claim.target_device_id)
        if (!targetPeerId || revoked.has(claim.target_device_id)) continue
        fields.target_peer_id = targetPeerId
      }
      for (const [field, value] of Object.entries(fields)) {
        const write = { entity: AUTHORITY_LOG_ENTITY, entity_id: claim.id, field, value }
        writes.push(write)
        working = applyWrite(working, write)
      }
      progress = true
    }
  }
  return writes
}

/** This device's OWN derived state: has the authority log it holds revoked it? */
export function isRevokedByOwnAuthority(db, deviceId) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status === 'revoked'
}
