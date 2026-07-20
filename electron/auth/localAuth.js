import { randomUUID, randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto'
import { appendOp } from '../ops/operations.js'

const SCRYPT_KEYLEN = 64

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000

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

// Looks up the current camp's signing secret from the db, mirroring the
// existing single-camp-per-db assumption already used elsewhere in this
// codebase (e.g. attemptLogin's own `SELECT id FROM camps LIMIT 1`). This
// is what makes a token issued by one process (e.g. a Host) verifiable by
// a different process (e.g. a Client that has since synced the camp row) —
// previously each process had its own random, unshared secret, so a
// Host-issued token could never pass a Client's own local verification.
function getSigningSecret(db) {
  const camp = db.prepare('SELECT signing_secret FROM camps LIMIT 1').get()
  if (!camp || !camp.signing_secret) return null
  return Buffer.from(camp.signing_secret, 'hex')
}

function sign(db, payload) {
  const secret = getSigningSecret(db)
  if (!secret) throw new Error('no camp signing secret available')
  return createHmac('sha256', secret).update(payload).digest()
}

export function issueSessionToken(db, userId, deviceId) {
  const payload = Buffer.from(JSON.stringify({ userId, deviceId }), 'utf8').toString('base64url')
  const signature = sign(db, payload).toString('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(db, token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!payload || !signature) return null

  let expected
  try {
    expected = sign(db, payload)
  } catch {
    return null
  }

  let provided
  try {
    provided = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null

  try {
    const { userId, deviceId } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof userId !== 'string' || typeof deviceId !== 'string') return null
    return { userId, deviceId }
  } catch {
    return null
  }
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
    return { locked: true, retryAfterMs: lockedUntil - Date.now() }
  }

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return null
  const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
  if (!user || !verifyPin(db, user.id, pin)) {
    let count = (attempt ? attempt.count : 0) + 1
    let newLockedUntil = null
    if (count >= LOGIN_MAX_ATTEMPTS) {
      newLockedUntil = Date.now() + LOGIN_LOCKOUT_MS
      count = 0
    }
    saveAttempts(db, name, count, newLockedUntil)
    return null
  }

  clearAttempts(db, name)

  const token = issueSessionToken(db, user.id, deviceId)
  return { token, userId: user.id, role: user.role }
}
