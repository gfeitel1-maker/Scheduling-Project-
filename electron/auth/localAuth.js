import { randomUUID, randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto'
import { appendOp } from '../ops/operations.js'

const SCRYPT_KEYLEN = 64
const sessionSecret = randomBytes(32)

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
      await write({ entity: 'users', entity_id: id, field, value })
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

function sign(payload) {
  return createHmac('sha256', sessionSecret).update(payload).digest()
}

export function issueSessionToken(userId, deviceId) {
  const payload = Buffer.from(JSON.stringify({ userId, deviceId }), 'utf8').toString('base64url')
  const signature = sign(payload).toString('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!payload || !signature) return null

  let expected
  try {
    expected = sign(payload)
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
