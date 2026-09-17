// @vitest-environment node
// Slice 2 of the Q1 fix (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md):
// promoteToAdmin — the only role->admin path — must MINT a Host signature over the exact three
// fields it writes, so the promotion is trusted when it replicates. These tests pin that the
// emitted auth_sig verifies against the camp public key for {id, role:'admin', pin_hash, pin_salt},
// and that promotion on a non-Host db fails loudly rather than writing an unsigned admin row.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { ensureHostSigningKey, hashPin } from '../auth/localAuth.js'
import { verifyAuthFields } from '../auth/authSignature.js'
import { promoteToAdmin } from './promoteToAdmin.js'

// Discards the cached template once, at the end (T188/F2b).
afterAll(() => {
  cleanupTemplatedDbs()
})

let db, tmpFile, publicKeyHex

function seedStaff(id, pin) {
  const salt = randomBytes(16).toString('hex')
  db.prepare(
    "INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig) VALUES (?, 'camp-1', ?, ?, ?, 'staff', '')"
  ).run(id, `u-${id}`, hashPin(pin, salt), salt)
}

beforeEach(() => {
  // Was openLocalDb(freshPath) — the per-test migration-chain replay, ~304ms (T188/F2b).
  // ONLY this setup call is templated. The second openLocalDb further down deliberately
  // builds a DISTINCT second database (a replica / another device) and is left alone.
  const __t = openTemplatedDb()
  db = __t.db
  tmpFile = __t.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES ('device-1','Dev',?,?, 'authorized')"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
  publicKeyHex = hostKey.public_key
})
afterEach(() => { db.close(); if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile) })

describe('promoteToAdmin mints a verifiable Host signature (Q1 slice 2)', () => {
  it('the promoted row carries an auth_sig that verifies over its new admin credentials', () => {
    const id = randomUUID()
    seedStaff(id, '1234')
    promoteToAdmin(db, { userId: id, newPin: '654321', actorUserId: null, deviceId: 'device-1' })

    const row = db.prepare('SELECT role, pin_hash, pin_salt, auth_sig, cred_version FROM users WHERE id = ?').get(id)
    expect(row.role).toBe('admin')
    expect(row.auth_sig).not.toBe('')
    expect(verifyAuthFields(publicKeyHex, { id, role: 'admin', pin_hash: row.pin_hash, pin_salt: row.pin_salt, cred_version: row.cred_version }, row.auth_sig)).toBe(true)
  })

  it('the signature does NOT verify against the pre-promotion (staff) role — it binds the new state', () => {
    const id = randomUUID()
    seedStaff(id, '1234')
    promoteToAdmin(db, { userId: id, newPin: '654321', actorUserId: null, deviceId: 'device-1' })
    const row = db.prepare('SELECT pin_hash, pin_salt, auth_sig, cred_version FROM users WHERE id = ?').get(id)
    // A forger who kept the admin signature but tried to pair it with role 'staff' (or any other
    // field value) must fail — the signature binds all four fields together.
    expect(verifyAuthFields(publicKeyHex, { id, role: 'staff', pin_hash: row.pin_hash, pin_salt: row.pin_salt, cred_version: row.cred_version }, row.auth_sig)).toBe(false)
  })

  it('fails loudly on a non-Host db rather than writing an unsigned admin row', () => {
    const clientFile = path.join(os.tmpdir(), `shoresh-promote-client-${Date.now()}-${Math.random()}.sqlite`)
    const clientDb = openLocalDb(clientFile)
    clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
    const id = randomUUID()
    const salt = randomBytes(16).toString('hex')
    clientDb.prepare(
      "INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig) VALUES (?, 'camp-1','x', ?, ?, 'staff', '')"
    ).run(id, hashPin('1234', salt), salt)
    expect(() => promoteToAdmin(clientDb, { userId: id, newPin: '654321', actorUserId: null, deviceId: 'device-1' })).toThrow()
    // and nothing was promoted
    expect(clientDb.prepare('SELECT role FROM users WHERE id = ?').get(id).role).toBe('staff')
    clientDb.close(); fs.unlinkSync(clientFile)
  })
})
