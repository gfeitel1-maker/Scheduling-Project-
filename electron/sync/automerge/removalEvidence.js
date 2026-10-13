// The evidence a refusal carries, and how the refused device uses it.
//
// A genuinely revoked device is refused by every peer, so ordinary sync can never deliver the revocation to it. The
// refusal therefore carries REAL Automerge changes from the refuser's document: the changes that wrote the revoke
// entries naming the refused device, plus their causal ancestors the refused device does not hold (the refused device
// names what it holds by sending its heads in its authenticate frame). Nothing is re-authored. The refused device
// applies them through the same machinery ordinary sync uses, so authority_cache is derived by authorityReplay, which
// judges every entry at its OWN causal position: a peer can never make an entry count that would not count via
// ordinary sync. Only if the device's own derived state then says 'revoked' does it record the removal.
//
// A refusal is accepted whole or not at all: the document that results must say, by authorityReplay's own verified
// derivation, that THIS device is revoked, and nothing may ride along except the revoke entries' causal past and the
// field writes of the entries themselves.
//
// Bounded in both directions: a device missing more history than MAX_EVIDENCE_BYTES learns nothing and stays signed in
// (the safe direction); changes that are not part of the revoke entries' own causal past are rejected whole.
import * as A from '@automerge/automerge'
import { AUTHORITY_LOG_ENTITY, createVerifiedEntryTrust, currentRevokedDeviceIds, entryChangeHashIndex, isCompleteEntry } from '../../automerge/authorityReplay.js'
import { sharesGenesis, listRecordIds, readRecord, splitRecordKey } from '../../automerge/campDocument.js'

export const MAX_HEADS = 16
export const MAX_EVIDENCE_CHANGES = 2000
export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024
const HASH_RE = /^[0-9a-f]{64}$/
export const REVOCATION_REFUSAL_REASONS = new Set(['device_revoked', 'device_revoked_by_authority'])

/**
 * Evidence is history of the camp, so it goes only to a peer the roster binds to the device id it claims: the Noise
 * handshake proves the peer holds that rostered key, whereas `device_id` alone is a claim any stranger can make.
 */
export function mayReceiveRevocationEvidence(db, peerId, deviceId) {
  return db.prepare('SELECT device_id FROM roster_cache WHERE peer_id = ?').get(peerId)?.device_id === deviceId
}

/** The heads this device sends so a refuser can tell which history it already holds. */
export function ownHeadsForHandshake(doc) {
  try { return A.getHeads(doc).slice(0, MAX_HEADS) } catch { return [] }
}

function ancestorClosure(startHashes, metaByHash) {
  const closure = new Set()
  const stack = [...startHashes]
  while (stack.length) {
    const h = stack.pop()
    if (closure.has(h) || !metaByHash.has(h)) continue
    closure.add(h)
    for (const dep of metaByHash.get(h).deps) stack.push(dep)
  }
  return closure
}

/**
 * Refusing side: the real changes that wrote the (verified) revoke entries naming `deviceId`, with the ancestors the
 * refused device lacks. `peerHeads` is whatever the refused device claimed to hold; heads this document does not know
 * are ignored. Returns null when there is nothing to send or it would exceed the bounds.
 */
export function collectRevocationEvidence(doc, deviceId, peerHeads) {
  if (!doc || typeof deviceId !== 'string' || !deviceId) return null
  try {
    const known = (Array.isArray(peerHeads) ? peerHeads.slice(0, MAX_HEADS) : []).filter((h) => typeof h === 'string' && HASH_RE.test(h) && A.hasHeads(doc, [h]))
    const isTrusted = createVerifiedEntryTrust(A, doc)
    const entryChange = entryChangeHashIndex(A, doc)
    const targets = []
    const revokeIds = new Set()
    for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
      const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
      if (!isCompleteEntry(row) || row.kind !== 'revoke' || row.target_device_id !== deviceId || !isTrusted({ id, ...row })) continue
      if (entryChange.has(id)) { targets.push(entryChange.get(id)); revokeIds.add(id) }
    }
    if (!targets.length) return null
    const meta = A.getChangesMetaSince(doc, known)
    const bytes = A.getChangesSince(doc, known)
    if (meta.length !== bytes.length || meta.length > MAX_EVIDENCE_CHANGES * 8) return null
    const metaByHash = new Map(meta.map((m) => [m.hash, m]))
    const needed = ancestorClosure(targets, metaByHash)
    absorbEntryFieldWrites(meta, bytes, needed, A.getObjectId(doc, AUTHORITY_LOG_ENTITY), revokeIds)
    if (!needed.size || needed.size > MAX_EVIDENCE_CHANGES) return null
    const changes = []
    let total = 0
    for (let i = 0; i < meta.length; i++) {
      if (!needed.has(meta[i].hash)) continue
      total += bytes[i].length
      if (total > MAX_EVIDENCE_BYTES) return null
      changes.push(Buffer.from(bytes[i]).toString('base64'))
    }
    return { changes }
  } catch {
    return null
  }
}

// True when every op in `bytes` writes a field of one of `entryIds` (or edits the text object that write created).
function writesOnlyEntryFields(bytes, logObjId, entryIds) {
  const decoded = A.decodeChange(bytes)
  const created = new Set()
  for (const [i, op] of decoded.ops.entries()) {
    const ownField = op.obj === logObjId && typeof op.key === 'string' && entryIds.has(splitRecordKey(op.key)?.entityId)
    if (!ownField && !created.has(op.obj)) return false
    if (op.action.startsWith('make')) created.add(`${decoded.startOp + i}@${decoded.actor}`)
  }
  return true
}

// Adds to `included` (hashes) every change in `metas` that only writes fields of `entryIds` and depends on nothing but
// included changes or changes outside `metas`: a signature lands in a change after the one that completes its entry.
function absorbEntryFieldWrites(metas, bytes, included, logObjId, entryIds) {
  const inSet = new Set(metas.map((m) => m.hash))
  for (const [i, m] of metas.entries()) {
    if (included.has(m.hash) || !m.deps.every((d) => included.has(d) || !inSet.has(d))) continue
    if (writesOnlyEntryFields(bytes[i], logObjId, entryIds)) included.add(m.hash)
  }
}

/**
 * Refused side: validates a refusal's evidence against `doc` (this device's own document) WITHOUT changing it, and
 * returns the decoded change bytes to apply, or null. Whole-or-nothing: every change must descend from this camp's
 * document (a foreign camp's changes have a root with no dependencies, or depend on hashes we have never held); the
 * resulting document must derive this device as revoked from signatures verified at each entry's own causal position;
 * and nothing may ride along beyond the causal past of the revoke entries naming this device and those entries' own
 * field writes.
 */
export function validateRefusalEvidence(doc, deviceId, evidence) {
  if (!doc || !evidence || typeof evidence !== 'object' || !Array.isArray(evidence.changes)) return null
  const { changes } = evidence
  if (changes.length === 0 || changes.length > MAX_EVIDENCE_CHANGES) return null
  let total = 0
  const bytes = []
  for (const b64 of changes) {
    if (typeof b64 !== 'string' || b64.length > MAX_EVIDENCE_BYTES * 2) return null
    const raw = new Uint8Array(Buffer.from(b64, 'base64'))
    total += raw.length
    if (raw.length === 0 || total > MAX_EVIDENCE_BYTES) return null
    bytes.push(raw)
  }
  try {
    const held = A.getHeads(doc)
    const [next] = A.applyChanges(A.clone(doc), bytes)
    if (A.getMissingDeps(next, []).length) return null
    const added = A.getChangesMetaSince(next, held)
    if (!added.length) return null
    const addedByHash = new Map(added.map((m) => [m.hash, m]))
    for (const m of added) {
      if (!m.deps.length) return null
      for (const dep of m.deps) if (!addedByHash.has(dep) && !A.hasHeads(doc, [dep])) return null
    }
    if (!sharesGenesis(next)) return null
    if (!currentRevokedDeviceIds(A, next, { isEntryTrusted: createVerifiedEntryTrust(A, next) }).includes(deviceId)) return null
    const entryChange = entryChangeHashIndex(A, next)
    const alreadyRevoked = new Set(currentRevokedDeviceIds(A, doc, { isEntryTrusted: createVerifiedEntryTrust(A, doc) }))
    const revokeIds = new Set()
    for (const id of listRecordIds(next, AUTHORITY_LOG_ENTITY)) {
      const row = readRecord(next, AUTHORITY_LOG_ENTITY, id)
      if (isCompleteEntry(row) && row.kind === 'revoke' && row.target_device_id === deviceId && entryChange.has(id)) {
        // A signer this device already knows to be revoked may only have written this on a fork from before its own
        // removal: valid at its causal position, but the refusal is a delivery route ordinary sync would have closed.
        if (alreadyRevoked.has(row.signer_device_id)) return null
        revokeIds.add(id)
      }
    }
    const allowed = ancestorClosure([...revokeIds].map((id) => entryChange.get(id)).filter((h) => addedByHash.has(h)), addedByHash)
    const addedBytes = A.getChangesSince(next, held)
    if (addedBytes.length !== added.length) return null
    absorbEntryFieldWrites(added, addedBytes, allowed, A.getObjectId(next, AUTHORITY_LOG_ENTITY), revokeIds)
    for (const m of added) if (!allowed.has(m.hash)) return null
    return bytes
  } catch {
    return null
  }
}

/** This device's OWN derived state: has the authority log it holds revoked it? */
export function isRevokedByOwnAuthority(db, deviceId) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status === 'revoked'
}
