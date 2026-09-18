// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { PROTO, sendFramed, receiveFramed, MAX_FRAME_BYTES } from './wireProtocol.js'

// libp2p v3's Stream is an EventTarget: reads arrive via async iteration
// (Stream extends AsyncIterable), writes go through a synchronous `.send()`
// that returns false on backpressure, and `.onDrain()` resolves once the
// write buffer has room again. This fake models exactly that surface — no
// real libp2p node needed to prove the framing is correct.
function makeFakeStream() {
  const written = []
  return {
    written,
    send(data) {
      written.push(data)
      return true
    },
    async onDrain() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of written) yield chunk
    },
  }
}

// A stream whose first `.send()` reports backpressure (returns false) so
// tests can prove sendFramed actually waits for 'drain' rather than just
// ignoring the return value (the silent-data-loss failure mode called out in
// the migration brief).
function makeBackpressuredStream() {
  const written = []
  let blocked = true
  let releaseDrain
  const drainPromise = new Promise((resolve) => {
    releaseDrain = resolve
  })
  return {
    written,
    send(data) {
      written.push(data)
      const ok = !blocked
      blocked = false
      return ok
    },
    onDrain() {
      return drainPromise
    },
    release() {
      releaseDrain()
    },
  }
}

describe('wireProtocol', () => {
  it('exports the fixed protocol string', () => {
    expect(PROTO).toBe('/shoresh/automerge/1.0.0')
  })

  it('round-trips a single payload through sendFramed/receiveFramed', async () => {
    const stream = makeFakeStream()
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    await sendFramed(stream, payload)

    const received = []
    await receiveFramed(stream, (bytes) => received.push(bytes))

    expect(received).toHaveLength(1)
    expect(Array.from(received[0])).toEqual([1, 2, 3, 4, 5])
  })

  it('round-trips multiple payloads in order', async () => {
    const stream = makeFakeStream()
    const payloads = [new Uint8Array([1]), new Uint8Array([2, 2]), new Uint8Array([3, 3, 3])]
    for (const p of payloads) await sendFramed(stream, p)

    const received = []
    await receiveFramed(stream, (bytes) => received.push(bytes))

    expect(received.map((b) => Array.from(b))).toEqual(payloads.map((p) => Array.from(p)))
  })

  it('handles an empty payload without dropping the frame', async () => {
    const stream = makeFakeStream()
    await sendFramed(stream, new Uint8Array([]))

    const received = []
    await receiveFramed(stream, (bytes) => received.push(bytes))

    expect(received).toHaveLength(1)
    expect(received[0]).toHaveLength(0)
  })

  it('exports a bounded frame cap (Security review)', () => {
    expect(typeof MAX_FRAME_BYTES).toBe('number')
    expect(MAX_FRAME_BYTES).toBeGreaterThan(0)
  })

  it('rejects an inbound frame larger than maxDataLength, without delivering it', async () => {
    const stream = makeFakeStream()
    await sendFramed(stream, new Uint8Array(1000)) // 1000-byte payload
    const received = []
    // A hostile/oversized frame must not be handed to the consumer; decode
    // throws when the declared length exceeds the cap, and receiveFramed rejects.
    await expect(
      receiveFramed(stream, (bytes) => received.push(bytes), { maxDataLength: 100 })
    ).rejects.toBeTruthy()
    expect(received).toHaveLength(0)
  })

  it('handles a large payload (bigger than one frame boundary)', async () => {
    const stream = makeFakeStream()
    const big = new Uint8Array(200_000).map((_, i) => i % 256)
    await sendFramed(stream, big)

    const received = []
    await receiveFramed(stream, (bytes) => received.push(bytes))

    expect(received).toHaveLength(1)
    expect(Array.from(received[0])).toEqual(Array.from(big))
  })

  it('awaits drain before resolving when .send() reports backpressure', async () => {
    const stream = makeBackpressuredStream()
    let resolved = false
    const pending = sendFramed(stream, new Uint8Array([42])).then(() => {
      resolved = true
    })

    // Give the event loop a couple of turns — sendFramed must NOT have
    // resolved yet, because .send() returned false and 'drain' hasn't fired.
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)

    stream.release()
    await pending
    expect(resolved).toBe(true)
    expect(stream.written).toHaveLength(1)
  })
})

// Red Hat finding (HIGH) on the libp2p 3.x migration: an unbounded onDrain() wait means a peer that
// never drains wedges the sender forever — a device that silently stops syncing rather than
// reporting an error. The wait must be bounded.
describe('sendFramed — a peer that never drains', () => {
  it('rejects after the drain timeout instead of hanging forever', async () => {
    const stream = {
      send: () => false,                       // always backpressured
      onDrain: (opts) => new Promise((_resolve, reject) => {
        // Honour the AbortSignal the way a real libp2p stream does.
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }
    await expect(sendFramed(stream, new Uint8Array([1, 2, 3]), { drainTimeoutMs: 20 }))
      .rejects.toThrow()
  })

  it('passes an abort signal to onDrain at all (non-vacuity: a stream ignoring it would hang)', async () => {
    let received = null
    const stream = { send: () => false, onDrain: (opts) => { received = opts; return Promise.resolve() } }
    await sendFramed(stream, new Uint8Array([1]), { drainTimeoutMs: 50 })
    expect(received?.signal).toBeInstanceOf(AbortSignal)
  })
})
