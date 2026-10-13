// The evidence a refusal carries, and how the refused device checks it.
//
// A genuinely revoked device is refused by every peer, so ordinary sync can never deliver the revocation to it. The
// refusal itself therefore carries the signed `camp_authority_log` revoke entries that name the refused device. The
// refused device never takes the peer's word: it accepts an entry only if the signer is an admin in ITS OWN authority
// state, the signature verifies against the peer id that own state holds for the signer, and the entry names this
// device. Accepted entries are merged into its own document; only if its re-derived authority_cache then says
// 'revoked' does it record the removal. Wrong-camp, forged, unsigned and non-admin-signed claims verify against
// nothing and are dropped.
import * as A from '@automerge/automerge'
import { AUTHORITY_LOG_ENTITY, createVerifiedEntryTrust, currentAuthorityState, resolveAuthorityPeerIds, isCompleteEntry } from '../../automerge/authorityReplay.js'
import { verifyAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { listRecordIds, readRecord } from '../../automerge/campDocument.js'

export const MAX_REVOCATION_EVIDENCE = 4
const MAX_FIELD_LENGTH = 200
export const REVOCATION_REFUSAL_REASONS = new Set(['device_revoked', 'device_revoked_by_authority'])
const ENTRY_FIELDS = ['id', 'kind', 'target_device_id', 'signer_device_id', 'signature']

/** Refusing side: the signed revoke entries in `doc` that name `deviceId`, bounded. */
export function collectRevocationEvidence(doc, deviceId) {
  if (!doc || typeof deviceId !== 'string' || !deviceId) return []
  const isTrusted = createVerifiedEntryTrust(A, doc)
  const out = []
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY).sort()) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    const entry = { id, ...row }
    if (entry.kind !== 'revoke' || entry.target_device_id !== deviceId || !isTrusted(entry)) continue
    out.push(Object.fromEntries(ENTRY_FIELDS.map((f) => [f, entry[f]])))
    if (out.length >= MAX_REVOCATION_EVIDENCE) break
  }
  return out
}

/**
 * Refused side: the document writes for every claimed entry that verifies against `doc` (this device's own
 * document). Entries this device already holds are skipped. Returns [] for anything malformed or unverifiable.
 */
export function verifiedEvidenceWrites(doc, deviceId, evidence) {
  if (!doc || !Array.isArray(evidence) || evidence.length > MAX_REVOCATION_EVIDENCE) return []
  const peerIdByDevice = resolveAuthorityPeerIds(A, doc)
  if (peerIdByDevice.size === 0) return []
  const { admins } = currentAuthorityState(A, doc)
  const writes = []
  for (const claim of evidence) {
    if (!claim || typeof claim !== 'object') continue
    if (!ENTRY_FIELDS.every((f) => typeof claim[f] === 'string' && claim[f].length > 0 && claim[f].length <= MAX_FIELD_LENGTH)) continue
    if (claim.kind !== 'revoke' || claim.target_device_id !== deviceId || claim.signer_device_id === deviceId) continue
    if (!admins.has(claim.signer_device_id)) continue
    const signerPeerId = peerIdByDevice.get(claim.signer_device_id)
    if (!signerPeerId) continue
    if (!verifyAuthorityEntry(signerPeerId, claim, claim.signature)) continue
    if (readRecord(doc, AUTHORITY_LOG_ENTITY, claim.id)) continue
    for (const field of ENTRY_FIELDS.filter((f) => f !== 'id')) {
      writes.push({ entity: AUTHORITY_LOG_ENTITY, entity_id: claim.id, field, value: claim[field] })
    }
  }
  return writes
}

/** This device's OWN derived state: has the authority log it holds revoked it? */
export function isRevokedByOwnAuthority(db, deviceId) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status === 'revoked'
}
