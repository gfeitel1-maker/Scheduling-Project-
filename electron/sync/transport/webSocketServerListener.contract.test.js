// @vitest-environment node
//
// S1.3 — contract test for the WebSocket SERVER listener. Uses the real S1.2
// createWebSocketClientTransport as the connecting peer(s), so this exercises
// a genuine client-transport <-> server-listener round trip over a real
// loopback socket, not two mocks talking to each other.
//
// Port: ephemeral via getFreePort(), same pattern as
// webSocketClientTransport.contract.test.js (repo memory flags fixed ports as
// a recurring flake source).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import { waitFor, sleepBecauseTimeIsUnderTest } from '../../../test/helpers/waitFor.js'
import { assertIsTransport, TRANSPORT_MEMBERS } from './transport.js'
import { createWebSocketClientTransport } from './webSocketClientTransport.js'
import { createWebSocketServerListener } from './webSocketServerListener.js'

/** Find a free TCP port on 127.0.0.1. Same approach as webSocketClientTransport.contract.test.js. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function collect(transport) {
  const received = []
  transport.onMessage((message, meta) => received.push({ message, meta }))
  return received
}

describe('WebSocket server listener', () => {
  let port
  let listener
  let clients

  beforeEach(async () => {
    port = await getFreePort()
    listener = createWebSocketServerListener({ port })
    clients = []
  })

  afterEach(async () => {
    for (const c of clients) await c.stop()
    await listener.stop()
  })

  function makeClient() {
    const c = createWebSocketClientTransport({ serverUrl: `ws://127.0.0.1:${port}` })
    clients.push(c)
    return c
  }

  it('start/stop the listener; onConnection fires with a conforming peerChannel and a peerId', async () => {
    await listener.start()

    const connections = []
    listener.onConnection((peerChannel, peerId) => connections.push({ peerChannel, peerId }))

    const a = makeClient()
    await a.start()
    await waitFor(() => connections.length === 1, { message: 'onConnection to fire' })

    expect(assertIsTransport(connections[0].peerChannel)).toBe(true)
    for (const m of TRANSPORT_MEMBERS) expect(connections[0].peerChannel[m]).toBeDefined()
    expect(typeof connections[0].peerId).toBe('string')
    expect(connections[0].peerId).not.toBe('')

    await listener.stop()
  })

  it('peerChannel emits "connected" on handout and "disconnected" on client disconnect; onDisconnection fires with that peerId', async () => {
    await listener.start()

    let peerChannel
    let peerId
    listener.onConnection((ch, id) => {
      peerChannel = ch
      peerId = id
    })
    const disconnected = []
    listener.onDisconnection((id) => disconnected.push(id))

    const statuses = []
    listener.onConnection((ch) => ch.onStatus((s) => statuses.push(s)))

    const a = makeClient()
    await a.start()
    await waitFor(() => peerChannel != null, { message: 'peerChannel to be handed out' })
    await waitFor(() => statuses.includes('connected'), { message: '"connected" to fire on handout' })

    await a.stop()
    await waitFor(() => statuses.includes('disconnected'), { message: '"disconnected" to fire on client close' })
    await waitFor(() => disconnected.includes(peerId), { message: 'onDisconnection to fire with peerId' })
  })

  it('delivers messages client -> peerChannel.onMessage', async () => {
    await listener.start()
    let peerChannel
    listener.onConnection((ch) => { peerChannel = ch })

    const a = makeClient()
    await a.start()
    await waitFor(() => peerChannel != null)

    const onServer = collect(peerChannel)
    await a.send({ type: 'submit_op', op: { id: 'op1' } })
    await waitFor(() => onServer.length === 1)
    expect(onServer[0].message).toEqual({ type: 'submit_op', op: { id: 'op1' } })
    expect(onServer[0].meta).toEqual({})
  })

  it('delivers messages peerChannel.send -> client.onMessage', async () => {
    await listener.start()
    let peerChannel
    listener.onConnection((ch) => { peerChannel = ch })

    const a = makeClient()
    const onA = collect(a)
    await a.start()
    await waitFor(() => peerChannel != null)

    await peerChannel.send({ type: 'op_applied', op: { id: 'op2' } })
    await waitFor(() => onA.length === 1)
    expect(onA[0].message.type).toBe('op_applied')
  })

  it('multi-peer: two clients get distinct peerIds; broadcast (caller iterates) reaches both; targeted send reaches only one', async () => {
    await listener.start()
    const channels = []
    listener.onConnection((ch, id) => channels.push({ ch, id }))

    const a = makeClient()
    const b = makeClient()
    const onA = collect(a)
    const onB = collect(b)
    await a.start()
    await b.start()
    await waitFor(() => channels.length === 2, { message: 'both peers to connect' })

    expect(channels[0].id).not.toBe(channels[1].id)

    // Broadcast: caller logic iterates the live peer channels, not a listener method.
    for (const { ch } of channels) await ch.send({ type: 'op_applied', op: { id: 'broadcast' } })
    await waitFor(() => onA.length === 1 && onB.length === 1)
    expect(onA[0].message.op.id).toBe('broadcast')
    expect(onB[0].message.op.id).toBe('broadcast')

    // Targeted: send on one channel only reaches that client.
    await channels[0].ch.send({ type: 'op_applied', op: { id: 'targeted' } })
    await waitFor(() => onA.length === 2)
    await sleepBecauseTimeIsUnderTest(50) // time-under-test: proving-absence
    expect(onA.map((r) => r.message.op.id)).toEqual(['broadcast', 'targeted'])
    expect(onB.map((r) => r.message.op.id)).toEqual(['broadcast'])
  })

  it('preserves FIFO order per channel', async () => {
    await listener.start()
    let peerChannel
    listener.onConnection((ch) => { peerChannel = ch })

    const a = makeClient()
    const onA = collect(a)
    await a.start()
    await waitFor(() => peerChannel != null)

    for (let i = 0; i < 5; i++) await peerChannel.send({ type: 'op_applied', seq: i })
    await waitFor(() => onA.length === 5)
    expect(onA.map((r) => r.message.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('unsubscribe stops delivery', async () => {
    await listener.start()
    let peerChannel
    listener.onConnection((ch) => { peerChannel = ch })

    const a = makeClient()
    await a.start()
    await waitFor(() => peerChannel != null)

    const received = []
    const off = peerChannel.onMessage((m) => received.push(m))
    await a.send({ type: 'x', seq: 1 })
    await waitFor(() => received.length === 1)
    off()
    await a.send({ type: 'x', seq: 2 })
    await sleepBecauseTimeIsUnderTest(50) // time-under-test: proving-absence
    expect(received.map((m) => m.seq)).toEqual([1])
  })

  it('send() after peer disconnect rejects', async () => {
    await listener.start()
    let peerChannel
    listener.onConnection((ch) => { peerChannel = ch })

    const a = makeClient()
    await a.start()
    await waitFor(() => peerChannel != null)

    const statuses = []
    peerChannel.onStatus((s) => statuses.push(s))
    await a.stop()
    await waitFor(() => statuses.includes('disconnected'), { message: 'peer channel to observe the client disconnect' })
    await expect(peerChannel.send({ type: 'x' })).rejects.toThrow(/not started/)
  })

  it('listener.stop() closes the server; each peer channel sees "disconnected"', async () => {
    await listener.start()
    let peerChannel
    listener.onConnection((ch) => { peerChannel = ch })

    const a = makeClient()
    await a.start()
    await waitFor(() => peerChannel != null)

    const statuses = []
    peerChannel.onStatus((s) => statuses.push(s))

    await listener.stop()
    await waitFor(() => statuses.includes('disconnected'), { message: 'peer channel to see disconnected on server stop' })
  })
})
