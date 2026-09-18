// Stage 4a (docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md): the
// libp2p protocol string plus length-prefixed framing, isolated from
// transport.js so it has its own unit tests against plain byte sources/sinks
// — no real libp2p node needed to prove the framing is correct.
//
// This module never imports Automerge: it moves opaque Uint8Array payloads.
// The protocol string doubles as the access-control gate transport.js relies
// on (see the design doc's "Protocol-gating" section) — a peer that never
// dials this exact string is never handed doc bytes.
//
// libp2p v3 (T215 migration): a Stream is no longer a `{ source, sink }`
// pull-stream pair — it's an EventTarget whose reads arrive via async
// iteration (Stream itself is AsyncIterable<Uint8Array | Uint8ArrayList>) and
// whose writes go through a synchronous `.send()` that returns `false` on
// backpressure, resolved later by an `.onDrain()` promise. `it-length-prefixed`
// v9's `decode()` accepts any AsyncIterable source directly, so receiveFramed
// just iterates the stream. There is no sink to `pipe()` into any more, so
// sendFramed frames the payload itself (`encode.single`, synchronous) and
// writes it with `.send()`, awaiting drain on backpressure exactly as the
// migration brief requires — dropping a `false` return on the floor would be
// silent data loss.
import { encode, decode } from 'it-length-prefixed'

export const PROTO = '/shoresh/automerge/1.0.0'

// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §1): a SEPARATE
// protocol id for the auth handshake, not a message-type branch inside PROTO
// — see the ADR for why two protocol ids (short-lived handshake vs.
// long-lived doc-sync) is the cleaner primitive than parse-and-branch on one
// stream. Reuses this file's own sendFramed/receiveFramed verbatim; only the
// protocol string differs.
export const AUTH_PROTO = '/shoresh/auth/1.0.0'

// Stage 5f-2 (real Automerge sync protocol, replacing whole-doc pushes): a THIRD, separate
// protocol id for A.generateSyncMessage/A.receiveSyncMessage frames, rather than a message-type
// branch inside PROTO. Same reasoning the ADR already used for AUTH_PROTO vs PROTO applies here,
// plus one more: a PROTO frame IS a complete Automerge document (A.load(bytes) must succeed) —
// that invariant is relied on by handleReceived (syncNode.js) and by the adversarial-input tests
// that deliberately send non-doc bytes at PROTO to prove it's rejected safely. A sync-protocol
// message is NOT a loadable document (it is an internal Automerge wire format A.load would throw
// on) — branching on message shape inside one protocol would blur that invariant and make the
// adversarial tests' "malformed doc bytes" case ambiguous with "valid sync message". A distinct
// protocol id keeps both wire formats structurally separate and keeps each one's own admission gate
// and framing simple to reason about independently.
export const SYNC_PROTO = '/shoresh/automerge-sync/1.0.0'

// Hard cap on a single inbound frame (Security review: bound a hostile peer's
// per-frame memory footprint explicitly rather than relying on
// it-length-prefixed's 4 MiB default). Stage 4 uses whole-document exchange, so
// one frame is the entire camp document — generous headroom for a camp whose
// documents carry base64 map images (camp_maps, ~1 MB each), while still
// bounding a maliciously-declared huge length. Stage 5's incremental sync will
// shrink a frame to a delta and this cap can drop sharply.
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

// How long to wait for a backpressured stream to drain before giving up.
//
// Red Hat finding on the libp2p 3.x migration (T215). v3's `.send()` returns false under
// backpressure and the caller awaits `onDrain()` — which, unbounded, means a peer that stops
// reading (a closed laptop lid, a suspended process, a frozen or hostile peer) wedges this promise
// FOREVER. Every send path awaits sendFramed, so the visible symptom is not an error but a device
// that quietly stops syncing, and in `authenticateWith` a pairing that sits on "Pending" with
// nothing to distinguish wedged from slow. The old pull-stream path had no equivalent unbounded
// wait at this layer, so this was exposure introduced BY the rewrite, not carried through it.
//
// A bounded wait converts a silent hang into a real rejection the caller already knows how to
// surface. 30s is deliberately generous — far beyond any healthy LAN drain, short enough that a
// human notices — and matches the posture of T203's bound on localClient writes.
export const DRAIN_TIMEOUT_MS = 30_000

// Frame one payload and write it to `stream` (a libp2p Stream, or any object
// exposing the same `.send()`/`.onDrain()` surface, e.g. a test fake).
export async function sendFramed(stream, payload, { drainTimeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  const frame = encode.single(payload)
  const canSendMore = stream.send(frame)
  if (!canSendMore) {
    // onDrain takes AbortOptions (verified in @libp2p/interface's message-stream.d.ts), so use the
    // library's own cancellation rather than racing a timer and leaving the wait dangling.
    await stream.onDrain({ signal: AbortSignal.timeout(drainTimeoutMs) })
  }
}

// Read framed payloads from `stream` (a libp2p Stream, or any AsyncIterable
// of Uint8Array/Uint8ArrayList, e.g. a test fake), calling `onPayload(bytes)`
// for each one as it arrives.
export async function receiveFramed(stream, onPayload, { maxDataLength = MAX_FRAME_BYTES } = {}) {
  for await (const chunk of decode(stream, { maxDataLength })) {
    onPayload(chunk.subarray())
  }
}
