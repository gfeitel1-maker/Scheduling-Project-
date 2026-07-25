import {
  randomUUID,
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import { appendOp } from '../ops/operations.js'
import { recordAuditEvent } from '../audit/auditLog.js'

const SCRYPT_KEYLEN = 64

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000

// Session token lifetime for both 'camp' and 'local' token types — a
// concrete number per docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md
// ("Suggested token lifetime... 24h"). Renewal (sub-task 3) is out of scope
// here; a token past this window simply stops verifying.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

function hashPin(pin, salt) {
  return scryptSync(pin, salt, SCRYPT_KEYLEN).toString('hex')
}

function assertValidPin(pin) {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > 32) {
    throw new Error('PIN must be a non-empty string of at most 32 characters')
  }
}

export async function createUser(db, { camp_id, name, pin, role }, write) {
  assertValidPin(pin)

  const existing = db.prepare('SELECT id FROM users WHERE camp_id = ? AND name = ?').get(camp_id, name)
  if (existing) {
    throw new Error(`A user named "${name}" already exists in this camp`)
  }

  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = hashPin(pin, salt)
  const fields = { camp_id, name, pin_hash, pin_salt: salt, role }

  try {
    for (const [field, value] of Object.entries(fields)) {
      const result = await write({ entity: 'users', entity_id: id, field, value })
      const status = result && result.status
      if (status !== 'applied') {
        throw new Error(
          `User creation requires an active connection to the camp's sync host (write status: ${status})`
        )
      }
    }
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error(`A user named "${name}" already exists in this camp`)
    }
    throw err
  }

  return { id, name, role }
}

export function verifyPin(db, userId, pin) {
  assertValidPin(pin)
  const row = db.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?').get(userId)
  if (!row) return false
  const candidate = Buffer.from(hashPin(pin, row.pin_salt), 'hex')
  const stored = Buffer.from(row.pin_hash, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}

// --- Host Ed25519 signing key (docs/adr/2026-07-25-device-trust-revocation.md) ---
//
// Host-only, singleton, generated exactly once at bootstrapCamp() on the
// device that becomes Host. Encoding: hex-encoded DER (SPKI for the public
// key, PKCS8 for the private key) — chosen for round-trippability through
// Node's createPublicKey/createPrivateKey({format:'der', ...}) without any
// extra parsing; hex (not base64) purely for consistency with every other
// hex-encoded secret already in this file (signing_secret,
// device_secret_identifier).
export function ensureHostSigningKey(db) {
  const existing = db.prepare('SELECT public_key, private_key, created_at FROM host_signing_key WHERE id = 1').get()
  if (existing) return existing

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const row = {
    public_key: publicKey.toString('hex'),
    private_key: privateKey.toString('hex'),
    created_at: new Date().toISOString(),
  }
  db.prepare(
    'INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)'
  ).run(row.public_key, row.private_key, row.created_at)
  return row
}

// Whether THIS device is the Host — i.e. holds the private key locally.
// Never true on a Client, which only ever receives the public half via
// full-sync (camps.signing_public_key).
function getHostSigningKey(db) {
  return db.prepare('SELECT public_key, private_key FROM host_signing_key WHERE id = 1').get() || null
}

function campIdFor(db) {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  return camp ? camp.id : null
}

// --- Token issuance ---
//
// Split from the old single issueSessionToken per the ADR: minting a 'camp'
// token requires holding the Host's private key (this device IS the Host);
// minting a 'local' token only requires this device's own
// device_secret_identifier (set at pairing) and never grants network trust
// — see verifySessionToken's type dispatch and syncServer.js's
// handleAuthenticate, which rejects a 'local' token outright.
export function issueCampToken(db, userId, deviceId) {
  const hostKey = getHostSigningKey(db)
  if (!hostKey) {
    throw new Error('issueCampToken: this device has no host_signing_key row — it is not the Host')
  }

  const iat = Date.now()
  const payload = {
    type: 'camp',
    userId,
    deviceId,
    campId: campIdFor(db),
    iat,
    exp: iat + TOKEN_TTL_MS,
    jti: randomUUID(),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const privateKeyObj = createPrivateKey({
    key: Buffer.from(hostKey.private_key, 'hex'),
    format: 'der',
    type: 'pkcs8',
  })
  const signature = edSign(null, Buffer.from(payloadB64), privateKeyObj).toString('base64url')
  return `${payloadB64}.${signature}`
}

export function issueLocalToken(db, userId, deviceId) {
  const device = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId)
  if (!device || !device.device_secret_identifier) {
    throw new Error('issueLocalToken: this device has no device_secret_identifier — pair it first')
  }

  const iat = Date.now()
  const payload = {
    type: 'local',
    userId,
    deviceId,
    campId: campIdFor(db),
    iat,
    exp: iat + TOKEN_TTL_MS,
    jti: randomUUID(),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const secret = Buffer.from(device.device_secret_identifier, 'hex')
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url')
  return `${payloadB64}.${signature}`
}

// Picks issueCampToken vs. issueLocalToken for the device attempting the
// login, per the design doc: "Host device (or Host process handling a
// remote WS login) -> issueCampToken; Client device doing its own local IPC
// login while offline -> issueLocalToken." Whether "this device is the
// Host" is re-derived from host_signing_key's presence, not passed in, so
// callers can't get it wrong.
function issueTokenForThisDevice(db, userId, deviceId) {
  if (getHostSigningKey(db)) return issueCampToken(db, userId, deviceId)
  return issueLocalToken(db, userId, deviceId)
}

// --- Token verification ---
//
// The `type` claim is parsed from the payload but NOT trusted to select
// behavior beyond "which verification method to attempt" until AFTER the
// signature check passes — a tampered/re-typed payload fails signature
// verification (wrong key material for its real origin), it never merely
// misroutes. Malformed/missing type, malformed structure, or a
// device_secret_identifier lookup miss all fail closed (return null),
// mirroring the "validate before touching properties" pattern already used
// for this function's `.` split. `exp` is enforced here — new behavior, see
// docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md.
export function verifySessionToken(db, token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, signature] = parts
  if (!payloadB64 || !signature) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const { type, userId, deviceId, campId, exp, jti } = payload
  if (type !== 'camp' && type !== 'local') return null
  if (typeof userId !== 'string' || userId.length === 0) return null
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null

  let providedSig
  try {
    providedSig = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }

  let sigOk = false
  if (type === 'camp') {
    const camp = db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()
    if (!camp || !camp.signing_public_key) return null
    try {
      const publicKeyObj = createPublicKey({
        key: Buffer.from(camp.signing_public_key, 'hex'),
        format: 'der',
        type: 'spki',
      })
      sigOk = edVerify(null, Buffer.from(payloadB64), publicKeyObj, providedSig)
    } catch {
      return null
    }
  } else {
    const device = db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId)
    if (!device || !device.device_secret_identifier) return null
    try {
      const secret = Buffer.from(device.device_secret_identifier, 'hex')
      const expected = createHmac('sha256', secret).update(payloadB64).digest()
      sigOk = providedSig.length === expected.length && timingSafeEqual(providedSig, expected)
    } catch {
      return null
    }
  }

  if (!sigOk) return null
  if (Date.now() > exp) return null

  return { userId, deviceId, campId: typeof campId === 'string' ? campId : null, type, jti: jti ?? null }
}

function attemptsRow(db, name) {
  return db.prepare('SELECT name, count, locked_until FROM login_attempts WHERE name = ?').get(name)
}

function saveAttempts(db, name, count, lockedUntil) {
  db.prepare(
    'INSERT OR REPLACE INTO login_attempts (name, count, locked_until) VALUES (?, ?, ?)'
  ).run(name, count, lockedUntil != null ? String(lockedUntil) : null)
}

function clearAttempts(db, name) {
  db.prepare('DELETE FROM login_attempts WHERE name = ?').run(name)
}

// Shared PIN-verification-and-lockout logic used both for local login (a
// device checking its own local `users` table — main.js's IPC `login`
// handler) and for a Host verifying a remote device's first-time login
// attempt sent unauthenticated over the sync WebSocket (syncServer.js's
// `login` message handler). Keeping this in one place means the two paths
// can never drift out of sync on lockout thresholds or verification rules.
export function attemptLogin(db, { name, pin, deviceId }) {
  const attempt = attemptsRow(db, name)
  const lockedUntil = attempt && attempt.locked_until ? Number(attempt.locked_until) : 0
  if (lockedUntil && lockedUntil > Date.now()) {
    recordAuditEvent(db, {
      actorUserId: null,
      deviceId,
      action: 'auth.login',
      outcome: 'deny',
      reason: 'locked_out',
    })
    return { locked: true, retryAfterMs: lockedUntil - Date.now() }
  }

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) {
    recordAuditEvent(db, {
      actorUserId: null,
      deviceId,
      action: 'auth.login',
      outcome: 'deny',
      reason: 'no_camp',
    })
    return null
  }
  const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
  if (!user || !verifyPin(db, user.id, pin)) {
    let count = (attempt ? attempt.count : 0) + 1
    let newLockedUntil = null
    if (count >= LOGIN_MAX_ATTEMPTS) {
      newLockedUntil = Date.now() + LOGIN_LOCKOUT_MS
      count = 0
    }
    saveAttempts(db, name, count, newLockedUntil)
    recordAuditEvent(db, {
      campId: camp.id,
      actorUserId: user ? user.id : null,
      deviceId,
      action: 'auth.login',
      outcome: 'deny',
      reason: user ? 'invalid_pin' : 'user_not_found',
    })
    return null
  }

  clearAttempts(db, name)

  // Host device (or Host process handling a remote WS login) -> camp token;
  // Client device doing its own local/offline login -> local token. Which
  // one applies is re-derived from host_signing_key's presence on THIS
  // device, never passed in — see issueTokenForThisDevice.
  const token = issueTokenForThisDevice(db, user.id, deviceId)
  recordAuditEvent(db, {
    campId: camp.id,
    actorUserId: user.id,
    deviceId,
    action: 'auth.login',
    outcome: 'allow',
  })
  return { token, userId: user.id, role: user.role }
}
