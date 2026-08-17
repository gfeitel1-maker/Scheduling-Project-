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
import { deviceTrustStatus, deviceTrustReason } from '../auth/deviceTrust.js'
import { deriveWriteAction, deriveBulkReplaceAction } from '../auth/deriveWriteAction.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { restoreEntity } from '../ops/restore.js'
import { CLEARABLE_ENTITIES, deleteRecord, mergeLocation } from '../ops/deleteRecord.js'
import { shouldThrottle, LOGIN_MIN_INTERVAL_MS, PAIRING_RATE_MS } from './rateLimit.js'
import { send } from './opDelivery.js'
import { currentMaxOpSeq, sendFullSyncIfFirstPairing, sendMissedOps, resolveApplyAck, resolveFullSyncAck } from './catchup.js'

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

function handleAuthenticate(db, ws, msg) {
  const verified = verifySessionToken(db, msg.token)
  if (!verified || verified.deviceId !== msg.device_id) {
    // 4401: custom app-level close code (WS custom range is 4000-4999) so a
    // client-side close handler CAN distinguish this from an ordinary
    // network drop. T87 (docs/adr/2026-08-16-client-reauth-on-restart.md) is
    // that client-side work — syncClient.js's close handler now branches on
    // this and the other app-level codes (4402/4403/4404) and surfaces them
    // to the renderer via onAuthRejected.
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
    // For the not-found case — unreachable here, since the synchronous
    // INSERT OR IGNORE self-registration immediately above guarantees
    // trust.found — this close reason TEXT is now 'device_not_found' (was
    // hardcoded 'device_not_authorized' pre-C3). The close CODE is
    // unaffected either way (4403).
    ws.close(reason === 'device_revoked' ? 4404 : 4403, reason)
    return
  }

  // T85 Risk 1 fix (docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md):
  // a re-authenticate on an ALREADY-authenticated socket (shift change —
  // loginRemote sends a fresh `authenticate` on the existing, never-closed
  // ws on every successful login, syncClient.js's loginRemote) must not
  // re-fire sendFullSyncIfFirstPairing/sendMissedOps. Both functions stash
  // pending-ack state on `ws` (ws.pendingFullSyncAckResolve — single slot;
  // ws.pendingApplyAcks — a per-connection Map keyed by op_id, C4) — a
  // second concurrent run for the same ws still clobbers the first run's
  // waiter: the full-sync-ack slot is single-valued regardless, and the
  // apply-ack Map is keyed by op_id but both runs read the same
  // end-of-run watermark and so both wait on the identical first op_id,
  // colliding at that one Map key. Either way the first run's real ack
  // resolves the wrong (or no) waiter, stalls to its full timeout, and its
  // watermark UPDATE races the second run's UPDATE on the same devices row.
  // C4's keyed Map removes the clobber only between DIFFERENT op_ids on one
  // ws — it does not make overlapping sendMissedOps runs safe, so
  // isReauthenticate below remains the sole guard against this ever
  // happening; it is not vestigial. The device-scoped catch-up already ran
  // (or is in flight) for this continuously-open connection, and live
  // broadcast keeps it current from there, so a second catch-up is both
  // unnecessary and the sole source of the clobber. The token/device match
  // is already validated above (verified.deviceId !== msg.device_id closes
  // the connection), so an already-set ws.deviceId is guaranteed to be this
  // same physical device re-authenticating, never a different one.
  const isReauthenticate = !!ws.deviceId

  ws.deviceId = verified.deviceId
  // userId/token DO get refreshed on a re-authenticate — a shift change is
  // the same device, new user, and later authorize() calls on this
  // connection (acquire_lock, submit_op, submit_bulk_replace_op) must use
  // the CURRENT signed-in user's session, not the shift's outgoing one.
  ws.userId = verified.userId
  // Stored so later authorize() calls on this connection (acquire_lock,
  // submit_op, submit_bulk_replace_op) can re-verify via the SAME
  // already-authenticated session token, never a client-claimed field from
  // a later message body. authorize()'s "always re-verify via
  // verifySessionToken" guarantee (electron/auth/authorize.js) requires a
  // real token, not just the derived userId/deviceId already set above.
  ws.token = msg.token

  if (isReauthenticate) return

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
  const trust = deviceTrustStatus(db, msg.device_id)
  if (!trust.found || !trust.authorized || trust.revoked) {
    send(ws, { type: 'login_failed' })
    return
  }
  // Constant-time comparison for the 64-char hex device secret to prevent
  // timing side-channels (Security review finding 3).
  const storedSecret = trust.row.device_secret_identifier
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
export function broadcastOps(wss, ops) {
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
          resolveFullSyncAck(ws, true)
          return
        }

        // T85 Part 2: Client -> Host ack that a specific op genuinely landed
        // in the Client's own op-log (syncClient.js's op_applied handler,
        // sent only when applyRemoteOp did not throw). Unlike
        // full_sync_applied, this carries a real correlator (op_id), so
        // catchup.js resolves it against a per-connection keyed registry
        // rather than a single resolver slot (C4).
        if (msg.type === 'op_applied_ack') {
          resolveApplyAck(ws, msg.op_id)
          return
        }

        // renew_token: authenticated only
        if (msg.type === 'renew_token') {
          const verified = verifySessionToken(db, msg.token)
          if (!verified || verified.deviceId !== ws.deviceId || verified.type !== 'camp') {
            send(ws, { type: 'token_renewal_failed', reason: 'invalid_token' })
            return
          }
          const renewTrust = deviceTrustStatus(db, ws.deviceId)
          if (!renewTrust.found || !renewTrust.authorized || renewTrust.revoked) {
            const reason = deviceTrustReason(renewTrust)
            // For the not-found case — practically unreachable, since
            // operations.device_id's FK prevents deleting a devices row for
            // any device that has synced, and the client discards
            // token_renewal_failed.reason anyway — this reason is now
            // 'device_not_found' (was the old ternary's 'device_not_authorized'
            // fallback pre-C3). No close-code change.
            send(ws, { type: 'token_renewal_failed', reason })
            if (reason === 'device_revoked') ws.close(4404, 'device_revoked')
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
