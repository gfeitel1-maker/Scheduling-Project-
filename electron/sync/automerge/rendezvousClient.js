// T288 — the v2 rendezvous HTTP client.
// docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, "Addendum 2026-09-28 (Architect,
// T288)" §2-3. docs/work/tickets/T288-rendezvous-client-v2.md.
//
// This is the ONLY file authorized to perform its own network egress under the `discovery`
// capability (transportCapabilities.js — TRANSPORT_CAPABILITIES.discovery.egressAllowlist), and
// this authorization is enforced mechanically by transportBoundary.guard.test.js, by exact
// basename, not by import relationship.
//
// Wire contract, field-for-field against workers/rendezvous/worker.js (the ground truth):
//   POST {baseUrl}/v1/register  body: {namespace, peerId, record(base64)}  -> {ok:true} | {error}
//   GET  {baseUrl}/v1/peers/<namespace>                                    -> {peers:[base64,...]}
//
// Never throws across its own boundary. Every method returns {ok:true, ...} or
// {ok:false, reason: 'network'|'http_4xx'|'http_5xx'|'malformed_response'|'unknown'}.
//
// Trust boundary: the Worker is "an untrusted cache, not an authority" (its own header comment).
// This client base64-decodes each GET /v1/peers entry and hands the raw bytes straight to the
// caller (who passes them to rendezvousRecord.verify(), the only place trust is established) — it
// never pre-validates or filters on content, and never treats peers.length===0 vs >0 as a trust
// signal (the Worker is an untrusted cache; an empty list proves nothing about the peer).
import { readRendezvousNamespace } from './rendezvousNamespace.js'
import { readRendezvousAddressKey } from './rendezvousAddressKey.js'

export function readRendezvousConfig(env) {
  const baseUrl = env?.SHORESH_RENDEZVOUS_URL
  if (!baseUrl) return { enabled: false, baseUrl: null }
  return { enabled: true, baseUrl }
}

// Client-side DoS protection against a flooded/hostile/hijacked worker (the worker is untrusted
// by design — see the header comment). Mirrors the worker's own MAX_PEERS_PER_NAMESPACE cap so a
// response cannot make the client do more decode/verify work than the worker itself allows to
// accumulate. Applied BEFORE decode/verify, restored after the v2 rewrite dropped the v1 client's
// equivalent caps (Round 2 FIX 2).
const MAX_RECORDS_PER_RESPONSE = 200
const MAX_RECORD_BASE64_LENGTH = 8192

function classifyHttpStatus(status) {
  if (status >= 400 && status < 500) return 'http_4xx'
  if (status >= 500) return 'http_5xx'
  return null
}

/**
 * POST a signed record (already-produced wire bytes from rendezvousRecord.signRecord) to the
 * Worker. Idempotent: re-publishing the same or a fresher record simply overwrites the Worker's
 * Durable Object entry for (namespace, peerId) — see the addendum's org-interface-contracts note.
 */
export async function registerRecord({ baseUrl, namespace, peerId, recordBytes, fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(`${baseUrl}/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        namespace,
        peerId,
        record: Buffer.from(recordBytes).toString('base64'),
      }),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (response.status === 200) return { ok: true }
  const reason = classifyHttpStatus(response.status)
  return { ok: false, reason: reason ?? 'unknown' }
}

/**
 * GET the raw (still base64-encoded) peer records for a namespace, decoded to bytes. Does NOT
 * verify anything — the caller passes each entry to rendezvousRecord.verify(). Adversarial input
 * from an untrusted cache; passed straight through.
 */
export async function fetchPeers({ baseUrl, namespace, fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(`${baseUrl}/v1/peers/${namespace}`, { method: 'GET' })
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (response.status !== 200) {
    const reason = classifyHttpStatus(response.status)
    return { ok: false, reason: reason ?? 'unknown' }
  }

  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'malformed_response' }
  }
  if (!body || !Array.isArray(body.peers)) return { ok: false, reason: 'malformed_response' }

  const bounded = body.peers.slice(0, MAX_RECORDS_PER_RESPONSE).filter((b64) => typeof b64 === 'string' && b64.length <= MAX_RECORD_BASE64_LENGTH)
  const peers = bounded.map((b64) => {
    try {
      return Buffer.from(b64, 'base64')
    } catch {
      return Buffer.alloc(0)
    }
  })
  return { ok: true, peers }
}

/**
 * Drive a publish/discover loop. `doc` is a LIVE accessor (e.g. liveDoc.js's getDocIfLoaded),
 * called fresh on every tick — never captured once. A null namespace/address key (rendezvous not
 * yet enabled for this camp) makes a tick a no-op: skip publish, retry next tick, not an error
 * (addendum §3 point 2).
 *
 * `onDiscoveredPeer({id, multiaddrs})` mirrors transport.js's onPeerDiscovery shape exactly, so
 * the caller (syncStarter.js) can feed it into the same path mDNS discovery already uses.
 *
 * A decrypt failure (wrong/absent address key) is NOT treated as rejection: the peer is
 * authentically who it claims (signature/freshness/monotonicity all passed) and is handed to
 * onDiscoveredPeer as "known but unresolved" via its own addresses being absent — the caller
 * decides whether an empty multiaddrs list is actionable; this client never blacklists it.
 */
export function startRendezvousClient({
  baseUrl,
  campId,
  doc,
  getPrivateKey,
  peerId,
  onDiscoveredPeer,
  fetchImpl = fetch,
  intervalMs = 60_000,
  nextSequence,
}) {
  let stopped = false
  let inFlight = false
  let timer = null
  let localSeq = 0

  async function tick() {
    if (stopped || inFlight) return // single in-flight publish per tick, skip-not-queue
    inFlight = true
    try {
      const namespaceInfo = readRendezvousNamespace(doc(), campId)
      const addressKey = readRendezvousAddressKey(doc(), campId)
      if (!namespaceInfo || !addressKey) return // no-op tick: rendezvous not enabled yet

      const { signRecord } = await import('./rendezvousRecord.js')
      const privateKey = await getPrivateKey()
      localSeq = nextSequence ? nextSequence() : localSeq + 1
      const now = Date.now()
      const record = {
        namespace: namespaceInfo.namespace,
        peerId,
        epoch: namespaceInfo.epoch,
        seq: localSeq,
        issuedAt: now,
        expiresAt: now + 2 * 60 * 60 * 1000,
        addresses: [], // no local transport address list available in this ticket's scope
      }
      const recordBytes = signRecord(record, privateKey, addressKey)
      await registerRecord({ baseUrl, namespace: namespaceInfo.namespace, peerId, recordBytes, fetchImpl })

      const discovered = await fetchPeers({ baseUrl, namespace: namespaceInfo.namespace, fetchImpl })
      if (discovered.ok) {
        const { verify } = await import('./rendezvousRecord.js')
        for (const bytes of discovered.peers) {
          const verdict = verify(bytes, { addressKey, now })
          if (!verdict.ok) continue // authenticity/freshness/monotonicity failed — not a peer we trust
          if (verdict.record.peerId === peerId) continue // never dial ourselves
          onDiscoveredPeer?.({
            id: verdict.record.peerId,
            multiaddrs: verdict.addressBodyDecrypted ? (verdict.record.addresses ?? []) : [],
          })
        }
      }
    } finally {
      inFlight = false
    }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      tick().catch(() => {}) // a tick never throws by construction, but a caller injecting a
      // throwing fetchImpl/getPrivateKey must not crash the interval loop
    }, intervalMs)
    if (timer.unref) timer.unref()
  }

  return {
    tick,
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}

/**
 * syncStarter.js integration point — a libp2p `peerDiscovery` factory, the SAME shape
 * createMdnsDiscovery({campId}) produces (discovery.js's `mdns({...})`): a function libp2p calls
 * with its components, returning a PeerDiscovery service (start/stop, emits a `peer` CustomEvent
 * with `{id: PeerId, multiaddrs: Multiaddr[]}`). Wired into `peerDiscovery: [createMdnsDiscovery(...), ...]`
 * alongside mDNS, never replacing it. Naming/interface-shape latitude granted by Governor
 * (addendum "Open questions for Governor" item 3).
 *
 * A discovered {id, multiaddrs} pair that fails to parse (malformed peer id, malformed multiaddr —
 * this data comes from an untrusted cache) is dropped rather than thrown, same discipline as the
 * rest of this file's untrusted-input handling.
 */
export function createRendezvousDiscovery({ campId, baseUrl, doc, getPrivateKey, peerId, nextSequence, intervalMs, fetchImpl } = {}) {
  return () => {
    let handle = null
    const target = new EventTarget()
    target.start = () => {
      handle = startRendezvousClient({
        baseUrl,
        campId,
        doc,
        getPrivateKey,
        peerId,
        nextSequence,
        intervalMs,
        ...(fetchImpl ? { fetchImpl } : {}),
        onDiscoveredPeer: async ({ id, multiaddrs }) => {
          try {
            const [{ peerIdFromString }, { multiaddr }] = await Promise.all([
              import('@libp2p/peer-id'),
              import('@multiformats/multiaddr'),
            ])
            const discoveredPeerId = peerIdFromString(id)
            const discoveredMultiaddrs = (multiaddrs ?? []).map((a) => multiaddr(a))
            target.dispatchEvent(new CustomEvent('peer', { detail: { id: discoveredPeerId, multiaddrs: discoveredMultiaddrs } }))
          } catch (err) {
            // Drop, don't throw — this data comes from an untrusted cache. But a bare catch also
            // masks a non-adversarial failure (e.g. a peer-id/multiaddr library version bump) as
            // if it were malicious input, so make it operator-visible. No-PII: log the failure
            // reason only, never the record bytes, addresses, or peer id itself.
            console.warn('rendezvous: dropped a discovered peer that failed to parse:', err?.message ?? String(err))
          }
        },
      })
      handle.tick().catch(() => {})
    }
    target.stop = () => {
      handle?.stop()
    }
    return target
  }
}
