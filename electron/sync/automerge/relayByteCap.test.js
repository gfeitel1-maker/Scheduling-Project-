// @vitest-environment node
//
// T337 pre-signoff hardening (behavioral byte-cap proof): the ~128 KiB per-relayed-exchange cap
// (`defaultDataLimit: 131072n`, syncStarter.js) has so far only been proven by reading the
// configured VALUE (relayCoordinationWindow.test.js's "maxReservations"/TTL tests, and the
// syncStarter.js comment) — never by actually sending bytes through an established relayed
// connection and observing the library enforce it. This file drives that end-to-end, real
// multi-node, the actually-installed `@libp2p/circuit-relay-v2@4.2.13` (`utils.js`'s
// `createLimitedRelay`/`countStreamBytes`, wired by `circuitRelayServer`'s own CONNECT handler —
// see server/index.js), no mocks: B dials C THROUGH R (mirrors relayEndToEndRevoke.test.js's
// setup), then sends a payload comfortably under 128 KiB (succeeds, byte-identical at C) and,
// in a SEPARATE connection, a payload comfortably over 128 KiB (the relayed connection is cut by
// the library's own transfer-limit enforcement before the full payload is delivered).
import { describe, it, expect, afterEach } from 'vitest'
import { multiaddr } from '@multiformats/multiaddr'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { startTransport } from './transport.js'

// The exact values syncStarter.js ships (COORDINATION_WINDOW_MS, MAX_SIMULTANEOUS_RESERVATIONS,
// and the 131072n byte cap at syncStarter.js:386-393).
const COORDINATION_WINDOW_MS = 120000
const MAX_SIMULTANEOUS_RESERVATIONS = 8
const DATA_LIMIT_BYTES = 131072 // 128 KiB, matches the configured `131072n`

let handles = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  handles = []
})

async function waitFor(predicate, { timeout = 15000, interval = 50 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

// Establishes R (relay server, real syncStarter.js values) + B/C (both relay-transport-capable),
// connects both to R, waits for C's real RESERVE to land, and connects B to C THROUGH the relay.
// Returns { r, b, c, receivedOnC } so each test can drive its own send.
async function setupRelayedPair() {
  const receivedOnC = []
  const r = await startTransport({
    deviceId: 'device-r',
    relayServerFactory: circuitRelayServer({
      reservations: {
        reservationTtl: COORDINATION_WINDOW_MS,
        maxReservations: MAX_SIMULTANEOUS_RESERVATIONS,
        // The actual cap under test — same shape/value as syncStarter.js:386-393's
        // `reservations: { defaultDataLimit: 131072n, ... }`.
        defaultDataLimit: BigInt(DATA_LIMIT_BYTES),
        defaultDurationLimit: COORDINATION_WINDOW_MS,
      },
    }),
  })
  const b = await startTransport({ deviceId: 'device-b', relayTransportFactory: circuitRelayTransport() })
  const c = await startTransport({
    deviceId: 'device-c',
    listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
    relayTransportFactory: circuitRelayTransport(),
    onDocReceived: (bytes) => { receivedOnC.push(bytes) },
  })

  await b.dial(r.getMultiaddrs()[0])
  await c.dial(r.getMultiaddrs()[0])
  r.admitPeer(b.peerId)
  r.admitPeer(c.peerId)

  await waitFor(() => c.getMultiaddrs().some((ma) => ma.toString().includes('/p2p-circuit')))
  const circuitAddr = c.getMultiaddrs().find((ma) => ma.toString().includes('/p2p-circuit'))
  await b.dial(multiaddr(circuitAddr.toString()))
  await waitFor(() => b.getPeers().includes(c.peerId))
  c.admitPeer(b.peerId)

  return { r, b, c, receivedOnC }
}

describe('T337 pre-signoff — the 128 KiB per-relayed-exchange cap is behaviorally enforced', () => {
  it('UNDER cap: a payload comfortably under 128 KiB sent over the established relayed connection arrives byte-identical', async () => {
    const { r, b, c, receivedOnC } = await setupRelayedPair()
    handles.push(r, b, c)

    const underCapBytes = new Uint8Array(64 * 1024) // 64 KiB — comfortably under 131072
    for (let i = 0; i < underCapBytes.length; i++) underCapBytes[i] = i % 256

    await b.sendDocTo(c.peerId, underCapBytes)
    await waitFor(() => receivedOnC.length > 0)

    expect(receivedOnC[0].length).toBe(underCapBytes.length)
    expect(new Uint8Array(receivedOnC[0])).toEqual(underCapBytes)
  }, 20000)

  it('OVER cap: a payload comfortably over 128 KiB sent over the established relayed connection is cut off by the library\'s transfer-limit enforcement', async () => {
    const { r, b, c, receivedOnC } = await setupRelayedPair()
    handles.push(r, b, c)

    const overCapBytes = new Uint8Array(200 * 1024) // 200 KiB — comfortably over 131072
    for (let i = 0; i < overCapBytes.length; i++) overCapBytes[i] = i % 256

    // The relayed connection is reset by R's data-limit enforcement (createLimitedRelay /
    // countStreamBytes, server/index.js's limited-relay wiring) once the cumulative byte count
    // crosses defaultDataLimit — this surfaces to the SENDER as the stream write/close failing,
    // not as a silently-truncated-but-successful delivery. Either outcome below (the send itself
    // rejecting, or the send resolving but delivery never completing) is consistent with the
    // cap firing; the one outcome that would FAIL this test is the full 200 KiB payload arriving
    // intact at C, which is the non-vacuity contrast against the UNDER-cap test above.
    let sendRejected = false
    try {
      await b.sendDocTo(c.peerId, overCapBytes)
    } catch {
      sendRejected = true
    }

    if (!sendRejected) {
      // The send call itself didn't reject (e.g. buffered before the limit tripped) — give the
      // library's own enforcement a moment to land, then assert delivery did not complete intact.
      await new Promise((res) => setTimeout(res, 500))
    }

    const deliveredIntact = receivedOnC.length > 0 && receivedOnC[0].length === overCapBytes.length
    expect(sendRejected || !deliveredIntact).toBe(true)
  }, 20000)
})
