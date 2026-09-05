// S1 (transport seam) — the contract, per docs/adr/2026-08-17-shared-project-multi-transport-sync.md.
//
// A Transport is a bidirectional, typed message channel that moves sync MESSAGES
// between Shoresh instances. It is deliberately dumb: it knows NOTHING about
// operations, conflicts, delivery acknowledgments, watermarks, or SQLite. All of
// that lives ABOVE the transport (electron/ops/* and the sync layer). Keeping the
// seam this thin is the whole point — WebSocket is the first implementation, and a
// folder journal and a relay are future implementations of the SAME five methods,
// so the sync logic never has to know which one is carrying its messages.
//
// This module is additive: nothing in the running app imports it yet. It exists so
// later S1 slices can migrate syncClient/syncServer onto it one seam at a time,
// each slice behavior-preserving and independently testable.
//
// The contract (an object with these five members):
//
//   id: string
//     A short, stable name for the transport instance ('ws-client', 'folder', …).
//
//   start(): Promise<void>
//     Begin operating: connect the socket / open the folder / bind the server.
//     Emits a 'connected' status when ready. Idempotent: calling start() on an
//     already-started transport resolves without re-connecting.
//
//   stop(): Promise<void>
//     Cease operating and release resources. Emits a 'disconnected' status.
//     After stop(), send() rejects until start() is called again.
//
//   send(message): Promise<void>
//     Hand one JSON-serializable sync message toward the peer(s). The message is
//     the existing sync envelope shape ({ type, ... }). Resolves once the transport
//     has accepted the message for delivery (NOT once the peer has applied it —
//     application-level delivery acknowledgment is a concern of the layer above,
//     exactly because a transport's own "it's synced" claim cannot be trusted; see
//     the ADR's field-test finding).
//
//   onMessage(handler): () => void
//     Register handler(message, meta) for each inbound message. meta may carry
//     { peerId } when the transport can distinguish peers (a server can; a folder
//     may not). Returns an unsubscribe function.
//
//   onStatus(handler): () => void
//     Register handler(status, detail) for connectivity changes, where status is
//     one of 'connected' | 'disconnected' | 'error'. Returns an unsubscribe
//     function. This is presence/liveness of the CHANNEL, not durable data.
//
// Ordering guarantee required of every transport: messages accepted by send() in a
// given order are delivered to the peer's onMessage handlers in that same order.
// (Convergence does not depend on cross-peer global order — the op-log's logical
// clock handles that — but per-channel FIFO keeps parent-before-child replay sane.)

/** The five members every Transport must expose. */
export const TRANSPORT_MEMBERS = Object.freeze([
  'id',
  'start',
  'stop',
  'send',
  'onMessage',
  'onStatus',
])

export const TRANSPORT_STATUSES = Object.freeze(['connected', 'disconnected', 'error'])

/**
 * Throw if `t` does not satisfy the Transport contract. Cheap structural check
 * used by the contract test and safe to call at wire-up time when a transport is
 * injected. Not a type system — just a guardrail against a half-built transport.
 * @param {unknown} t
 * @returns {t is import('./transport.js').Transport}
 */
export function assertIsTransport(t) {
  if (!t || typeof t !== 'object') {
    throw new TypeError('Transport must be an object')
  }
  if (typeof t.id !== 'string' || t.id.length === 0) {
    throw new TypeError('Transport.id must be a non-empty string')
  }
  for (const m of ['start', 'stop', 'send', 'onMessage', 'onStatus']) {
    if (typeof t[m] !== 'function') {
      throw new TypeError(`Transport.${m} must be a function`)
    }
  }
  return true
}
