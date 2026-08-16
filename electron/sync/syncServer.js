import { WebSocketServer } from 'ws'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { verifySessionToken, attemptLogin, issueCampToken } from '../auth/localAuth.js'
import { acquireLock, expireLocks, releaseLocksForDevice } from './lockManager.js'
import {
  detectConflict,
  detectUniqueFieldCollision,
  appendOp,
  recordConflict,
  findOpByClientWriteId,
  appendBulkReplaceOp,
  detectBulkReplaceConflict,
} from '../ops/operations.js'
import { authorize } from '../auth/authorize.js'
import { deriveWriteAction, deriveBulkReplaceAction } from '../auth/deriveWriteAction.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { restoreEntity } from '../ops/restore.js'
import { CLEARABLE_ENTITIES, deleteRecord, mergeLocation } from '../ops/deleteRecord.js'
import { shouldThrottle, LOGIN_MIN_INTERVAL_MS, PAIRING_RATE_MS } from './rateLimit.js'

// The parent-scoped entities shipped in the first-pairing domain snapshot —
// deliberately excludes `schedule_snapshots` (see design doc Consequences:
// unbounded historical growth over a season, out of scope for this ticket).
// week_location_exclusions (v32) is the third instance of the v28 pattern and
// joins its two siblings here. NOTE: like its siblings, it is NOT yet in
// syncClient's DOMAIN_SNAPSHOT_TABLES, so a first-pairing Client currently drops
// these rows (they replicate to already-paired devices via the op log). That
// client-side snapshot gap predates this slice and is shared by all three
// week_*_exclusions tables; wiring the client snapshot for them is out of M1's
// scope (no week_location_exclusions rows exist until slice M5).
const DOMAIN_PARENT_SCOPED_ENTITIES = ['template_slots', 'template_overlays', 'day_override_template_slots', 'week_activity_exclusions', 'week_group_exclusions', 'week_location_exclusions']

// Task 10 round-5 Fix 4: report success/failure back to the caller instead
// of unconditionally swallowing it. sendMissedOps needs this to know exactly
// which missed op was the LAST one that genuinely made it out over the wire,
// so it can stop the watermark there instead of blindly advancing past ops
// that never actually sent.
function send(ws, message) {
  try {
    if (ws.readyState !== ws.OPEN) return false
    ws.send(JSON.stringify(message))
    return true
  } catch {
    // ignore send failures to dead/closing sockets — but tell the caller
    return false
  }
}

// Red Hat review follow-up: ws.send()'s completion callback is documented to
// go unfired in some destroy-path edge cases in the underlying `ws` library.
// Without a bound, that would hang this Promise forever. sendMissedOps's
// caller isn't awaited at its own call site, so this can't cascade into a
// connection- or process-wide freeze — but it would silently stall one
// device's catch-up with zero observability. SEND_ACK_TIMEOUT_MS races the
// ack against a bounded timeout and resolves false on expiry, matching the
// existing withResolverTimeout pattern in syncClient.js: settle-once guard,
// clear the timer on whichever path wins.
const SEND_ACK_TIMEOUT_MS = 8000

// Task 10 round-6 follow-up: a synchronous absence-of-exception from
// ws.send() is NOT proof of delivery. On a live-but-broken TCP connection,
// ws.send() commonly returns normally (readyState stays OPEN, nothing
// throws) while the actual write fails asynchronously — that failure only
// surfaces later via ws.send()'s optional completion callback (called with
// an Error on failure, undefined on success) or a subsequent close/error
// event. sendWithAck awaits that genuine confirmation instead of trusting
// the synchronous return, so callers (specifically sendMissedOps) can gate
// watermark advancement on real delivery, not just "didn't throw yet".
export function sendWithAck(ws, message, timeoutMs = SEND_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (ws.readyState !== ws.OPEN) {
      resolve(false)
      return
    }
    let settled = false
    let timer = null
    const settle = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      // The ws.send() callback never fired within the bound. Treat this the
      // same as an explicit ack-failure so sendMissedOps's loop breaks
      // cleanly and the watermark stays honest rather than advancing past
      // an unconfirmed op.
      settle(false)
    }, timeoutMs)
    try {
      ws.send(JSON.stringify(message), (err) => {
        settle(!err)
      })
    } catch {
      // Preserve round-5 behavior: a synchronous throw from ws.send() itself
      // (if the underlying implementation can still do that) is still
      // treated as an immediate failure.
      settle(false)
    }
  })
}

function sendError(ws) {
  if (ws.deviceId) {
    send(ws, { type: 'error', message: 'invalid request' })
  } else {
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

// T7 fix: how long the Host waits for the Client's application-level
// `full_sync_applied` ack (see waitForFullSyncAck below) after the transport
// send itself is confirmed. Generous vs. SEND_ACK_TIMEOUT_MS's 8s: this is a
// larger, one-time batch commit on the Client (every camp-scoped domain
// table), not a single op.
const FULL_SYNC_ACK_TIMEOUT_MS = 15000

// Resolves once this connection's Client sends `full_sync_applied`, or after
// timeoutMs elapses with no ack (resolves false either way on timeout — the
// Host must not latch last_synced_at on a transport-confirmed-but-never-
// -acked send). Only one full_sync is ever in flight per connection, since
// sendFullSyncIfFirstPairing's own last_synced_at guard prevents re-entry
// until the latch is actually set.
function waitForFullSyncAck(ws, timeoutMs = FULL_SYNC_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const settle = (result) => {
      if (settled) return
      settled = true
      // Clear the timer on whichever path settles first, exactly as
      // sendWithAck does above. Without this, an acked full-sync still left a
      // live 15s timer holding this socket: harmless-looking in production,
      // but it keeps the event loop busy and made the test suite's 5s-timeout
      // cases fail nondeterministically under load.
      if (timer) clearTimeout(timer)
      ws.pendingFullSyncAckResolve = null
      resolve(result)
    }
    ws.pendingFullSyncAckResolve = settle
    timer = setTimeout(() => settle(false), timeoutMs)
  })
}

// asOfSeq is not read by this function's own body — it is accepted purely so
// the caller (handleAuthenticate) can pass the SAME single, synchronously-
// computed value into both this function and sendMissedOps, per the design
// doc §2.5: the two must agree on the exact same instant, and passing it
// through here keeps that invariant true by construction rather than true
// only because nothing currently awaits between two independently-read values.
// eslint-disable-next-line no-unused-vars
async function sendFullSyncIfFirstPairing(db, ws, asOfSeq) {
  const device = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(ws.deviceId)
  if (!device || device.last_synced_at) return

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  const campId = camp?.id ?? null

  const users = db.prepare('SELECT id, camp_id, name, pin_hash, pin_salt, role FROM users').all()
  // signing_public_key travels the same way signing_secret always has — see
  // docs/adr/2026-07-25-device-trust-revocation.md: every device needs it to
  // verify a 'camp' token fully offline. host_signing_key (the PRIVATE half)
  // is a separate table, never selected here or anywhere else in this file.
  const camps = db.prepare('SELECT id, name, signing_secret, signing_public_key FROM camps').all()

  // Extend the same full_sync message with every camp-scoped domain table
  // (design doc §2.1) — reusing the exact registry/scoping logic main.js's
  // `list()` IPC handler uses, so "camp-scoped" can never mean two different
  // things between the renderer's read path and this snapshot. If there is
  // no camp row yet (should not be reachable via a real pairing flow, but
  // defensive), every domain table ships as an empty array rather than the
  // message being skipped, so the Client's applyFullSync still runs and the
  // rest of the handshake still completes.
  const domainTables = {}
  for (const entity of DIRECT_CAMP_ENTITIES) {
    domainTables[entity] = campId
      ? db.prepare(`SELECT * FROM ${entity} WHERE camp_id = ?`).all(campId)
      : []
  }
  for (const entity of DOMAIN_PARENT_SCOPED_ENTITIES) {
    const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
    domainTables[entity] = campId
      ? db.prepare(`SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ?`).all(campId)
      : []
  }

  const delivered = await sendWithAck(ws, { type: 'full_sync', users, camps, ...domainTables })
  if (!delivered) return // transport failure — no point waiting for an app-level ack that can't arrive

  // Corrected mechanism (design doc §2.4): a transport-confirmed send is NOT
  // proof the Client's applyFullSync transaction actually committed. Wait
  // for the Client's own `full_sync_applied` reply — sent only after that
  // transaction commits (syncClient.js) — before latching last_synced_at.
  const applied = await waitForFullSyncAck(ws)
  if (applied) {
    try {
      db.prepare('UPDATE devices SET last_synced_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        ws.deviceId
      )
    } catch {
      // The ack timeout can resolve up to FULL_SYNC_ACK_TIMEOUT_MS after this
      // function started — long enough that the Host's own db/process may
      // already be shutting down by the time this fires (e.g. test teardown,
      // or a genuine host restart). A closed-db error here must not become
      // an unhandled rejection; harmless either way, since a still-unset
      // last_synced_at simply means the next reconnect retries the snapshot.
    }
  }
  // applied === false: transport delivered, but no application ack arrived
  // within the timeout (Client's apply failed, or the ack itself was lost).
  // last_synced_at stays NULL either way — next reconnect retries the whole
  // snapshot from scratch, safe by construction since every insert on the
  // Client side is INSERT OR REPLACE.
}

// Task 10 round-4 Fix 3: reconnect catch-up. sendFullSyncIfFirstPairing only
// ever ships `users`/`camps`, and only once — it says nothing about the
// `operations` log. Without this, a device that recorded a conflict (via
// recordConflict on receiving op_conflict) and then went offline before the
// resolution op was broadcast can never learn the conflict was resolved:
// listPendingConflicts() on that device only clears a conflict once a
// matching parent_op_id op exists in ITS OWN local operations table, and
// that op will never arrive on its own.
//
// Fix: on every authenticate (not just first pairing), send any `operations`
// rows with seq greater than this device's last-seen watermark, as
// `op_applied` messages — the exact same message shape/type the client
// already handles for a live write, so it flows through the existing
// applyRemoteOp path (idempotent INSERT ... ON CONFLICT DO NOTHING) with no
// new client-side code required. That in turn means a previously-missed
// resolution op lands in the device's local operations table, so the next
// listPendingConflicts() call on that device correctly reports the conflict
// as resolved.
//
// Scope: this covers exactly one thing — a reconnecting device catching up
// on missed `operations` rows (which is sufficient to fix stale conflict
// status). It does NOT re-deliver missed op_conflict notifications
// themselves (a conflict that was recorded live already persisted itself
// via recordConflict before this device went offline, so it doesn't need
// resending) and it does NOT solve general catch-up of every other message
// type (e.g. lock state). A device's very first authenticate only
// establishes its watermark baseline (see sendMissedOps below) — it does
// NOT replay the full pre-existing op history, so pre-existing conflicts
// from before a device's first connection are out of scope too.
function currentMaxOpSeq(db) {
  const row = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get()
  return row && Number.isInteger(row.maxSeq) ? row.maxSeq : 0
}

// Exported for direct unit testing (Task 10 round-5 Fix 4): a real,
// deterministic mid-replay socket failure is impractical to force reliably
// over an actual network socket in a test, so the partial-send-failure path
// is tested by calling this directly against a real SQLite db with a
// controlled fake `ws` object whose send() throws on a specific op.
// asOfSeq (design doc §2.5): the caller (handleAuthenticate) computes
// currentMaxOpSeq(db) synchronously ONCE and passes the SAME value into both
// this function and sendFullSyncIfFirstPairing, so a write landing between
// two separately-computed baselines can never end up claimed as "already
// seen" by the watermark while also missing the domain snapshot (or vice
// versa). This is a signature change to an exported, directly-unit-tested
// function — every existing direct call site must pass asOfSeq explicitly.
export async function sendMissedOps(db, ws, asOfSeq, ackTimeoutMs = SEND_ACK_TIMEOUT_MS) {
  const device = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(ws.deviceId)

  if (!device || device.last_synced_seq === null || device.last_synced_seq === undefined) {
    // First time this device's watermark is being established: baseline it
    // to "everything that exists right now" WITHOUT sending it. A device
    // connecting for the very first time doesn't need the entire
    // pre-existing op history replayed at it just to learn its own
    // watermark — that's out of scope here (see the Fix 3 comment above).
    // From this point on, only ops created AFTER this moment are missed-op
    // candidates for this device.
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(
      asOfSeq,
      ws.deviceId
    )
    return
  }

  const since = device.last_synced_seq
  const rows = db.prepare('SELECT * FROM operations WHERE seq > ? ORDER BY seq ASC').all(since)
  if (rows.length === 0) return

  // Task 10 round-5 Fix 4: only advance the watermark up to the seq of the
  // LAST successfully-sent op, not blindly to the max seq among ALL
  // candidate rows. Previously, if the connection dropped partway through
  // this replay loop, the watermark still jumped to maxSeq over every row —
  // falsely marking undelivered ops as delivered and silently, permanently
  // losing them from this device's perspective (they'd never be re-sent on
  // the next reconnect, since the watermark already claims they were seen).
  // Stop advancing at the first send failure: ops are sent in seq order, so
  // once one fails there's no guarantee later ones over the same dead/dying
  // socket would succeed either, and even if a later one happened to get
  // through, correctness requires no gaps below the watermark.
  // Task 10 round-6 follow-up: gate advancement on genuine async delivery
  // confirmation (sendWithAck), not just the absence of a synchronous throw.
  // We also re-check readyState via sendWithAck before every op — if the
  // socket closed/errored between one op's callback confirming success and
  // the next op's send being attempted, sendWithAck fails fast without
  // calling ws.send() again on a now-dead socket, and the loop stops there.
  let lastSuccessSeq = since
  for (const op of rows) {
    const ok = await sendWithAck(ws, { type: 'op_applied', op }, ackTimeoutMs)
    if (!ok) break
    if (op.seq > lastSuccessSeq) lastSuccessSeq = op.seq
  }
  if (lastSuccessSeq !== since) {
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(lastSuccessSeq, ws.deviceId)
  }
}

function handleAuthenticate(db, ws, msg) {
  const verified = verifySessionToken(db, msg.token)
  if (!verified || verified.deviceId !== msg.device_id) {
    // 4401: custom app-level close code (WS custom range is 4000-4999) so a
    // client-side close handler CAN distinguish this from an ordinary
    // network drop if it ever wants to (Red Hat: today's syncClient.js does
    // not branch on this yet — closing the observability gap is left to
    // whichever sub-task next touches the client reconnect UX, but the
    // signal is now actually present on the wire rather than absent).
    ws.close(4401, 'invalid_token')
    return
  }

  // A 'local' token is this-device-only by design (HMAC'd with a device's
  // own device_secret_identifier — see localAuth.js's issueLocalToken /
  // verifySessionToken) and must never be accepted as proof of network
  // trust, per docs/adr/2026-07-25-device-trust-revocation.md §3. Rejected
  // outright here rather than relying on signature mismatch alone, since a
  // 'local' token from THIS SAME device (or one whose secret it somehow
  // knows) would otherwise verify successfully.
  if (verified.type !== 'camp') {
    ws.close(4402, 'local_token_not_valid_for_network')
    return
  }

  // Self-registration is allowed regardless of authorization status (a
  // brand-new device must get a `devices` row to exist at all before it can
  // ever be authorized), but connection ACCEPTANCE is gated on
  // authorized_at/revoked_at, re-checked fresh here rather than cached —
  // same revocation-enforcement rule authorize() applies on every IPC call.
  // Self-register this device on the Host if it has never been seen before.
  // Without this, a genuinely new device connecting for the first time has no
  // `devices` row, sendFullSyncIfFirstPairing's lookup returns undefined, and
  // the first-pairing full_sync silently never fires. INSERT OR IGNORE makes
  // this a safe no-op for an already-known device (own-machine registration
  // via ensureDeviceRow in main.js, or a returning peer). pairing_status
  // defaults to 'pending' — a device row existing no longer implies it may
  // log in (docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md).
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')"
  ).run(verified.deviceId, `Device ${verified.deviceId.slice(0, 8)}`)

  const deviceRow = db
    .prepare('SELECT authorized_at, revoked_at FROM devices WHERE id = ?')
    .get(verified.deviceId)
  if (!deviceRow || !deviceRow.authorized_at) {
    recordAuditEvent(db, {
      actorUserId: verified.userId,
      deviceId: verified.deviceId,
      action: 'auth.authenticate',
      outcome: 'deny',
      reason: 'device_not_authorized',
      metadata: verified.jti ? { jti: verified.jti } : null,
    })
    ws.close(4403, 'device_not_authorized')
    return
  }
  if (deviceRow.revoked_at) {
    recordAuditEvent(db, {
      actorUserId: verified.userId,
      deviceId: verified.deviceId,
      action: 'auth.authenticate',
      outcome: 'deny',
      reason: 'device_revoked',
      metadata: verified.jti ? { jti: verified.jti } : null,
    })
    ws.close(4404, 'device_revoked')
    return
  }

  ws.deviceId = verified.deviceId
  ws.userId = verified.userId
  // Stored so later authorize() calls on this connection (acquire_lock,
  // submit_op, submit_bulk_replace_op) can re-verify via the SAME
  // already-authenticated session token, never a client-claimed field from
  // a later message body. authorize()'s "always re-verify via
  // verifySessionToken" guarantee (electron/auth/authorize.js) requires a
  // real token, not just the derived userId/deviceId already set above.
  ws.token = msg.token

  // Computed once, synchronously, here — before either call below, and
  // before either has a chance to await anything. Both
  // sendFullSyncIfFirstPairing's row snapshot and sendMissedOps's own
  // first-time watermark baseline must agree on the exact same instant, or a
  // write landing between two separately-computed values could end up in
  // neither the snapshot nor any future replay (design doc §2.5). Nothing
  // between here and the two calls below yields to the event loop, so this
  // is the one instant both need.
  const asOfSeq = currentMaxOpSeq(db)

  // Fire-and-forget, per this file's existing convention (sendMissedOps was
  // already un-awaited here before this change) — handleAuthenticate must
  // not block on either completing.
  sendFullSyncIfFirstPairing(db, ws, asOfSeq)
  sendMissedOps(db, ws, asOfSeq)
}

function validateLoginMsg(msg) {
  // device_secret_identifier is optional for backward compat with pre-sub-task-2 tests
  return isNonEmptyString(msg.device_id) && isNonEmptyString(msg.name) && isNonEmptyString(msg.pin)
}

function validateAcquireLockMsg(msg) {
  return isNonEmptyString(msg.entity) && isNonEmptyString(msg.entity_id) && isNonEmptyString(msg.field)
}

// The throttle constants and the "is this too soon?" rule live in
// ./rateLimit.js so they can be tested by arithmetic rather than by racing a
// real clock against scryptSync. See T26.

function handleLogin(db, ws, msg, now) {
  if (!validateLoginMsg(msg)) return

  // Sub-task 4: require device to be paired and secret to match BEFORE touching PIN
  // or the per-connection throttle. This closes "any device on the LAN can
  // attempt PIN guesses" (§6.3). The two rejection paths intentionally return
  // the same opaque 'login_failed' response with no reason field — leaking
  // distinct reasons would create a device-existence/authorization oracle
  // (Security review finding 4).
  const deviceRow = db.prepare('SELECT authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?').get(msg.device_id)
  if (!deviceRow || !deviceRow.authorized_at || deviceRow.revoked_at) {
    send(ws, { type: 'login_failed' })
    return
  }
  // Constant-time comparison for the 64-char hex device secret to prevent
  // timing side-channels (Security review finding 3).
  const storedSecret = deviceRow.device_secret_identifier
  const providedSecret = typeof msg.device_secret_identifier === 'string' ? msg.device_secret_identifier : ''
  let secretOk = false
  if (storedSecret && storedSecret.length === providedSecret.length) {
    try {
      secretOk = timingSafeEqual(Buffer.from(storedSecret), Buffer.from(providedSecret))
    } catch {
      secretOk = false
    }
  }
  if (!secretOk) {
    send(ws, { type: 'login_failed' })
    return
  }

  // Throttle: a message arriving faster than LOGIN_MIN_INTERVAL_MS since this
  // connection's last login attempt is dropped silently before it ever
  // reaches attemptLogin, so it cannot touch the login_attempts lockout
  // counter. Silent drop (vs. an explicit throttled reply) matches this
  // file's existing convention for rejecting bad input (see the malformed
  // message and validateLoginMsg early-returns above) and keeps the
  // unauthenticated surface from being handed a way to trigger extra replies.
  const at = now()
  if (shouldThrottle(ws.lastLoginAttemptAt, at, LOGIN_MIN_INTERVAL_MS)) {
    return
  }
  ws.lastLoginAttemptAt = at

  const result = attemptLogin(db, { name: msg.name, pin: msg.pin, deviceId: msg.device_id })

  if (!result) {
    send(ws, { type: 'login_failed' })
    return
  }
  if (result.locked) {
    send(ws, { type: 'login_failed', locked: true, retryAfterMs: result.retryAfterMs })
    return
  }
  send(ws, { type: 'login_ok', token: result.token, userId: result.userId, role: result.role })
}

function validateSubmitOpMsg(msg) {
  const op = msg.op
  if (!op || typeof op !== 'object') return false
  if (!isNonEmptyString(op.entity)) return false
  if (!isNonEmptyString(op.entity_id)) return false
  if (!isNonEmptyString(op.field)) return false
  if (!(op.parent_op_id === null || isNonEmptyString(op.parent_op_id))) return false
  // client_write_id (Task 10 round-5 Fix 3) is optional for backward
  // compatibility with older clients / callers that don't set it, but if
  // present it must be a non-empty string so it's safe to use as a dedup key.
  if (!(op.client_write_id === undefined || op.client_write_id === null || isNonEmptyString(op.client_write_id))) return false
  return true
}

// Message-shape validation for the new bulk_replace submission type, run
// BEFORE handleSubmitBulkReplaceOp (and therefore before any DB access),
// exactly matching validateSubmitOpMsg's pattern above. Deep row-shape
// validation (per-row required fields/types) happens one layer deeper, in
// operations.js's validateBulkReplaceRows (called from appendBulkReplaceOp)
// - this function only confirms the message is well-formed enough to
// dispatch at all: entity/scope_id are non-empty strings, rows is an array.
function validateSubmitBulkReplaceMsg(msg) {
  const op = msg.op
  if (!op || typeof op !== 'object') return false
  if (!isNonEmptyString(op.entity)) return false
  if (!isNonEmptyString(op.scope_id)) return false
  if (!Array.isArray(op.rows)) return false
  if (!(op.client_write_id === undefined || op.client_write_id === null || isNonEmptyString(op.client_write_id))) return false
  // based_on_seq (round 2, conflict-detection wiring): optional for backward
  // compatibility with any pre-existing caller, but if present must be a
  // non-negative integer — detectBulkReplaceConflict normalizes an absent/
  // invalid value to 0 (strictest behavior), so this is just a shape check.
  if (!(op.based_on_seq === undefined || op.based_on_seq === null || (Number.isInteger(op.based_on_seq) && op.based_on_seq >= 0))) return false
  return true
}

// This is the actual network trust boundary for a Host process — any device
// that has completed the `authenticate` handshake can otherwise reach these
// handlers directly over the WS listener, bypassing the renderer/IPC path
// entirely. authorize() is called with THIS connection's already-verified
// ws.token (set in handleAuthenticate from the authenticate message's own
// token, itself already verified via verifySessionToken during the
// handshake) — never from a client-claimed field inside the mutating
// message body (e.g. msg.op.device_id) — so a staff-role device cannot
// forge a different identity by lying in submit_op/acquire_lock payloads.
function authorizeWs(db, ws, action) {
  return authorize({ db, token: ws.token, action })
}

function handleAcquireLock(db, ws, msg) {
  // Per the ADR's WS table: a lock is acquired as a precondition to a write
  // on that entity/field, so it reuses the entity's write action rather
  // than an independent locks.* privilege.
  const action = deriveWriteAction({ entity: msg.entity, field: msg.field })
  if (!authorizeWs(db, ws, action).allowed) {
    sendError(ws)
    return
  }
  const result = acquireLock(db, {
    entity: msg.entity,
    entity_id: msg.entity_id,
    field: msg.field,
    device_id: ws.deviceId,
  })
  send(ws, { type: 'lock_result', granted: result.granted, ...(result.holder_device_id ? { holder_device_id: result.holder_device_id } : {}) })
}

function handleSubmitOp(db, wss, ws, msg) {
  const action = deriveWriteAction({ entity: msg.op.entity, field: msg.op.field })
  if (!authorizeWs(db, ws, action).allowed) {
    sendError(ws)
    return
  }
  // S2a Security V1 (CRITICAL): the Host is the originator of record for a
  // peer's submitted field write. FORCE source:'human' and NEVER copy
  // msg.op.source — a submitted op must never be able to introduce 'import'
  // provenance (which would flip a victim's hand-edited field to import-owned
  // and let the next import silently overwrite it, bypassing the S2b gate).
  // 'import' is producible ONLY by host-local commitPlan. Unlike author_user_id
  // (which IS client-asserted on this path), source is host-derived here.
  const incomingOp = { ...msg.op, device_id: ws.deviceId, source: 'human' }

  // Task 10 round-5 Fix 3: idempotency-at-the-logical-write-level. If a
  // submit_op carrying this client_write_id was already applied (e.g. the
  // original submission WAS applied server-side but its op_applied reply
  // never reached the client — timeout/disconnect mid-flight — and the
  // client's flushQueue retried the same logical write), return the
  // ORIGINAL op instead of running detectConflict/appendOp again. Running
  // detectConflict on a replay would spuriously report a conflict (the
  // replay's parent_op_id points at the state BEFORE the original op, but
  // the original op is now itself the latest op for this entity/field) and
  // appendOp would mint a second, distinct op id for the same logical write.
  if (incomingOp.client_write_id) {
    const already = findOpByClientWriteId(db, incomingOp.client_write_id)
    if (already) {
      send(ws, { type: 'op_applied', op: already })
      return
    }
  }

  const { conflict, existingOp } = detectConflict(db, incomingOp)
  if (conflict) {
    // Persist so this conflict survives a restart of the host, even if the
    // submitting device never receives/persists the op_conflict message
    // itself (e.g. it disconnects before the reply arrives).
    try {
      recordConflict(db, { incomingOp, existingOp })
    } catch {
      // best-effort: persistence failure must never block the conflict
      // notification the submitting device is waiting on
    }
    send(ws, { type: 'op_conflict', incomingOp, existingOp })
    return
  }

  // D2/D3 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
  // an app-level UNIQUE(camp_id, name) collision detectConflict cannot see
  // (it spans a DIFFERENT entity_id, not this one). Checked before appendOp
  // so the doomed write is never attempted — appendOp's own transaction
  // would otherwise roll back the whole thing on SQLITE_CONSTRAINT_UNIQUE,
  // but only after propagating a generic, uncorrelated error the Client has
  // no case for (see the ADR's Path 2). Never call appendOp on a hit.
  const collision = detectUniqueFieldCollision(db, incomingOp)
  if (collision) {
    send(ws, {
      type: 'op_rejected',
      op: incomingOp,
      reason: 'unique_field',
      field: incomingOp.field,
      existing: { id: collision.id, name: collision.name, capacity: collision.capacity, notes: collision.notes },
    })
    return
  }

  const op = appendOp(db, incomingOp)
  for (const client of wss.clients) {
    if (client.deviceId) {
      try {
        if (client.readyState === client.OPEN) {
          send(client, { type: 'op_applied', op })
        }
      } catch {
        // never let one dead client stop the broadcast to others
      }
    }
  }
}

// Host-side handling of a bulk_replace submission. Distinct from
// handleSubmitOp, dispatched by its own `submit_bulk_replace_op` message
// type (rather than overloading `submit_op`'s op shape) so the existing
// field-level path is untouched and the two remain easy to reason about
// independently.
//
// Idempotency: same client_write_id pattern as handleSubmitOp - if a
// bulk_replace with this client_write_id was already applied (e.g. the
// original submission's op_applied reply never reached the client and it
// retried), return the ORIGINAL op rather than re-running
// appendBulkReplaceOp. A delete-then-reinsert replay would be harmless for
// the resulting template_slots ROWS themselves (same full-replace payload
// twice is idempotent at the data level), but without this check the
// op-log would still gain a spurious duplicate entry on every retry.
//
// Conflict detection (round 2 — replaces round 1's unconditional skip,
// which GOVERNOR round 1 flagged CRITICAL: it let a bulk_replace silently
// clobber a concurrent field-level edit to a row in its scope with zero
// conflict ever recorded). See the extended mechanism comment on
// BULK_REPLACE_FIELD / detectBulkReplaceConflict in operations.js for the
// full "what does based_on_seq mean" design; this is the call site.
// Ordering matters: the idempotency check above (same client_write_id ==
// already applied) MUST run first and return early — a retried submission
// of an op this Host already applied must short-circuit to the original
// op, not get re-run through conflict detection against the effect IT
// ITSELF already produced (that would spuriously self-conflict, since the
// bulk_replace's own prior application is exactly the "newer op" a naive
// re-check would find).
//
// Malformed/partial rows: appendBulkReplaceOp validates row shape BEFORE
// touching the DB (see validateBulkReplaceRows) and throws synchronously on
// a bad payload, without ever starting the delete+insert transaction. The
// try/catch here is defense-in-depth on top of that validation (also
// catching a genuine mid-transaction DB failure, e.g. a duplicate row id,
// which appendBulkReplaceOp's transaction already rolls back) - not a
// substitute for it.
function handleSubmitBulkReplaceOp(db, wss, ws, msg) {
  const { entity, scope_id, rows, client_write_id, based_on_seq } = msg.op

  if (!authorizeWs(db, ws, deriveBulkReplaceAction(entity)).allowed) {
    sendError(ws)
    return
  }

  if (client_write_id) {
    const already = findOpByClientWriteId(db, client_write_id)
    if (already) {
      send(ws, { type: 'op_applied', op: already })
      return
    }
  }

  const incomingOp = { entity, entity_id: scope_id, field: '__bulk_replace__', scope_id, rows, based_on_seq, device_id: ws.deviceId }
  const { conflict, existingOp, currentSeq } = detectBulkReplaceConflict(db, { entity, scope_id, based_on_seq })
  if (conflict) {
    // Persist so this conflict survives a Host restart even if the
    // submitting device never receives/persists the op_conflict reply
    // itself, mirroring handleSubmitOp's field-level conflict path above.
    try {
      recordConflict(db, { incomingOp, existingOp })
    } catch {
      // best-effort: persistence failure must never block the conflict
      // notification the submitting device is waiting on
    }
    send(ws, { type: 'op_conflict', incomingOp, existingOp })
    return
  }

  let op
  try {
    op = appendBulkReplaceOp(db, {
      entity,
      scope_id,
      rows,
      author_user_id: ws.userId,
      device_id: ws.deviceId,
      client_write_id,
      // Chain this bulk_replace to whatever op it was actually based on
      // (currentSeq's op — could be a prior bulk_replace on this scope, a
      // field-level edit to a row in it, or null for a brand-new scope),
      // so the op-log records real scope-level provenance the same way a
      // field-level op's parent_op_id does.
      parent_op_id: currentSeq ? db.prepare('SELECT id FROM operations WHERE seq = ?').get(currentSeq)?.id ?? null : null,
    })
  } catch {
    sendError(ws)
    return
  }

  for (const client of wss.clients) {
    if (client.deviceId) {
      try {
        if (client.readyState === client.OPEN) {
          send(client, { type: 'op_applied', op })
        }
      } catch {
        // never let one dead client stop the broadcast to others
      }
    }
  }
}

function validateRestoreRequestMsg(msg) {
  return (
    isNonEmptyString(msg.request_id) && isNonEmptyString(msg.entity) && isNonEmptyString(msg.entity_id)
  )
}

// Shared by restore/delete/merge — each commits a multi-op host-atomic
// transaction and then broadcasts every resulting op to every OTHER
// connected, authenticated client. This nested loop used to be hand-copied
// 3x (M3c's merge handler was the 5th near-identical copy in this file
// counting the two single-op broadcasts elsewhere); collapsed here so a
// future 6th caller can't reintroduce the deviceId/readyState guard
// incorrectly.
function broadcastOps(wss, ops) {
  for (const op of ops) {
    for (const client of wss.clients) {
      if (!client.deviceId) continue
      try {
        if (client.readyState === client.OPEN) send(client, { type: 'op_applied', op })
      } catch {
        // never let one dead client stop the broadcast to others
      }
    }
  }
}

// Host-side handling of a Client's restore request
// (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §5).
//
// The Host is the only device guaranteed to hold the record's op history: a
// first-pairing Client receives materialized rows and a watermark, never the
// prior log. So a Client asks; the Host reads and appends; the ops replicate
// back through the ordinary broadcast.
//
// Order of checks is load-bearing:
//   1. authorize as '<entity>.restore'. Admin-only by construction — the
//      action is absent from PERMISSIONS.staff, and admin holds '*'.
//      deriveWriteAction is deliberately NOT reused: a restore must never
//      derive to '<entity>.write', which staff hold.
//   2. the allowlist, checked inside restoreEntity BEFORE it reads the log,
//      so no path reaches the history of a refused entity (`users` above all).
//   3-5. still-deleted, creation op present, last value per field.
//   6. append inside one transaction, then broadcast — never the reverse.
//      Broadcasting from inside the transaction would announce ops that could
//      still roll back.
function handleRestoreRequest(db, wss, ws, msg) {
  const { request_id, entity, entity_id } = msg

  if (!authorizeWs(db, ws, `${entity}.restore`).allowed) {
    send(ws, { type: 'restore_result', request_id, error: 'forbidden' })
    return
  }

  const result = restoreEntity(db, {
    entity,
    entity_id,
    author_user_id: ws.userId,
    device_id: ws.deviceId,
  })

  if (result.error) {
    // Finding A (addendum): restoreEntity's 'unique_field' refusal carries
    // two extra fields (field, existing) beyond the four pre-existing error
    // strings — forward them only when present so the other refusal reasons
    // are byte-identical to before. requestRestore's `if (reply.error)`
    // branch (syncClient.js) is generic over the error value, so no
    // Client-side change is required to receive these.
    send(ws, {
      type: 'restore_result',
      request_id,
      error: result.error,
      ...(result.field ? { field: result.field } : {}),
      ...(result.existing ? { existing: result.existing } : {}),
    })
    return
  }

  broadcastOps(wss, result.ops)

  send(ws, {
    type: 'restore_result',
    request_id,
    ok: true,
    restored_fields: result.restored_fields,
    deleted_children: result.deleted_children,
  })
}

function validateDeleteRecordRequestMsg(msg) {
  return (
    isNonEmptyString(msg.request_id) &&
    isNonEmptyString(msg.entity) &&
    isNonEmptyString(msg.entity_id) &&
    (msg.expected_slot_count === undefined || Number.isInteger(msg.expected_slot_count))
  )
}

function validateMergeLocationRequestMsg(msg) {
  return (
    isNonEmptyString(msg.request_id) &&
    isNonEmptyString(msg.loser_id) &&
    isNonEmptyString(msg.winner_id) &&
    (msg.winner_capacity === undefined || msg.winner_capacity === null || Number.isInteger(msg.winner_capacity)) &&
    (msg.expected_ref_count === undefined || Number.isInteger(msg.expected_ref_count))
  )
}

// Host-side handling of a Client's location merge (M3c, docs/adr/2026-08-15-
// locations-merge-and-delete-rehome.md D1 Open Q1). Mirrors
// handleDeleteRecordRequest exactly — same reasoning: one transaction over
// many ops, which submit_op cannot express, and never queued (a merge
// executed later against a stale ref_count is not the merge the director
// agreed to). Gated 'locations.delete' — merging DELETES the loser, the same
// action deriveWriteAction derives for a DELETE_FIELD write on locations.
function handleMergeLocationRequest(db, wss, ws, msg) {
  const { request_id, loser_id, winner_id, winner_capacity, expected_ref_count } = msg

  if (!authorizeWs(db, ws, 'locations.delete').allowed) {
    send(ws, { type: 'merge_location_result', request_id, error: 'forbidden' })
    return
  }

  let result
  try {
    result = mergeLocation(db, {
      loser_id,
      winner_id,
      winner_capacity,
      expected_ref_count,
      author_user_id: ws.userId,
      device_id: ws.deviceId,
    })
  } catch {
    send(ws, { type: 'merge_location_result', request_id, error: 'merge-failed' })
    return
  }

  if (result.error) {
    send(ws, { type: 'merge_location_result', request_id, ...result })
    return
  }

  // Broadcast AFTER the transaction committed, never from inside it.
  broadcastOps(wss, result.ops)

  const { ops, ...reportable } = result
  send(ws, { type: 'merge_location_result', request_id, ...reportable, ops_written: ops.length })
}

// Host-side handling of a Client's delete of a record a schedule uses
// (docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md).
//
// Mirrors handleRestoreRequest, and for the same reason: the whole operation is
// one transaction over many ops, which `submit_op` cannot express. Gated as
// '<entity>.delete' — the same action deriveWriteAction already derives for a
// DELETE_FIELD write, so this adds no new authorization surface.
//
// Unlike a restore, a delete is never queued when the Host is away: see
// deleteRecord.js on why a delete executed against a stale count is not a
// delete the director agreed to.
function handleDeleteRecordRequest(db, wss, ws, msg) {
  const { request_id, entity, entity_id, expected_slot_count } = msg

  if (!authorizeWs(db, ws, `${entity}.delete`).allowed) {
    send(ws, { type: 'delete_record_result', request_id, error: 'forbidden' })
    return
  }
  if (!CLEARABLE_ENTITIES.has(entity)) {
    send(ws, { type: 'delete_record_result', request_id, error: 'not-clearable' })
    return
  }

  let result
  try {
    result = deleteRecord(db, {
      entity,
      entity_id,
      expected_slot_count,
      author_user_id: ws.userId,
      device_id: ws.deviceId,
    })
  } catch {
    send(ws, { type: 'delete_record_result', request_id, error: 'delete-failed' })
    return
  }

  if (result.error) {
    send(ws, { type: 'delete_record_result', request_id, ...result })
    return
  }

  // Broadcast AFTER the transaction committed, never from inside it.
  broadcastOps(wss, result.ops)

  const { ops, ...reportable } = result
  send(ws, { type: 'delete_record_result', request_id, ...reportable, ops_written: ops.length })
}

// Max pending pairing connections at once (Security: prevents Map/WS handle
// exhaustion via LAN flood of pairing_request messages).
const MAX_PENDING_PAIRING = 50
// Minimum interval between pairing_request messages from the same device_id
// (Security: per-device rate limit to bound DB write frequency).

// `now` is injectable so the rate limits can be tested deterministically; it
// defaults to the real clock, which is what ships. See T26.
export function startSyncServer(db, { port, onPairingRequest, now = Date.now } = {}) {
  const wss = new WebSocketServer({ port })
  // Map of device_id -> ws for devices waiting for pairing approval
  const pendingPairingConnections = new Map()
  // Map of device_id -> timestamp for per-device pairing_request rate limiting
  const lastPairingRequestTime = new Map()

  wss.on('error', () => {
    // defense-in-depth: swallow bind failures (e.g. EADDRINUSE) so an
    // underlying port collision cannot crash the whole process via Node's
    // default "throw on unhandled EventEmitter error" behavior.
  })

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return
      }

      try {
        // pairing_request: unauthenticated, handled before the !ws.deviceId guard.
        if (msg.type === 'pairing_request') {
          const { device_id, device_name } = msg
          if (!isNonEmptyString(device_id) || !isNonEmptyString(device_name)) {
            sendError(ws)
            return
          }

          // Security: rate-limit per device_id to prevent DB flood.
          const at = now()
          const lastReq = lastPairingRequestTime.get(device_id)
          if (shouldThrottle(lastReq, at, PAIRING_RATE_MS)) {
            ws.close()
            return
          }
          lastPairingRequestTime.set(device_id, at)

          // Security: cap total pending connections to prevent Map/WS handle exhaustion.
          if (pendingPairingConnections.size >= MAX_PENDING_PAIRING) {
            ws.close()
            return
          }

          // RedHat FM3/5/6 recovery: if this device is already authorized on the
          // Host (e.g. the Client received pairing_approved but failed to persist
          // it locally, or the WS dropped right after approval), re-deliver
          // pairing_approved with the stored secret rather than treating this as
          // a fresh unknown request. This makes the approval idempotent.
          const existingDevice = db.prepare('SELECT authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?').get(device_id)
          if (existingDevice && existingDevice.authorized_at && !existingDevice.revoked_at && existingDevice.device_secret_identifier) {
            send(ws, { type: 'pairing_approved', device_secret_identifier: existingDevice.device_secret_identifier })
            return
          }

          // First-time or pending device: upsert without overwriting the name once
          // it's set (Security MEDIUM-2: prevents name spoofing on a pending device).
          db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(device_id, device_name)
          // Only update pairing_status, not the name — the first-seen name wins.
          db.prepare("UPDATE devices SET pairing_status = 'pending' WHERE id = ? AND (pairing_status IS NULL OR pairing_status = 'pending')").run(device_id)

          pendingPairingConnections.set(device_id, ws)
          ws.pendingDeviceId = device_id
          recordAuditEvent(db, { deviceId: device_id, actorUserId: null, action: 'device.pairing_request', outcome: 'allow' })
          if (typeof onPairingRequest === 'function') onPairingRequest(device_id, device_name)
          return
        }

        if (msg.type === 'authenticate') {
          handleAuthenticate(db, ws, msg)
          return
        }

        if (msg.type === 'login') {
          handleLogin(db, ws, msg, now)
          return
        }

        if (!ws.deviceId) return

        // Client -> Host application-level ack that the full_sync batch
        // actually committed (design doc §2.4) — only ever sent after
        // `authenticate` has already set ws.deviceId, so this sits alongside
        // the other authenticated-only branches below.
        if (msg.type === 'full_sync_applied') {
          if (ws.pendingFullSyncAckResolve) ws.pendingFullSyncAckResolve(true)
          return
        }

        // renew_token: authenticated only
        if (msg.type === 'renew_token') {
          const verified = verifySessionToken(db, msg.token)
          if (!verified || verified.deviceId !== ws.deviceId || verified.type !== 'camp') {
            send(ws, { type: 'token_renewal_failed', reason: 'invalid_token' })
            return
          }
          const renewDeviceRow = db.prepare('SELECT authorized_at, revoked_at FROM devices WHERE id = ?').get(ws.deviceId)
          if (!renewDeviceRow || !renewDeviceRow.authorized_at || renewDeviceRow.revoked_at) {
            const reason = renewDeviceRow?.revoked_at ? 'device_revoked' : 'device_not_authorized'
            send(ws, { type: 'token_renewal_failed', reason })
            if (renewDeviceRow?.revoked_at) ws.close(4404, 'device_revoked')
            return
          }
          const newToken = issueCampToken(db, verified.userId, ws.deviceId)
          send(ws, { type: 'token_renewed', token: newToken })
          return
        }

        if (msg.type === 'acquire_lock') {
          if (!validateAcquireLockMsg(msg)) {
            sendError(ws)
            return
          }
          handleAcquireLock(db, ws, msg)
        } else if (msg.type === 'submit_op') {
          if (!validateSubmitOpMsg(msg)) {
            sendError(ws)
            return
          }
          handleSubmitOp(db, wss, ws, msg)
        } else if (msg.type === 'restore_request') {
          if (!validateRestoreRequestMsg(msg)) {
            sendError(ws)
            return
          }
          handleRestoreRequest(db, wss, ws, msg)
        } else if (msg.type === 'delete_record_request') {
          if (!validateDeleteRecordRequestMsg(msg)) {
            sendError(ws)
            return
          }
          handleDeleteRecordRequest(db, wss, ws, msg)
        } else if (msg.type === 'merge_location_request') {
          if (!validateMergeLocationRequestMsg(msg)) {
            sendError(ws)
            return
          }
          handleMergeLocationRequest(db, wss, ws, msg)
        } else if (msg.type === 'submit_bulk_replace_op') {
          if (!validateSubmitBulkReplaceMsg(msg)) {
            sendError(ws)
            return
          }
          handleSubmitBulkReplaceOp(db, wss, ws, msg)
        }
      } catch {
        sendError(ws)
      }
    })

    ws.on('close', () => {
      if (ws.pendingDeviceId) {
        pendingPairingConnections.delete(ws.pendingDeviceId)
      }
      if (ws.deviceId) {
        try {
          releaseLocksForDevice(db, ws.deviceId)
        } catch {
          // ignore errors releasing locks on disconnect
        }
      }
    })
  })

  const expiryInterval = setInterval(() => expireLocks(db, 60_000), 30_000)

  return {
    wss,
    close() {
      clearInterval(expiryInterval)
      wss.close()
    },
    sendPairingApproved(deviceId, deviceSecretIdentifier) {
      const ws = pendingPairingConnections.get(deviceId)
      if (!ws) return false
      send(ws, { type: 'pairing_approved', device_secret_identifier: deviceSecretIdentifier })
      pendingPairingConnections.delete(deviceId)
      return true
    },
    sendPairingDenied(deviceId) {
      const ws = pendingPairingConnections.get(deviceId)
      if (!ws) return false
      send(ws, { type: 'pairing_denied' })
      pendingPairingConnections.delete(deviceId)
      return true
    },
  }
}
