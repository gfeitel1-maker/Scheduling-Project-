// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §2/§3): the
// transport-independent admission decision extracted out of syncServer.js's
// `handleAuthenticate`, so a second transport (libp2p's auth-over-libp2p
// handshake, electron/sync/automerge/authGate.js) can reuse the EXACT same
// verify/reject-local/trust-check logic instead of forking it. Two copies of
// this decision is the drift class the whole libp2p membership design exists
// to avoid (see the ADR's §2 "why this matters for cannot drift").
//
// Deliberately does NOT include handleAuthenticate's WS-only tail
// (isReauthenticate bookkeeping, sendFullSyncIfFirstPairing/sendMissedOps
// catchup) — those are long-lived-WS-connection lifecycle concerns, not part
// of "should this peer be admitted at all," and libp2p's doc-sync catchup is
// a separate, already-built mechanism (Stage 5c) that doesn't need re-firing
// here.
import { verifySessionToken } from './localAuth.js'
import { deviceTrustStatus, deviceTrustReason } from './deviceTrust.js'
import { recordAuditEvent } from '../audit/auditLog.js'

// Returns:
//   { ok: true, verified }   — verified is verifySessionToken's own return shape
//   { ok: false, code, reason }
// `code` mirrors syncServer.js's existing WS close-code convention exactly
// (4401 invalid/tampered/expired token or device_id mismatch, 4402 a
// structurally-valid `local` token rejected outright, 4403 device not
// authorized, 4404 device revoked) so a caller on any transport can report
// failures identically.
export function evaluateAuthenticate(db, { token, device_id }) {
  const verified = verifySessionToken(db, token)
  if (!verified || verified.deviceId !== device_id) {
    return { ok: false, code: 4401, reason: 'invalid_token' }
  }

  // A 'local' token is this-device-only by design (HMAC'd with a device's
  // own device_secret_identifier — see localAuth.js's issueLocalToken /
  // verifySessionToken) and must never be accepted as proof of network
  // trust, per docs/adr/2026-07-25-device-trust-revocation.md §3. This check
  // is byte-for-byte the same as syncServer.js's WS rejection — there is no
  // product reason to relax it for a different transport.
  if (verified.type !== 'camp') {
    return { ok: false, code: 4402, reason: 'local_token_not_valid_for_network' }
  }

  // Self-registration is allowed regardless of authorization status (a
  // brand-new device must get a `devices` row to exist at all before it can
  // ever be authorized), but connection ADMISSION is gated on
  // authorized_at/revoked_at, re-checked fresh here rather than cached — same
  // revocation-enforcement rule authorize() applies on every IPC call.
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')"
  ).run(verified.deviceId, `Device ${verified.deviceId.slice(0, 8)}`)

  const trust = deviceTrustStatus(db, verified.deviceId)
  if (!trust.found || !trust.authorized || trust.revoked) {
    const reason = deviceTrustReason(trust)
    recordAuditEvent(db, {
      actorUserId: verified.userId,
      deviceId: verified.deviceId,
      action: 'auth.authenticate',
      outcome: 'deny',
      reason,
      metadata: verified.jti ? { jti: verified.jti } : null,
    })
    return { ok: false, code: reason === 'device_revoked' ? 4404 : 4403, reason }
  }

  return { ok: true, verified }
}
