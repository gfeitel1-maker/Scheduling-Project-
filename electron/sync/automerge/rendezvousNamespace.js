// Mint / rotate / read the camp rendezvous namespace and epoch.
// docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, Decision 3.
//
// Pure document-layer code: operates on an in-memory Automerge `doc` object, reusing
// electron/automerge/campDocument.js's flat per-field record shape and key scheme (`recordKey`,
// `readRecord`) — the SAME shape every other `camps` field (e.g. `name`) uses. No SQLite, no
// libp2p, no network egress. The rotation TRIGGER lives in rendezvousRotation.js (rotate when the
// revocation set changes, on the elected admin device).
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
//
// ONE TUPLE FOR ALL THE SECRETS (WAN-ladder F1, round 2). The same argument now covers the address
// key and the revocation digest a rotation was minted for: Red Hat showed that a namespace from one
// rotation could pair with a key from another. So the current secrets are ONE scalar field,
// `rendezvousSecrets` = `v2:<epoch>:<64 hex namespace>:<64 hex address key>:<64 hex digest | ->`,
// and every read (namespace, key, rotated-for digest) comes from that one tuple. reconcile.js
// excludes this one field from director-facing conflicts; Automerge's winner is the answer.
//
// Legacy fallback: a camp minted before the tuple has `rendezvousDiscovery` (+ maybe
// `rendezvousAddressKey`). Those are read as the current tuple while the new field is absent; the
// next mint or rotation writes the new field. Nothing ever writes the legacy fields again.
import * as A from '@automerge/automerge'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { recordKey, readRecord } from '../../automerge/campDocument.js'

const ENTITY = 'camps'
export const SECRETS_FIELD = 'rendezvousSecrets'
const LEGACY_DISCOVERY_FIELD = 'rendezvousDiscovery'
const LEGACY_KEY_FIELD = 'rendezvousAddressKey'
const SECRETS_PATTERN = /^v2:(0|[1-9][0-9]*):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64}|-)$/
const LEGACY_DISCOVERY_PATTERN = /^v1:(0|[1-9][0-9]*):([0-9a-f]{64})$/
const HEX64 = /^[0-9a-f]{64}$/

function malformed(field, value) {
  return new Error(`rendezvousNamespace: malformed ${field} value: ${JSON.stringify(value)}`)
}

/**
 * The camp's current rendezvous secrets: { epoch, namespace, addressKey, rotatedFor } or null if
 * rendezvous was never enabled. Strict: a malformed value throws rather than being half-read.
 * `addressKey` may be null only on a legacy camp that minted a namespace but never a key.
 */
export function readRendezvousSecrets(doc, campId) {
  const row = readRecord(doc, ENTITY, campId)
  if (!row) return null
  if (row[SECRETS_FIELD] != null) {
    const m = typeof row[SECRETS_FIELD] === 'string' ? SECRETS_PATTERN.exec(row[SECRETS_FIELD]) : null
    if (!m) throw malformed(SECRETS_FIELD, row[SECRETS_FIELD])
    return { epoch: Number(m[1]), namespace: m[2], addressKey: m[3], rotatedFor: m[4] === '-' ? null : m[4] }
  }
  if (row[LEGACY_DISCOVERY_FIELD] == null && row[LEGACY_KEY_FIELD] == null) return null
  let epoch = null
  let namespace = null
  if (row[LEGACY_DISCOVERY_FIELD] != null) {
    const m = typeof row[LEGACY_DISCOVERY_FIELD] === 'string' ? LEGACY_DISCOVERY_PATTERN.exec(row[LEGACY_DISCOVERY_FIELD]) : null
    if (!m) throw malformed(LEGACY_DISCOVERY_FIELD, row[LEGACY_DISCOVERY_FIELD])
    epoch = Number(m[1])
    namespace = m[2]
  }
  const addressKey = row[LEGACY_KEY_FIELD] ?? null
  if (addressKey != null && (typeof addressKey !== 'string' || !HEX64.test(addressKey))) throw malformed(LEGACY_KEY_FIELD, addressKey)
  return { epoch, namespace, addressKey, rotatedFor: null }
}

function writeSecrets(doc, campId, { epoch, namespace, addressKey, rotatedFor }) {
  return A.change(doc, (d) => {
    if (!d[ENTITY]) d[ENTITY] = {}
    d[ENTITY][recordKey(campId, SECRETS_FIELD)] = `v2:${epoch}:${namespace}:${addressKey}:${rotatedFor ?? '-'}`
  })
}

/**
 * Mint the secrets the first time rendezvous is enabled, filling whatever a legacy camp lacks.
 * Never overwrites a complete set (that is what rotate is for). Idempotent against SEQUENTIAL calls
 * only: two devices minting concurrently both write, and Automerge keeps one whole tuple.
 */
export function mintRendezvousSecrets(doc, campId, { randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousSecrets(doc, campId)
  if (existing?.namespace && existing.addressKey) return { doc, secrets: existing, minted: false }
  const secrets = {
    epoch: existing?.epoch ?? 1,
    namespace: existing?.namespace ?? randomBytes(32).toString('hex'),
    addressKey: existing?.addressKey ?? randomBytes(32).toString('hex'),
    rotatedFor: existing?.rotatedFor ?? null,
  }
  return { doc: writeSecrets(doc, campId, secrets), secrets, minted: true }
}

/**
 * Rotate EVERYTHING in one write: fresh namespace, fresh address key, epoch + 1, and the revocation
 * digest this rotation was minted for. Leaves the device-local `seq`
 * (electron/sync/automerge/rendezvousSequence.js) untouched.
 */
export function rotateRendezvousSecrets(doc, campId, { rotatedFor = null, randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousSecrets(doc, campId)
  const secrets = {
    epoch: (existing?.epoch ?? 0) + 1,
    namespace: randomBytes(32).toString('hex'),
    addressKey: randomBytes(32).toString('hex'),
    rotatedFor,
  }
  return { doc: writeSecrets(doc, campId, secrets), secrets }
}

/** Read the current namespace/epoch for a camp, or null if rendezvous was never enabled. */
export function readRendezvousNamespace(doc, campId) {
  const s = readRendezvousSecrets(doc, campId)
  return s?.namespace ? { epoch: s.epoch, namespace: s.namespace } : null
}

/** Mint (see mintRendezvousSecrets) and return the namespace view. */
export function mintRendezvousNamespace(doc, campId, opts = {}) {
  const { doc: next, secrets, minted } = mintRendezvousSecrets(doc, campId, opts)
  return { doc: next, namespace: secrets.namespace, epoch: secrets.epoch, minted }
}

/** Rotate the whole tuple (see rotateRendezvousSecrets) and return the namespace view. */
export function rotateRendezvousNamespace(doc, campId, opts = {}) {
  const { doc: next, secrets } = rotateRendezvousSecrets(doc, campId, opts)
  return { doc: next, namespace: secrets.namespace, epoch: secrets.epoch }
}
