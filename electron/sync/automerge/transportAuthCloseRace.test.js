// @vitest-environment node
//
// T217 finding 1 — settles, empirically, a disagreement between two reviews of
// `authenticateWith` (transport.js).
//
// THE DISPUTE. `authenticateWith` resolves its outer promise on the FIRST
// decoded frame, while `receiveFramed`'s `for await` over `decode(stream)` is a
// separate, unawaited iteration still running underneath. The `finally` then
// calls `stream.close()` immediately. `red-hat` read that as a truncation race:
// a close landing mid-iteration would silently drop an already-arrived second
// frame, with two swallowed errors (`.catch(() => {})` on `close()` and on
// `receiveFramed`) hiding it. `security` read the same code and concluded close
// cannot truncate the reader. The ticket forbids resolving this by picking the
// more confident reviewer; it is a question about real libp2p v3 stream
// semantics, so it is settled here by sending TWO frames on one AUTH_PROTO
// stream and observing whether the second survives.
//
// THE ANSWER: close() cannot truncate the reader, and the reason is structural
// rather than a matter of timing luck. `AbstractStream.close()`
// (@libp2p/utils/dist/src/abstract-stream.js) drains and closes the WRITABLE
// half only — it sets `writeStatus`, awaits the write queue, and calls
// `sendCloseWrite()`. It never touches `readStatus` and never touches
// `readBuffer`. The method that discards unread inbound data is the separate
// `closeRead()`, whose first act is `this.readBuffer.consume(...)`, and
// `close()` does not call it. The read side ends only when the REMOTE closes
// its write half (`remoteWriteStatus === 'closed'` → `maybeDispatchEnd`). So a
// frame that arrives after a local `close()` — even 300ms after — is still
// delivered to the iteration.
//
// WHY THE TEST STAYS. `AUTH_PROTO` responses are a single frame today, so this
// behaviour is not observable through `authenticateWith`'s public API and no
// production change was warranted. These tests pin the property at the layer
// where it IS observable, so that if libp2p's close semantics change under a
// future upgrade, or anything ever pipelines a second AUTH_PROTO frame, the
// regression is caught here rather than discovered as a silently dropped frame
// in the field. The `closeRead`/`abort` cases below are deliberate non-vacuity
// controls: they exercise teardowns that DO truncate, proving these assertions
// can distinguish the two outcomes rather than passing for any reason at all.
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { startTransport } from './transport.js'
import { AUTH_PROTO, sendFramed, receiveFramed } from './wireProtocol.js'

// How long to let a second frame arrive (or prove it never does) after teardown.
// Generous relative to a loopback round trip; the positive cases below settle in
// single-digit milliseconds.
const SETTLE_MS = 1500

let nodes = []
let transports = []
afterEach(async () => {
  await Promise.all(transports.map((t) => t.stop?.().catch(() => {})))
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  nodes = []
  transports = []
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))

async function bareNode() {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  })
  nodes.push(node)
  return node
}

async function waitFor(predicate, { timeout = 5000, interval = 5 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await sleep(interval)
  }
}

// A responder that pipelines TWO frames on one AUTH_PROTO stream.
// `delayBeforeSecond = 0` puts the second frame in flight (and in practice
// already buffered on the dialer) at the instant the dialer settles and tears
// down — the alleged race's worst case. A non-zero delay is the strictly harder
// case: the second frame has definitively NOT arrived when teardown happens.
function respondWithTwoFrames(node, { delayBeforeSecond = 0 } = {}) {
  return node.handle(AUTH_PROTO, (stream) => {
    ;(async () => {
      await sendFramed(stream, enc({ n: 1 }))
      if (delayBeforeSecond > 0) await sleep(delayBeforeSecond)
      await sendFramed(stream, enc({ n: 2 }))
    })().catch(() => {
      // A dialer that tore the stream down mid-send is exactly what some of
      // these cases do on purpose; the responder must not crash the node.
    })
  })
}

// Reproduces authenticateWith's shape against a real dialed stream, using the
// production `receiveFramed`: an unawaited reader, settle on the first frame,
// then tear the stream down with `teardown` and see what the reader was handed.
async function framesSurvivingTeardown(teardown, { delayBeforeSecond = 0 } = {}) {
  const responder = await bareNode()
  await respondWithTwoFrames(responder, { delayBeforeSecond })

  const dialer = await bareNode()
  await dialer.dial(responder.getMultiaddrs()[0])
  const stream = await dialer.dialProtocol(responder.peerId, AUTH_PROTO)

  const got = []
  let readerError = null
  // Unawaited, exactly as in authenticateWith.
  receiveFramed(stream, (bytes) => {
    got.push(JSON.parse(new TextDecoder().decode(bytes)))
  }).catch((err) => {
    readerError = err
  })

  await waitFor(() => got.length >= 1)
  await teardown(stream).catch((err) => {
    readerError = readerError ?? err
  })
  await sleep(delayBeforeSecond + SETTLE_MS)

  return { got, readerError }
}

describe('T217 finding 1 — authenticateWith close vs. an in-flight receiveFramed', () => {
  it('the production authenticateWith resolves with the FIRST frame when a peer pipelines two', async () => {
    const responder = await bareNode()
    await respondWithTwoFrames(responder)

    const dialer = await startTransport({ deviceId: 'dialer' })
    transports.push(dialer)

    await dialer.dial(responder.getMultiaddrs()[0])
    await waitFor(() => dialer.getPeers().length > 0)

    const result = await dialer.authenticateWith(responder.peerId.toString(), { type: 'authenticate' })

    // First frame wins; the `settled` guard discards the second. No hang, no
    // rejection, no unhandled error from the close that follows.
    expect(result).toEqual({ n: 1 })
  })

  it('close() does not truncate a second frame that is already in flight', async () => {
    const { got, readerError } = await framesSurvivingTeardown((s) => s.close())
    expect(readerError).toBeNull()
    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('close() does not truncate a second frame that arrives AFTER the close', async () => {
    // The structural claim, isolated from buffering luck: close() shuts the
    // writable half only, so the read side keeps delivering afterwards.
    const { got, readerError } = await framesSurvivingTeardown((s) => s.close(), { delayBeforeSecond: 300 })
    expect(readerError).toBeNull()
    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  })

  // ---- non-vacuity controls: teardowns that DO truncate ----
  // If these passed alongside the cases above for some incidental reason, the
  // assertions above would prove nothing. They fail in the opposite direction,
  // which is what makes the close() result meaningful.

  it('closeRead() — which close() deliberately does not call — DOES drop a later frame', async () => {
    const { got } = await framesSurvivingTeardown((s) => s.closeRead(), { delayBeforeSecond: 300 })
    expect(got).toEqual([{ n: 1 }])
  })

  it('abort() drops a later frame and surfaces an error to the reader', async () => {
    const { got, readerError } = await framesSurvivingTeardown(
      async (s) => { s.abort(new Error('t217-control')) },
      { delayBeforeSecond: 300 }
    )
    expect(got).toEqual([{ n: 1 }])
    expect(readerError).not.toBeNull()
  })
})
