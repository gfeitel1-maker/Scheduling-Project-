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
import { handleRequest, NAMESPACE_RE } from './worker.js'
import { FakeKvNamespace } from './fakeKv.js'

const VALID_NAMESPACE = 'a'.repeat(64)
const OTHER_NAMESPACE = 'b'.repeat(64)
const PEER_A = 'peerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PEER_B = 'peerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const RECORD_A = Buffer.from('opaque-signed-record-for-peer-a').toString('base64')
const RECORD_B = Buffer.from('opaque-signed-record-for-peer-b').toString('base64')

function makeEnv(overrides = {}) {
  let clockMs = overrides.startMs ?? 0
  const kv = overrides.kv ?? new FakeKvNamespace({ now: () => clockMs })
  return {
    env: { RENDEZVOUS_KV: kv },
    advance(ms) {
      clockMs += ms
    },
  }
}

function registerRequest({ namespace = VALID_NAMESPACE, peerId = PEER_A, record = RECORD_A } = {}) {
  return new Request('https://rendezvous.example/v1/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace, peerId, record }),
  })
}

function peersRequest(namespace) {
  return new Request(`https://rendezvous.example/v1/peers/${namespace}`, { method: 'GET' })
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

  it('rejects an oversized record blob', async () => {
    const { env } = makeEnv()
    const huge = Buffer.alloc(1024 * 1024, 'a').toString('base64')
    const res = await handleRequest(registerRequest({ record: huge }), env)
    expect(res.status).toBe(400)
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
    const MAX = 200 // must match worker.js's MAX_PEERS_PER_NAMESPACE for this test to be meaningful
    let lastStatus
    for (let i = 0; i < MAX + 5; i++) {
      const res = await handleRequest(
        registerRequest({ peerId: `peer-${i}-${'x'.repeat(10)}`, namespace: OTHER_NAMESPACE }),
        env
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
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
})

describe('NAMESPACE_RE (exported for the ticket-mandated 64-lowercase-hex check)', () => {
  it('matches exactly 64 lowercase hex characters', () => {
    expect(NAMESPACE_RE.test('a'.repeat(64))).toBe(true)
    expect(NAMESPACE_RE.test('A'.repeat(64))).toBe(false)
    expect(NAMESPACE_RE.test('a'.repeat(63))).toBe(false)
  })
})
