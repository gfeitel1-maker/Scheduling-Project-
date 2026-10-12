// @vitest-environment node
// docs/adr/2026-10-12-shared-signed-device-roster.md section 1: the host-signed roster tuple.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../db/localDb.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { signAuthFields, verifyAuthFields } from '../auth/authSignature.js'
import { signRosterEntry, verifyRosterEntry, canonicalRosterMessage } from './deviceRosterSignature.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})
function hostDb() {
  const file = path.join(os.tmpdir(), `shoresh-roster-sig-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  return { db, key: ensureHostSigningKey(db) }
}

const fields = { id: 'dev-1', camp_id: 'camp-1', device_id: 'dev-1', device_peer_id: '12D3KooWPeer', added_at: '2026-10-12T00:00:00.000Z' }

describe('roster signature', () => {
  it('round-trips under the host key', () => {
    const { db, key } = hostDb()
    const sig = signRosterEntry(db, fields)
    expect(verifyRosterEntry(key.public_key, fields, sig)).toBe(true)
  })

  it.each(Object.keys(fields))('fails when %s is altered after signing', (field) => {
    const { db, key } = hostDb()
    const sig = signRosterEntry(db, fields)
    expect(verifyRosterEntry(key.public_key, { ...fields, [field]: `${fields[field]}x` }, sig)).toBe(false)
  })

  it('fails under another key, with an absent key, and with an absent or junk signature', () => {
    const { db } = hostDb()
    const other = hostDb()
    const sig = signRosterEntry(db, fields)
    expect(verifyRosterEntry(other.key.public_key, fields, sig)).toBe(false)
    expect(verifyRosterEntry(null, fields, sig)).toBe(false)
    expect(verifyRosterEntry('', fields, sig)).toBe(false)
    expect(verifyRosterEntry(other.key.public_key, fields, undefined)).toBe(false)
    expect(verifyRosterEntry(other.key.public_key, fields, 'not-a-signature')).toBe(false)
  })

  it('is domain-separated from the credential signature in both directions', () => {
    const { db, key } = hostDb()
    const rosterSig = signRosterEntry(db, fields)
    expect(verifyAuthFields(key.public_key, { id: 'dev-1', role: 'camp-1', pin_hash: 'dev-1', pin_salt: '12D3KooWPeer', cred_version: '2026-10-12T00:00:00.000Z' }, rosterSig)).toBe(false)
    const authSig = signAuthFields(db, { id: 'a', role: 'b', pin_hash: 'c', pin_salt: 'd', cred_version: 1 })
    expect(verifyRosterEntry(key.public_key, fields, authSig)).toBe(false)
    expect(canonicalRosterMessage(fields).startsWith('shoresh-roster-sig-v1\n')).toBe(true)
  })

  it('refuses to sign on a device that is not the host', () => {
    const file = path.join(os.tmpdir(), `shoresh-roster-sig-nohost-${Date.now()}-${Math.random()}.sqlite`)
    files.push(file)
    const db = new Database(file)
    initSchema(db)
    expect(() => signRosterEntry(db, fields)).toThrow(/host_signing_key/)
  })
})
