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

// Keep at most this many remembered addresses per peer — small and deliberately so: a camp LAN
// device rarely has more than a couple of live interfaces, and this only exists to cap growth,
// not to model every address a peer has ever been seen at.
export const PEER_LAST_ADDRESSES_MAX_PER_PEER = 5

// Remembers (or updates) an observed multiaddr for `peerId`. Called from syncNode.js's
// onPeerAdmitted — i.e. only after a peer has completed the authenticated handshake — never from
// discovery or document merge. The SAME (peer_id, multiaddr) pair updates last_seen_at in place; a
// NEW multiaddr for the same peer_id is remembered as an additional row (up to the cap). `now` is
// injectable (tests only; defaults to the real clock).
export function rememberPeerAddress(db, peerId, multiaddr, now = () => new Date().toISOString()) {
  if (typeof peerId !== 'string' || peerId.length === 0) return
  if (typeof multiaddr !== 'string' || multiaddr.length === 0) return
  const lastSeenAt = typeof now === 'function' ? now() : now
  db.prepare(
    'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(peer_id, multiaddr) DO UPDATE SET last_seen_at = excluded.last_seen_at'
  ).run(peerId, multiaddr, lastSeenAt)

  // Prune to the N most-recent rows for THIS peer only — every other peer's rows are untouched.
  // `last_seen_at` ties are broken by `multiaddr` purely for determinism (SQLite's DESC/LIMIT
  // ordering is otherwise unspecified on an exact tie); this never affects which rows survive in
  // practice since lastSeenAt is a wall-clock ISO string.
  db.prepare(
    'DELETE FROM peer_last_addresses WHERE peer_id = ? AND multiaddr NOT IN (' +
      'SELECT multiaddr FROM peer_last_addresses WHERE peer_id = ? ' +
      'ORDER BY last_seen_at DESC, multiaddr DESC LIMIT ?' +
      ')'
  ).run(peerId, peerId, PEER_LAST_ADDRESSES_MAX_PER_PEER)
}

// Deletes every remembered address for a peer. Wired into main.js's revokeDevice path — a revoked
// peer's addresses must not survive to be redialed on a later startup.
export function forgetPeerAddress(db, peerId) {
  if (typeof peerId !== 'string' || peerId.length === 0) return
  db.prepare('DELETE FROM peer_last_addresses WHERE peer_id = ?').run(peerId)
}

// Every (peerId, multiaddr) pair for a trusted (authorized, not revoked) peer with at least one
// remembered address — the redial list. A multi-homed peer contributes one entry per remembered
// address. Queried fresh on every call, same discipline as createBoundPeerTrust (peerIdentity.js):
// a peer revoked since the last read is excluded. This is a SNAPSHOT, not a live guarantee — see
// redialTrustedPeers' own per-target re-check for why a revoke landing after this call is still
// honored.
export function listTrustedRememberedAddresses(db) {
  const rows = db
    .prepare(
      'SELECT d.id AS deviceId, d.libp2p_peer_id AS peerId, p.multiaddr AS multiaddr ' +
        'FROM peer_last_addresses p JOIN devices d ON d.libp2p_peer_id = p.peer_id'
    )
    .all()
  return rows
    .filter((row) => {
      const trust = deviceTrustStatus(db, row.deviceId)
      return trust.authorized && !trust.revoked
    })
    .map((row) => ({ peerId: row.peerId, multiaddr: row.multiaddr }))
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

export async function redialTrustedPeers(db, { dial, isConnected, isPeerTrusted } = {}) {
  const checkTrust = isPeerTrusted ?? createBoundPeerTrust(db)
  const targets = listTrustedRememberedAddresses(db)
  const attempted = []

  await Promise.allSettled(
    targets.map(async ({ peerId, multiaddr }) => {
      if (isConnected?.(peerId)) return
      if (!checkTrust(peerId)) return
      attempted.push(peerId)
      try {
        await dial(multiaddr)
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
