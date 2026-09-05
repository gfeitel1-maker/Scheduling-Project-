// @vitest-environment node
//
// The Transport CONTRACT test (S1 seam). Every transport implementation — the
// in-memory reference here, and later the WebSocket/folder/relay transports — must
// pass this same suite. That is the point of a seam: one behavioural spec, many
// carriers. Run against inMemoryTransport for now.
import { describe, it, expect } from 'vitest'
import { assertIsTransport, TRANSPORT_MEMBERS } from './transport.js'
import { createInMemoryTransportPair } from './inMemoryTransport.js'

// Drain the microtask queue a few turns so queueMicrotask-based delivery settles.
// Deterministic and instant — no timers, so this is safe under the no-sleeps guard.
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function collect(endpoint) {
  const received = []
  endpoint.onMessage((message, meta) => received.push({ message, meta }))
  return received
}

describe('Transport contract (via inMemoryTransport)', () => {
  it('both endpoints satisfy the contract shape', () => {
    const [a, b] = createInMemoryTransportPair()
    expect(assertIsTransport(a)).toBe(true)
    expect(assertIsTransport(b)).toBe(true)
    for (const m of TRANSPORT_MEMBERS) expect(a[m]).toBeDefined()
  })

  it('assertIsTransport rejects a malformed transport', () => {
    expect(() => assertIsTransport({ id: 'x', start() {}, stop() {}, send() {} }))
      .toThrow(/onMessage/)
    expect(() => assertIsTransport({ id: '', start() {}, stop() {}, send() {}, onMessage() {}, onStatus() {} }))
      .toThrow(/id/)
  })

  it('emits "connected" on start and "disconnected" on stop', async () => {
    const [a] = createInMemoryTransportPair()
    const statuses = []
    a.onStatus((s) => statuses.push(s))
    await a.start()
    await a.stop()
    expect(statuses).toEqual(['connected', 'disconnected'])
  })

  it('delivers A -> B with sender peerId in meta', async () => {
    const [a, b] = createInMemoryTransportPair({ idA: 'alpha', idB: 'beta' })
    const onB = collect(b)
    await a.start(); await b.start()
    await a.send({ type: 'submit_op', op: { id: 'op1', value: 'Field 1' } })
    await drain()
    expect(onB).toHaveLength(1)
    expect(onB[0].message).toEqual({ type: 'submit_op', op: { id: 'op1', value: 'Field 1' } })
    expect(onB[0].meta.peerId).toBe('alpha')
  })

  it('delivers B -> A (bidirectional)', async () => {
    const [a, b] = createInMemoryTransportPair()
    const onA = collect(a)
    await a.start(); await b.start()
    await b.send({ type: 'op_applied', op: { id: 'op2' } })
    await drain()
    expect(onA).toHaveLength(1)
    expect(onA[0].message.type).toBe('op_applied')
  })

  it('preserves FIFO order per channel', async () => {
    const [a, b] = createInMemoryTransportPair()
    const onB = collect(b)
    await a.start(); await b.start()
    for (let i = 0; i < 5; i++) await a.send({ type: 'op_applied', seq: i })
    await drain()
    expect(onB.map((r) => r.message.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('store-and-forward: messages sent while the peer is down arrive after it starts', async () => {
    const [a, b] = createInMemoryTransportPair()
    const onB = collect(b)
    await a.start() // b intentionally NOT started yet
    await a.send({ type: 'op_applied', seq: 1 })
    await a.send({ type: 'op_applied', seq: 2 })
    await drain()
    expect(onB).toHaveLength(0) // nothing lost, nothing delivered yet
    await b.start() // peer "reconnects"
    await drain()
    expect(onB.map((r) => r.message.seq)).toEqual([1, 2]) // backlog flushes in order
  })

  it('unsubscribe stops delivery to that handler', async () => {
    const [a, b] = createInMemoryTransportPair()
    const received = []
    const off = b.onMessage((m) => received.push(m))
    await a.start(); await b.start()
    await a.send({ type: 'op_applied', seq: 1 })
    await drain()
    off()
    await a.send({ type: 'op_applied', seq: 2 })
    await drain()
    expect(received.map((m) => m.seq)).toEqual([1]) // second message not seen
  })

  it('rejects send() after stop until restarted', async () => {
    const [a, b] = createInMemoryTransportPair()
    await a.start(); await b.start()
    await a.stop()
    await expect(a.send({ type: 'x' })).rejects.toThrow(/not started/)
  })

  it('delivered message is an independent copy (mutation after send does not leak)', async () => {
    const [a, b] = createInMemoryTransportPair()
    const onB = collect(b)
    await a.start(); await b.start()
    const msg = { type: 'submit_op', op: { id: 'op9', value: 'before' } }
    await a.send(msg)
    msg.op.value = 'after' // mutate AFTER handing off
    await drain()
    expect(onB[0].message.op.value).toBe('before')
  })
})
