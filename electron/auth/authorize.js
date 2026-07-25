import { verifySessionToken } from './localAuth.js'
import { PERMISSIONS } from './permissions.js'
import { recordAuditEvent } from '../audit/auditLog.js'

// Central authorization check for every privileged action, per
// docs/adr/2026-07-24-centralized-authorization-layer.md. Re-derives
// "what is this caller currently allowed to do" from the database on every
// call — never trusts role (or anything else) cached in the token payload,
// which only ever carries { userId, deviceId } in the first place (see
// issueSessionToken). This is what makes a role change or a deleted
// user/device take effect on the very next call, not just future logins.
//
// `resourceId` is accepted but unused by any check in this phase — there is
// no per-resource ownership model yet, only role-based matrix lookup. It's
// here so later per-resource rules don't require a signature change.
//
// Never throws on malformed/missing input — always returns a result object.
export function authorize({ db, token, action, resourceId }) {
  void resourceId
  const session = verifySessionToken(db, token)
  if (!session) {
    return deny(db, action, undefined, 'invalid_token', null, null)
  }

  // A malformed action is denied for every role, including admin, before
  // any role/matrix lookup happens — admin's '*' shortcut must never mask
  // a caller bug where `action` wasn't actually passed.
  if (typeof action !== 'string' || action.length === 0) {
    return deny(db, action, undefined, 'invalid_action', session.userId, session.deviceId)
  }

  let userRow, deviceRow
  try {
    // Re-query users by session.userId — role is read from THIS row, never
    // from the token payload. A row deleted since the token was issued (or a
    // role flipped by another admin) is caught here on every call.
    userRow = db.prepare('SELECT id, role FROM users WHERE id = ?').get(session.userId)

    // Isolated step so a future revocation check (authorized_at/revoked_at,
    // deferred to Phase 3) is a one-line addition here, not a redesign.
    deviceRow = db.prepare('SELECT id FROM devices WHERE id = ?').get(session.deviceId)
  } catch (err) {
    console.warn(`authorize: db error while checking action=${action}: ${err.message}`)
    return deny(db, action, undefined, 'db_error', session.userId, session.deviceId)
  }

  if (!userRow) {
    return deny(db, action, undefined, 'user_not_found', session.userId, session.deviceId)
  }
  if (!deviceRow) {
    return deny(db, action, userRow.role, 'device_not_found', session.userId, session.deviceId)
  }

  const role = userRow.role
  const allowedActions = PERMISSIONS[role]
  if (!allowedActions || (!allowedActions.includes('*') && !allowedActions.includes(action))) {
    return deny(db, action, role, 'forbidden', session.userId, session.deviceId)
  }

  if (typeof action === 'string' && action.startsWith('users.')) {
    recordAuditEvent(db, {
      actorUserId: session.userId,
      deviceId: session.deviceId,
      action,
      outcome: 'allow',
    })
  }

  return { allowed: true, userId: session.userId, deviceId: session.deviceId, role }
}

function deny(db, action, role, reason, actorUserId, deviceId) {
  console.warn(`authorize: denied action=${action} role=${role} reason=${reason}`)
  recordAuditEvent(db, {
    actorUserId: actorUserId ?? null,
    deviceId: deviceId ?? null,
    action,
    outcome: 'deny',
    reason,
  })
  return { allowed: false, reason }
}
