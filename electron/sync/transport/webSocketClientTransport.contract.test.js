// @vitest-environment node
//
// Runs the SAME behavioural battery as transport.contract.test.js, but against
// a REAL WebSocketClientTransport talking to a real `ws` server over a real
// loopback socket — not the in-memory reference. Two endpoints:
//   - "a" = createWebSocketClientTransport, the thing under test.
//   - "b" = the raw `ws` server side, stood in for the future S1.3 server
//     transport. It is deliberately NOT wrapped in a Transport here (that
//     wrapper is S1.3's job); this file only has to prove the client half.
//
// Port: ephemeral, chosen fresh per test via getFreePort() (adapted from
// test/integration/harness.js's helper — same approach, not a shared import,
// since electron/sync/transport/ has no existing dependency on test/). Repo
// memory (reference_running_long_gates_and_shell_gotchas /
// project_cross_device_sync_defect_t85 gotchas) flags fixed ports as a
// recurring flake source; this avoids it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { sleepBecauseTimeIsUnderTest } from '../../../test/helpers/waitFor.js'
import { assertIsTransport, TRANSPORT_MEMBERS } from './transport.js'
import { createWebSocketClientTransport } from './webSocketClientTransport.js'

/** Find a free TCP port on 127.0.0.1. Same approach as test/integration/harness.js. */
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

// Poll until predicate is true or timeout — arrival-then-assert, not a fixed
// guessed sleep. Mirrors test/integration/harness.js's waitFor().
async function waitFor(predicate, timeoutMs = 2000, pollMs = 10) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await sleepBecauseTimeIsUnderTest(pollMs) // time-under-test: crossing-interval
  }
  throw new Error('waitFor: timed out')
}

function collect(transport) {
  const received = []
  transport.onMessage((message, meta) => received.push({ message, meta }))
  return received
}

describe('Transport contract (via WebSocketClientTransport against a real ws server)', () => {
  let port
  let wss
  let serverSockets

  beforeEach(async () => {
    port = await getFreePort()
    serverSockets = []
    wss = new WebSocketServer({ host: '127.0.0.1', port })
    wss.on('connection', (socket) => {
      serverSockets.push(socket)
    })
    await waitFor(() => wss.address() != null)
  })

  afterEach(async () => {
    for (const s of serverSockets) s.terminate()
    await new Promise((resolve) => wss.close(resolve))
  })

  function makeClient(overrides = {}) {
    return createWebSocketClientTransport({
      id: 'ws-client-under-test',
      serverUrl: `ws://127.0.0.1:${port}`,
      ...overrides,
    })
  }

  function serverSend(message) {
    // Server -> client, mirroring what the future S1.3 server transport does.
    serverSockets[0].send(JSON.stringify(message))
  }

  it('satisfies the contract shape', () => {
    const a = makeClient()
    expect(assertIsTransport(a)).toBe(true)
    for (const m of TRANSPORT_MEMBERS) expect(a[m]).toBeDefined()
  })

  it('emits "connected" on start and "disconnected" on stop', async () => {
    const a = makeClient()
    const statuses = []
    a.onStatus((s) => statuses.push(s))
    await a.start()
    await waitFor(() => statuses.includes('connected'))
    await a.stop()
    await waitFor(() => statuses.includes('disconnected'))
    expect(statuses).toEqual(['connected', 'disconnected'])
  })

  it('start() is idempotent — a second call does not re-connect', async () => {
    const a = makeClient()
    const statuses = []
    a.onStatus((s) => statuses.push(s))
    await a.start()
    await waitFor(() => statuses.includes('connected'))
    await a.start() // no-op
    expect(statuses).toEqual(['connected']) // no second 'connected' emitted
    await a.stop()
  })

  it('delivers client -> server -> back to a second client (round trip)', async () => {
    const a = makeClient()
    await a.start()
    await waitFor(() => serverSockets.length === 1)

    // Server echoes whatever it receives straight back, standing in for a
    // real server transport relaying to the sync layer and it replying.
    serverSockets[0].on('message', (data) => {
      serverSockets[0].send(data.toString())
    })

    const onA = collect(a)
    await a.send({ type: 'submit_op', op: { id: 'op1', value: 'Field 1' } })
    await waitFor(() => onA.length === 1)
    expect(onA[0].message).toEqual({ type: 'submit_op', op: { id: 'op1', value: 'Field 1' } })

    await a.stop()
  })

  it('delivers server -> client', async () => {
    const a = makeClient()
    const onA = collect(a)
    await a.start()
    await waitFor(() => serverSockets.length === 1)

    serverSend({ type: 'op_applied', op: { id: 'op2' } })
    await waitFor(() => onA.length === 1)
    expect(onA[0].message.type).toBe('op_applied')

    await a.stop()
  })

  it('preserves FIFO order per channel', async () => {
    const a = makeClient()
    const onA = collect(a)
    await a.start()
    await waitFor(() => serverSockets.length === 1)

    for (let i = 0; i < 5; i++) serverSend({ type: 'op_applied', seq: i })
    await waitFor(() => onA.length === 5)
    expect(onA.map((r) => r.message.seq)).toEqual([0, 1, 2, 3, 4])

    await a.stop()
  })

  it('unsubscribe stops delivery to that handler', async () => {
    const a = makeClient()
    const received = []
    const off = a.onMessage((m) => received.push(m))
    await a.start()
    await waitFor(() => serverSockets.length === 1)

    serverSend({ type: 'op_applied', seq: 1 })
    await waitFor(() => received.length === 1)
    off()
    serverSend({ type: 'op_applied', seq: 2 })
    // Give the (unsubscribed) handler a chance to have fired if it were
    // still wired, then assert it did not.
    await sleepBecauseTimeIsUnderTest(50) // time-under-test: proving-absence
    expect(received.map((m) => m.seq)).toEqual([1])

    await a.stop()
  })

  it('rejects send() after stop until restarted', async () => {
    const a = makeClient()
    await a.start()
    await waitFor(() => serverSockets.length === 1)
    await a.stop()
    await expect(a.send({ type: 'x' })).rejects.toThrow(/not started/)
  })

  it('rejects send() before the socket has finished opening', async () => {
    const a = makeClient()
    const sendPromise = a.send({ type: 'x' }) // start() not even called yet
    await expect(sendPromise).rejects.toThrow(/not started/)
    await a.stop()
  })

  it('malformed inbound frames are dropped, not thrown or surfaced as an error', async () => {
    const a = makeClient()
    const statuses = []
    a.onStatus((s) => statuses.push(s))
    const onA = collect(a)
    await a.start()
    await waitFor(() => serverSockets.length === 1)

    serverSockets[0].send('not valid json{{{')
    serverSockets[0].send(JSON.stringify({ noTypeField: true }))
    serverSend({ type: 'op_applied', seq: 99 }) // a good frame after the bad ones

    await waitFor(() => onA.length === 1)
    expect(onA[0].message.seq).toBe(99)
    expect(statuses).not.toContain('error')

    await a.stop()
  })

  it('independent client copies do not share state', async () => {
    const a = makeClient({ id: 'client-a' })
    const b = makeClient({ id: 'client-b' })
    await a.start()
    await b.start()
    await waitFor(() => serverSockets.length === 2)
    expect(a.id).toBe('client-a')
    expect(b.id).toBe('client-b')
    await a.stop()
    await b.stop()
  })

  // Deliberate deviation from inMemoryTransport, documented in
  // webSocketClientTransport.js's header: a live socket has no
  // store-and-forward buffer, so a message sent while genuinely disconnected
  // rejects immediately rather than queuing silently. This pins that choice
  // so a future change can't accidentally add a fake buffer without a test
  // noticing.
  it('does NOT buffer sends made while disconnected (unlike inMemoryTransport)', async () => {
    const a = makeClient()
    // Never started — analogous to "peer down" in the in-memory test, but for
    // a real socket there is no outbox to flush later.
    await expect(a.send({ type: 'queued-while-down' })).rejects.toThrow(/not started/)
  })
})
