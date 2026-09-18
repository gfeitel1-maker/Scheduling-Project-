// T209 Phase A — the rendezvous bulletin board.
//
// docs/work/tickets/T209-rendezvous-worker-phase-a.md
// docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md
// docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md
//
// CONTRACT: this Worker treats every stored record as an OPAQUE, already-signed byte blob
// (transported here as a base64 string). It never decodes, parses, or verifies it — all
// verification of the record's signature, freshness, and (epoch, seq) monotonicity happens
// client-side, in rendezvousRecord.js (T210, a different branch). A Cloudflare response must
// never be able to establish trust, so this file has no reason to ever import that module or
// know its shape. Do not "helpfully" start decoding the record here — that is the exact
// boundary this design depends on staying closed.
//
// THE WORKER IS AN UNTRUSTED CACHE, NOT AN AUTHORITY. It does not order entries, does not
// dedupe by content, and does not arbitrate between two records for the same peer id — the
// client's (epoch, seq) watermark does that (see the ADR's "Verifier-side watermark"). KV is
// only eventually consistent across edge PoPs, so `GET /v1/peers/<namespace>` may return a
// stale or forked view; that is expected and is exactly why ordering is not this Worker's job.
// Do not add sorting, deduping, or "latest wins" logic here later.
//
// WHAT THIS DESIGN DOES NOT DEFEND AGAINST, AND WHAT THE OWNER MUST CONFIGURE AT DEPLOY TIME
// (this is an owner action outside this ticket — see workers/rendezvous/README.md):
//   - Write-amplification / DoS on the unauthenticated POST endpoint. This file bounds per-request
//     work (fixed-size validation, a hard cap on entries per namespace, a hard cap on record size),
//     but it does NOT rate-limit by IP or otherwise throttle callers. The owner must configure
//     Cloudflare-side rate limiting and/or a WAF rule in front of this route; there is no code-level
//     substitute for that at the edge.
//   - Namespace enumeration. The namespace is a 256-bit value minted at trusted setup and is
//     unguessable by construction (see the ADR); this Worker deliberately exposes no endpoint that
//     lists namespaces, and `GET /v1/peers/<namespace>` returns nothing useful without already
//     knowing one. It cannot stop someone who already has a namespace (e.g. a departed staffer) from
//     continuing to read/write it until the owner rotates it (T210 Decision 3) or the TTL expires.
//   - Lockout via the per-namespace cap. MAX_PEERS_PER_NAMESPACE is a fixed cap on distinct peer
//     ids per namespace, and it is a lockout primitive, not just an abuse bound: anyone who knows
//     the namespace can register up to the cap in fabricated peer ids. Already-registered peers
//     keep refreshing without limit (re-registering an existing peer id is exempt from the cap —
//     see handleRegister), but a NEW legitimate device (e.g. a re-imaged staff laptop) that has
//     not registered yet is then permanently refused with 429 until the owner rotates the
//     namespace (T210) or an existing entry's TTL expires and frees a slot. Namespace rotation
//     (T210 Decision 3) closes this by invalidating the attacker's knowledge of the namespace;
//     lowering MAX_PEERS_PER_NAMESPACE does not close it — it only changes how many fabricated
//     registrations the attack needs, and is a product question (how many devices a camp legitimately
//     runs) rather than a security fix. Do not "fix" this finding by silently lowering the constant.
//   - Traffic analysis. Cloudflare's own request logs (source IP, path, timing) are outside this
//     Worker's control and, per the spec, outlive the ~2h record TTL. This file does not log request
//     bodies, IPs, namespaces, or peer ids anywhere (see the LOGGING note below) — but the owner is
//     responsible for setting Cloudflare's account-level log retention short, and for not enabling
//     any logging integration (e.g. Logpush) that would defeat that.
//
// LOGGING POSTURE: this bulletin board is a live, refreshed register of the public IP addresses of
// staff laptops at children's camps (see spec §2.3, "Privacy is a first-class finding"). This file
// therefore never logs a request body, IP, namespace, or peer id — there is no console.log/error
// call in this module at all. The owner must additionally disable or minimize Cloudflare's own
// edge request logging for this route (Workers Logs / Logpush are opt-in Cloudflare features, not
// something this source file can turn off from inside the sandbox) — see the README.

export const NAMESPACE_RE = /^[0-9a-f]{64}$/
// libp2p peer ids are base58btc (Bitcoin alphabet) or base36, typically ~46-53 characters for the
// Ed25519 identity multihashes this system uses. The character class below is deliberately generous
// (base58/base64-safe, no ':') rather than a strict base58 check: the Worker's job is to keep the
// value safe as a KV key component, not to validate that it is a well-formed multihash — that is a
// client-side concern (peerIdFromString would already reject a bad one).
const PEER_ID_RE = /^[A-Za-z0-9+/=_-]{1,256}$/
const RECORD_B64_RE = /^[A-Za-z0-9+/=]+$/

const KEY_PREFIX = 'shoresh:rendezvous'
const TTL_SECONDS = 2 * 60 * 60 // ~2h, per the ticket and spec
const MAX_RECORD_B64_BYTES = 8 * 1024 // generous headroom over a real signed record (~600 bytes)
export const MAX_PEERS_PER_NAMESPACE = 200 // abuse bound: caps both write-amplification and GET response size
// Headroom over MAX_RECORD_B64_BYTES for the surrounding JSON structure (namespace, peerId,
// field names, quoting). This is the cap the register endpoint enforces BEFORE parsing the
// body at all, via Content-Length when present and via a manual byte count on the stream when
// it is not (a chunked request has no Content-Length header to trust).
const MAX_BODY_BYTES = MAX_RECORD_B64_BYTES + 2048

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function kvKey(namespace, peerId) {
  return `${KEY_PREFIX}:${namespace}:${peerId}`
}

// Reads the request body as text while enforcing maxBytes, rejecting BEFORE the full body is
// buffered — a Content-Length over the cap is rejected without reading the stream at all; when
// Content-Length is absent (a chunked request has none), the stream is read incrementally and
// aborted the moment the running total crosses the cap.
async function readBoundedBody(request, maxBytes) {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isFinite(length) || length > maxBytes) {
      return { tooLarge: true }
    }
  }

  const reader = request.body.getReader()
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      return { tooLarge: true }
    }
    chunks.push(value)
  }

  const buffer = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(buffer) }
}

async function handleRegister(request, kv) {
  const body = await readBoundedBody(request, MAX_BODY_BYTES)
  if (body.tooLarge) {
    return json(413, { error: 'request body too large' })
  }

  let payload
  try {
    payload = JSON.parse(body.text)
  } catch {
    return json(400, { error: 'malformed JSON body' })
  }

  if (payload === null || typeof payload !== 'object') {
    return json(400, { error: 'body must be a JSON object' })
  }

  const { namespace, peerId, record } = payload

  if (typeof namespace !== 'string' || !NAMESPACE_RE.test(namespace)) {
    return json(400, { error: 'namespace must be exactly 64 lowercase hex characters' })
  }
  if (typeof peerId !== 'string' || !PEER_ID_RE.test(peerId)) {
    return json(400, { error: 'peerId is missing, too long, or contains an invalid character' })
  }
  if (typeof record !== 'string' || record.length === 0) {
    return json(400, { error: 'record must be a non-empty base64 string' })
  }
  if (record.length > MAX_RECORD_B64_BYTES) {
    return json(400, { error: 'record exceeds the maximum size' })
  }
  if (!RECORD_B64_RE.test(record)) {
    return json(400, { error: 'record must be base64-encoded' })
  }

  const key = kvKey(namespace, peerId)
  const nsPrefix = `${KEY_PREFIX}:${namespace}:`
  const existing = await kv.get(key)
  if (existing === null) {
    // Only a NEW peer id in this namespace counts against the cap — a peer re-registering
    // (refreshing its own TTL) must not be blocked by the cap it already fits inside of.
    const { keys } = await kv.list({ prefix: nsPrefix, limit: MAX_PEERS_PER_NAMESPACE })
    if (keys.length >= MAX_PEERS_PER_NAMESPACE) {
      return json(429, { error: 'namespace is at capacity' })
    }
  }

  await kv.put(key, record, { expirationTtl: TTL_SECONDS })
  return json(200, { ok: true })
}

async function handlePeers(namespace, kv) {
  if (!NAMESPACE_RE.test(namespace)) {
    return json(400, { error: 'namespace must be exactly 64 lowercase hex characters' })
  }

  const nsPrefix = `${KEY_PREFIX}:${namespace}:`
  const { keys } = await kv.list({ prefix: nsPrefix, limit: MAX_PEERS_PER_NAMESPACE })

  // No ordering, no dedup, no "latest wins" — see the file-level comment. Just the raw opaque
  // blobs currently live under this namespace, capped defensively at MAX_PEERS_PER_NAMESPACE.
  const peers = []
  for (const { name } of keys) {
    const value = await kv.get(name)
    if (value !== null) peers.push(value)
  }
  return json(200, { peers })
}

const PEERS_PATH_RE = /^\/v1\/peers\/([^/]+)$/

export async function handleRequest(request, env) {
  const url = new URL(request.url)
  const { pathname } = url

  if (pathname === '/v1/register') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
    return handleRegister(request, env.RENDEZVOUS_KV)
  }

  const peersMatch = PEERS_PATH_RE.exec(pathname)
  if (peersMatch) {
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' })
    return handlePeers(peersMatch[1], env.RENDEZVOUS_KV)
  }

  return json(404, { error: 'not found' })
}

export default {
  fetch: handleRequest,
}
