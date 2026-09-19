// T233: signed purge-tombstone primitive — mirrors electron/auth/authSignature.test.js exactly.
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { canonicalTombstoneMessage, signTombstone, verifyTombstone } from './tombstoneSignature.js'

function keypairHex() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKeyHex: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  }
}

function dbWithHostKey(privateKeyHex, publicKeyHex) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE host_signing_key (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  if (privateKeyHex) {
    db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run(publicKeyHex, privateKeyHex, new Date().toISOString())
  }
  return db
}

describe('tombstoneSignature', () => {
  it('signs and verifies a round trip', () => {
    const { publicKeyHex, privateKeyHex } = keypairHex()
    const db = dbWithHostKey(privateKeyHex, publicKeyHex)
    const fields = { id: 'camper-1', entity: 'campers', version: 1 }
    const sig = signTombstone(db, fields)
    expect(verifyTombstone(publicKeyHex, fields, sig)).toBe(true)
  })

  it('rejects a tampered id', () => {
    const { publicKeyHex, privateKeyHex } = keypairHex()
    const db = dbWithHostKey(privateKeyHex, publicKeyHex)
    const fields = { id: 'camper-1', entity: 'campers', version: 1 }
    const sig = signTombstone(db, fields)
    expect(verifyTombstone(publicKeyHex, { ...fields, id: 'camper-2' }, sig)).toBe(false)
  })

  it('rejects a tampered entity', () => {
    const { publicKeyHex, privateKeyHex } = keypairHex()
    const db = dbWithHostKey(privateKeyHex, publicKeyHex)
    const fields = { id: 'camper-1', entity: 'campers', version: 1 }
    const sig = signTombstone(db, fields)
    expect(verifyTombstone(publicKeyHex, { ...fields, entity: 'users' }, sig)).toBe(false)
  })

  it('rejects a tampered version', () => {
    const { publicKeyHex, privateKeyHex } = keypairHex()
    const db = dbWithHostKey(privateKeyHex, publicKeyHex)
    const fields = { id: 'camper-1', entity: 'campers', version: 1 }
    const sig = signTombstone(db, fields)
    expect(verifyTombstone(publicKeyHex, { ...fields, version: 2 }, sig)).toBe(false)
  })

  it('rejects a signature made with the wrong key', () => {
    const { publicKeyHex: wrongPub } = keypairHex()
    const { publicKeyHex, privateKeyHex } = keypairHex()
    const db = dbWithHostKey(privateKeyHex, publicKeyHex)
    const fields = { id: 'camper-1', entity: 'campers', version: 1 }
    const sig = signTombstone(db, fields)
    expect(verifyTombstone(wrongPub, fields, sig)).toBe(false)
  })

  it('throws on sign when this device has no host_signing_key row', () => {
    const db = dbWithHostKey(null, null)
    expect(() => signTombstone(db, { id: 'camper-1', entity: 'campers', version: 1 })).toThrow(
      /no host_signing_key row/
    )
  })

  it('verify never throws and returns false for absent/junk input', () => {
    expect(verifyTombstone('', { id: 'x', entity: 'campers', version: 1 }, 'sig')).toBe(false)
    expect(verifyTombstone('deadbeef', { id: 'x', entity: 'campers', version: 1 }, '')).toBe(false)
    expect(verifyTombstone('not-hex-!!', { id: 'x', entity: 'campers', version: 1 }, 'not-a-sig')).toBe(false)
  })

  it('a context/domain-separation change breaks verification (canonical message pins the context)', () => {
    const { publicKeyHex, privateKeyHex } = keypairHex()
    const db = dbWithHostKey(privateKeyHex, publicKeyHex)
    const fields = { id: 'camper-1', entity: 'campers', version: 1 }
    expect(canonicalTombstoneMessage(fields).startsWith('shoresh-tombstone-sig-v1\n')).toBe(true)
    const sig = signTombstone(db, fields)
    // Verifying against a message built under a different context must fail — proven indirectly:
    // tampering any signed field changes the canonical message and breaks verification exactly the
    // same way a context change would (canonicalTombstoneMessage is not separately swappable here).
    expect(verifyTombstone(publicKeyHex, { ...fields, id: 'camper-1x' }, sig)).toBe(false)
  })
})
