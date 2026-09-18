import { deviceTrustStatus } from '../../auth/deviceTrust.js'

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
  } catch (err) {
    // ONLY a UNIQUE collision gets the clear-and-retry treatment (case 2
    // above). A bare `catch` here would treat any failure — SQLITE_BUSY, a
    // locked db, disk-full — as if it were a stale claim, and would then
    // NULL some other device's routing column for a reason that has nothing
    // to do with a collision. Anything else is re-thrown to the caller, which
    // is the honest outcome: this is a convenience write, and a real db fault
    // should surface as a db fault rather than be silently converted into a
    // successful-looking write against the wrong row.
    if (!String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw err
    db.prepare('UPDATE devices SET libp2p_peer_id = NULL WHERE libp2p_peer_id = ? AND id != ?').run(peerId, deviceId)
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run(peerId, deviceId)
  }
}

// bindOrVerifyPeerIdentity (ADR: docs/adr/2026-09-14-device-identity-and-token-binding.md §3/§4).
// Trust-on-first-use: the FIRST peer id ever presented for a device_id becomes that
// device's bound identity; every later presentation must match exactly, or is
// rejected. Unlike recordLibp2pPeerId (routing convenience, always overwrites, never
// a trust signal — kept for joinSession.js's Client-side Host-routing use, unchanged),
// this function IS part of the admission decision and is called only from
// connectionAuth.js's evaluateAuthenticate/evaluateLogin call sites.
// createBoundPeerTrust (T208, docs/work/tickets/T208-discovery-seam-has-no-local-trust-filter.md).
// Replaces syncNode.js's permissive `lanTopologyTrust` stub with a real check against
// the `devices` row a peer id is BOUND to (bindOrVerifyPeerIdentity's TOFU bind, above).
// True only when the bound device is authorized and not revoked — reusing
// deviceTrustStatus (electron/auth/deviceTrust.js) so "trusted" cannot drift into a
// second, competing definition. Queries fresh on every call, deliberately: mutualAuth.js
// never caches this verdict, specifically so a revocation takes effect at the very next
// discovery event rather than lingering until restart.
export function createBoundPeerTrust(db) {
  return function isPeerTrusted(peerId) {
    if (typeof peerId !== 'string' || peerId.length === 0) return false
    const row = db.prepare('SELECT id FROM devices WHERE libp2p_peer_id = ?').get(peerId)
    if (!row) return false
    const trust = deviceTrustStatus(db, row.id)
    return trust.authorized && !trust.revoked
  }
}

export function bindOrVerifyPeerIdentity(db, deviceId, peerId) {
  const row = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId)
  const bound = row?.libp2p_peer_id ?? null

  if (bound === null) {
    // The v57 partial unique index means this UPDATE can fail: another device row
    // already claims this peer id. The ADR (§3) says such a collision is "correctly
    // rejected" — but a bare .run() rejects it by throwing a raw SQLITE_CONSTRAINT
    // out of an admission decision, which skips the caller's recordAuditEvent and
    // leaves the connection to fail with no audit trail. Reject it the way every
    // other denial here is rejected instead: as a value.
    //
    // Two devices presenting the same peer id is either a cryptographically
    // negligible keypair collision or — the realistic cause — one device_identity_key
    // copied to a second machine (a cloned VM image, a duplicated install). Both are
    // exactly what this function exists to refuse, so peer_identity_mismatch is the
    // honest reason, not an internal error.
    //
    // ONLY a constraint violation is converted. SQLITE_BUSY, a locked db or disk-full
    // are re-thrown, matching recordLibp2pPeerId's documented posture one function up:
    // a real db fault must surface as a db fault, never be silently rendered as a
    // clean authentication decision.
    try {
      db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run(peerId, deviceId)
    } catch (err) {
      if (!String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw err
      return { ok: false, reason: 'peer_identity_mismatch' }
    }
    return { ok: true, bound: 'first' }
  }
  if (bound === peerId) {
    return { ok: true, bound: 'match' }
  }
  return { ok: false, reason: 'peer_identity_mismatch' }
}
