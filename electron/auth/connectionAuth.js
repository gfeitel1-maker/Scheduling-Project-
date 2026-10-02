// The transport-independent admission decision: "should this peer be admitted at
// all", with no transport lifecycle mixed in. Its live consumer is the libp2p
// auth-over-libp2p handshake (electron/sync/automerge/authGate.js, called from
// syncNode.js).
//
// _Prior (Stage 5d-1, docs/adr/2026-09-06-libp2p-membership-mapping.md §2/§3):
// this was "extracted out of syncServer.js's `handleAuthenticate`, so a SECOND
// transport ... can reuse the EXACT same verify/reject-local/trust-check logic
// instead of forking it. Two copies of this decision is the drift class the whole
// libp2p membership design exists to avoid." It also recorded what it left
// behind: "handleAuthenticate's WS-only tail (isReauthenticate bookkeeping,
// sendFullSyncIfFirstPairing/sendMissedOps catchup) — those are
// long-lived-WS-connection lifecycle concerns."
//
// syncServer.js was deleted at the Stage 6c cutover, so the FIRST of those two
// transports is gone and there is now exactly one caller. Read the "cannot drift"
// rationale as history, not as a live constraint: there is no WS implementation
// left to keep this in parity with, and none of the WS-only tail named above
// exists anywhere. The extraction is kept because the separation it created is
// still the right shape — admission is decided here, connection lifecycle lives
// in the transport — and because authGate.js and its tests are written against
// this boundary._
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { verifySessionToken, attemptLogin } from './localAuth.js'
import { deviceTrustStatus, deviceTrustReason } from './deviceTrust.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { bindOrVerifyPeerIdentity } from '../sync/automerge/peerIdentity.js'

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

// Returns:
//   { ok: true, verified }   — verified is verifySessionToken's own return shape
//   { ok: false, code, reason }
// `code` values follow the close-code convention this module defines
// (4401 invalid/tampered/expired token or device_id mismatch, 4402 a
// structurally-valid `local` token rejected outright, 4403 device not
// authorized, 4404 device revoked, 4405 peer_identity_mismatch — T162,
// docs/adr/2026-09-14-device-identity-and-token-binding.md §3) so a caller on
// any transport can report failures identically. _Prior: these were described as
// mirroring "syncServer.js's existing WS close-code convention"; that file is
// deleted, so this module is now the origin of the convention rather than a copy
// of it. electron/authRejectedSender.js is the other half that must agree — see
// its own comment._
//
// `appliedTombstones` (T322 S3a, docs/adr/2026-09-19-multi-device-erasure-propagation.md's
// "Addendum (2026-10-01, Architect, T322 S3a)", optional): the peer's own self-reported set of
// (tombstone id, version) pairs it has verified-and-projected, as `[{id, version}, ...]`.
// Persisted into `peer_tombstone_reports`, keyed by `verified.deviceId` — the AUTHENTICATED
// identity, never the raw `device_id` off the wire before verification — and ONLY after the
// trust/revocation gate below passes, mirroring the peer-identity bind's own ordering. This is
// advisory display data (S3b reads it) and must never feed back into any admission decision.
// Tolerant of a missing/malformed value: an absent field, a non-array, or an individual entry
// with a non-string id/non-non-negative-integer version is silently skipped — mirrors how
// `msg.schemaVersion` tolerates a non-numeric value as "unknown" rather than throwing.
function persistAppliedTombstones(db, deviceId, appliedTombstones) {
  if (!Array.isArray(appliedTombstones)) return
  const reportedAt = new Date().toISOString()
  // Monotonic upsert, keyed on the (device_id, tombstone_id) primary key
  // (schema.sql): a report only ever ADVANCES a stored per-id version, never
  // lowers it. A blind INSERT OR REPLACE would let a stale/out-of-order
  // re-authenticate carry an OLDER version and overwrite a newer stored one,
  // flickering a peer's S3b badge from LOGICALLY_ERASED back to UNKNOWN. The
  // `WHERE excluded.version >= ...version` no-ops a strictly-older report and
  // refreshes reported_at on an equal-or-newer one — safe either way, this is
  // advisory display data that never feeds an admission decision.
  const upsert = db.prepare(
    `INSERT INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id, tombstone_id) DO UPDATE SET
       version = excluded.version,
       reported_at = excluded.reported_at
     WHERE excluded.version >= peer_tombstone_reports.version`
  )
  for (const entry of appliedTombstones) {
    if (!entry || typeof entry !== 'object') continue
    const { id, version } = entry
    if (!isNonEmptyString(id)) continue
    if (!Number.isInteger(version) || version < 0) continue
    upsert.run(deviceId, id, version, reportedAt)
  }
}

// `peerId` (T162, optional): the libp2p peer id that presented this token,
// established by libp2p's own Noise handshake before this function is ever
// called — not client-asserted data. When provided, bound via
// bindOrVerifyPeerIdentity (TOFU: first contact binds, a later mismatch is
// rejected) so a token copied off a paired device's disk no longer
// authenticates from a different machine. Omitting it (every caller that
// doesn't have a libp2p connection to report) skips the check entirely —
// this is purely an admission-layer tightening, not a new required field.
export function evaluateAuthenticate(db, { token, device_id, peerId, appliedTombstones }) {
  const verified = verifySessionToken(db, token)
  if (!verified || verified.deviceId !== device_id) {
    return { ok: false, code: 4401, reason: 'invalid_token' }
  }

  // A 'local' token is this-device-only by design (HMAC'd with a device's
  // own device_secret_identifier — see localAuth.js's issueLocalToken /
  // verifySessionToken) and must never be accepted as proof of network
  // trust, per docs/adr/2026-07-25-device-trust-revocation.md §3. _Prior: "this
  // check is byte-for-byte the same as syncServer.js's WS rejection — there is no
  // product reason to relax it for a different transport." The WS rejection it was
  // matched against is deleted; the rule itself is unchanged and is now enforced
  // only here._
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

  if (typeof peerId === 'string' && peerId.length > 0) {
    const bind = bindOrVerifyPeerIdentity(db, verified.deviceId, peerId)
    if (!bind.ok) {
      recordAuditEvent(db, {
        actorUserId: verified.userId,
        deviceId: verified.deviceId,
        action: 'auth.authenticate',
        outcome: 'deny',
        reason: bind.reason,
        metadata: verified.jti ? { jti: verified.jti } : null,
      })
      return { ok: false, code: 4405, reason: bind.reason }
    }
  }

  // Gate A (T331, docs/adr/2026-10-02-distributed-revocation-authority.md) — the DISTRIBUTED
  // revocation check, independent of and in addition to the Host-local devices.revoked_at check
  // above. A device can be removed by ANY currently-valid admin's signed camp_authority_log
  // entry, reaching quorum for an admin/founder target — never requiring the Host specifically
  // (that is the entire point of this ADR: the Host being the one revoked, or offline, must not
  // block its own removal). Read from authority_cache, this device's LOCAL, already-verified-and-
  // replayed derived cache (electron/automerge/projector.js's upsertCampAuthorityLogEntity) —
  // never from the connecting peer's own self-report. Reuses this function's existing deny shape
  // (code 4404) with its own distinguishing reason string, per the ADR's enforcement checklist.
  const authorityStatus = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(verified.deviceId)?.status
  if (authorityStatus === 'revoked') {
    recordAuditEvent(db, {
      actorUserId: verified.userId,
      deviceId: verified.deviceId,
      action: 'auth.authenticate',
      outcome: 'deny',
      reason: 'device_revoked_by_authority',
      metadata: verified.jti ? { jti: verified.jti } : null,
    })
    return { ok: false, code: 4404, reason: 'device_revoked_by_authority' }
  }

  persistAppliedTombstones(db, verified.deviceId, appliedTombstones)

  return { ok: true, verified }
}

// The transport-independent DECISION half of pairing-request handling, called by
// authGate.js. Deliberately excludes the bookkeeping that stays in authGate.js:
// per-device rate limiting and the MAX_PENDING_PAIRING cap operate on the
// transport's own live-connection map (libp2p's PeerId-keyed map) and protect
// that transport's own connection-handle exhaustion, not the admission decision
// itself.
//
// _Prior (Stage 5d-2b): described as "the transport-independent DECISION half of
// syncServer.js's `pairing_request` block — extracted so libp2p's
// auth-over-libp2p handler (authGate.js) reuses it instead of forking it", with
// the excluded bookkeeping said to stay "in syncServer.js/authGate.js" and the
// two maps contrasted as "ws Map keyed by device_id vs. libp2p's PeerId-keyed
// map". syncServer.js is deleted, so only the libp2p side of each of those pairs
// remains. See evaluateAuthenticate above for why the extraction is kept anyway._
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

// The transport-independent DECISION half of login handling — device-secret check
// (constant-time) + attemptLogin (PIN/lockout). The caller is responsible for its
// own request-rate bookkeeping before calling this.
//
// _Prior (Stage 5d-2b): described as "the transport-independent DECISION half of
// syncServer.js's `handleLogin` ... reused verbatim rather than forked", excluding
// "the WS-only per-connection throttle (LOGIN_MIN_INTERVAL_MS via
// ws.lastLoginAttemptAt) — that guards a specific long-lived WS connection's own
// attempt rate and has no equivalent state on a short-lived libp2p auth stream."
// syncServer.js and that throttle are deleted. The rate-limiting responsibility
// this note hands to the caller is real and now lands on authGate.js — see its
// own rate-limit comment._
//
// Returns:
//   { ok: false, reason: 'not_paired' }                                — device unknown/unauthorized/revoked
//   { ok: false, reason: 'bad_secret' }                                — device_secret_identifier mismatch
//   { ok: false, reason: 'invalid_credentials' }                       — attemptLogin returned null (bad PIN/user)
//   { ok: false, reason: 'locked', locked: true, retryAfterMs }        — attemptLogin lockout in effect
//   { ok: true, token, userId, role }                                  — attemptLogin succeeded
//
// The two rejection reasons before attemptLogin runs are intentionally
// generic to the caller (_prior: "mirrors syncServer.js's opaque `login_failed`
// with no reason field for these two cases", a file deleted at Stage 6c; the
// opacity is now this module's own rule) — leaking which one failed would
// create a device-existence/authorization oracle (Security review finding
// 4, carried over unchanged).
export function evaluateLogin(db, { device_id, device_secret_identifier, name, pin, peerId }) {
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

  // T162 peer identity bind (see evaluateAuthenticate's doc comment for the
  // full rationale) — checked after attemptLogin succeeds, per ADR §3, so a
  // failed PIN/lockout attempt never leaks whether this device's identity
  // would also have mismatched. No numeric `code` on this branch, matching
  // this function's existing no-code convention for every other rejection.
  if (typeof peerId === 'string' && peerId.length > 0) {
    const bind = bindOrVerifyPeerIdentity(db, device_id, peerId)
    if (!bind.ok) {
      recordAuditEvent(db, {
        actorUserId: result.userId,
        deviceId: device_id,
        action: 'auth.login',
        outcome: 'deny',
        reason: bind.reason,
      })
      return { ok: false, reason: bind.reason }
    }
  }

  // `camp` (Stage 6 join flow, docs/adr/2026-09-08-libp2p-join-flow.md): the
  // identity a brand-new device needs and has no other way to obtain. Under the
  // op-log this rode along in syncServer.js's first-pairing `full_sync`
  // snapshot, which the Client wrote with `INSERT OR REPLACE INTO camps` — both
  // deleted at the Stage 6c cutover. projector.js's comment on the `camps` entity
  // recorded finding a libp2p-native equivalent as "Stage 6's problem"; this is
  // that equivalent, and that comment now points back here.
  //
  // `signing_public_key` specifically is what lets the joined device VERIFY the
  // Host's tokens from its next launch onward, and it is deliberately carried
  // here rather than modeled as a document field — key material has no business
  // in shared CRDT history, where there is no payload to grep for it after the
  // fact (see hostOnlyExclusion.test.js's standing invariant). `signing_secret`
  // is never read here and never leaves the Host.
  //
  // Sent only on the `ok` path, so an unauthenticated or failed attempt learns
  // nothing about the camp — not its id, not its name.
  const camp = db.prepare('SELECT id, name, signing_public_key FROM camps LIMIT 1').get() ?? null

  return { ok: true, token: result.token, userId: result.userId, role: result.role, camp }
}
