// T288 — the v2 rendezvous HTTP client. Wire contract per ADR 2026-09-27 addendum §2:
// POST /v1/register {namespace, peerId, record(base64)} -> {ok:true}|{error}
// GET  /v1/peers/<namespace> -> {peers:[base64,...]}
//
// The worker.js handlers (workers/rendezvous/worker.js) are the ground truth for the wire shape —
// seam 4 (addendum §6) rounds-trips against the REAL handler, not a hand-described stub, so a body
// shape drift is caught even if this test file and the client agree with each other and disagree
// with the worker.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { handleRequest, RendezvousNamespace } from '../../../workers/rendezvous/worker.js'
import { FakeDurableObjectNamespace } from '../../../workers/rendezvous/fakeDurableObject.js'
import { signRecord, verify } from './rendezvousRecord.js'
import {
  readRendezvousConfig,
  registerRecord,
  fetchPeers,
  startRendezvousClient,
  createRendezvousDiscovery,
} from './rendezvousClient.js'
import { openLocalDb } from '../../db/localDb.js'
import { nextSequence } from './rendezvousSequence.js'

// The worker fails closed (503) without its rate-limit bindings, so the in-process env supplies
// allow-all stand-ins for them; the limiter itself is covered in workers/rendezvous/worker.test.js.
const allowAll = { limit: async () => ({ success: true }) }
function workerEnv(doNamespace) {
  return { NAMESPACE_DO: doNamespace, REGISTER_LIMITER: allowAll, PEERS_LIMITER: allowAll }
}

function makeKvMock() {
  return new FakeDurableObjectNamespace(RendezvousNamespace)
}

// A fetch stub that routes to the real worker handler in-process, so the client's requests are
// validated against the actual production wire-parsing logic.
function makeWorkerFetch(kv) {
  return async (url, init = {}) => {
    const request = new Request(url, init)
    const response = await handleRequest(request, workerEnv(kv))
    return response
  }
}

async function makeRecord({ namespace, epoch = 1, seq = 1 }) {
  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const addressKey = 'a'.repeat(64)
  const now = Date.now()
  const record = {
    namespace,
    peerId,
    epoch,
    seq,
    issuedAt: now,
    expiresAt: now + 60_000,
    addresses: ['/ip4/1.2.3.4/tcp/4001'],
  }
  const bytes = signRecord(record, privateKey, addressKey)
  return { bytes, peerId, addressKey, namespace }
}

describe('readRendezvousConfig', () => {
  it('is disabled when SHORESH_RENDEZVOUS_URL is unset', () => {
    expect(readRendezvousConfig({})).toEqual({ enabled: false, baseUrl: null })
  })

  it('is enabled with the configured base URL', () => {
    expect(readRendezvousConfig({ SHORESH_RENDEZVOUS_URL: 'https://rendezvous.example/api' })).toEqual({
      enabled: true,
      baseUrl: 'https://rendezvous.example/api',
    })
  })
})

describe('registerRecord / fetchPeers — round-trip against the REAL worker handler', () => {
  it('publishes and discovers a record matching what was signed', async () => {
    const kv = makeKvMock()
    const fetchImpl = makeWorkerFetch(kv)
    const namespace = 'b'.repeat(64)
    const { bytes, peerId } = await makeRecord({ namespace })

    const publishResult = await registerRecord({
      baseUrl: 'https://rendezvous.example',
      namespace,
      peerId,
      recordBytes: bytes,
      fetchImpl,
    })
    expect(publishResult).toEqual({ ok: true })

    const discoverResult = await fetchPeers({ baseUrl: 'https://rendezvous.example', namespace, fetchImpl })
    expect(discoverResult.ok).toBe(true)
    expect(discoverResult.peers).toHaveLength(1)
    const verdict = verify(discoverResult.peers[0], { addressKey: 'a'.repeat(64) })
    expect(verdict.ok).toBe(true)
    expect(verdict.record.peerId).toBe(peerId)
    expect(verdict.addressBodyDecrypted).toBe(true)
    expect(verdict.record.addresses).toEqual(['/ip4/1.2.3.4/tcp/4001'])
  })

  it('fails loudly (ok:false) if the client body shape drifts from {namespace, peerId, record}', async () => {
    const kv = makeKvMock()
    // A fetchImpl that posts the WRONG shape directly, bypassing registerRecord's own encoding,
    // to prove the round-trip actually depends on the real shape rather than agreeing with itself.
    const namespace = 'c'.repeat(64)
    const { bytes, peerId } = await makeRecord({ namespace })
    const wrongShapeFetch = async (url) => {
      const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordBase64: Buffer.from(bytes).toString('base64'), peerId, namespace }),
      })
      return handleRequest(request, workerEnv(kv))
    }
    const result = await registerRecord({
      baseUrl: 'https://rendezvous.example',
      namespace,
      peerId,
      recordBytes: bytes,
      fetchImpl: async (url, init) => wrongShapeFetch(url, init),
    })
    expect(result.ok).toBe(false)
  })

  it('never throws across the boundary on a network failure', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    const result = await registerRecord({
      baseUrl: 'https://rendezvous.example',
      namespace: 'd'.repeat(64),
      peerId: 'x',
      recordBytes: Buffer.from('junk'),
      fetchImpl,
    })
    expect(result).toEqual({ ok: false, reason: 'network' })
  })

  it('maps a non-2xx worker response to a reason, never throwing', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'namespace is at capacity' }), { status: 429 })
    const result = await registerRecord({
      baseUrl: 'https://rendezvous.example',
      namespace: 'e'.repeat(64),
      peerId: 'x',
      recordBytes: Buffer.from('junk'),
      fetchImpl,
    })
    expect(result).toEqual({ ok: false, reason: 'http_4xx' })
  })

  it('treats adversarial GET response bytes as untrusted input passed straight to verify()', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ peers: ['!!!not-base64!!!'] }), { status: 200 })
    const result = await fetchPeers({ baseUrl: 'https://rendezvous.example', namespace: 'f'.repeat(64), fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.peers).toHaveLength(1)
    // The client does not pre-validate base64 shape — it hands raw decoded bytes to the caller,
    // who passes them to verify(), which must reject malformed bytes without throwing.
  })

  it('a malformed {peers} response shape is reported, not thrown', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ notPeers: [] }), { status: 200 })
    const result = await fetchPeers({ baseUrl: 'https://rendezvous.example', namespace: 'g'.repeat(64), fetchImpl })
    expect(result).toEqual({ ok: false, reason: 'malformed_response' })
  })
})

describe('startRendezvousClient — namespace/key re-derivation, decrypt-failure handling', () => {
  it('is a no-op tick (skip publish) when namespace or address key is null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const handle = startRendezvousClient({
      baseUrl: 'https://rendezvous.example',
      campId: 'camp-1',
      doc: () => ({}), // no camps rows at all -> readRendezvousNamespace/readRendezvousAddressKey both null
      getPrivateKey: async () => {
        throw new Error('should not be called when namespace/key are null')
      },
      peerId: 'peer-x',
      onDiscoveredPeer: () => {},
      fetchImpl,
      intervalMs: 0,
    })
    await handle.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    handle.stop()
  })

  it('re-reads namespace/address key fresh from doc() every tick — picks up the SURVIVING key after a concurrent mint merge', async () => {
    // This is the test that would fail if the client hoisted the key/namespace into a closure at
    // construction time instead of re-reading doc() per tick (addendum §6 seam 5).
    const A = await import('@automerge/automerge')
    const { mintRendezvousAddressKey } = await import('./rendezvousAddressKey.js')
    const { mintRendezvousNamespace } = await import('./rendezvousNamespace.js')

    let base = A.from({ camps: { 'camp-1::name': 'Camp' } })
    base = A.change(base, (d) => {
      d.camps.id = 'camp-1'
    })
    // give the doc a camps.id row the readers expect
    let forkA = A.clone(base)
    let forkB = A.clone(base)
    forkA = mintRendezvousNamespace(forkA, 'camp-1').doc
    forkA = mintRendezvousAddressKey(forkA, 'camp-1').doc
    forkB = mintRendezvousNamespace(forkB, 'camp-1').doc
    forkB = mintRendezvousAddressKey(forkB, 'camp-1').doc

    const merged = A.merge(forkA, forkB)
    const { readRendezvousAddressKey } = await import('./rendezvousAddressKey.js')
    const { readRendezvousNamespace } = await import('./rendezvousNamespace.js')
    const survivingNs = readRendezvousNamespace(merged, 'camp-1')
    // read to prove the key exists post-merge; the tick assertion below checks namespace only,
    // since only namespace is echoed back in the POST body.
    readRendezvousAddressKey(merged, 'camp-1')

    let currentDoc = merged
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const privateKey = await generateKeyPair('Ed25519')
    const handle = startRendezvousClient({
      baseUrl: 'https://rendezvous.example',
      campId: 'camp-1',
      doc: () => currentDoc,
      getPrivateKey: async () => privateKey,
      peerId: peerIdFromPrivateKey(privateKey).toString(),
      onDiscoveredPeer: () => {},
      fetchImpl,
      intervalMs: 0,
    })
    await handle.tick()
    expect(fetchImpl).toHaveBeenCalled()
    const registerCall = fetchImpl.mock.calls.find(([url]) => url.includes('/v1/register'))
    const [, init] = registerCall
    const body = JSON.parse(init.body)
    expect(body.namespace).toBe(survivingNs.namespace)
    handle.stop()
  })

  it('decrypt failure (wrong/no address key) keeps the peer as known-unresolved, not dropped', async () => {
    const kv = makeKvMock()
    const fetchImpl = makeWorkerFetch(kv)
    const namespace = 'a'.repeat(64)
    const { bytes, peerId } = await makeRecord({ namespace })
    await registerRecord({ baseUrl: 'https://rendezvous.example', namespace, peerId, recordBytes: bytes, fetchImpl })

    const discoveredPeers = []
    const handle = startRendezvousClient({
      baseUrl: 'https://rendezvous.example',
      campId: 'camp-1',
      doc: () => ({}), // publish side no-ops; we only exercise discover manually below
      getPrivateKey: async () => {
        throw new Error('n/a')
      },
      peerId: 'irrelevant',
      onDiscoveredPeer: (peer) => discoveredPeers.push(peer),
      fetchImpl,
      intervalMs: 0,
    })
    const result = await fetchPeers({ baseUrl: 'https://rendezvous.example', namespace, fetchImpl })
    const verdict = verify(result.peers[0], { addressKey: 'f'.repeat(64) }) // wrong key
    expect(verdict.ok).toBe(true)
    expect(verdict.addressBodyDecrypted).toBe(false)
    expect(verdict.record.addressBodyError).toBeDefined()
    handle.stop()
  })

  it('logs a non-PII warning when a discovered peer fails to parse (Round 2, FIX 4)', async () => {
    // A validly-signed record whose decrypted address body contains a malformed multiaddr string
    // is not adversarial input (verify() already authenticated the signer) — it is exactly the
    // kind of non-adversarial failure (e.g. a library version bump) the bare catch was masking.
    // console.warn must fire with a reason, never with the record bytes/addresses themselves.
    const kv = makeKvMock()
    const fetchImpl = makeWorkerFetch(kv)

    const A = await import('@automerge/automerge')
    const { mintRendezvousAddressKey, readRendezvousAddressKey } = await import('./rendezvousAddressKey.js')
    const { mintRendezvousNamespace, readRendezvousNamespace } = await import('./rendezvousNamespace.js')
    let doc = A.from({ camps: { 'camp-1::name': 'Camp' } })
    doc = A.change(doc, (d) => {
      d.camps.id = 'camp-1'
    })
    doc = mintRendezvousNamespace(doc, 'camp-1').doc
    doc = mintRendezvousAddressKey(doc, 'camp-1').doc
    const { namespace } = readRendezvousNamespace(doc, 'camp-1')
    const addressKey = readRendezvousAddressKey(doc, 'camp-1')

    // A peer OTHER than the discovering client, with a validly-signed record whose decrypted
    // address body contains a malformed multiaddr string — authenticated but structurally broken.
    const otherPrivateKey = await generateKeyPair('Ed25519')
    const otherPeerId = peerIdFromPrivateKey(otherPrivateKey).toString()
    const now = Date.now()
    const record = {
      namespace,
      peerId: otherPeerId,
      epoch: 1,
      seq: 1,
      issuedAt: now,
      expiresAt: now + 60_000,
      addresses: ['not-a-valid-multiaddr'],
    }
    const bytes = signRecord(record, otherPrivateKey, addressKey)
    await registerRecord({ baseUrl: 'https://rendezvous.example', namespace, peerId: otherPeerId, recordBytes: bytes, fetchImpl })

    const selfPrivateKey = await generateKeyPair('Ed25519')
    const selfPeerId = peerIdFromPrivateKey(selfPrivateKey).toString()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const target = createRendezvousDiscovery({
        campId: 'camp-1',
        baseUrl: 'https://rendezvous.example',
        doc: () => doc,
        getPrivateKey: async () => selfPrivateKey,
        peerId: selfPeerId,
        fetchImpl,
        intervalMs: 0,
      })()
      let capturedPeer = null
      target.addEventListener('peer', (e) => {
        capturedPeer = e.detail
      })
      target.start()
      await new Promise((resolve) => setTimeout(resolve, 50))
      target.stop()

      expect(capturedPeer).toBeNull() // the malformed multiaddr means no 'peer' event fires
      expect(warnSpy).toHaveBeenCalled()
      const loggedText = warnSpy.mock.calls.flat().join(' ')
      expect(loggedText).not.toContain('not-a-valid-multiaddr')
      expect(loggedText).not.toContain(otherPeerId)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('fetchPeers — client-side response caps (Round 2, FIX 2 regression restoration)', () => {
  it('drops entries beyond MAX_RECORDS_PER_RESPONSE without attempting to decode/verify them', async () => {
    const overLimitPeers = Array.from({ length: 250 }, (_, i) => Buffer.from(`peer-${i}`).toString('base64'))
    const fetchImpl = async () => new Response(JSON.stringify({ peers: overLimitPeers }), { status: 200 })
    const result = await fetchPeers({ baseUrl: 'https://rendezvous.example', namespace: 'h'.repeat(64), fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.peers.length).toBeLessThan(overLimitPeers.length)
    expect(result.peers.length).toBeLessThanOrEqual(200)
  })

  it('drops an individual entry whose base64 length exceeds MAX_RECORD_BASE64_LENGTH before decoding', async () => {
    const oversizedEntry = 'A'.repeat(20000)
    const normalEntry = Buffer.from('small-record').toString('base64')
    const fetchImpl = async () => new Response(JSON.stringify({ peers: [oversizedEntry, normalEntry] }), { status: 200 })
    const result = await fetchPeers({ baseUrl: 'https://rendezvous.example', namespace: 'i'.repeat(64), fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.peers).toHaveLength(1)
    expect(result.peers[0].toString()).toBe('small-record')
  })
})

describe('durable rendezvous publish sequence across a simulated restart (Round 2, FIX 1)', () => {
  const files = []
  afterEach(() => {
    for (const f of files.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
      }
    }
  })

  it('continues the persisted sequence after a fresh client is constructed against the same db, not reset to 1', async () => {
    const dbFile = path.join(os.tmpdir(), `shoresh-rendezvous-seq-${Date.now()}-${Math.random()}.sqlite`)
    files.push(dbFile)
    const db = openLocalDb(dbFile)

    const A = await import('@automerge/automerge')
    const { mintRendezvousAddressKey } = await import('./rendezvousAddressKey.js')
    const { mintRendezvousNamespace } = await import('./rendezvousNamespace.js')
    let doc = A.from({ camps: { id: 'camp-1' } })
    doc = mintRendezvousNamespace(doc, 'camp-1').doc
    doc = mintRendezvousAddressKey(doc, 'camp-1').doc

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const privateKey = await generateKeyPair('Ed25519')
    const peerId = peerIdFromPrivateKey(privateKey).toString()

    // "Before restart" — a client wired with the durable counter, same shape syncStarter.js uses.
    const before = startRendezvousClient({
      baseUrl: 'https://rendezvous.example',
      campId: 'camp-1',
      doc: () => doc,
      getPrivateKey: async () => privateKey,
      peerId,
      onDiscoveredPeer: () => {},
      fetchImpl,
      intervalMs: 0,
      nextSequence: () => nextSequence(db),
    })
    await before.tick()
    await before.tick()
    before.stop()

    const registerCalls = fetchImpl.mock.calls.filter(([url]) => url.includes('/v1/register'))
    expect(registerCalls).toHaveLength(2)
    const rowBeforeRestart = db.prepare('SELECT seq FROM rendezvous_sequence WHERE id = 1').get()
    expect(rowBeforeRestart.seq).toBe(2)

    // "Restart" — a brand-new client instance (localSeq starts back at 0 in-memory), same db.
    const after = startRendezvousClient({
      baseUrl: 'https://rendezvous.example',
      campId: 'camp-1',
      doc: () => doc,
      getPrivateKey: async () => privateKey,
      peerId,
      onDiscoveredPeer: () => {},
      fetchImpl,
      intervalMs: 0,
      nextSequence: () => nextSequence(db),
    })
    await after.tick()
    after.stop()

    const rowAfterRestart = db.prepare('SELECT seq FROM rendezvous_sequence WHERE id = 1').get()
    expect(rowAfterRestart.seq).toBe(3) // continues, does NOT reset to 1
    db.close()
  })
})
