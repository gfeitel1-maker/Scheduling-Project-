// Slice 1 of the Q1 mitigation (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md):
// the isolated sign/verify primitives for Host-signed credential fields. No behavior change yet —
// nothing calls these in production until slice 2. These tests pin the crypto contract:
//   - only the Host's key produces a signature the public key verifies;
//   - the signature binds all four fields together (id, role, pin_hash, pin_salt) — flipping any
//     one, or moving a signature between users, fails verification;
//   - verify NEVER throws and NEVER returns true for junk / wrong / absent inputs.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateKeyPairSync } from 'node:crypto'
import {
  signAuthFields,
  verifyAuthFields,
  canonicalAuthMessage,
} from './authSignature.js'

// A minimal Host db: just the host_signing_key row the signer reads. Mirrors the real spki/pkcs8
// hex encoding ensureHostSigningKey uses, so the primitive is exercised against real key material.
function hostDbWithKey() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE host_signing_key (id INTEGER PRIMARY KEY, public_key TEXT, private_key TEXT, created_at INTEGER)')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const pub = publicKey.toString('hex')
  db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(pub, privateKey.toString('hex'), 1)
  return { db, publicKeyHex: pub }
}

const FIELDS = { id: 'user-1', role: 'admin', pin_hash: 'scrypt$deadbeef', pin_salt: 'cafebabe', cred_version: 2 }

describe('canonicalAuthMessage', () => {
  it('is deterministic and order-independent of the input object keys', () => {
    const a = canonicalAuthMessage({ id: 'u', role: 'admin', pin_hash: 'h', pin_salt: 's' })
    const b = canonicalAuthMessage({ pin_salt: 's', pin_hash: 'h', role: 'admin', id: 'u' })
    expect(a).toBe(b)
  })

  it('changes if any of the five bound fields changes (incl cred_version — replay defense)', () => {
    const base = canonicalAuthMessage(FIELDS)
    expect(canonicalAuthMessage({ ...FIELDS, role: 'staff' })).not.toBe(base)
    expect(canonicalAuthMessage({ ...FIELDS, id: 'user-2' })).not.toBe(base)
    expect(canonicalAuthMessage({ ...FIELDS, pin_hash: 'x' })).not.toBe(base)
    expect(canonicalAuthMessage({ ...FIELDS, pin_salt: 'x' })).not.toBe(base)
    expect(canonicalAuthMessage({ ...FIELDS, cred_version: 3 })).not.toBe(base)
  })

  it('is unambiguous across a field-boundary shift (no delimiter collision)', () => {
    // "ab"|"c" must not serialize the same as "a"|"bc"
    const x = canonicalAuthMessage({ id: 'ab', role: 'c', pin_hash: 'h', pin_salt: 's' })
    const y = canonicalAuthMessage({ id: 'a', role: 'bc', pin_hash: 'h', pin_salt: 's' })
    expect(x).not.toBe(y)
  })
})

describe('signAuthFields / verifyAuthFields', () => {
  let db, publicKeyHex
  beforeEach(() => { ({ db, publicKeyHex } = hostDbWithKey()) })

  it('a Host-produced signature verifies against the public key', () => {
    const sig = signAuthFields(db, FIELDS)
    expect(typeof sig).toBe('string')
    expect(verifyAuthFields(publicKeyHex, FIELDS, sig)).toBe(true)
  })

  it('throws when signing on a non-Host db (no host_signing_key row)', () => {
    const client = new Database(':memory:')
    client.exec('CREATE TABLE host_signing_key (id INTEGER PRIMARY KEY, public_key TEXT, private_key TEXT, created_at INTEGER)')
    expect(() => signAuthFields(client, FIELDS)).toThrow()
  })

  it('rejects a signature when ANY bound field is altered (tamper detection)', () => {
    const sig = signAuthFields(db, FIELDS)
    expect(verifyAuthFields(publicKeyHex, { ...FIELDS, role: 'staff' }, sig)).toBe(false)   // privilege flip
    expect(verifyAuthFields(publicKeyHex, { ...FIELDS, pin_hash: 'other' }, sig)).toBe(false) // PIN overwrite
    expect(verifyAuthFields(publicKeyHex, { ...FIELDS, pin_salt: 'other' }, sig)).toBe(false)
    expect(verifyAuthFields(publicKeyHex, { ...FIELDS, id: 'user-2' }, sig)).toBe(false)     // moved to another user
    expect(verifyAuthFields(publicKeyHex, { ...FIELDS, cred_version: 99 }, sig)).toBe(false) // version tamper (replay defense)
  })

  it('rejects a signature from a DIFFERENT host key', () => {
    const other = hostDbWithKey()
    const sigFromOther = signAuthFields(other.db, FIELDS)
    expect(verifyAuthFields(publicKeyHex, FIELDS, sigFromOther)).toBe(false)
  })

  it('verify never throws and never returns true for junk / absent inputs', () => {
    const sig = signAuthFields(db, FIELDS)
    for (const badSig of ['', 'not-base64url!!', 'AAAA', null, undefined, 12]) {
      let r, threw = false
      try { r = verifyAuthFields(publicKeyHex, FIELDS, badSig) } catch { threw = true }
      expect(threw).toBe(false)
      expect(r).not.toBe(true)
    }
    // absent / malformed public key → false, never throw (the enforcement slice treats "no key"
    // as keep-last-known at the CALL SITE; the primitive itself simply cannot verify → false)
    for (const badKey of ['', 'zz', null, undefined]) {
      let r, threw = false
      try { r = verifyAuthFields(badKey, FIELDS, sig) } catch { threw = true }
      expect(threw).toBe(false)
      expect(r).not.toBe(true)
    }
  })
})
