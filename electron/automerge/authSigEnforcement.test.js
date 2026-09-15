// @vitest-environment node
// Slice 3 of the Q1 fix (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md):
// projection-time enforcement. This is the slice that actually refuses the Q1 attack, so it is the
// most safety-critical — a wrong rule locks a camp out. These tests pin BOTH halves:
//   ATTACK BLOCKED: a forged credential change arriving via the document (no valid Host signature)
//     is refused on projection; the victim's current credentials are kept.
//   NO LOCKOUT: a genuine Host-signed change applies; an UNCHANGED (incl. legacy-unsigned) row
//     always applies; and a device with no public key DEGRADES to accepting rather than locking out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { ensureHostSigningKey, hashPin } from '../auth/localAuth.js'
import { signAuthFields } from '../auth/authSignature.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { projectAll } from './projector.js'

let db, tmpFile

// Write a users record into the document field-by-field (applyWrite is immutable, one field per
// call — mirroring liveDoc.recordLocalWrite). Sign with `signerDb` (the Host) for a genuine change,
// or pass `forgedSig` to simulate an attacker's merge with no valid Host signature. Returns the new
// doc plus the values written.
function putUser(doc, { id, name = 'U', role, pin, camp_id = 'camp-1', signerDb, forgedSig, salt }) {
  const useSalt = salt ?? randomBytes(16).toString('hex')
  const pin_hash = hashPin(pin, useSalt)
  const auth_sig = signerDb
    ? signAuthFields(signerDb, { id, role, pin_hash, pin_salt: useSalt })
    : (forgedSig ?? '')
  for (const [f, v] of [
    ['camp_id', camp_id], ['name', name], ['pin_hash', pin_hash],
    ['pin_salt', useSalt], ['role', role], ['auth_sig', auth_sig],
  ]) {
    doc = applyWrite(doc, { entity: 'users', entity_id: id, field: f, value: v })
  }
  return { doc, id, role, pin_hash, pin_salt: useSalt, auth_sig }
}

const roleOf = (id) => db.prepare('SELECT role FROM users WHERE id = ?').get(id)?.role
const pinHashOf = (id) => db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(id)?.pin_hash

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-enforce-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
})
afterEach(() => { db.close(); if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile) })

describe('Q1 enforcement — attack blocked on the projection path', () => {
  it('refuses a FORGED role escalation (staff→admin, no valid signature); role stays staff', () => {
    const id = randomUUID()
    projectAll(db, putUser(createEmptyDoc(), { id, role: 'staff', pin: '1234', signerDb: db }).doc)
    expect(roleOf(id)).toBe('staff')

    // Attacker: role→admin with a forged signature.
    projectAll(db, putUser(createEmptyDoc(), { id, role: 'admin', pin: '1234', forgedSig: 'AAAAAAAA' }).doc)
    expect(roleOf(id)).toBe('staff') // REFUSED
  })

  it('refuses a FORGED admin-PIN overwrite; the original pin_hash is kept', () => {
    const id = randomUUID()
    const legit = putUser(createEmptyDoc(), { id, role: 'admin', pin: '123456', signerDb: db })
    projectAll(db, legit.doc)

    projectAll(db, putUser(createEmptyDoc(), { id, role: 'admin', pin: '000000', forgedSig: 'Zm9yZ2Vk' }).doc)
    expect(pinHashOf(id)).toBe(legit.pin_hash) // attacker's PIN did not take
  })

  it('refuses a brand-new FORGED admin (unsigned); the row is not a usable admin', () => {
    const id = randomUUID()
    projectAll(db, putUser(createEmptyDoc(), { id, role: 'admin', pin: '000000', forgedSig: '' }).doc)
    expect(roleOf(id)).not.toBe('admin')
  })
})

describe('Q1 enforcement — never locks anyone out', () => {
  it('applies a GENUINE Host-signed promotion', () => {
    const id = randomUUID()
    projectAll(db, putUser(createEmptyDoc(), { id, role: 'staff', pin: '1234', signerDb: db }).doc)
    projectAll(db, putUser(createEmptyDoc(), { id, role: 'admin', pin: '123456', signerDb: db }).doc)
    expect(roleOf(id)).toBe('admin')
  })

  it('an UNCHANGED legacy-unsigned row is never rejected (re-projects as a no-op)', () => {
    const id = randomUUID()
    const salt = randomBytes(16).toString('hex')
    const ph = hashPin('123456', salt)
    db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig) VALUES (?, 'camp-1','Legacy', ?, ?, 'admin', '')")
      .run(id, ph, salt)
    // Re-project the SAME (unsigned) values — an unchanged credential value must apply as a no-op.
    let doc = createEmptyDoc()
    for (const [f, v] of [['camp_id', 'camp-1'], ['name', 'Legacy'], ['pin_hash', ph], ['pin_salt', salt], ['role', 'admin'], ['auth_sig', '']]) {
      doc = applyWrite(doc, { entity: 'users', entity_id: id, field: f, value: v })
    }
    projectAll(db, doc)
    expect(roleOf(id)).toBe('admin') // not locked out
    expect(pinHashOf(id)).toBe(ph)
  })

  it('DEGRADES to accepting when this device has no signing_public_key (rebuilt device, #401)', () => {
    db.prepare('UPDATE camps SET signing_public_key = NULL').run()
    const id = randomUUID()
    projectAll(db, putUser(createEmptyDoc(), { id, role: 'admin', pin: '123456', forgedSig: 'unverifiable' }).doc)
    expect(roleOf(id)).toBe('admin') // no key → accept, never lock out
  })
})
