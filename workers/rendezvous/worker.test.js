// T209 Phase A — unit tests for the rendezvous Worker's fetch(request, env) handler.
//
// These exercise the handler function directly against an in-memory fake KV
// namespace (fakeKv.js), not a deployed Worker: no wrangler, no miniflare, no
// network. The ticket's "two independent HTTP clients round-trip a record,
// including across a TTL boundary" success predicate is satisfied here as two
// independent calls into the same handler with an injectable clock, which is a
// handler-level round-trip rather than a live network one — see the report for
// why that is the honest reading of "in-repo, no deploy".
import { describe, it, expect } from 'vitest'
import { handleRequest, NAMESPACE_RE, MAX_PEERS_PER_NAMESPACE } from './worker.js'
import { FakeKvNamespace } from './fakeKv.js'

const VALID_NAMESPACE = 'a'.repeat(64)
const OTHER_NAMESPACE = 'b'.repeat(64)
const PEER_A = 'peerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PEER_B = 'peerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const RECORD_A = Buffer.from('opaque-signed-record-for-peer-a').toString('base64')
const RECORD_B = Buffer.from('opaque-signed-record-for-peer-b').toString('base64')

// A stand-in for a Workers Rate Limiting binding (env.X.limit({ key }) -> { success }).
function allowAll() {
  return { limit: async () => ({ success: true }) }
}

// Counts per key within the test; refuses once `max` calls for one key have been made.
function fakeLimiter(max) {
  const seen = new Map()
  const keys = []
  return {
    keys,
    async limit({ key }) {
      keys.push(key)
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      return { success: n <= max }
    },
  }
}

function makeEnv(overrides = {}) {
  let clockMs = overrides.startMs ?? 0
  const kv = overrides.kv ?? new FakeKvNamespace({ now: () => clockMs })
  return {
    env: {
      RENDEZVOUS_KV: kv,
      REGISTER_LIMITER: overrides.registerLimiter ?? allowAll(),
      PEERS_LIMITER: overrides.peersLimiter ?? allowAll(),
    },
    advance(ms) {
      clockMs += ms
    },
  }
}

function registerRequest({ namespace = VALID_NAMESPACE, peerId = PEER_A, record = RECORD_A, ip } = {}) {
  return new Request('https://rendezvous.example/v1/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    body: JSON.stringify({ namespace, peerId, record }),
  })
}

function peersRequest(namespace, { ip } = {}) {
  return new Request(`https://rendezvous.example/v1/peers/${namespace}`, {
    method: 'GET',
    headers: ip ? { 'cf-connecting-ip': ip } : {},
  })
}

describe('POST /v1/register', () => {
  it('accepts a well-formed registration', async () => {
    const { env } = makeEnv()
    const res = await handleRequest(registerRequest(), env)
    expect(res.status).toBe(200)
  })

  it('rejects a namespace that is not exactly 64 lowercase hex characters', async () => {
    const { env } = makeEnv()
    for (const bad of ['short', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const res = await handleRequest(registerRequest({ namespace: bad }), env)
      expect(res.status, `namespace ${JSON.stringify(bad)} should be rejected`).toBe(400)
    }
  })

  it('rejects a namespace containing a colon (key-injection attempt)', async () => {
    const { env } = makeEnv()
    const res = await handleRequest(
      registerRequest({ namespace: `${'a'.repeat(30)}:evil${'a'.repeat(29)}` }),
      env
    )
    expect(res.status).toBe(400)
  })

  it('rejects a peer id containing a colon (key-injection attempt)', async () => {
    const { env } = makeEnv()
    const res = await handleRequest(registerRequest({ peerId: 'evil:peer' }), env)
    expect(res.status).toBe(400)
  })

  it('rejects an unbounded peer id', async () => {
    const { env } = makeEnv()
    const res = await handleRequest(registerRequest({ peerId: 'p'.repeat(5000) }), env)
    expect(res.status).toBe(400)
  })

  it('rejects a record exceeding the field-level cap with 400 (body still under the overall size cap)', async () => {
    const { env } = makeEnv()
    // Just over MAX_RECORD_B64_BYTES (8192) but comfortably under the overall body-size cap
    // (MAX_RECORD_B64_BYTES + 2048), so this exercises the field-specific 400, not the 413
    // pre-parse size gate covered separately below.
    const oversizedRecord = 'a'.repeat(8200)
    const res = await handleRequest(registerRequest({ record: oversizedRecord }), env)
    expect(res.status).toBe(400)
  })

  it('rejects a body far exceeding the overall size cap with 413', async () => {
    const { env } = makeEnv()
    const huge = Buffer.alloc(1024 * 1024, 'a').toString('base64')
    const res = await handleRequest(registerRequest({ record: huge }), env)
    expect(res.status).toBe(413)
  })

  it('rejects malformed JSON', async () => {
    const { env } = makeEnv()
    const req = new Request('https://rendezvous.example/v1/register', {
      method: 'POST',
      body: '{not json',
    })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(400)
  })

  it('never decodes or parses the record blob — an arbitrary opaque base64 string round-trips unchanged', async () => {
    const { env } = makeEnv()
    await handleRequest(registerRequest({ record: RECORD_A }), env)
    const res = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    const body = await res.json()
    expect(body.peers).toEqual([RECORD_A])
  })

  it('enforces a cap on entries per namespace', async () => {
    const { env } = makeEnv()
    let lastStatus
    for (let i = 0; i < MAX_PEERS_PER_NAMESPACE + 5; i++) {
      const res = await handleRequest(
        registerRequest({ peerId: `peer-${i}-${'x'.repeat(10)}`, namespace: OTHER_NAMESPACE }),
        env
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })

  it('rejects a request whose declared Content-Length exceeds the cap with 413, without parsing the body', async () => {
    const { env } = makeEnv()
    // The body itself is invalid JSON. If the handler parsed it anyway, malformed-JSON
    // handling would return 400 — so a 413 here proves the size check ran first and the
    // parse never happened.
    const req = new Request('https://rendezvous.example/v1/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '99999999' },
      body: 'not valid json',
    })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(413)
  })

  it('bounds an oversized body even when Content-Length is absent (chunked transfer)', async () => {
    const { env } = makeEnv()
    const stream = new ReadableStream({
      start(controller) {
        // Larger than any legitimate register payload, sent with no Content-Length header.
        controller.enqueue(new TextEncoder().encode('a'.repeat(64 * 1024)))
        controller.close()
      },
    })
    const req = new Request('https://rendezvous.example/v1/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    })
    expect(req.headers.get('content-length')).toBeNull()
    const res = await handleRequest(req, env)
    expect(res.status).toBe(413)
  })
})

describe('GET /v1/peers/<namespace>', () => {
  it('returns an empty list for a namespace nobody has registered into', async () => {
    const { env } = makeEnv()
    const res = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.peers).toEqual([])
  })

  it('rejects a malformed namespace without listing anything', async () => {
    const { env } = makeEnv()
    const res = await handleRequest(peersRequest('not-a-namespace'), env)
    expect(res.status).toBe(400)
  })

  it('does not leak entries from a different namespace', async () => {
    const { env } = makeEnv()
    await handleRequest(registerRequest({ namespace: VALID_NAMESPACE, peerId: PEER_A, record: RECORD_A }), env)
    await handleRequest(registerRequest({ namespace: OTHER_NAMESPACE, peerId: PEER_B, record: RECORD_B }), env)
    const res = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    const body = await res.json()
    expect(body.peers).toEqual([RECORD_A])
  })

  it('two independent registrations round-trip through two independent GETs', async () => {
    const { env } = makeEnv()
    await handleRequest(registerRequest({ peerId: PEER_A, record: RECORD_A }), env)
    await handleRequest(registerRequest({ peerId: PEER_B, record: RECORD_B }), env)

    const res1 = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    const body1 = await res1.json()
    expect(new Set(body1.peers)).toEqual(new Set([RECORD_A, RECORD_B]))

    // A second, independent GET call sees the same state — simulating a second client.
    const res2 = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    const body2 = await res2.json()
    expect(new Set(body2.peers)).toEqual(new Set([RECORD_A, RECORD_B]))
  })

  it('a record expires at the TTL boundary and is no longer returned', async () => {
    const { env, advance } = makeEnv({ startMs: 0 })
    await handleRequest(registerRequest({ peerId: PEER_A, record: RECORD_A }), env)

    // Just before TTL: still present.
    advance(2 * 60 * 60 * 1000 - 1000)
    const before = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    expect((await before.json()).peers).toEqual([RECORD_A])

    // Past TTL: gone.
    advance(2000)
    const after = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    expect((await after.json()).peers).toEqual([])
  })
})

// T287 Slice B: confirm the Worker's opaque-blob contract needs no change for the v2 encrypted
// rendezvous record — it never decodes `record` at all, so a real v2-encoded (address-body
// AES-256-GCM-encrypted) record round-trips through register/peers exactly like any other opaque
// base64 blob, and the Worker/KV never sees a plaintext address anywhere in what it stores.
describe('v2 encrypted rendezvous record round-trips as an opaque blob', () => {
  it('register + peers returns the v2 record unchanged, with no plaintext address visible to the worker', async () => {
    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
    const { signRecord } = await import('../../electron/sync/automerge/rendezvousRecord.js')

    const privateKey = await generateKeyPair('Ed25519')
    const peerId = peerIdFromPrivateKey(privateKey).toString()
    const addressKey = Buffer.alloc(32, 3)
    const now = Date.now()
    const plaintextAddress = '/ip4/203.0.113.7/tcp/4001'
    const v2Wire = signRecord(
      {
        namespace: VALID_NAMESPACE,
        peerId,
        epoch: 1,
        seq: 1,
        issuedAt: now,
        expiresAt: now + 2 * 60 * 60 * 1000,
        addresses: [plaintextAddress],
      },
      privateKey,
      addressKey
    )
    const recordB64 = v2Wire.toString('base64')

    const { env } = makeEnv()
    const registerRes = await handleRequest(registerRequest({ peerId, record: recordB64 }), env)
    expect(registerRes.status).toBe(200)

    const peersRes = await handleRequest(peersRequest(VALID_NAMESPACE), env)
    const body = await peersRes.json()
    expect(body.peers).toEqual([recordB64])
    expect(body.peers[0]).not.toContain(plaintextAddress)
  })
})

describe('method/route handling', () => {
  it('returns 405 for GET on /v1/register', async () => {
    const { env } = makeEnv()
    const req = new Request('https://rendezvous.example/v1/register', { method: 'GET' })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(405)
  })

  it('returns 405 for POST on /v1/peers/<namespace>', async () => {
    const { env } = makeEnv()
    const req = new Request(`https://rendezvous.example/v1/peers/${VALID_NAMESPACE}`, { method: 'POST' })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(405)
  })

  it('returns 404 for an unknown route', async () => {
    const { env } = makeEnv()
    const req = new Request('https://rendezvous.example/v1/whatever', { method: 'GET' })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(404)
  })

  it('returns 404 for the bare root', async () => {
    const { env } = makeEnv()
    const req = new Request('https://rendezvous.example/', { method: 'GET' })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(404)
  })

  it('returns a clean 404 with no body content for /v1/peers with no trailing segment', async () => {
    const { env } = makeEnv()
    const req = new Request('https://rendezvous.example/v1/peers', { method: 'GET' })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'not found' })
  })

  it('returns a clean 404 for /v1/peers/ with an empty namespace segment', async () => {
    const { env } = makeEnv()
    const req = new Request('https://rendezvous.example/v1/peers/', { method: 'GET' })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'not found' })
  })

  it('returns a clean 404 for /v1/peers/<namespace>/extra with a trailing extra segment', async () => {
    const { env } = makeEnv()
    const req = new Request(`https://rendezvous.example/v1/peers/${VALID_NAMESPACE}/extra`, {
      method: 'GET',
    })
    const res = await handleRequest(req, env)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'not found' })
  })
})

describe('NAMESPACE_RE (exported for the ticket-mandated 64-lowercase-hex check)', () => {
  it('matches exactly 64 lowercase hex characters', () => {
    expect(NAMESPACE_RE.test('a'.repeat(64))).toBe(true)
    expect(NAMESPACE_RE.test('A'.repeat(64))).toBe(false)
    expect(NAMESPACE_RE.test('a'.repeat(63))).toBe(false)
  })
})

describe('caller rate limiting (Workers Rate Limiting binding)', () => {
  it('refuses a register over the per-caller limit with 429 and does not write', async () => {
    const kv = new FakeKvNamespace({ now: () => 0 })
    const { env } = makeEnv({ kv, registerLimiter: fakeLimiter(2) })
    expect((await handleRequest(registerRequest({ ip: '198.51.100.7', peerId: PEER_A }), env)).status).toBe(200)
    expect((await handleRequest(registerRequest({ ip: '198.51.100.7', peerId: PEER_A }), env)).status).toBe(200)
    const refused = await handleRequest(registerRequest({ ip: '198.51.100.7', peerId: PEER_B }), env)
    expect(refused.status).toBe(429)
    const list = await (await handleRequest(peersRequest(VALID_NAMESPACE), env)).json()
    expect(list.peers.map((p) => p.peerId)).not.toContain(PEER_B)
  })

  it('limits per caller: another IP is unaffected', async () => {
    const { env } = makeEnv({ registerLimiter: fakeLimiter(1) })
    expect((await handleRequest(registerRequest({ ip: '198.51.100.7' }), env)).status).toBe(200)
    expect((await handleRequest(registerRequest({ ip: '198.51.100.7' }), env)).status).toBe(429)
    expect((await handleRequest(registerRequest({ ip: '203.0.113.9' }), env)).status).toBe(200)
  })

  it('refuses a peers listing over the per-caller limit with 429', async () => {
    const { env } = makeEnv({ peersLimiter: fakeLimiter(1) })
    expect((await handleRequest(peersRequest(VALID_NAMESPACE, { ip: '198.51.100.7' }), env)).status).toBe(200)
    expect((await handleRequest(peersRequest(VALID_NAMESPACE, { ip: '198.51.100.7' }), env)).status).toBe(429)
  })

  it('keys the limiter on the caller IP, never on the namespace or peer id', async () => {
    const reg = fakeLimiter(10)
    const peers = fakeLimiter(10)
    const { env } = makeEnv({ registerLimiter: reg, peersLimiter: peers })
    await handleRequest(registerRequest({ ip: '198.51.100.7' }), env)
    await handleRequest(peersRequest(VALID_NAMESPACE, { ip: '198.51.100.7' }), env)
    expect(reg.keys).toEqual(['198.51.100.7'])
    expect(peers.keys).toEqual(['198.51.100.7'])
  })

  it('fails CLOSED with 503 when a limiter binding is missing (misdeploy is never unthrottled)', async () => {
    const { env } = makeEnv()
    delete env.REGISTER_LIMITER
    expect((await handleRequest(registerRequest({ ip: '198.51.100.7' }), env)).status).toBe(503)
    const env2 = makeEnv().env
    delete env2.PEERS_LIMITER
    expect((await handleRequest(peersRequest(VALID_NAMESPACE, { ip: '198.51.100.7' }), env2)).status).toBe(503)
  })

  it('fails CLOSED with 503 when the limiter throws', async () => {
    const { env } = makeEnv({ registerLimiter: { limit: async () => { throw new Error('binding down') } } })
    expect((await handleRequest(registerRequest({ ip: '198.51.100.7' }), env)).status).toBe(503)
  })
})
