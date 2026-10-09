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
// client's (epoch, seq) watermark does that (see the ADR's "Verifier-side watermark"). Ordering is
// not this Worker's job. Do not add sorting, deduping, or "latest wins" logic here later.
//
// STORAGE: ONE Durable Object instance for the whole service (RendezvousStore, bound as
// RENDEZVOUS_DO, always addressed by idFromName(STORE_NAME) -- a constant, never derived from the
// namespace). Every namespace is rows in that one SQLite database. Owner ruling, 2026-10-09: "i do
// not want each camp getting their own storage. this is a tiny relay service". One Worker, one
// store, nothing per camp. See docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md
// (Amendment 2026-10-09 (owner): single store).
//
// WHAT HOLDS, AND WHAT DOES NOT:
//   - EXACT, per namespace: MAX_PEERS_PER_NAMESPACE (200 unexpired distinct peers) and
//     WRITES_PER_WINDOW (30 accepted registers per rolling 60s).
//   - EXACT, whole service: GLOBAL_WRITES_PER_DAY accepted registers per UTC day, one counter row
//     updated in place. Sized from the Free plan's 100k rows-written/day (see the README).
//   - All three are enforced inside the single DO, whose SQL section runs without yielding, so
//     concurrent registers cannot over-admit. Refused requests do not count against any budget and
//     perform no write. No IP and no IP-derived value is stored anywhere.
//   - BEST-EFFORT only: the per-IP throttle (REGISTER_LIMITER / PEERS_LIMITER). Cloudflare documents
//     the binding as permissive, eventually consistent and counted per location, so it has NO
//     guaranteed bound. It runs before dispatch. A missing or failing binding fails CLOSED (503).
//     The IP is the limiter key only and is never logged or stored.
//   - ACCEPTED RESIDUAL (owner posture call 2026-10-09: stay on the Free plan): because the IP
//     throttle is best-effort, a stranger can exhaust the GLOBAL budget, and rung 3 is then down for
//     EVERY camp until 00:00 UTC. The global budget bounds the damage to that window (and to the
//     Free-plan quota); it does not prevent it. Impact is availability of this last-resort
//     rendezvous only.
//
// ALSO NOT DEFENDED, AND WHAT THE OWNER MUST CONFIGURE AT DEPLOY TIME (an owner action outside
// this ticket — see workers/rendezvous/README.md):
//   - Write-amplification / DoS on the unauthenticated endpoints: bounded per namespace and per service as above;
//     the cross-namespace case is the accepted residual above.
//   - Namespace enumeration. The namespace is a 256-bit value minted at trusted setup and is
//     unguessable by construction (see the ADR); this Worker deliberately exposes no endpoint that
//     lists namespaces, and `GET /v1/peers/<namespace>` returns nothing useful without already
//     knowing one. It cannot stop someone who already has a namespace (e.g. a departed staffer) from
//     continuing to read/write it until the owner rotates it (T210 Decision 3) or the TTL expires.
//   - Lockout via the per-namespace cap. MAX_PEERS_PER_NAMESPACE is a fixed cap on distinct peer
//     ids per namespace, and it is a lockout primitive, not just an abuse bound: anyone who knows
//     the namespace can register up to the cap in fabricated peer ids. Already-registered peers
//     keep refreshing without limit (re-registering an existing peer id is exempt from the cap —
//     see RendezvousStore.register), but a NEW legitimate device (e.g. a re-imaged staff laptop) that has
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
// value a safe identifier, not to validate that it is a well-formed multihash — that is a
// client-side concern (peerIdFromString would already reject a bad one).
const PEER_ID_RE = /^[A-Za-z0-9+/=_-]{1,256}$/
const RECORD_B64_RE = /^[A-Za-z0-9+/=]+$/

const TTL_SECONDS = 2 * 60 * 60 // ~2h, per the ticket and spec
const MAX_RECORD_B64_BYTES = 8 * 1024 // generous headroom over a real signed record (~600 bytes)
export const MAX_PEERS_PER_NAMESPACE = 200 // abuse bound: caps both write-amplification and GET response size
export const WRITES_PER_WINDOW = 30 // accepted registers per namespace per rolling WRITE_WINDOW_MS
// Whole-service accepted registers per UTC day. Worst case 11 rows written per accepted register
// (README "Sizing"): 7000 x 11 = 77,000 rows/day, under ~80k of the Free plan's 100k.
export const GLOBAL_WRITES_PER_DAY = 7000
export const STORE_NAME = 'rendezvous'
const DAY_MS = 24 * 60 * 60 * 1000
const WRITE_WINDOW_MS = 60 * 1000
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

async function handleRegister(request, env) {
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

  return dispatch(env, 'register', 'POST', { namespace, peerId, record })
}

function dispatch(env, op, method, payload) {
  const binding = env.RENDEZVOUS_DO
  if (!binding || typeof binding.idFromName !== 'function') return json(503, { error: 'unavailable' })
  const stub = binding.get(binding.idFromName(STORE_NAME))
  // A fresh Request carrying only the validated fields: no headers, so no IP can reach the DO.
  return stub.fetch(
    new Request(`https://rendezvous.internal/${op}`, {
      method,
      body: payload ? JSON.stringify(payload) : undefined,
    })
  )
}

function handlePeers(namespace, env) {
  if (!NAMESPACE_RE.test(namespace)) {
    return json(400, { error: 'namespace must be exactly 64 lowercase hex characters' })
  }
  return dispatch(env, `peers/${namespace}`, 'GET')
}

// The single store. Every statement that decides admission runs synchronously
// (ctx.storage.sql.exec does not yield), so there is no await between a check and its write.
// Refused requests return before any write.
export class RendezvousStore {
  constructor(ctx) {
    this.sql = ctx.storage.sql
    this.ready = false
  }

  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/register') return this.register(await request.json())
    return this.peers(pathname.slice('/peers/'.length))
  }

  init() {
    if (this.ready) return
    const sql = this.sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS peers (namespace TEXT NOT NULL, peerId TEXT NOT NULL, record TEXT NOT NULL, expiresAt INTEGER NOT NULL, PRIMARY KEY (namespace, peerId)) WITHOUT ROWID'
    )
    sql.exec('CREATE INDEX IF NOT EXISTS peers_expiry ON peers (namespace, expiresAt)')
    sql.exec('CREATE TABLE IF NOT EXISTS writes (namespace TEXT NOT NULL, at INTEGER NOT NULL)')
    sql.exec('CREATE INDEX IF NOT EXISTS writes_at ON writes (namespace, at)')
    sql.exec('CREATE TABLE IF NOT EXISTS budget (day INTEGER PRIMARY KEY, n INTEGER NOT NULL)')
    this.ready = true
  }

  register({ namespace, peerId, record }) {
    this.init()
    const now = Date.now()
    const day = Math.floor(now / DAY_MS)
    const sql = this.sql

    const today = sql.exec('SELECT n FROM budget WHERE day = ?', day).toArray()[0]
    if ((today?.n ?? 0) >= GLOBAL_WRITES_PER_DAY) {
      return json(429, { error: 'service write budget exhausted' })
    }
    const recent = sql
      .exec('SELECT COUNT(*) AS n FROM writes WHERE namespace = ? AND at > ?', namespace, now - WRITE_WINDOW_MS)
      .toArray()[0].n
    if (recent >= WRITES_PER_WINDOW) {
      return json(429, { error: 'namespace write budget exhausted' })
    }
    // Only a NEW peer id counts against the cap -- a peer refreshing its own TTL must not be
    // blocked by the cap it already fits inside of.
    const known = sql.exec('SELECT 1 AS k FROM peers WHERE namespace = ? AND peerId = ? AND expiresAt > ?', namespace, peerId, now).toArray().length > 0
    if (!known) {
      const live = sql.exec('SELECT COUNT(*) AS n FROM peers WHERE namespace = ? AND expiresAt > ?', namespace, now).toArray()[0].n
      if (live >= MAX_PEERS_PER_NAMESPACE) return json(429, { error: 'namespace is at capacity' })
    }

    if (!today) {
      // First accepted write of a UTC day: one full sweep of everything stale, service-wide.
      sql.exec('DELETE FROM peers WHERE expiresAt <= ?', now)
      sql.exec('DELETE FROM writes WHERE at <= ?', now - WRITE_WINDOW_MS)
      sql.exec('DELETE FROM budget WHERE day < ?', day)
    }
    sql.exec('DELETE FROM peers WHERE namespace = ? AND expiresAt <= ?', namespace, now)
    sql.exec('DELETE FROM writes WHERE namespace = ? AND at <= ?', namespace, now - WRITE_WINDOW_MS)
    sql.exec('INSERT INTO writes (namespace, at) VALUES (?, ?)', namespace, now)
    sql.exec(
      'INSERT INTO peers (namespace, peerId, record, expiresAt) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, peerId) DO UPDATE SET record = excluded.record, expiresAt = excluded.expiresAt',
      namespace,
      peerId,
      record,
      now + TTL_SECONDS * 1000
    )
    sql.exec('INSERT INTO budget (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1', day)
    return json(200, { ok: true })
  }

  peers(namespace) {
    const sql = this.sql
    // A store nobody has written to has no tables; answering from this read creates nothing.
    if (sql.exec("SELECT 1 AS k FROM sqlite_master WHERE type = 'table' AND name = 'peers'").toArray().length === 0) {
      return json(200, { peers: [] })
    }
    // No ordering, no dedup, no "latest wins" -- see the file-level comment.
    const rows = sql
      .exec('SELECT record FROM peers WHERE namespace = ? AND expiresAt > ? LIMIT ?', namespace, Date.now(), MAX_PEERS_PER_NAMESPACE)
      .toArray()
    return json(200, { peers: rows.map((r) => r.record) })
  }
}

const PEERS_PATH_RE = /^\/v1\/peers\/([^/]+)$/

// The limiter key for a caller IP. IPv4 is used as-is. IPv6 is reduced to its /64 — one subscriber
// is normally handed a whole /64, so keying on the full address would let a caller rotate into a
// fresh bucket per request. Anything unparseable falls back to the raw string (shares a bucket with
// nobody else, and never widens the limit).
export function limiterKey(ip) {
  if (!ip.includes(':')) return ip
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

// Per-caller throttle via a Workers Rate Limiting binding. Returns a refusal Response, or null to
// proceed. Keyed on the caller IP only — never the namespace or peer id, which an attacker chooses.
async function throttle(limiter, request) {
  if (!limiter || typeof limiter.limit !== 'function') return json(503, { error: 'unavailable' })
  const key = limiterKey(request.headers.get('cf-connecting-ip') || 'unknown')
  let outcome
  try {
    outcome = await limiter.limit({ key })
  } catch {
    return json(503, { error: 'unavailable' })
  }
  return outcome?.success ? null : json(429, { error: 'rate limited' })
}

export async function handleRequest(request, env) {
  const url = new URL(request.url)
  const { pathname } = url

  if (pathname === '/v1/register') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
    const refused = await throttle(env.REGISTER_LIMITER, request)
    if (refused) return refused
    return handleRegister(request, env)
  }

  const peersMatch = PEERS_PATH_RE.exec(pathname)
  if (peersMatch) {
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' })
    const refused = await throttle(env.PEERS_LIMITER, request)
    if (refused) return refused
    return handlePeers(peersMatch[1], env)
  }

  return json(404, { error: 'not found' })
}

export default {
  fetch: handleRequest,
}
