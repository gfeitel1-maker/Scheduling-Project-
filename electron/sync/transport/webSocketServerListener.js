// S1.3 — WebSocket SERVER listener (Model A, per the Architect's design note at
// experiments/future-arch/S1.3-server-transport-design.md).
//
// This module is NOT a Transport. It is a listener that hands out one
// per-peer Transport (a "peer channel") for every accepted socket. The
// contract in ./transport.js describes a single bidirectional channel to ONE
// counterpart; a listening server has many simultaneous counterparts, so it
// cannot honestly satisfy assertIsTransport itself — there is no single
// send()/onMessage() that means anything without first saying to which peer.
// Model A keeps the seam narrow: the listener's only job is accept + hand out
// a conforming Transport per connection; everything else (broadcast, peer
// bookkeeping, auth) stays exactly where it already lives, one layer up.
//
// This file is additive and unused by the running app. syncServer.js is not
// rewired onto it — that is S1.5, a separate reviewed slice.
//
// Inbound framing mirrors webSocketClientTransport.js exactly: JSON.parse in
// a try/catch, silently drop anything that isn't a well-formed sync envelope
// (a plain object with a string `type`), never surface a bad frame as an
// onStatus('error').

import { WebSocketServer } from 'ws'
import { assertIsTransport } from './transport.js'

/**
 * @param {{
 *   port: number,
 *   id?: string,
 *   wssFactory?: (opts: { port: number }) => import('ws').WebSocketServer,
 * }} opts
 */
export function createWebSocketServerListener(opts) {
  const {
    port,
    id = 'ws-server',
    wssFactory = ({ port: p }) => new WebSocketServer({ host: '127.0.0.1', port: p }),
  } = opts

  if (typeof port !== 'number') {
    throw new TypeError('createWebSocketServerListener requires opts.port')
  }

  const connectionHandlers = new Set()
  const disconnectionHandlers = new Set()
  // Node's underlying server.close() stops accepting new connections but
  // does NOT proactively close sockets already open — its callback only
  // fires once every existing connection has ended on its own. A peer that
  // never initiates its own close would hang stop() forever, so the listener
  // tracks live sockets itself and terminates them before closing the server.
  const liveSockets = new Set()

  let wss = null
  let nextPeerNum = 0

  // peerId is a listener-assigned opaque counter ('peer-1', 'peer-2', …), NOT
  // deviceId and NOT derived from remote address — deviceId is set later, by
  // handleAuthenticate (electron/sync/syncServer.js:454), well after the
  // socket already exists; a peerId must be available at connect time.
  function nextPeerId() {
    nextPeerNum += 1
    return `peer-${nextPeerNum}`
  }

  function makePeerChannel(socket, peerId) {
    const messageHandlers = new Set()
    const statusHandlers = new Set()
    let stopped = false

    function emitStatus(status, detail) {
      for (const h of statusHandlers) h(status, detail)
    }

    socket.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return // malformed frame: dropped, not surfaced as a channel error
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return // well-formed JSON but not a sync envelope: same treatment
      }
      const meta = {} // single counterpart per channel, like the client transport
      for (const h of messageHandlers) h(msg, meta)
    })

    socket.on('close', () => {
      stopped = true
      liveSockets.delete(socket)
      emitStatus('disconnected')
      for (const h of disconnectionHandlers) h(peerId)
    })

    socket.on('error', (err) => {
      emitStatus('error', err)
    })

    const channel = {
      id: `${id}-${peerId}`,

      async start() {
        // The socket is already open when handed to onConnection; nothing to do.
      },

      async stop() {
        if (stopped) return
        stopped = true
        socket.removeAllListeners('close')
        socket.close()
        emitStatus('disconnected')
      },

      async send(message) {
        if (stopped || socket.readyState !== socket.OPEN) {
          throw new Error(`Transport ${channel.id} is not started`)
        }
        socket.send(JSON.stringify(message))
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

    assertIsTransport(channel)
    return { channel, emitConnected: () => emitStatus('connected') }
  }

  return {
    id,

    async start() {
      if (wss) return // idempotent
      wss = wssFactory({ port })
      wss.on('connection', (socket) => {
        liveSockets.add(socket)
        const peerId = nextPeerId()
        const { channel, emitConnected } = makePeerChannel(socket, peerId)
        // Handed to onConnection first so a caller's onStatus() subscription
        // (made synchronously inside its handler) is in place before
        // 'connected' fires — the socket is already open at handout time, so
        // there is no separate start() step for a connection the caller did
        // not initiate.
        for (const h of connectionHandlers) h(channel, peerId)
        emitConnected()
      })
      const server = wss
      await new Promise((resolve, reject) => {
        if (server.address() != null) {
          resolve()
          return
        }
        server.once('listening', resolve)
        server.once('error', reject)
      })
    },

    async stop() {
      if (!wss) return
      const server = wss
      wss = null
      for (const socket of liveSockets) socket.close()
      liveSockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },

    onConnection(handler) {
      connectionHandlers.add(handler)
      return () => connectionHandlers.delete(handler)
    },

    onDisconnection(handler) {
      disconnectionHandlers.add(handler)
      return () => disconnectionHandlers.delete(handler)
    },
  }
}
