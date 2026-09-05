// S1.2 — WebSocket CLIENT transport (Transport contract, see ./transport.js).
//
// Wraps the `ws` package the same way electron/sync/syncClient.js already does
// (see that file's `connect()`, `ws.on('open'|'message'|'close'|'error')`, and
// its RECONNECT_DELAY_MS loop) but strips out everything above the wire: no
// auth handshake, no op-log semantics, no resolvers/acks. Those stay in
// syncClient.js today and will move onto this seam in S1.4, which is a
// separate, reviewed slice — this file is additive and unused by the running
// app.
//
// Design decisions this file encodes (see the accompanying design note at
// experiments/future-arch/S1.2-websocket-adapter-design.md for the full
// reasoning):
//
//  1. Auto-reconnect lives INSIDE the transport. syncClient.js today does its
//     own reconnect loop (electron/sync/syncClient.js:854-888) because `ws`
//     itself has none. A transport that hides "the channel dropped and came
//     back" behind onStatus('disconnected') -> onStatus('connected') is the
//     whole point of the seam — callers above should not need to know their
//     carrier is a socket that can fall over. This also means whenever S1.4
//     migrates syncClient onto this transport, that reconnect loop deletes
//     entirely rather than growing a second copy.
//
//  2. The transport/sync boundary stays exactly where the contract's header
//     comment draws it: this file moves bytes and reports channel liveness.
//     It does NOT parse `msg.type`, does NOT know about `submit_op` /
//     `op_applied_ack` / resolvers, and does NOT retry a message that was
//     in flight when the socket dropped — that is store-and-forward, and per
//     the contract header ("acks... are a concern of the layer above") and
//     this transport's own delivery note below, a live socket cannot honestly
//     promise it. The sync layer already re-sends from its own durable state
//     on reconnect (pendingWrites, catchup) and keeps doing so unchanged.
//
//  3. Framing: every outbound message is `JSON.stringify`'d; every inbound
//     frame is `JSON.parse`'d defensively, matching syncClient.js:619-630 — a
//     frame that isn't valid JSON, or whose parsed value isn't a plain object
//     with a string `type`, is silently dropped (never thrown, never
//     surfaced as an 'error' status: a single malformed frame is not loss of
//     the channel).
//
// Delivery semantics vs. the in-memory reference: unlike inMemoryTransport,
// this transport does NOT buffer messages sent while disconnected — a real
// socket has no such buffer, and pretending otherwise would misrepresent what
// TCP actually guarantees. `send()` rejects immediately if the socket is not
// OPEN, exactly like the "after stop()" case the contract mandates, so a
// caller always finds out synchronously rather than believing something was
// queued that in fact was not. This is the one deliberate, documented
// deviation from inMemoryTransport's store-and-forward — see the contract
// test file for the assertion that pins it.

import WebSocket from 'ws'
import { assertIsTransport } from './transport.js'

/**
 * @param {{
 *   id?: string,
 *   serverUrl: string,
 *   wsFactory?: (url: string) => import('ws'),
 *   reconnectDelayMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} opts
 * @returns {import('./transport.js').Transport}
 */
export function createWebSocketClientTransport(opts) {
  const {
    id = 'ws-client',
    serverUrl,
    wsFactory = (url) => new WebSocket(url),
    // Same default as syncClient.js's RECONNECT_DELAY_MS (electron/sync/syncClient.js:317).
    reconnectDelayMs = 1500,
    // Injectable so tests can use a short real delay without editing the
    // module's default, and so a future caller can supply a fake timer.
    // Deliberately real timer functions, not a bare setTimeout literal in
    // this module's body being called with a fixed guessed duration.
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = opts

  if (!serverUrl) throw new TypeError('createWebSocketClientTransport requires opts.serverUrl')

  const messageHandlers = new Set()
  const statusHandlers = new Set()

  let ws = null
  let stoppedByCaller = true // starts "stopped" until start() is called
  let reconnectTimer = null

  function emitStatus(status, detail) {
    for (const h of statusHandlers) h(status, detail)
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect() {
    if (stoppedByCaller) return
    clearReconnectTimer()
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null
      if (!stoppedByCaller) openSocket()
    }, reconnectDelayMs)
  }

  function openSocket() {
    ws = wsFactory(serverUrl)

    ws.on('open', () => {
      emitStatus('connected')
    })

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return // malformed frame: dropped, not surfaced as a channel error
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return // well-formed JSON but not a sync envelope: same treatment
      }
      const meta = {} // a lone server has no peerId to distinguish; S1.3 adds it server-side
      for (const h of messageHandlers) h(msg, meta)
    })

    ws.on('error', (err) => {
      emitStatus('error', err)
    })

    ws.on('close', () => {
      emitStatus('disconnected')
      scheduleReconnect()
    })
  }

  const transport = {
    id,

    async start() {
      if (!stoppedByCaller) return // idempotent: already started
      stoppedByCaller = false
      openSocket()
    },

    async stop() {
      if (stoppedByCaller) return
      stoppedByCaller = true
      clearReconnectTimer()
      const socket = ws
      ws = null
      if (socket) {
        // Avoid a spurious reconnect-scheduling race: close listener above
        // still fires and calls scheduleReconnect(), which is now a no-op
        // because stoppedByCaller is already true.
        socket.removeAllListeners('close')
        socket.close()
      }
      emitStatus('disconnected')
    },

    async send(message) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Transport ${id} is not started`)
      }
      ws.send(JSON.stringify(message))
    },

    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },

    onStatus(handler) {
      statusHandlers.add(handler)
      return () => statusHandlers.delete(handler)
    },
  }

  assertIsTransport(transport)
  return transport
}
