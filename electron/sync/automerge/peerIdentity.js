// Stage 5d-2b (docs/adr/2026-09-06-libp2p-membership-mapping.md §4):
// records a device's current libp2p PeerId on its `devices` row
// (`libp2p_peer_id`, schema v57, electron/db/schema.sql) on successful
// libp2p login/authenticate. This is a ROUTING CONVENIENCE ONLY, never a
// trust signal — nothing may authorize on it (authorize.js never reads this
// column; see libp2pPeerId.migration.test.js's own guard test for that
// invariant). All this does is let a future caller find "which PeerId is
// device X currently reachable at," e.g. to dial it directly for a
// pairing_approved delivery.
//
// Two edge cases the schema's partial-unique index forces a decision on:
//
// 1. The SAME device reconnects with a DIFFERENT PeerId (libp2p generates a
//    fresh keypair-derived PeerId on every process restart unless one is
//    persisted — Stage 4 does not persist one). This is a plain UPDATE on
//    that device's own row and never conflicts with the unique index.
//
// 2. A PeerId is already claimed by ANOTHER device's row. Since a libp2p
//    PeerId is derived from a freshly generated keypair each start, a
//    genuine collision (two different devices independently generating the
//    same PeerId) is cryptographically negligible — the realistic cause is
//    a STALE row: some other device claimed this PeerId in a past process
//    lifetime and never got the chance to clear it (crashed, or simply
//    hasn't reconnected since). Because this column is documented as a
//    non-trust routing convenience, the safe choice is: clear the stale
//    claim and let the device presenting it now win, rather than throwing
//    the caller into an unhandled SQLite UNIQUE error. Nothing is
//    authorized by this — the row that loses the claim keeps its
//    authorized_at/device_secret_identifier untouched, it just becomes
//    unreachable via this convenience column until it reconnects again.
export function recordLibp2pPeerId(db, deviceId, peerId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) return
  if (typeof peerId !== 'string' || peerId.length === 0) return

  try {
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run(peerId, deviceId)
  } catch {
    // UNIQUE collision: another row currently claims this PeerId. Clear the
    // stale claim, then retry — see case 2 above.
    db.prepare('UPDATE devices SET libp2p_peer_id = NULL WHERE libp2p_peer_id = ? AND id != ?').run(peerId, deviceId)
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run(peerId, deviceId)
  }
}
