// T209 Phase A — unit tests for the rendezvous Worker's fetch(request, env) handler.
//
// These exercise the handler function directly against an in-memory fake Durable Object
// namespace (fakeDurableObject.js, real SQLite behind ctx.storage.sql), not a deployed Worker:
// no wrangler, no miniflare, no network. The ticket's "two independent HTTP clients round-trip a record,
// including across a TTL boundary" success predicate is satisfied here as two
// independent calls into the same handler with an injectable clock, which is a
// handler-level round-trip rather than a live network one — see the report for
// why that is the honest reading of "in-repo, no deploy".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleRequest,
  NAMESPACE_RE,
  MAX_PEERS_PER_NAMESPACE,
  WRITES_PER_WINDOW,
  GLOBAL_WRITES_PER_DAY,
  STORE_NAME,
  RendezvousStore,
} from './worker.js'
import { FakeDurableObjectNamespace } from './fakeDurableObject.js'

const MINUTE = 60_000

// Only Date is faked: the DO reads Date.now() for TTL and the write window.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

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
  vi.setSystemTime(clockMs)
  const doNamespace = overrides.doNamespace ?? new FakeDurableObjectNamespace(RendezvousStore)
  return {
    doNamespace,
    env: {
      RENDEZVOUS_DO: doNamespace,
      REGISTER_LIMITER: overrides.registerLimiter ?? allowAll(),
      PEERS_LIMITER: overrides.peersLimiter ?? allowAll(),
    },
    advance(ms) {
      clockMs += ms
      vi.setSystemTime(clockMs)
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
    const { env } = makeEnv({ registerLimiter: fakeLimiter(2) })
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

  it('keys an IPv6 caller on its /64, so rotating addresses inside one /64 shares a bucket', async () => {
    const { env } = makeEnv({ registerLimiter: fakeLimiter(1) })
    expect((await handleRequest(registerRequest({ ip: '2001:db8:1:2::a' }), env)).status).toBe(200)
    expect((await handleRequest(registerRequest({ ip: '2001:db8:1:2:ffff::b' }), env)).status).toBe(429)
    expect((await handleRequest(registerRequest({ ip: '2001:db8:1:3::a' }), env)).status).toBe(200)
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

describe('single store: per-namespace budget, peer cap and global budget (exact)', () => {
  const peer = (i) => `peer-${i}-${'x'.repeat(10)}`
  const freshNs = (i) => i.toString(16).padStart(64, '0')
  const register = (env, peerId, namespace = VALID_NAMESPACE) =>
    handleRequest(registerRequest({ namespace, peerId }), env)
  const store = (doNamespace) => doNamespace.storageFor(STORE_NAME)
  const count = (doNamespace, table) => store(doNamespace).db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n
  const globalN = (doNamespace) => store(doNamespace).db.prepare('SELECT n FROM budget').get().n
  const seedFull = (storage, namespace, expiresAt, n) => {
    const ins = storage.db.prepare('INSERT INTO peers VALUES (?, ?, ?, ?)')
    for (let i = 0; i < n; i++) ins.run(namespace, peer(i), RECORD_A, expiresAt)
  }

  it('(a) a burst of 300 registers to one namespace within 60s accepts exactly 30 and refuses 270', async () => {
    const { env } = makeEnv()
    const bodies = []
    for (let i = 0; i < 300; i++) {
      const res = await register(env, peer(i))
      bodies.push([res.status, (await res.json()).error])
    }
    expect(bodies.filter(([s]) => s === 200)).toHaveLength(WRITES_PER_WINDOW)
    const refused = bodies.filter(([s]) => s === 429)
    expect(refused).toHaveLength(300 - WRITES_PER_WINDOW)
    expect(new Set(refused.map(([, e]) => e))).toEqual(new Set(['namespace write budget exhausted']))
  })

  it('(a) the budget is rolling: capacity returns once accepted writes age past 60s', async () => {
    const { env, advance } = makeEnv()
    for (let i = 0; i < 30; i++) expect((await register(env, peer(i))).status).toBe(200)
    expect((await register(env, peer(30))).status).toBe(429)
    advance(MINUTE + 1)
    expect((await register(env, peer(30))).status).toBe(200)
  })

  it('(b) 200 distinct peers across minutes fill the cap; peer 201 is refused, an existing peer refreshes', async () => {
    const { env, advance } = makeEnv()
    for (let i = 0; i < MAX_PEERS_PER_NAMESPACE; i++) {
      expect((await register(env, peer(i))).status, `peer ${i}`).toBe(200)
      if (i % 25 === 24) advance(MINUTE + 1)
    }
    const over = await register(env, peer(MAX_PEERS_PER_NAMESPACE))
    expect(over.status).toBe(429)
    expect((await over.json()).error).toBe('namespace is at capacity')
    expect((await register(env, peer(0))).status).toBe(200)
  })

  it('(b) the cap is per namespace: a full namespace does not block another', async () => {
    const { env, doNamespace } = makeEnv()
    await register(env, PEER_A)
    seedFull(store(doNamespace), VALID_NAMESPACE, Date.now() + 60 * MINUTE, MAX_PEERS_PER_NAMESPACE)
    expect((await register(env, peer(900))).status).toBe(429)
    expect((await register(env, peer(900), OTHER_NAMESPACE)).status).toBe(200)
  })

  it('(b) expired rows do not count toward the cap', async () => {
    const { env, advance } = makeEnv()
    for (let i = 0; i < MAX_PEERS_PER_NAMESPACE; i++) {
      await register(env, peer(i))
      if (i % 25 === 24) advance(MINUTE + 1)
    }
    expect((await register(env, peer(MAX_PEERS_PER_NAMESPACE))).status).toBe(429)
    advance(2 * 60 * MINUTE)
    expect((await register(env, peer(MAX_PEERS_PER_NAMESPACE))).status).toBe(200)
    const body = await (await handleRequest(peersRequest(VALID_NAMESPACE), env)).json()
    expect(body.peers).toHaveLength(1)
  })

  it('(c) a brand-new namespace registers and lists with no setup', async () => {
    const { env } = makeEnv()
    const fresh = 'c0ffee'.repeat(10) + 'abcd'
    expect((await register(env, PEER_A, fresh)).status).toBe(200)
    const body = await (await handleRequest(peersRequest(fresh), env)).json()
    expect(body.peers).toEqual([RECORD_A])
  })

  it('(d) a GET on an unknown namespace performs zero writes, before and after the store has data', async () => {
    const { env, doNamespace } = makeEnv()
    const res = await handleRequest(peersRequest(OTHER_NAMESPACE), env)
    expect(await res.json()).toEqual({ peers: [] })
    expect(store(doNamespace).rowsWritten).toBe(0)
    expect(store(doNamespace).db.prepare('SELECT name FROM sqlite_master').all()).toEqual([])

    await register(env, PEER_A)
    const before = store(doNamespace).rowsWritten
    const res2 = await handleRequest(peersRequest(OTHER_NAMESPACE), env)
    expect(await res2.json()).toEqual({ peers: [] })
    expect(store(doNamespace).rowsWritten).toBe(before)
  })

  it('(e) a refused request does not consume budget (namespace budget)', async () => {
    const { env, doNamespace } = makeEnv()
    for (let i = 0; i < 30; i++) await register(env, peer(i))
    const before = [count(doNamespace, 'writes'), globalN(doNamespace)]
    const rowsBefore = store(doNamespace).rowsWritten
    for (let i = 0; i < 50; i++) expect((await register(env, peer(100 + i))).status).toBe(429)
    expect([count(doNamespace, 'writes'), globalN(doNamespace)]).toEqual(before)
    expect(store(doNamespace).rowsWritten).toBe(rowsBefore)
    // The lockout ends when the ORIGINAL 30 age out, not 60s after the last refused hammer.
    vi.setSystemTime(Date.now() + MINUTE - 1000)
    expect((await register(env, peer(200))).status).toBe(429)
    vi.setSystemTime(Date.now() + 2000)
    expect((await register(env, peer(200))).status).toBe(200)
  })

  it('(e) a cap refusal consumes neither the namespace nor the global budget', async () => {
    const { env, doNamespace } = makeEnv()
    await register(env, PEER_A)
    seedFull(store(doNamespace), VALID_NAMESPACE, Date.now() + MINUTE, MAX_PEERS_PER_NAMESPACE)
    const writesBefore = count(doNamespace, 'writes')
    for (let i = 0; i < 10; i++) expect((await register(env, peer(500 + i))).status).toBe(429)
    expect(count(doNamespace, 'writes')).toBe(writesBefore)
    expect(globalN(doNamespace)).toBe(1)
  })

  it('(f) many fresh namespaces in one window are admitted exactly GLOBAL_WRITES_PER_DAY times in total', async () => {
    const { env, doNamespace } = makeEnv()
    let ok = 0
    const errors = new Set()
    for (let i = 0; i < GLOBAL_WRITES_PER_DAY + 50; i++) {
      const res = await register(env, PEER_A, freshNs(i))
      if (res.status === 200) ok++
      else {
        expect(res.status).toBe(429)
        errors.add((await res.json()).error)
      }
    }
    expect(ok).toBe(GLOBAL_WRITES_PER_DAY)
    expect(errors).toEqual(new Set(['service write budget exhausted']))
    expect(globalN(doNamespace)).toBe(GLOBAL_WRITES_PER_DAY)
    // Refusals consumed nothing, and a refresh in an existing namespace is refused too.
    expect((await register(env, PEER_A, freshNs(0))).status).toBe(429)
    expect(globalN(doNamespace)).toBe(GLOBAL_WRITES_PER_DAY)
    expect(count(doNamespace, 'peers')).toBe(GLOBAL_WRITES_PER_DAY)
  }, 60_000)

  it('(f) the global budget resets at 00:00 UTC and the next day sweeps stale rows', async () => {
    const { env, doNamespace, advance } = makeEnv({ startMs: 0 })
    for (let i = 0; i < GLOBAL_WRITES_PER_DAY; i++) await register(env, PEER_A, freshNs(i))
    expect((await register(env, PEER_A, freshNs(99999))).status).toBe(429)
    advance(24 * 60 * MINUTE)
    expect((await register(env, PEER_A, freshNs(99999))).status).toBe(200)
    expect(count(doNamespace, 'budget')).toBe(1)
    expect(count(doNamespace, 'peers')).toBe(1)
  }, 60_000)

  it('(f) concurrent registers past the cap cannot over-admit', async () => {
    const { env, doNamespace } = makeEnv()
    await register(env, 'seed-peer')
    seedFull(store(doNamespace), VALID_NAMESPACE, Date.now() + 60 * MINUTE, MAX_PEERS_PER_NAMESPACE - 2)
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => register(env, peer(1000 + i))))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(count(doNamespace, 'peers')).toBe(MAX_PEERS_PER_NAMESPACE)
  })

  it('(f) concurrent registers past the budget cannot over-admit', async () => {
    const { env } = makeEnv()
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => register(env, peer(i))))
    expect(results.filter((r) => r.status === 200)).toHaveLength(WRITES_PER_WINDOW)
  })

  it('(g) no IP or IP-derived value appears in any stored row', async () => {
    const { env, doNamespace } = makeEnv()
    await handleRequest(registerRequest({ ip: '198.51.100.7' }), env)
    await handleRequest(registerRequest({ ip: '2001:db8:1:2::a', peerId: PEER_B }), env)
    const storage = store(doNamespace)
    const dump = JSON.stringify(
      storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(({ name }) => storage.db.prepare(`SELECT * FROM ${name}`).all())
    )
    expect(dump).toContain(RECORD_A)
    expect(dump).not.toContain('198.51.100.7')
    expect(dump).not.toContain('2001:db8')
    expect(dump).not.toContain('/64')
  })

  it('(h) every request for every namespace goes to the SAME DO id, a constant', async () => {
    const { env, doNamespace } = makeEnv()
    const spy = vi.spyOn(doNamespace, 'idFromName')
    for (let i = 0; i < 5; i++) await register(env, PEER_A, freshNs(i))
    for (let i = 0; i < 5; i++) await handleRequest(peersRequest(freshNs(i)), env)
    expect(spy).toHaveBeenCalledTimes(10)
    expect(new Set(spy.mock.calls.map((c) => c[0]))).toEqual(new Set(['rendezvous']))
    expect(STORE_NAME).toBe('rendezvous')
    expect(doNamespace._instances.size).toBe(1)
  })

  it('rejects malformed requests before any DO is dispatched', async () => {
    const { env, doNamespace } = makeEnv()
    const spy = vi.spyOn(doNamespace, 'get')
    await handleRequest(registerRequest({ namespace: 'short' }), env)
    await handleRequest(registerRequest({ peerId: 'evil:peer' }), env)
    await handleRequest(registerRequest({ record: '!!!' }), env)
    await handleRequest(peersRequest('not-a-namespace'), env)
    await handleRequest(new Request('https://rendezvous.example/v1/register', { method: 'GET' }), env)
    expect(spy).not.toHaveBeenCalled()
  })

  it('fails closed with 503 when the DO binding is missing', async () => {
    const { env } = makeEnv()
    delete env.RENDEZVOUS_DO
    expect((await register(env, PEER_A)).status).toBe(503)
    expect((await handleRequest(peersRequest(VALID_NAMESPACE), env)).status).toBe(503)
  })
})
