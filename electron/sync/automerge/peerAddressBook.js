// T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md, Slice 1; widened to
// multiple addresses per peer in the correction pass): persisted-peer address storage and direct
// reconnect. NO new libp2p package, NO internet discovery — addresses come only from an
// already-observed, authenticated connection (syncNode.js's onPeerAdmitted) or the join flow's
// existing knownHostAddr. Backed by the device-local, never-synced `peer_last_addresses` table
// (schema.sql v88, widened to a composite key at v89) — see electron/automerge/purgeCollateral.js
// and electron/automerge/hostOnlyExclusion.test.js for the exclusion-class mechanism this joins.
//
// MULTIPLE ADDRESSES PER PEER (correction pass): the ADR says "last-known multiaddrs", plural.
// v88's single-row-per-peer, last-write-wins shape silently discarded a still-good address for a
// multi-homed peer, defeating reconnect for exactly the case Slice 1 exists to help. Every
// distinct observed (peer_id, multiaddr) pair is now its own row; a peer re-observed at the SAME
// address updates that row's last_seen_at in place. PEER_LAST_ADDRESSES_MAX_PER_PEER caps growth —
// pruned on every remember, keeping only the N most-recent-by-last_seen_at rows per peer.
//
// STALE-ADDRESS SAFETY: every remembered multiaddr is stored WITH an explicit `/p2p/<peerId>`
// component. Dialing a multiaddr that carries a peer id component makes libp2p's own Noise
// handshake verify the remote's cryptographic identity against that component — a peer now
// answering at that address under a DIFFERENT identity fails the handshake and the dial rejects,
// before any stream opens. Remembering an address therefore grants no trust by itself; trust is
// still established exclusively by the Noise mutual-auth handshake, exactly as for any other
// dial. This is now verified by a REAL two-node libp2p test — see transport.test.js's "stale
// address safety" describe block (a dialer targets node C's real listening address but pins node
// A's peer id in the multiaddr; the Noise handshake rejects the connection because the responder's
// verified identity is C, not A). redialTrustedPeers treats such a rejection as an ordinary failed
// attempt (logged, non-fatal, never thrown) and keeps dialing the remaining targets.
//
// PER-TARGET TRUST RE-CHECK (correction pass, Security + Red Hat): the trusted-peer list is a
// snapshot (listTrustedRememberedAddresses), but a revocation can land at any point after that
// snapshot is taken. redialTrustedPeers re-checks trust IMMEDIATELY BEFORE each individual dial —
// not once for the whole batch — so a peer revoked mid-batch is not dialed even though it was
// still trusted when the snapshot was read.
import { deviceTrustStatus } from '../../auth/deviceTrust.js'
import { createBoundPeerTrust } from './peerIdentity.js'
import { multiaddr } from '@multiformats/multiaddr'
import { isPublicAddress, MAX_FUTURE_SKEW_MS } from './punchGossip.js'

// Keep at most this many remembered addresses per peer — small and deliberately so: a camp LAN
// device rarely has more than a couple of live interfaces, and this only exists to cap growth,
// not to model every address a peer has ever been seen at.
export const PEER_LAST_ADDRESSES_MAX_PER_PEER = 5

// T359 slice 2: a router-mapped address is a PUBLIC TCP address. Rows of that shape are written only by
// rememberMappedPeerAddress (from a verified gossip entry), at most one per peer, and are outside the LAN
// prune below. An observed public TCP address (an inbound connection's ephemeral source port) is not a
// listener and is never stored by rememberPeerAddress.
export const MAPPED_ADDRESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// T361: a LAN row older than this is not redialed at startup. 30 days: a camp's LAN addresses are DHCP
// leases that survive an off-season gap far less often than a router mapping is refreshed, while a
// refused dial is now isolated and cheap, so the bound only has to stop an ancient row being tried forever.
export const LAN_ADDRESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
// Per-dial budget for the startup redial, its own signal rather than libp2p's 30s default.
export const REDIAL_TIMEOUT_MS = 5000
const TCP_ADDR_RE = /^\/(ip4|ip6)\/([^/]+)\/tcp\/(\d{1,5})(?:\/p2p\/([^/]+))?$/
function parsePublicTcp(multiaddr) {
  const m = TCP_ADDR_RE.exec(multiaddr)
  if (!m) return null
  const port = Number(m[3])
  if (port < 1 || port > 65535 || !isPublicAddress(m[1], m[2])) return null
  return { peerId: m[4] ?? null }
}
const isPublicTcp = (multiaddr) => parsePublicTcp(multiaddr) !== null

// Remembers (or updates) an observed multiaddr for `peerId`. Called from syncNode.js's
// onPeerAdmitted — i.e. only after a peer has completed the authenticated handshake — never from
// discovery or document merge. The SAME (peer_id, multiaddr) pair updates last_seen_at in place; a
// NEW multiaddr for the same peer_id is remembered as an additional row (up to the cap). `now` is
// injectable (tests only; defaults to the real clock).
export function rememberPeerAddress(db, peerId, multiaddr, now = () => new Date().toISOString()) {
  if (typeof peerId !== 'string' || peerId.length === 0) return
  if (typeof multiaddr !== 'string' || multiaddr.length === 0) return
  if (isPublicTcp(multiaddr)) return
  const lastSeenAt = typeof now === 'function' ? now() : now
  db.prepare(
    'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(peer_id, multiaddr) DO UPDATE SET last_seen_at = excluded.last_seen_at'
  ).run(peerId, multiaddr, lastSeenAt)

  // Prune the LAN rows to the N most-recent for THIS peer only; the mapped (public TCP) row is not
  // ranked, so LAN rows can never push it out.
  const lan = db
    .prepare('SELECT multiaddr FROM peer_last_addresses WHERE peer_id = ? ORDER BY last_seen_at DESC, multiaddr DESC')
    .all(peerId)
    .map((r) => r.multiaddr)
    .filter((m) => !isPublicTcp(m))
  const del = db.prepare('DELETE FROM peer_last_addresses WHERE peer_id = ? AND multiaddr = ?')
  for (const m of lan.slice(PEER_LAST_ADDRESSES_MAX_PER_PEER)) del.run(peerId, m)
}

// T359 slice 2: remembers the router-mapped TCP address a peer published in its VERIFIED gossip entry
// (`/ip4/<ext>/tcp/<port>/p2p/<peerId>`). `observedAtMs` is the entry's own signed timestamp. Public-
// filtered here at the write; at most one such row per peer; it is replaced only by a strictly newer
// entry, so republishing other ports cannot churn it and an older entry cannot roll it back.
export function rememberMappedPeerAddress(db, peerId, multiaddr, { observedAtMs = Date.now(), now = Date.now } = {}) {
  if (typeof peerId !== 'string' || peerId.length === 0 || typeof multiaddr !== 'string') return false
  const parsed = parsePublicTcp(multiaddr)
  if (!parsed || parsed.peerId !== peerId || !Number.isFinite(observedAtMs)) return false
  if (observedAtMs - now() > MAX_FUTURE_SKEW_MS) return false
  const seen = new Date(observedAtMs).toISOString()
  return db.transaction(() => {
    const existing = db.prepare('SELECT multiaddr, last_seen_at FROM peer_last_addresses WHERE peer_id = ?').all(peerId).filter((r) => isPublicTcp(r.multiaddr))
    if (existing.some((r) => r.last_seen_at >= seen)) return false
    const del = db.prepare('DELETE FROM peer_last_addresses WHERE peer_id = ? AND multiaddr = ?')
    for (const r of existing) del.run(peerId, r.multiaddr)
    db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)').run(peerId, multiaddr, seen)
    return true
  })()
}

// The trusted peer's remembered mapped address if it is at most 7 days old, else null. The age limit
// is applied here and by listTrustedRememberedAddresses. `isAddressAllowed` is a test-only injection
// point (loopback fixtures); production never passes it.
export function loadMappedPeerAddress(db, peerId, { isPeerTrusted, maxAgeMs = MAPPED_ADDRESS_MAX_AGE_MS, now = Date.now, isAddressAllowed = isPublicTcp } = {}) {
  const checkTrust = isPeerTrusted ?? createBoundPeerTrust(db)
  if (!checkTrust(peerId)) return null
  const rows = db.prepare('SELECT multiaddr, last_seen_at FROM peer_last_addresses WHERE peer_id = ? ORDER BY last_seen_at DESC').all(peerId)
  const row = rows.find((r) => isAddressAllowed(r.multiaddr))
  if (!row || !(now() - Date.parse(row.last_seen_at) <= maxAgeMs)) return null
  return row.multiaddr
}

// Deletes every remembered address for a peer; returns how many rows it removed. Wired into main.js's revokeDevice path — a revoked
// peer's addresses must not survive to be redialed on a later startup.
export function forgetPeerAddress(db, peerId) {
  if (typeof peerId !== 'string' || peerId.length === 0) return 0
  const addresses = db.prepare('DELETE FROM peer_last_addresses WHERE peer_id = ?').run(peerId).changes
  const memory = db.prepare('DELETE FROM peer_punch_memory WHERE peer_id = ?').run(peerId).changes
  return addresses + memory
}

// T348 (Rung 1): the punched session a peer left behind - OUR role, the peer's last SDP and its
// candidates - so a later redial needs zero signaling. Same discipline as rememberPeerAddress:
// called only for an authenticated peer, device-local, never synced. A description without a DTLS
// fingerprint and ICE credentials cannot be replayed, so it is not stored.
export function rememberPunchMemory(db, peerId, { role, remoteSdpType, remoteSdp, candidates }, now = () => new Date().toISOString()) {
  if (typeof peerId !== 'string' || peerId.length === 0) return
  const fingerprint = /^a=fingerprint:\S+ (\S+)/m.exec(remoteSdp)?.[1]
  const ufrag = /^a=ice-ufrag:(\S+)/m.exec(remoteSdp)?.[1]
  const pwd = /^a=ice-pwd:(\S+)/m.exec(remoteSdp)?.[1]
  if (!fingerprint || !ufrag || !pwd) return
  db.prepare(
    'INSERT INTO peer_punch_memory (peer_id, role, remote_sdp_type, remote_sdp, remote_fingerprint, remote_ufrag, remote_pwd, candidates, last_seen_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET role = excluded.role, remote_sdp_type = excluded.remote_sdp_type, ' +
      'remote_sdp = excluded.remote_sdp, remote_fingerprint = excluded.remote_fingerprint, remote_ufrag = excluded.remote_ufrag, ' +
      'remote_pwd = excluded.remote_pwd, candidates = excluded.candidates, last_seen_at = excluded.last_seen_at'
  ).run(peerId, role, remoteSdpType, remoteSdp, fingerprint, ufrag, pwd, JSON.stringify(candidates), now())
}

// The remembered punch session for `peerId`, or null - including when the peer is not currently
// trusted (revoked or unknown). Trust is queried fresh on every call, like listTrustedRememberedAddresses.
export function loadTrustedPunchMemory(db, peerId, { isPeerTrusted } = {}) {
  const checkTrust = isPeerTrusted ?? createBoundPeerTrust(db)
  if (!checkTrust(peerId)) return null
  const row = db.prepare('SELECT * FROM peer_punch_memory WHERE peer_id = ?').get(peerId)
  if (!row) return null
  let candidates
  try { candidates = JSON.parse(row.candidates) } catch { return null }
  if (!Array.isArray(candidates)) return null
  return {
    peerId: row.peer_id,
    role: row.role,
    remoteSdpType: row.remote_sdp_type,
    remoteSdp: row.remote_sdp,
    remoteFingerprint: row.remote_fingerprint,
    remoteUfrag: row.remote_ufrag,
    remotePwd: row.remote_pwd,
    candidates,
    lastSeenAt: row.last_seen_at,
  }
}

// Every (peerId, multiaddr) pair for a trusted (authorized, not revoked) peer with at least one
// remembered address — the redial list. A multi-homed peer contributes one entry per remembered
// address. Queried fresh on every call, same discipline as createBoundPeerTrust (peerIdentity.js):
// a peer revoked since the last read is excluded. This is a SNAPSHOT, not a live guarantee — see
// redialTrustedPeers' own per-target re-check for why a revoke landing after this call is still
// honored.
export function listTrustedRememberedAddresses(db, { now = Date.now } = {}) {
  const rows = db
    .prepare(
      'SELECT d.id AS deviceId, d.libp2p_peer_id AS peerId, p.multiaddr AS multiaddr, p.last_seen_at AS lastSeenAt ' +
        'FROM peer_last_addresses p JOIN devices d ON d.libp2p_peer_id = p.peer_id'
    )
    .all()
  const at = now()
  const fresh = (row) => at - Date.parse(row.lastSeenAt) <= (isPublicTcp(row.multiaddr) ? MAPPED_ADDRESS_MAX_AGE_MS : LAN_ADDRESS_MAX_AGE_MS)
  return rows
    .filter((row) => {
      const trust = deviceTrustStatus(db, row.deviceId)
      return trust.authorized && !trust.revoked && fresh(row)
    })
    .sort((a, b) => isPublicTcp(b.multiaddr) - isPublicTcp(a.multiaddr) || (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))
    .map((row) => ({ peerId: row.peerId, multiaddr: row.multiaddr }))
}

// The dial target for a remembered '/ip4/…/p2p/<id>' string, or null when it does not name `peerId`.
// The /p2p component is validated here and then DROPPED from the dial: a dial pinned to a peer id is
// keyed by that id in libp2p's dial queue, so a later discovery dial for the same peer JOINS the stale
// job and inherits its refusal (see docs/work/tickets/T361-startup-redial-isolation.md). Identity is
// verified on the resulting connection instead.
function redialTarget(peerId, remembered) {
  try {
    const named = multiaddr(remembered).getComponents().find((c) => c.name === 'p2p')?.value
    return named === peerId ? multiaddr(remembered.replace(/\/p2p\/[^/]+$/, '')) : null
  } catch {
    return null
  }
}

// Dials every remembered address of every trusted peer, in PARALLEL (Promise.allSettled — one
// slow or stale address must not serialize the rest). Called from syncNode.js BEFORE
// wireMutualAuth sets up discovery-driven dialing (mDNS/rendezvous), so a reconnect to a
// still-reachable peer no longer depends on discovery.
//
// Idempotent via `isConnected` — a peer already connected (e.g. a live mDNS connection that raced
// this call) is skipped, never double-dialed, for ALL of its remembered addresses.
//
// TOCTOU-safe via `isPeerTrusted`: re-checked immediately before EACH target's own dial (not once
// for the whole batch), defaulting to createBoundPeerTrust(db) — a fresh devices-table query, so a
// revoke landing after the initial snapshot (listTrustedRememberedAddresses) is still honored for
// any target not yet dialed.
//
// Each dial is independent and best-effort: a failed dial (unreachable address, or — the
// stale-address-safety case, see the module comment and transport.test.js's real two-node test —
// the address now answering as a different peer id, which libp2p's Noise handshake itself
// rejects) is logged and never thrown, so one bad remembered address can never block the rest.
// Returns the list of peer ids actually dialed (for tests; may repeat a peer id once per address
// dialed for it).
// T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md §A step 1): candidate-R
// selection for the coordination relay. B, failing a direct redial to its target C, needs any
// OTHER currently-trusted camp peer it has a remembered address for, ranked by last_seen_at
// (most-recently-observed first — the exact ordering redialTrustedPeers already uses) and
// CAPPED so one reconnect attempt can never fan out into an unbounded dial storm. Reuses
// PEER_LAST_ADDRESSES_MAX_PER_PEER as that cap rather than inventing a second number — the
// ticket's "mirrors redialTrustedPeers' cap" instruction, read literally: that is the only
// existing cap in this file, and growth is already bounded by it per-peer.
//
// Deliberately excludes `excludePeerId` (the target C itself — dialing C as its own relay
// candidate is meaningless) and returns ONE row per candidate peer (its single
// most-recently-seen address), not one row per remembered address — R is a peer to dial, not a
// peer to retry at every address it was ever seen at.
export function selectCoordinationCandidates(db, excludePeerId, { isPeerTrusted } = {}) {
  const checkTrust = isPeerTrusted ?? createBoundPeerTrust(db)
  const rows = db
    .prepare(
      'SELECT d.id AS deviceId, d.libp2p_peer_id AS peerId, p.multiaddr AS multiaddr, p.last_seen_at AS lastSeenAt ' +
        'FROM peer_last_addresses p JOIN devices d ON d.libp2p_peer_id = p.peer_id ' +
        'WHERE p.peer_id != ? ' +
        'ORDER BY p.last_seen_at DESC, p.multiaddr DESC'
    )
    .all(excludePeerId)

  const candidates = []
  const seenPeerIds = new Set()
  for (const row of rows) {
    if (seenPeerIds.has(row.peerId)) continue // one (most-recent) address per candidate peer
    if (!checkTrust(row.peerId)) continue
    seenPeerIds.add(row.peerId)
    candidates.push({ peerId: row.peerId, multiaddr: row.multiaddr })
    if (candidates.length >= PEER_LAST_ADDRESSES_MAX_PER_PEER) break
  }
  return candidates
}

export async function redialTrustedPeers(db, { dial, isConnected, isPeerTrusted, timeoutMs = REDIAL_TIMEOUT_MS, now } = {}) {
  const checkTrust = isPeerTrusted ?? createBoundPeerTrust(db)
  const targets = listTrustedRememberedAddresses(db, { now })
  const attempted = []

  await Promise.allSettled(
    targets.map(async ({ peerId, multiaddr }) => {
      if (isConnected?.(peerId)) return
      if (!checkTrust(peerId)) return
      const target = redialTarget(peerId, multiaddr)
      if (!target) return
      attempted.push(peerId)
      try {
        const connection = await dial(target, { signal: AbortSignal.timeout(timeoutMs) })
        const remote = connection?.remotePeer?.toString()
        if (remote && remote !== peerId) await connection.close?.()
      } catch (err) {
        console.error(
          `redialTrustedPeers: dial to remembered address for ${peerId} failed (stale address, ` +
            `peer unreachable, or peer id mismatch — no trust granted either way): ${err?.message ?? err}`
        )
      }
    })
  )

  return attempted
}
