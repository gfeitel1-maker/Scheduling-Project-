// @vitest-environment node
//
// S4c rung 3: the rendezvous client runs only on demand, with exponential backoff, and fills its
// record with this device's PUBLIC reflexive addresses only. Uses an injected clock and a fetch spy.
import { describe, it, expect, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { mintRendezvousAddressKey, readRendezvousAddressKey } from './rendezvousAddressKey.js'
import { mintRendezvousNamespace } from './rendezvousNamespace.js'
import { verify } from './rendezvousRecord.js'
import { startDemandRendezvousClient, startRendezvousClient, publicRecordAddresses, createQueuedDemand } from './rendezvousClient.js'

function readyDoc() {
  let doc = A.change(A.from({ camps: {} }), (d) => { d.camps.id = 'camp-1' })
  doc = mintRendezvousNamespace(doc, 'camp-1').doc
  doc = mintRendezvousAddressKey(doc, 'camp-1').doc
  return doc
}

async function harness(extra = {}) {
  const doc = readyDoc()
  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const fetchImpl = vi.fn(async (url, init) => (init?.method === 'POST'
    ? new Response(JSON.stringify({ ok: true }), { status: 200 })
    : new Response(JSON.stringify({ peers: [] }), { status: 200 })))
  const timers = []
  const opts = {
    baseUrl: 'https://rendezvous.example', campId: 'camp-1', doc: () => doc, getPrivateKey: async () => privateKey, peerId,
    fetchImpl, setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t }, clearTimer: (t) => { t.cleared = true },
    minMs: 60_000, capMs: 30 * 60 * 1000, random: () => 1, ...extra,
  }
  return { doc, fetchImpl, timers, opts, peerId }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('demand-driven polling', () => {
  it('no request: no publish, no poll, no timer', async () => {
    const { opts, fetchImpl, timers } = await harness()
    const c = startDemandRendezvousClient(opts)
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
    expect(c.demand()).toBe(0)
    c.stop()
  })

  it('a request publishes and polls at once, then backs off 60s -> 120s -> 240s ... capped at 30 min', async () => {
    const { opts, fetchImpl, timers } = await harness()
    const c = startDemandRendezvousClient(opts)
    c.request('peer-b')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    expect(timers.map((t) => t.ms)).toEqual([60_000])
    const delays = []
    for (let i = 0; i < 8; i++) {
      timers.at(-1).fn()
      await vi.waitFor(() => expect(timers).toHaveLength(i + 2))
      delays.push(timers.at(-1).ms)
    }
    expect(delays).toEqual([120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000])
    c.stop()
  })

  it('jitter keeps each delay within 75-100% of the nominal backoff', async () => {
    const { opts, timers } = await harness({ random: () => 0 })
    const c = startDemandRendezvousClient(opts)
    c.request('peer-b')
    await flush()
    expect(timers[0].ms).toBe(45_000)
    c.stop()
  })

  it('releasing the only wanted peer stops the polling; a pending timer firing later does nothing', async () => {
    const { opts, fetchImpl, timers } = await harness()
    const c = startDemandRendezvousClient(opts)
    c.request('peer-b')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    c.release('peer-b')
    expect(timers[0].cleared).toBe(true)
    timers[0].fn()
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(1)
    c.stop()
  })

  it('a second wanted peer does not restart or double the polling; polling continues until the last release', async () => {
    const { opts, fetchImpl } = await harness()
    const c = startDemandRendezvousClient(opts)
    c.request('peer-b')
    c.request('peer-c')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    c.release('peer-b')
    expect(c.demand()).toBe(1)
    c.release('peer-c')
    expect(c.demand()).toBe(0)
    c.stop()
  })
})

describe('rendezvous record addresses', () => {
  it('publicRecordAddresses keeps public udp multiaddrs and drops private, LAN, loopback, CGNAT, malformed', () => {
    expect(publicRecordAddresses([
      '/ip4/9.9.9.9/udp/50001', '/ip4/8.8.8.8/udp/4000', '/ip6/2606:4700::1111/udp/5000',
      '/ip4/192.168.1.5/udp/4000', '/ip4/10.0.0.2/udp/4000', '/ip4/127.0.0.1/udp/4000', '/ip4/100.64.0.1/udp/4000',
      '/ip6/fe80::1/udp/4000', '/ip6/::1/udp/4000', '/ip4/8.8.8.8/tcp/4000', 'garbage', 42, null,
    ])).toEqual(['/ip4/9.9.9.9/udp/50001', '/ip4/8.8.8.8/udp/4000', '/ip6/2606:4700::1111/udp/5000'])
  })

  it('the published, signed record carries this device\'s public reflexive addresses and none of its private ones', async () => {
    const { opts, fetchImpl, doc } = await harness()
    const handle = startRendezvousClient({
      ...opts, intervalMs: 0,
      getAddresses: () => ['/ip4/9.9.9.9/udp/50001', '/ip4/192.168.1.5/udp/4000', '/ip4/127.0.0.1/udp/9'],
    })
    await handle.tick()
    const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')
    const bytes = Buffer.from(JSON.parse(post[1].body).record, 'base64')
    const verdict = verify(bytes, { addressKey: readRendezvousAddressKey(doc, 'camp-1'), now: Date.now() })
    expect(verdict.ok).toBe(true)
    expect(verdict.record.addresses).toEqual(['/ip4/9.9.9.9/udp/50001'])
    handle.stop()
  })

  it('with no address source the record still publishes an empty list', async () => {
    const { opts, fetchImpl, doc } = await harness()
    const handle = startRendezvousClient({ ...opts, intervalMs: 0 })
    await handle.tick()
    const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')
    const verdict = verify(Buffer.from(JSON.parse(post[1].body).record, 'base64'), { addressKey: readRendezvousAddressKey(doc, 'camp-1'), now: Date.now() })
    expect(verdict.record.addresses).toEqual([])
    handle.stop()
  })
})

describe('queued demand before discovery start', () => {
  it('a request made before the handle exists is replayed on attach, not dropped', () => {
    const demand = createQueuedDemand()
    demand.request('peer-b')
    demand.request('peer-c')
    demand.release('peer-c')
    const handle = { request: vi.fn(), release: vi.fn() }
    demand.attach(handle)
    expect(handle.request.mock.calls).toEqual([['peer-b']])
    demand.request('peer-d')
    demand.release('peer-b')
    expect(handle.request).toHaveBeenLastCalledWith('peer-d')
    expect(handle.release).toHaveBeenCalledWith('peer-b')
  })
})
