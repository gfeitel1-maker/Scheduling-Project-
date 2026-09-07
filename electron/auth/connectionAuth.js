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
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { verifySessionToken, attemptLogin } from './localAuth.js'
import { deviceTrustStatus, deviceTrustReason } from './deviceTrust.js'
import { recordAuditEvent } from '../audit/auditLog.js'

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

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
  //
  // 'device' (Finding 2 fix, Stage 5d-2b re-review) IS accepted here: it is
  // the Host's own connection-admission-only token (issueDeviceToken,
  // localAuth.js), Host-signed exactly like 'camp' and used ONLY to let the
  // Host authenticate itself outward to a peer it dials — it carries no
  // userId. Admitting it here is safe precisely because "admitted" and
  // "authorized to act" are different layers: authorize() (electron/auth/
  // authorize.js) explicitly refuses `type: 'device'` outright, so nothing
  // this token touches can ever reach a role decision.
  if (verified.type !== 'camp' && verified.type !== 'device') {
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

// Stage 5d-2b: the transport-independent DECISION half of syncServer.js's
// `pairing_request` block — extracted so libp2p's auth-over-libp2p handler
// (authGate.js) reuses it instead of forking it, the same reason
// evaluateAuthenticate exists. Deliberately excludes the WS-only bookkeeping
// that stays in syncServer.js/authGate.js: per-device rate limiting and the
// MAX_PENDING_PAIRING cap operate on a transport's own live-connection map
// (ws Map keyed by device_id vs. libp2p's PeerId-keyed map) and protect that
// transport's own connection-handle exhaustion, not the admission decision
// itself — there is nothing to drift between transports there because the
// resource each protects is transport-specific.
//
// Returns:
//   { ok: false, reason: 'invalid_request' }                                  — malformed input
//   { ok: true, alreadyApproved: true, device_secret_identifier }             — RedHat FM3/5/6 idempotent re-delivery
//   { ok: true, alreadyApproved: false }                                      — fresh/pending device; caller must
//                                                                                still invoke onPairingRequest itself
export function evaluatePairingRequest(db, { device_id, device_name }) {
  if (!isNonEmptyString(device_id) || !isNonEmptyString(device_name)) {
    return { ok: false, reason: 'invalid_request' }
  }

  // RedHat FM3/5/6 recovery: if this device is already authorized on the
  // Host (e.g. the Client received pairing_approved but failed to persist it
  // locally, or the connection dropped right after approval), re-deliver
  // pairing_approved with the stored secret rather than treating this as a
  // fresh unknown request. This makes the approval idempotent.
  const existingDevice = db
    .prepare('SELECT authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?')
    .get(device_id)
  if (existingDevice && existingDevice.authorized_at && !existingDevice.revoked_at && existingDevice.device_secret_identifier) {
    return { ok: true, alreadyApproved: true, device_secret_identifier: existingDevice.device_secret_identifier }
  }

  // First-time or pending device: upsert without overwriting the name once
  // it's set (Security MEDIUM-2: prevents name spoofing on a pending device).
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(device_id, device_name)
  // Only update pairing_status, not the name — the first-seen name wins.
  db.prepare("UPDATE devices SET pairing_status = 'pending' WHERE id = ? AND (pairing_status IS NULL OR pairing_status = 'pending')").run(device_id)
  recordAuditEvent(db, { deviceId: device_id, actorUserId: null, action: 'device.pairing_request', outcome: 'allow' })

  return { ok: true, alreadyApproved: false }
}

// Stage 5d-2b: the transport-independent DECISION half of syncServer.js's
// `handleLogin` — device-secret check (constant-time) + attemptLogin
// (PIN/lockout), reused verbatim rather than forked, same rationale as
// above. Deliberately excludes the WS-only per-connection throttle
// (LOGIN_MIN_INTERVAL_MS via ws.lastLoginAttemptAt) — that guards a specific
// long-lived WS connection's own attempt rate and has no equivalent state on
// a short-lived libp2p auth stream; each transport's caller is responsible
// for its own request-rate bookkeeping before calling this.
//
// Returns:
//   { ok: false, reason: 'not_paired' }                                — device unknown/unauthorized/revoked
//   { ok: false, reason: 'bad_secret' }                                — device_secret_identifier mismatch
//   { ok: false, reason: 'invalid_credentials' }                       — attemptLogin returned null (bad PIN/user)
//   { ok: false, reason: 'locked', locked: true, retryAfterMs }        — attemptLogin lockout in effect
//   { ok: true, token, userId, role }                                  — attemptLogin succeeded
//
// The two rejection reasons before attemptLogin runs are intentionally
// generic to the caller (mirrors syncServer.js's opaque `login_failed` with
// no reason field for these two cases) — leaking which one failed would
// create a device-existence/authorization oracle (Security review finding
// 4, carried over unchanged).
export function evaluateLogin(db, { device_id, device_secret_identifier, name, pin }) {
  const trust = deviceTrustStatus(db, device_id)
  if (!trust.found || !trust.authorized || trust.revoked) {
    return { ok: false, reason: 'not_paired' }
  }

  // Constant-time comparison for the 64-char hex device secret to prevent
  // timing side-channels (Security review finding 3, carried over unchanged).
  const storedSecret = trust.row.device_secret_identifier
  const providedSecret = typeof device_secret_identifier === 'string' ? device_secret_identifier : ''
  let secretOk = false
  if (storedSecret && storedSecret.length === providedSecret.length) {
    try {
      secretOk = timingSafeEqual(Buffer.from(storedSecret), Buffer.from(providedSecret))
    } catch {
      secretOk = false
    }
  }
  if (!secretOk) {
    return { ok: false, reason: 'bad_secret' }
  }

  const result = attemptLogin(db, { name, pin, deviceId: device_id })
  if (!result) {
    return { ok: false, reason: 'invalid_credentials' }
  }
  if (result.locked) {
    return { ok: false, reason: 'locked', locked: true, retryAfterMs: result.retryAfterMs }
  }
  return { ok: true, token: result.token, userId: result.userId, role: result.role }
}
