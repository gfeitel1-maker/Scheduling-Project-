// T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md, Slice 1): persisted-peer
// address storage and direct reconnect. NO new libp2p package, NO internet discovery — addresses
// come only from an already-observed, authenticated connection (syncNode.js's onPeerAdmitted) or
// the join flow's existing knownHostAddr. Backed by the device-local, never-synced
// `peer_last_addresses` table (schema.sql v88) — see electron/automerge/purgeCollateral.js and
// electron/automerge/hostOnlyExclusion.test.js for the exclusion-class mechanism this joins.
//
// STALE-ADDRESS SAFETY: every remembered multiaddr is stored WITH an explicit `/p2p/<peerId>`
// component. Dialing a multiaddr that carries a peer id component makes libp2p's own Noise
// handshake verify the remote's cryptographic identity against that component — a peer now
// answering at that address under a DIFFERENT identity fails the handshake and the dial rejects,
// before any stream opens. Remembering an address therefore grants no trust by itself; trust is
// still established exclusively by the Noise mutual-auth handshake, exactly as for any other
// dial. redialTrustedPeers treats such a rejection as an ordinary failed attempt (logged,
// non-fatal, never thrown) and keeps dialing the remaining peers — see its own comment and
// peerAddressBook.test.js's "fails closed" case.
import { deviceTrustStatus } from '../../auth/deviceTrust.js'

// Remembers (or updates) the last-observed multiaddr for `peerId`. Called from syncNode.js's
// onPeerAdmitted — i.e. only after a peer has completed the authenticated handshake — never from
// discovery or document merge. `now` is injectable (tests only; defaults to the real clock).
export function rememberPeerAddress(db, peerId, multiaddr, now = () => new Date().toISOString()) {
  if (typeof peerId !== 'string' || peerId.length === 0) return
  if (typeof multiaddr !== 'string' || multiaddr.length === 0) return
  const lastSeenAt = typeof now === 'function' ? now() : now
  db.prepare(
    'INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(peer_id) DO UPDATE SET multiaddr = excluded.multiaddr, last_seen_at = excluded.last_seen_at'
  ).run(peerId, multiaddr, lastSeenAt)
}

// Deletes a peer's remembered address. Wired into main.js's revokeDevice path — a revoked peer's
// address must not survive to be redialed on a later startup.
export function forgetPeerAddress(db, peerId) {
  if (typeof peerId !== 'string' || peerId.length === 0) return
  db.prepare('DELETE FROM peer_last_addresses WHERE peer_id = ?').run(peerId)
}

// Trusted (authorized, not revoked) peers with a remembered address — the redial list. Queried
// fresh on every call, same discipline as createBoundPeerTrust (peerIdentity.js): a peer revoked
// since the last read must not still be dialed.
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

// Dials every trusted peer's remembered address. Called from syncNode.js BEFORE wireMutualAuth
// sets up discovery-driven dialing (mDNS/rendezvous), so a reconnect to a still-reachable peer no
// longer depends on discovery. Idempotent via `isConnected` — a peer already connected (e.g. a
// live mDNS connection that raced this call) is skipped, never double-dialed. Each dial is
// independent and best-effort: a failed dial (unreachable address, or — the stale-address-safety
// case — the address now answering as a different peer id, which libp2p's Noise handshake itself
// rejects; see the module comment) is logged and never thrown, so one bad remembered address can
// never block redialing the rest. Returns the list of peer ids actually dialed (for tests).
export async function redialTrustedPeers(db, { dial, isConnected } = {}) {
  const targets = listTrustedRememberedAddresses(db)
  const attempted = []
  for (const { peerId, multiaddr } of targets) {
    if (isConnected?.(peerId)) continue
    attempted.push(peerId)
    try {
      await dial(multiaddr)
    } catch (err) {
      console.error(
        `redialTrustedPeers: dial to remembered address for ${peerId} failed (stale address, ` +
          `peer unreachable, or peer id mismatch — no trust granted either way): ${err?.message ?? err}`
      )
    }
  }
  return attempted
}
