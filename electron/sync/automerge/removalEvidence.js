// The evidence a refusal carries, and how the refused device uses it.
//
// A genuinely revoked device is refused by every peer, so ordinary sync can never deliver the revocation to it. The
// refusal therefore carries REAL Automerge changes from the refuser's document: the changes that wrote the revoke
// entries naming the refused device (each entry is one change), plus their causal ancestors the refused device does not hold (the refused device
// names what it holds by sending its heads in its authenticate frame). Nothing is re-authored. The refused device
// applies them through the same machinery ordinary sync uses, so authority_cache is derived by authorityReplay, which
// judges every entry at its OWN causal position: a peer can never make an entry count that would not count via
// ordinary sync. Only if the device's own derived state then says 'revoked' does it record the removal.
//
// A refusal is accepted whole or not at all: the document that results must say, by authorityReplay's own verified
// derivation, that THIS device is revoked, and nothing may ride along except the revoke entries' causal past, and each revoke entry's own change may write nothing but that entry.
//
// Bounded in both directions: a device missing more history than MAX_EVIDENCE_BYTES learns nothing and stays signed in
// (the safe direction); changes that are not part of the revoke entries' own causal past are rejected whole.
import * as A from '@automerge/automerge'
import { AUTHORITY_LOG_ENTITY, createVerifiedEntryTrust, currentRevokedDeviceIds, requireRoot, signedEntries } from '../../automerge/authorityReplay.js'
import { sharesGenesis, splitRecordKey, PROVENANCE_COLLECTION, AUTHOR_COLLECTION } from '../../automerge/campDocument.js'

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

// True when every op in `bytes` writes a field of one of `entryIds` (or edits the text object that write created), or
// the provenance / authorship marker the document write path records beside that same field. Markers are keyed
// `<entity>\0<id>\0<field>`, so one can only be about an entry in `entryIds`. The change that writes a revoke entry must be
// exactly this: anything else in it would travel to the refused device under the revoke's name.
function writesOnlyEntryFields(bytes, logObjId, entryIds, markerObjIds) {
  const decoded = A.decodeChange(bytes)
  const created = new Set()
  for (const [i, op] of decoded.ops.entries()) {
    const isKey = typeof op.key === 'string'
    const ownField = op.obj === logObjId && isKey && entryIds.has(splitRecordKey(op.key)?.entityId)
    const ownMarker = markerObjIds.has(op.obj) && isKey && isMarkerOfEntry(op.key, entryIds)
    if (!ownField && !ownMarker && !created.has(op.obj)) return false
    if (op.action.startsWith('make')) created.add(`${decoded.startOp + i}@${decoded.actor}`)
  }
  return true
}

function isMarkerOfEntry(key, entryIds) {
  const parts = key.split('\0')
  return parts.length === 3 && parts[0] === AUTHORITY_LOG_ENTITY && entryIds.has(parts[1])
}

function markerObjectIds(doc) {
  const ids = new Set()
  for (const name of [PROVENANCE_COLLECTION, AUTHOR_COLLECTION]) {
    try { ids.add(A.getObjectId(doc, name)) } catch { /* collection absent */ }
  }
  return ids
}

/**
 * Refusing side: the real changes that wrote the (verified) revoke entries naming `deviceId`, with the ancestors the
 * refused device lacks. `peerHeads` is whatever the refused device claimed to hold; heads this document does not know
 * are ignored. Returns null when there is nothing to send or it would exceed the bounds.
 */
export function collectRevocationEvidence(doc, deviceId, peerHeads, root) {
  requireRoot(root)
  if (!doc || typeof deviceId !== 'string' || !deviceId) return null
  try {
    const known = (Array.isArray(peerHeads) ? peerHeads.slice(0, MAX_HEADS) : []).filter((h) => typeof h === 'string' && HASH_RE.test(h) && A.hasHeads(doc, [h]))
    const isTrusted = createVerifiedEntryTrust(A, doc, root)
    const revokes = signedEntries(A, doc).filter((e) => e.kind === 'revoke' && e.target_device_id === deviceId && isTrusted(e))
    if (!revokes.length) return null
    const meta = A.getChangesMetaSince(doc, known)
    const bytes = A.getChangesSince(doc, known)
    if (meta.length !== bytes.length || meta.length > MAX_EVIDENCE_CHANGES * 8) return null
    const metaByHash = new Map(meta.map((m) => [m.hash, m]))
    const indexOf = new Map(meta.map((m, i) => [m.hash, i]))
    const logObjId = A.getObjectId(doc, AUTHORITY_LOG_ENTITY)
    const markers = markerObjectIds(doc)
    const targets = revokes
      .filter((e) => !indexOf.has(e.changeHash) || writesOnlyEntryFields(bytes[indexOf.get(e.changeHash)], logObjId, new Set([e.id]), markers))
      .map((e) => e.changeHash)
    if (!targets.length) return null
    const needed = ancestorClosure(targets, metaByHash)
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

/**
 * Refused side: validates a refusal's evidence against `doc` (this device's own document) WITHOUT changing it, and
 * returns the decoded change bytes to apply, or null. Whole-or-nothing: every change must descend from this camp's
 * document (a foreign camp's changes have a root with no dependencies, or depend on hashes we have never held); the
 * resulting document must derive this device as revoked from signatures verified at each entry's own causal position;
 * and nothing may ride along beyond the causal past of the revoke entries naming this device and those entries' own
 * field writes.
 */
export function validateRefusalEvidence(doc, deviceId, evidence, root, onReject) {
  requireRoot(root)
  const reject = (reason) => { onReject?.(reason); return null }
  if (!doc || !evidence || typeof evidence !== 'object' || !Array.isArray(evidence.changes)) return reject('evidence-not-a-change-list')
  const { changes } = evidence
  if (changes.length === 0 || changes.length > MAX_EVIDENCE_CHANGES) return reject('change-count-out-of-bounds')
  let total = 0
  const bytes = []
  for (const b64 of changes) {
    if (typeof b64 !== 'string' || b64.length > MAX_EVIDENCE_BYTES * 2) return reject('change-not-a-bounded-string')
    const raw = new Uint8Array(Buffer.from(b64, 'base64'))
    total += raw.length
    if (raw.length === 0 || total > MAX_EVIDENCE_BYTES) return reject('evidence-bytes-out-of-bounds')
    bytes.push(raw)
  }
  try {
    const held = A.getHeads(doc)
    const [next] = A.applyChanges(A.clone(doc), bytes)
    if (A.getMissingDeps(next, []).length) return reject('missing-dependencies')
    const added = A.getChangesMetaSince(next, held)
    if (!added.length) return reject('no-new-changes')
    const addedByHash = new Map(added.map((m) => [m.hash, m]))
    for (const m of added) {
      if (!m.deps.length) return reject('change-with-no-dependencies')
      for (const dep of m.deps) if (!addedByHash.has(dep) && !A.hasHeads(doc, [dep])) return reject('depends-on-history-never-held')
    }
    if (!sharesGenesis(next)) return reject('foreign-camp')
    if (!currentRevokedDeviceIds(A, next, { root, isEntryTrusted: createVerifiedEntryTrust(A, next, root) }).includes(deviceId)) return reject('derived-state-does-not-revoke-this-device')
    const alreadyRevoked = new Set(currentRevokedDeviceIds(A, doc, { root, isEntryTrusted: createVerifiedEntryTrust(A, doc, root) }))
    const revokeHashes = []
    const logObjId = A.getObjectId(next, AUTHORITY_LOG_ENTITY)
    const markers = markerObjectIds(next)
    const addedBytes = A.getChangesSince(next, held)
    if (addedBytes.length !== added.length) return reject('change-bytes-mismatch')
    const addedIndex = new Map(added.map((m, i) => [m.hash, i]))
    for (const e of signedEntries(A, next)) {
      if (e.kind !== 'revoke' || e.target_device_id !== deviceId) continue
      // A signer this device already knows to be revoked may only have written this on a fork from before its own
      // removal: valid at its causal position, but the refusal is a delivery route ordinary sync would have closed.
      if (alreadyRevoked.has(e.signer_device_id)) return reject('signer-already-revoked-here')
      // The revoke's own change may write nothing but that entry (and its markers); a change that also carries other
      // writes is not evidence, and is left out so it cannot ride along.
      if (addedIndex.has(e.changeHash) && !writesOnlyEntryFields(addedBytes[addedIndex.get(e.changeHash)], logObjId, new Set([e.id]), markers)) continue
      revokeHashes.push(e.changeHash)
    }
    const allowed = ancestorClosure(revokeHashes.filter((h) => addedByHash.has(h)), addedByHash)
    for (const m of added) if (!allowed.has(m.hash)) return reject('change-outside-revoke-causal-past')
    return bytes
  } catch (err) {
    return reject(`threw: ${err?.message ?? err}`)
  }
}

/** This device's OWN derived state: has the authority log it holds revoked it? */
export function isRevokedByOwnAuthority(db, deviceId) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status === 'revoked'
}
