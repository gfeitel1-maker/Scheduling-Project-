// Mint / rotate / read the camp rendezvous namespace and epoch.
// docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, Decision 3.
//
// Pure document-layer code: operates on an in-memory Automerge `doc` object, reusing
// electron/automerge/campDocument.js's flat per-field record shape and key scheme (`recordKey`,
// `readRecord`) — the SAME shape every other `camps` field (e.g. `name`) uses. No SQLite, no
// libp2p, no network egress. Not imported by electron/main.js or any production sync path; wiring
// (including any rotation TRIGGER) is out of scope here — see the ADR's Decision 3 "Deliberately
// not decided here" and Decision 4.
//
// Deliberately bypasses campDocument.js's applyWrite/PROJECTIONS.camps.fields allowlist rather
// than registering these two fields there: PROJECTIONS.camps.fields doubles as the literal column
// list electron/automerge/seed.js SELECTs from SQLite (`SELECT id, ${fields.join(', ')} FROM
// camps`), so registering an unbacked field there breaks every existing seed/liveDoc test the
// moment a camps row is read — a coupling this module's own test run surfaced. These two fields
// are genuinely document-only (no SQL column, no projection, no migration) until the wiring ticket
// (T211) decides whether and how they reach SQLite, so writing them via the low-level
// recordKey/readRecord primitives — which know nothing about PROJECTIONS — is the correct,
// narrower "flat per-field record shape" the ADR asks for, not the higher-level applyWrite that
// happens to enforce a stricter, SQLite-coupled contract this entity doesn't need yet.
import * as A from '@automerge/automerge'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { recordKey, readRecord } from '../../automerge/campDocument.js'

const ENTITY = 'camps'

function writeField(doc, campId, field, value) {
  return A.change(doc, (d) => {
    if (!d[ENTITY]) d[ENTITY] = {}
    d[ENTITY][recordKey(campId, field)] = value
  })
}

/** Read the current namespace/epoch for a camp, or null if rendezvous was never enabled. */
export function readRendezvousNamespace(doc, campId) {
  const row = readRecord(doc, ENTITY, campId)
  if (!row || !row.rendezvousNamespace) return null
  return { namespace: row.rendezvousNamespace, epoch: row.rendezvousEpoch ?? 1 }
}

/**
 * Mint a fresh namespace the first time rendezvous is enabled for a camp. Idempotent-safe: if a
 * namespace already exists, it is returned unchanged — minting never silently overwrites an
 * existing namespace (that is what rotate is for).
 */
export function mintRendezvousNamespace(doc, campId, { randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousNamespace(doc, campId)
  if (existing) {
    return { doc, namespace: existing.namespace, epoch: existing.epoch, minted: false }
  }

  const namespace = randomBytes(32).toString('hex')
  const epoch = 1
  let next = writeField(doc, campId, 'rendezvousNamespace', namespace)
  next = writeField(next, campId, 'rendezvousEpoch', epoch)
  return { doc: next, namespace, epoch, minted: true }
}

/**
 * Rotate to a fresh namespace and increment the epoch together, in one call. Leaves the
 * device-local `seq` (electron/sync/automerge/rendezvousSequence.js) completely untouched — that
 * counter lives in a different table this module never opens.
 */
export function rotateRendezvousNamespace(doc, campId, { randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousNamespace(doc, campId)
  const namespace = randomBytes(32).toString('hex')
  const epoch = (existing?.epoch ?? 0) + 1
  let next = writeField(doc, campId, 'rendezvousNamespace', namespace)
  next = writeField(next, campId, 'rendezvousEpoch', epoch)
  return { doc: next, namespace, epoch }
}
