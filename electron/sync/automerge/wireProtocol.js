// Stage 4a (docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md): the
// libp2p protocol string plus length-prefixed framing, isolated from
// transport.js so it has its own unit tests against plain byte sources/sinks
// — no real libp2p node needed to prove the framing is correct.
//
// This module never imports Automerge: it moves opaque Uint8Array payloads.
// The protocol string doubles as the access-control gate transport.js relies
// on (see the design doc's "Protocol-gating" section) — a peer that never
// dials this exact string is never handed doc bytes.
import { pipe } from 'it-pipe'
import { encode, decode } from 'it-length-prefixed'

export const PROTO = '/shoresh/automerge/1.0.0'

// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §1): a SEPARATE
// protocol id for the auth handshake, not a message-type branch inside PROTO
// — see the ADR for why two protocol ids (short-lived handshake vs.
// long-lived doc-sync) is the cleaner primitive than parse-and-branch on one
// stream. Reuses this file's own sendFramed/receiveFramed verbatim; only the
// protocol string differs.
export const AUTH_PROTO = '/shoresh/auth/1.0.0'

// Hard cap on a single inbound frame (Security review: bound a hostile peer's
// per-frame memory footprint explicitly rather than relying on
// it-length-prefixed's 4 MiB default). Stage 4 uses whole-document exchange, so
// one frame is the entire camp document — generous headroom for a camp whose
// documents carry base64 map images (camp_maps, ~1 MB each), while still
// bounding a maliciously-declared huge length. Stage 5's incremental sync will
// shrink a frame to a delta and this cap can drop sharply.
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

// Frame one payload and write it to `sink` (a libp2p stream's .sink, or any
// it-sink for testing).
export async function sendFramed(sink, payload) {
  await pipe([payload], (source) => encode(source), sink)
}

// Read framed payloads from `source` (a libp2p stream's .source, or any
// it-source for testing), calling `onPayload(bytes)` for each one as it
// arrives.
export async function receiveFramed(source, onPayload, { maxDataLength = MAX_FRAME_BYTES } = {}) {
  await pipe(source, (s) => decode(s, { maxDataLength }), async (framed) => {
    for await (const chunk of framed) {
      onPayload(chunk.subarray())
    }
  })
}
