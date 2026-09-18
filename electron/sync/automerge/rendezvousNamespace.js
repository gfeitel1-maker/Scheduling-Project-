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
// than registering these fields there: PROJECTIONS.camps.fields doubles as the literal column
// list electron/automerge/seed.js SELECTs from SQLite (`SELECT id, ${fields.join(', ')} FROM
// camps`), so registering an unbacked field there breaks every existing seed/liveDoc test the
// moment a camps row is read — a coupling this module's own test run surfaced. This field is
// genuinely document-only (no SQL column, no projection, no migration) until the wiring ticket
// (T211) decides whether and how it reaches SQLite, so writing it via the low-level
// recordKey/readRecord primitives — which know nothing about PROJECTIONS — is the correct,
// narrower "flat per-field record shape" the ADR asks for, not the higher-level applyWrite that
// happens to enforce a stricter, SQLite-coupled contract this entity doesn't need yet.
//
// ONE DOCUMENT KEY, NOT TWO (round 2 correction). Namespace and epoch used to be two independent
// document keys (`rendezvousNamespace`, `rendezvousEpoch`), each adjudicated independently by
// electron/automerge/reconcile.js's per-key conflict resolution. Two devices rotating concurrently
// could therefore leave device A's namespace paired with device B's epoch — a pair NEITHER device
// ever generated — and a director resolving what looked like two unrelated conflicts could pick
// exactly that mix by hand. Worse, a surviving epoch lower than one already published under makes
// every future publish fail the monotonicity check in rendezvousRecord.js's verify() — a
// self-inflicted denial of service on the very feature rotation exists to fix.
//
// The fix is to make the pair unsplittable by making it ONE document key: `rendezvousDiscovery`,
// a single scalar string `v1:<decimal epoch>:<64 hex namespace chars>`. Automerge's conflict
// resolution operates per key, so a single key can only ever resolve to ONE of the values written
// to it — never a hybrid. Anyone reconciling a conflict on this field chooses a whole pair, which
// is exactly the CRDT property Decision 3 needs and did not have with two fields. Deliberately a
// fixed-shape string, not something JSON-shaped that a naive merge/reorder could still separate.
import * as A from '@automerge/automerge'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { recordKey, readRecord } from '../../automerge/campDocument.js'

const ENTITY = 'camps'
const FIELD = 'rendezvousDiscovery'
const DISCOVERY_VERSION = 'v1'
// v1:<decimal epoch, no leading zeros>:<64 lowercase hex chars>
const DISCOVERY_PATTERN = /^v1:(0|[1-9][0-9]*):([0-9a-f]{64})$/

function encodeDiscovery(epoch, namespace) {
  return `${DISCOVERY_VERSION}:${epoch}:${namespace}`
}

// Strict: anything that doesn't match the fixed shape is rejected outright rather than
// best-effort parsed. A malformed value can only mean a bug or tampering, and reading a half
// value would defeat the entire point of collapsing this into one field.
function parseDiscovery(value) {
  const match = typeof value === 'string' ? DISCOVERY_PATTERN.exec(value) : null
  if (!match) {
    throw new Error(`rendezvousNamespace: malformed ${FIELD} value: ${JSON.stringify(value)}`)
  }
  return { epoch: Number(match[1]), namespace: match[2] }
}

function writeField(doc, campId, value) {
  return A.change(doc, (d) => {
    if (!d[ENTITY]) d[ENTITY] = {}
    d[ENTITY][recordKey(campId, FIELD)] = value
  })
}

/** Read the current namespace/epoch for a camp, or null if rendezvous was never enabled. */
export function readRendezvousNamespace(doc, campId) {
  const row = readRecord(doc, ENTITY, campId)
  if (!row || row[FIELD] == null) return null
  return parseDiscovery(row[FIELD])
}

/**
 * Mint a fresh namespace the first time rendezvous is enabled for a camp. Idempotent-safe: if a
 * namespace already exists, it is returned unchanged — minting never silently overwrites an
 * existing namespace (that is what rotate is for). This is idempotent only against SEQUENTIAL
 * calls: two devices minting concurrently both see "no existing namespace" and both write, so one
 * write wins the merge and the other's minted:true is a lie about what survives — a genuine
 * concurrent-mint race, not a bug this module hides. Because namespace+epoch is now one field,
 * the loser's write is a whole pair, not half of one: the survivor is one complete namespace/epoch
 * pair a real device produced, never a mix.
 */
export function mintRendezvousNamespace(doc, campId, { randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousNamespace(doc, campId)
  if (existing) {
    return { doc, namespace: existing.namespace, epoch: existing.epoch, minted: false }
  }

  const namespace = randomBytes(32).toString('hex')
  const epoch = 1
  const next = writeField(doc, campId, encodeDiscovery(epoch, namespace))
  return { doc: next, namespace, epoch, minted: true }
}

/**
 * Rotate to a fresh namespace and increment the epoch together, in one call, written as ONE
 * document field so Automerge can never resolve a concurrent rotation into a namespace/epoch
 * pair neither device generated. Leaves the device-local `seq`
 * (electron/sync/automerge/rendezvousSequence.js) completely untouched — that counter lives in a
 * different table this module never opens.
 */
export function rotateRendezvousNamespace(doc, campId, { randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousNamespace(doc, campId)
  const namespace = randomBytes(32).toString('hex')
  const epoch = (existing?.epoch ?? 0) + 1
  const next = writeField(doc, campId, encodeDiscovery(epoch, namespace))
  return { doc: next, namespace, epoch }
}
