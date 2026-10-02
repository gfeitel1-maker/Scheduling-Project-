import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../db/localDb.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { canonicalAuthorityMessage, signAuthorityEntry, verifyAuthorityEntry } from './authorityLogSignature.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})
function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-authsig-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

describe('canonicalAuthorityMessage', () => {
  it('is deterministic regardless of extra/absent fields and caller key order', () => {
    const a = canonicalAuthorityMessage({ kind: 'grant', target_device_id: 'd1', signer_device_id: 's1' })
    const b = canonicalAuthorityMessage({ signer_device_id: 's1', kind: 'grant', target_device_id: 'd1' })
    expect(a).toBe(b)
  })

  it('is domain-separated from a tombstone or auth-field signature context', () => {
    const msg = canonicalAuthorityMessage({ kind: 'grant', target_device_id: 'd1', signer_device_id: 's1' })
    expect(msg).toMatch(/^shoresh-authority-sig-v1\n/)
  })
})

describe('signAuthorityEntry / verifyAuthorityEntry', () => {
  it('a signature minted by a device verifies against that device\'s own peer id', async () => {
    const db = freshDb()
    const { peerId } = await ensureDeviceIdentity(db)
    const fields = { kind: 'grant', target_device_id: 'target-1', signer_device_id: 'signer-1' }
    const sig = signAuthorityEntry(db, fields)
    expect(verifyAuthorityEntry(peerId, fields, sig)).toBe(true)
    db.close()
  })

  it('rejects a signature verified against a DIFFERENT device\'s peer id', async () => {
    const signerDb = freshDb()
    const otherDb = freshDb()
    await ensureDeviceIdentity(signerDb)
    const { peerId: otherPeerId } = await ensureDeviceIdentity(otherDb)
    const fields = { kind: 'grant', target_device_id: 'target-1', signer_device_id: 'signer-1' }
    const sig = signAuthorityEntry(signerDb, fields)
    expect(verifyAuthorityEntry(otherPeerId, fields, sig)).toBe(false)
    signerDb.close()
    otherDb.close()
  })

  it('rejects a signature whose fields were tampered with after signing', async () => {
    const db = freshDb()
    const { peerId } = await ensureDeviceIdentity(db)
    const fields = { kind: 'revoke', target_device_id: 'target-1', signer_device_id: 'signer-1' }
    const sig = signAuthorityEntry(db, fields)
    const tampered = { ...fields, target_device_id: 'target-2' }
    expect(verifyAuthorityEntry(peerId, tampered, sig)).toBe(false)
    db.close()
  })

  it('rejects junk input without throwing', () => {
    expect(verifyAuthorityEntry('', {}, 'sig')).toBe(false)
    expect(verifyAuthorityEntry('not-a-real-peer-id', {}, 'sig')).toBe(false)
    expect(verifyAuthorityEntry('12D3KooWFTexnMF8cis2SPeLEjxCGSRxTojQyHEou9VMX6UbVfqw', {}, '')).toBe(false)
  })

  it('throws if this device has never run ensureDeviceIdentity', () => {
    const db = freshDb()
    expect(() => signAuthorityEntry(db, { kind: 'grant', target_device_id: 'x', signer_device_id: 'y' })).toThrow(
      /no device_identity_key row/
    )
    db.close()
  })

  it('interoperates with the async @libp2p/crypto sign/verify over the same key (deterministic Ed25519)', async () => {
    const db = freshDb()
    const { peerId, privateKey } = await ensureDeviceIdentity(db)
    const fields = { kind: 'grant', target_device_id: 'target-1', signer_device_id: 'signer-1' }
    const syncSig = signAuthorityEntry(db, fields)
    const asyncSig = Buffer.from(
      await privateKey.sign(Buffer.from(canonicalAuthorityMessage(fields), 'utf8'))
    ).toString('base64url')
    expect(syncSig).toBe(asyncSig)
    expect(verifyAuthorityEntry(peerId, fields, asyncSig)).toBe(true)
    db.close()
  })
})
