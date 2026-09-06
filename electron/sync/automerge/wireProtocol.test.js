// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { PROTO, sendFramed, receiveFramed } from './wireProtocol.js'

// A minimal in-memory duplex: sendFramed's frames go into `chunks`;
// receiveFramed reads them back out of an async iterable built from `chunks`.
// No real stream or libp2p node involved — proves the framing round-trips.
function makeDuplex() {
  const chunks = []
  const sink = async (source) => {
    for await (const chunk of source) chunks.push(chunk)
  }
  async function* source() {
    for (const chunk of chunks) yield chunk
  }
  return { sink, source }
}

describe('wireProtocol', () => {
  it('exports the fixed protocol string', () => {
    expect(PROTO).toBe('/shoresh/automerge/1.0.0')
  })

  it('round-trips a single payload through sendFramed/receiveFramed', async () => {
    const { sink, source } = makeDuplex()
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    await sendFramed(sink, payload)

    const received = []
    await receiveFramed(source(), (bytes) => received.push(bytes))

    expect(received).toHaveLength(1)
    expect(Array.from(received[0])).toEqual([1, 2, 3, 4, 5])
  })

  it('round-trips multiple payloads in order', async () => {
    const { sink, source } = makeDuplex()
    const payloads = [new Uint8Array([1]), new Uint8Array([2, 2]), new Uint8Array([3, 3, 3])]
    for (const p of payloads) await sendFramed(sink, p)

    const received = []
    await receiveFramed(source(), (bytes) => received.push(bytes))

    expect(received.map((b) => Array.from(b))).toEqual(payloads.map((p) => Array.from(p)))
  })

  it('handles an empty payload without dropping the frame', async () => {
    const { sink, source } = makeDuplex()
    await sendFramed(sink, new Uint8Array([]))

    const received = []
    await receiveFramed(source(), (bytes) => received.push(bytes))

    expect(received).toHaveLength(1)
    expect(received[0]).toHaveLength(0)
  })

  it('handles a large payload (bigger than one frame boundary)', async () => {
    const { sink, source } = makeDuplex()
    const big = new Uint8Array(200_000).map((_, i) => i % 256)
    await sendFramed(sink, big)

    const received = []
    await receiveFramed(source(), (bytes) => received.push(bytes))

    expect(received).toHaveLength(1)
    expect(Array.from(received[0])).toEqual(Array.from(big))
  })
})
