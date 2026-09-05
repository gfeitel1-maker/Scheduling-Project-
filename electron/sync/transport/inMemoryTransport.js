// In-memory reference Transport (S1 seam). Two endpoints wired loopback: whatever
// endpoint A sends is delivered to endpoint B's message handlers, and vice versa.
//
// Why it exists:
//  1. It is the contract's reference implementation — the shape every real
//     transport (WebSocket, folder, relay) is measured against by the contract test.
//  2. It lets the sync layer be exercised end-to-end WITHOUT sockets, files, or a
//     network, which is what makes later S1 slices testable in isolation.
//  3. Its store-and-forward behavior (buffer until the partner starts, then flush in
//     order) models exactly the offline-then-reconnect case the whole architecture
//     hinges on — a message sent while the peer is "offline" is not lost.
//
// It uses queueMicrotask (never setTimeout) so delivery is asynchronous but
// deterministic and instant in tests — and so it never trips the no-bare-sleeps
// guard that governs this directory.

import { assertIsTransport } from './transport.js'

function makeEndpoint(id) {
  const messageHandlers = new Set()
  const statusHandlers = new Set()
  const outbox = [] // messages accepted while the partner wasn't ready yet
  const state = { started: false, partner: null }

  function emitStatus(status, detail) {
    for (const h of statusHandlers) h(status, detail)
  }

  function flush() {
    // Deliver in FIFO order to the partner, one message per microtask turn so
    // ordering is preserved even if a handler sends in response.
    if (!state.partner || !state.partner.__started()) return
    while (outbox.length > 0) {
      const message = outbox.shift()
      const meta = { peerId: id } // the sender's id, from the receiver's point of view
      const deliver = () => {
        for (const h of state.partner.__messageHandlers()) h(message, meta)
      }
      queueMicrotask(deliver)
    }
  }

  const endpoint = {
    id,
    async start() {
      if (state.started) return
      state.started = true
      emitStatus('connected')
      // If the partner queued messages for us while we were down, let them arrive.
      if (state.partner) state.partner.__flush()
    },
    async stop() {
      if (!state.started) return
      state.started = false
      emitStatus('disconnected')
    },
    async send(message) {
      if (!state.started) throw new Error(`Transport ${id} is not started`)
      // JSON round-trip models real serialization: the delivered object is an
      // independent copy, so a later mutation of the caller's object can't leak.
      const cloned = JSON.parse(JSON.stringify(message))
      outbox.push(cloned)
      flush()
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onStatus(handler) {
      statusHandlers.add(handler)
      return () => statusHandlers.delete(handler)
    },
    // --- internal wiring, not part of the public Transport contract ---
    __started: () => state.started,
    __messageHandlers: () => messageHandlers,
    __flush: flush,
    __link: (partner) => { state.partner = partner },
  }
  return endpoint
}

/**
 * Create a linked pair of in-memory transports.
 * @param {{ idA?: string, idB?: string }} [opts]
 * @returns {[import('./transport.js').Transport, import('./transport.js').Transport]}
 */
export function createInMemoryTransportPair(opts = {}) {
  const a = makeEndpoint(opts.idA || 'mem-a')
  const b = makeEndpoint(opts.idB || 'mem-b')
  a.__link(b)
  b.__link(a)
  assertIsTransport(a)
  assertIsTransport(b)
  return [a, b]
}
