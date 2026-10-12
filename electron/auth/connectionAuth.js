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
import { attemptLogin } from './localAuth.js'
import { deviceTrustStatus } from './deviceTrust.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { bindOrVerifyPeerIdentity, recordLibp2pPeerId } from '../sync/automerge/peerIdentity.js'
import { sanitizePeerDeviceName } from './deviceName.js'

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

// evaluateAuthenticate returns:
//   { ok: true, verified: { deviceId, userId: null } }
//   { ok: false, code, reason }
// `code` values follow the close-code convention this module defines (4403 device not authorized,
// 4404 device revoked, 4405 peer_identity_mismatch, T162, docs/adr/2026-09-14-device-identity-and-token-binding.md
// §3; 4401/4402 are produced only by the token-era evaluateLogin path and by authRejectedSender's reason map),
// so a caller on any transport can report failures identically. electron/authRejectedSender.js is the
// other half that must agree — see its own comment.
//
// `appliedTombstones` (T322 S3a, docs/adr/2026-09-19-multi-device-erasure-propagation.md's
// "Addendum (2026-10-01, Architect, T322 S3a)", optional): the peer's own self-reported set of
// (tombstone id, version) pairs it has verified-and-projected, as `[{id, version}, ...]`.
// Persisted into `peer_tombstone_reports`, keyed by `verified.deviceId` — the AUTHENTICATED
// identity, never the raw `device_id` off the wire before verification — and ONLY after the
// roster/revocation gate below passes. This is
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

// A refused device redials on a timer, and the audit table is append-only: one row per window per refused roster
// member, carrying how many further refusals it stands for. Keys are roster members only (see deny), so the map is
// bounded by the roster, not by what a stranger can invent.
const REFUSAL_AUDIT_WINDOW_MS = 60_000
const refusalAudit = new WeakMap()

function auditRefusal(db, { key, deviceId, reason }) {
  let byKey = refusalAudit.get(db)
  if (!byKey) refusalAudit.set(db, (byKey = new Map()))
  const at = Date.now()
  const state = byKey.get(key)
  if (state && at - state.at < REFUSAL_AUDIT_WINDOW_MS) {
    state.suppressed += 1
    return
  }
  recordAuditEvent(db, { actorUserId: null, deviceId, action: 'auth.authenticate', outcome: 'deny', reason, ...(state?.suppressed ? { metadata: { suppressed: state.suppressed } } : {}) })
  byKey.set(key, { at, suppressed: 0 })
}

// Admission of an `authenticate` frame (docs/adr/2026-10-12-shared-signed-device-roster.md, T376). There is no
// token: a peer is admitted iff the Host-signed device roster (roster_cache, derived by projector.js's
// upsertDeviceRosterEntity) binds the device id it claims to the libp2p peer id it connected from, and neither
// authority_cache nor the legacy devices stamp has the device revoked. `peerId` is established by libp2p's own
// Noise handshake before this runs (the Noise key IS the device identity key, syncNode.js), so possession of
// the rostered key is already proven by the transport; `device_id` is only a claim to be matched against it.
// Nothing here needs the Host, so two enrolled devices admit each other with the Host off, indefinitely.
//
// _Prior: this verified a Host-signed 24h session token (verifySessionToken), rejected a 'local' token with
// 4402, required devices.authorized_at, and TOFU-bound the peer id via bindOrVerifyPeerIdentity. With the Host
// off nothing could renew the token and two clients never held an authorized devices row for each other, so
// clients stopped syncing between themselves (hostOffRoster.integration.test.js)._
//
// Close-code convention (4402 no longer produced here): 4403 device not authorized / not rostered, 4404 device
// revoked, 4405 peer_identity_mismatch (the roster binds that device id to a different peer id, or that peer id
// to a different device id).
export function evaluateAuthenticate(db, { device_id, peerId, appliedTombstones }) {
  if (!isNonEmptyString(device_id) || !isNonEmptyString(peerId)) return { ok: false, code: 4403, reason: 'device_not_authorized' }

  const byPeer = db.prepare('SELECT device_id FROM roster_cache WHERE peer_id = ?').get(peerId)
  const byDevice = db.prepare('SELECT peer_id FROM roster_cache WHERE device_id = ?').get(device_id)
  // Only a refusal of a peer the roster knows is audited. An unrostered stranger can open connections and send
  // authenticate frames at will, and the audit table is append-only, so auditing every stranger would let one
  // write unbounded rows.
  const deny = (code, reason) => {
    if (byPeer || byDevice) auditRefusal(db, { key: `${byPeer ? 'p' : 'd'}:${byPeer ? peerId : device_id}:${reason}`, deviceId: device_id, reason })
    return { ok: false, code, reason }
  }

  // Revoked first, beating everything: a device removed by the distributed authority log is refused even if
  // the roster (monotonic, never un-verified) still holds it. docs/adr/2026-10-02-distributed-revocation-authority.md.
  const authorityStatus = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(device_id)?.status
  if (authorityStatus === 'revoked') return deny(4404, 'device_revoked_by_authority')

  if (byPeer && byPeer.device_id !== device_id) return deny(4405, 'peer_identity_mismatch')
  if (!byPeer && byDevice) return deny(4405, 'peer_identity_mismatch')
  if (!byPeer) return deny(4403, 'device_not_authorized')

  // The legacy devices.revoked_at stamp (pre-T331 and revokeDevice's local write) still denies, unless
  // authority_cache says this device is a fleet-confirmed admin (the 2026-10-03 RISK-1 precedence, unchanged).
  if (authorityStatus !== 'admin' && deviceTrustStatus(db, device_id).revoked) return deny(4404, 'device_revoked')

  // A device admitted by the roster may have no devices row on this device (it enrolled elsewhere); the
  // advisory per-peer tombstone report below is keyed on it.
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(
    device_id,
    `Device ${device_id.slice(0, 8)}`
  )
  // Routing convenience only, never a trust signal (peerIdentity.js): it is how revokeDevice finds the live connection to
  // evict and how the redial/punch paths find a peer's address. The roster, not this column, decides admission.
  recordLibp2pPeerId(db, device_id, peerId)
  persistAppliedTombstones(db, device_id, appliedTombstones)

  return { ok: true, verified: { deviceId: device_id, userId: null } }
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
export function evaluatePairingRequest(db, { device_id, device_name, rejoin = false, sameCamp = false, schemaCompatible = true }) {
  if (!isNonEmptyString(device_id) || !isNonEmptyString(device_name)) {
    return { ok: false, reason: 'invalid_request' }
  }

  const existingDevice = db
    .prepare('SELECT authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?')
    .get(device_id)

  // An explicitly revoked device id is refused outright, by either route. Neither a typed code
  // nor a director's click may quietly undo a revoke; a removed machine comes back only as a new
  // device (new id), which the director approves as one.
  const authorityStatus = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(device_id)?.status
  if (existingDevice?.revoked_at || authorityStatus === 'revoked') {
    recordAuditEvent(db, { deviceId: device_id, actorUserId: null, action: rejoin ? 'device.rejoin_request' : 'device.pairing_request', outcome: 'deny', reason: 'device_revoked' })
    return { ok: false, reason: 'device_revoked' }
  }

  // Pair again: a device this camp already admitted, re-pairing because its discovery secrets went
  // stale. It must be a device this camp knows (a different camp's code reaches a Host that has
  // never seen it), and it waits for a director exactly like a first join — no idempotent
  // re-delivery of the old secret. Approval issues a new one.
  if (rejoin) {
    // `sameCamp`: the requester proved it belongs to THIS camp but this device never approved it
    // (it pairs through whichever device approved it). Otherwise it is a different camp's device.
    if (!existingDevice?.authorized_at) return { ok: false, reason: sameCamp ? 'not_known_here' : 'not_a_member' }
    // Refused before a director is asked: an approval across a schema gap would admit a device
    // that every sync exchange then refuses.
    if (!schemaCompatible) return { ok: false, reason: 'schema_mismatch' }
    db.prepare("UPDATE devices SET pairing_status = 'rejoin_pending' WHERE id = ?").run(device_id)
    recordAuditEvent(db, { deviceId: device_id, actorUserId: null, action: 'device.rejoin_request', outcome: 'allow' })
    return { ok: true, alreadyApproved: false }
  }

  // RedHat FM3/5/6 recovery: if this device is already authorized on the
  // Host (e.g. the Client received pairing_approved but failed to persist it
  // locally, or the connection dropped right after approval), re-deliver
  // pairing_approved with the stored secret rather than treating this as a
  // fresh unknown request. This makes the approval idempotent.
  if (existingDevice && existingDevice.authorized_at && existingDevice.device_secret_identifier) {
    return { ok: true, alreadyApproved: true, device_secret_identifier: existingDevice.device_secret_identifier }
  }

  // First-time or pending device: upsert without overwriting the name once
  // it's set (Security MEDIUM-2: prevents name spoofing on a pending device).
  // The name is the peer's own claim: strip invisible/bidi characters and cap it before storing.
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(device_id, sanitizePeerDeviceName(device_name, device_id))
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
  // Amendment 2026-10-03 (RISK-1) — identical precedence to evaluateAuthenticate above: an
  // admin wrongly locked out at the network gate must not separately fail login via this
  // same-class local-only check. authority_cache 'revoked' still denies unconditionally;
  // 'admin' skips the legacy trust gate (trust.row is still needed below for the device secret,
  // so `trust` itself is still fetched either way); no row falls straight back to today's check.
  const authorityStatus = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(device_id)?.status
  if (authorityStatus === 'revoked') {
    return { ok: false, reason: 'not_paired' }
  }
  if (authorityStatus !== 'admin' && (!trust.found || !trust.authorized || trust.revoked)) {
    return { ok: false, reason: 'not_paired' }
  }
  // Still required regardless of authorityStatus: the device-secret check below reads
  // trust.row, which is null when this device has no local `devices` row at all — a bypass
  // can waive the revoked_at/authorized_at CHECK, never the existence of the row it reads.
  if (!trust.row) {
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
