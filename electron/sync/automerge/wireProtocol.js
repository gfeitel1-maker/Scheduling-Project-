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

// Frame one payload and write it to `sink` (a libp2p stream's .sink, or any
// it-sink for testing).
export async function sendFramed(sink, payload) {
  await pipe([payload], (source) => encode(source), sink)
}

// Read framed payloads from `source` (a libp2p stream's .source, or any
// it-source for testing), calling `onPayload(bytes)` for each one as it
// arrives.
export async function receiveFramed(source, onPayload) {
  await pipe(source, (s) => decode(s), async (framed) => {
    for await (const chunk of framed) {
      onPayload(chunk.subarray())
    }
  })
}
