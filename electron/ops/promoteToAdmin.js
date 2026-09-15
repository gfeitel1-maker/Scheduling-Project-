import { randomBytes } from 'node:crypto'
import { appendOp, runAtomic } from './operations.js'
import { assertValidPin, hashPin } from '../auth/localAuth.js'
import { signAuthFields } from '../auth/authSignature.js'

// T163 (owner decision 2026-09-14, SECURITY.md T150) — the dedicated
// promotion path a staff -> admin role change MUST go through instead of
// the generic write() IPC handler (which electron/main.js's write() now
// refuses for entity:'users' field:'role' value:'admin', naming this
// function in the error).
//
// WHY a dedicated handler, not just a stricter check in write(): the server
// cannot know a PIN's plaintext length from its scrypt hash — that is
// structural (scrypt is a one-way function; the stored hash carries no
// length information), not an oversight. So there is no way to inspect an
// existing staff user's PIN and decide "this one is already 6+ digits, the
// role flip alone is fine." The only honest fix is to require a FRESH PIN
// that is verified to meet the admin floor, and to write it atomically with
// the role flip — otherwise a role-flip-without-repin would (even briefly)
// leave a director-privileged account behind a 4-digit PIN, exactly the
// hole this closes.
//
// runAtomic (electron/ops/operations.js) is used because this is a
// multi-write job (role + pin_hash + pin_salt) that must share one rollback
// boundary across SQLite, the op-log and the Automerge document — see that
// function's own comment for what goes wrong without it.
export function promoteToAdmin(db, { userId, newPin, actorUserId, deviceId }) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('userId is required')
  }
  if (typeof newPin !== 'string' || newPin.length === 0) {
    throw new Error(
      'promoteToAdmin requires newPin — the server cannot know a PIN\'s plaintext length from its scrypt hash, so a role change to admin must always be accompanied by a fresh PIN that is verified to meet the director floor'
    )
  }
  assertValidPin(newPin, 'admin')

  const user = db.prepare('SELECT id, cred_version FROM users WHERE id = ?').get(userId)
  if (!user) {
    throw new Error('user not found')
  }

  const salt = randomBytes(16).toString('hex')
  const pin_hash = hashPin(newPin, salt)
  // Bump the monotonic credential version so this promotion supersedes any prior signed tuple —
  // a replay of the pre-promotion (staff) tuple carries an older version and is refused (T172).
  const cred_version = (Number(user.cred_version) || 0) + 1
  // Q1 fix (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md): mint the Host
  // signature over the exact three fields this promotion writes, so the promotion is trusted when it
  // replicates. This is the ONLY role->admin path, so it is the one place a role-change signature is
  // minted. signAuthFields requires the Host key — promotion is a Host-device operation (the same
  // constraint createUser now carries), which is correct: only the Host may mint admin authority.
  const auth_sig = signAuthFields(db, { id: userId, role: 'admin', pin_hash, pin_salt: salt, cred_version })

  return runAtomic(db, () => {
    appendOp(db, { entity: 'users', entity_id: userId, field: 'role', value: 'admin', author_user_id: actorUserId, device_id: deviceId })
    appendOp(db, { entity: 'users', entity_id: userId, field: 'pin_hash', value: pin_hash, author_user_id: actorUserId, device_id: deviceId })
    appendOp(db, { entity: 'users', entity_id: userId, field: 'pin_salt', value: salt, author_user_id: actorUserId, device_id: deviceId })
    appendOp(db, { entity: 'users', entity_id: userId, field: 'cred_version', value: cred_version, author_user_id: actorUserId, device_id: deviceId })
    appendOp(db, { entity: 'users', entity_id: userId, field: 'auth_sig', value: auth_sig, author_user_id: actorUserId, device_id: deviceId })
    return { userId, role: 'admin' }
  })
}
