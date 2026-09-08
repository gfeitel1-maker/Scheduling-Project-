// @vitest-environment node
//
// Stage 6 prep (docs/work/plans/2026-09-07-stage6-cutover-plan.md): `users` and `camps` join the
// Automerge document. Under the op-log these two synced via bespoke mechanisms (localAuth.js's
// createUser -> write({entity:'users',...}); camps via the legacy WS full_sync's
// `INSERT OR REPLACE INTO camps`). Stage 6 retires both. Without this slice, a counselor added on
// one device could never log in on any other device after cutover, and the camp's `name` field
// would never converge across devices either.
//
// These tests exercise the exact scenario that would otherwise break: a user created on device A
// (via applyWrite, mirroring what liveDoc.recordLocalWrite does on every real write) merges into
// device B's document and materializes correctly in device B's SQLite, PIN material intact so
// login succeeds there too — all through the document alone, with zero `operations` rows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { scryptSync, randomBytes } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS } from '../ops/projections.js'
import { verifyPin } from '../auth/localAuth.js'
import {
  createEmptyDoc,
  applyWrite,
  MODELED_ENTITIES,
  saveDoc,
  loadDoc,
} from './campDocument.js'
import { projectAll } from './projector.js'
import { synthesizeOpEvents } from '../sync/automerge/docDiffEvents.js'
import { sanitizeOpForIpc } from '../main.js'

let files = []
function freshDb(tag, campId = 'camp-1') {
  const f = path.join(os.tmpdir(), `shoresh-userscamp-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(`device-${tag}`, `Device ${tag}`)
  return db
}
function operationsCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
}

let dbs = []
beforeEach(() => { dbs = [] })
afterEach(() => {
  for (const db of dbs) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

function writeUser(doc, { id, camp_id, name, pin_hash, pin_salt, role }) {
  doc = applyWrite(doc, { entity: 'users', entity_id: id, field: 'camp_id', value: camp_id })
  doc = applyWrite(doc, { entity: 'users', entity_id: id, field: 'name', value: name })
  doc = applyWrite(doc, { entity: 'users', entity_id: id, field: 'pin_hash', value: pin_hash })
  doc = applyWrite(doc, { entity: 'users', entity_id: id, field: 'pin_salt', value: pin_salt })
  doc = applyWrite(doc, { entity: 'users', entity_id: id, field: 'role', value: role })
  return doc
}

describe('users/camps modeled in the Automerge document (Stage 6 prep)', () => {
  it('MODELED_ENTITIES now includes users and camps', () => {
    expect(MODELED_ENTITIES.has('users')).toBe(true)
    expect(MODELED_ENTITIES.has('camps')).toBe(true)
  })

  it('a user created on device A appears on device B via document sync, with the correct role', () => {
    const dbA = freshDb('a')
    const dbB = freshDb('b')
    dbs.push(dbA, dbB)

    let docA = createEmptyDoc()
    docA = writeUser(docA, {
      id: 'user-1',
      camp_id: 'camp-1',
      name: 'Counselor Dana',
      pin_hash: 'hash-value',
      pin_salt: 'salt-value',
      role: 'admin',
    })
    projectAll(dbA, docA)

    // Simulate the doc reaching device B over sync (Automerge merge), mirroring syncNode's
    // handleReceived: merge the received bytes into B's own doc, then project.
    const docB = createEmptyDoc()
    const merged = A.merge(docB, A.load(saveDoc(docA)))
    projectAll(dbB, merged)

    const row = dbB.prepare('SELECT camp_id, name, role FROM users WHERE id = ?').get('user-1')
    expect(row).toEqual({ camp_id: 'camp-1', name: 'Counselor Dana', role: 'admin' })
  })

  it('login works on device B with a user created on device A (PIN material carried correctly)', () => {
    const dbA = freshDb('login-a')
    const dbB = freshDb('login-b')
    dbs.push(dbA, dbB)

    // Real scrypt hash/salt, exactly as localAuth.hashPin/createUser would produce.
    const salt = randomBytes(16).toString('hex')
    const pin = '4321'
    const pinHash = scryptSync(pin, salt, 64).toString('hex')

    let docA = createEmptyDoc()
    docA = writeUser(docA, {
      id: 'user-2',
      camp_id: 'camp-1',
      name: 'Counselor Sam',
      pin_hash: pinHash,
      pin_salt: salt,
      role: 'staff',
    })
    projectAll(dbA, docA)

    const merged = A.merge(createEmptyDoc(), A.load(saveDoc(docA)))
    projectAll(dbB, merged)

    expect(verifyPin(dbB, 'user-2', pin)).toBe(true)
    expect(verifyPin(dbB, 'user-2', '0000')).toBe(false)
  })

  it('a pure doc replay into a fresh db with zero operations rows materializes both users and camps', () => {
    const db = freshDb('purereplay')
    dbs.push(db)
    expect(operationsCount(db)).toBe(0)

    let doc = createEmptyDoc()
    doc = writeUser(doc, {
      id: 'user-3',
      camp_id: 'camp-1',
      name: 'Fresh Replay',
      pin_hash: 'h',
      pin_salt: 's',
      role: 'staff',
    })
    doc = applyWrite(doc, { entity: 'camps', entity_id: 'camp-1', field: 'name', value: 'Renamed Camp' })

    projectAll(db, doc)

    expect(operationsCount(db)).toBe(0)
    const user = db.prepare('SELECT name, role FROM users WHERE id = ?').get('user-3')
    expect(user).toEqual({ name: 'Fresh Replay', role: 'staff' })
    const camp = db.prepare('SELECT name FROM camps WHERE id = ?').get('camp-1')
    expect(camp).toEqual({ name: 'Renamed Camp' })
  })

  it('camps.signing_secret is never in the document, on a real document', () => {
    expect(PROJECTIONS.camps.fields).toEqual(['name'])

    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'camps', entity_id: 'camp-1', field: 'name', value: 'Camp Achva' })
    // Even an explicit (malicious-or-buggy) attempt to write signing_secret must be a silent no-op
    // (applyWrite's "field not registered" rule) — never land as a document key.
    doc = applyWrite(doc, { entity: 'camps', entity_id: 'camp-1', field: 'signing_secret', value: 'sneaky' })

    expect(Object.keys(doc.camps['camp-1'])).toEqual(['name'])
    expect(doc.camps['camp-1'].signing_secret).toBeUndefined()

    // And round-tripped through real save/load bytes, not just the in-memory object.
    const reloaded = loadDoc(saveDoc(doc))
    expect(Object.keys(reloaded.camps['camp-1'])).toEqual(['name'])
  })

  describe('camps singleton convergence: two different camp ids merged into one document', () => {
    it("this device's own camp id always wins; the foreign camp id is never created, and other entities still project", () => {
      const db = freshDb('convergence', 'camp-local')
      dbs.push(db)

      let doc = createEmptyDoc()
      // The device's OWN camp — a legitimate name update.
      doc = applyWrite(doc, { entity: 'camps', entity_id: 'camp-local', field: 'name', value: 'My Real Camp' })
      // A FOREIGN camp row that should never have been in this document (the divergence case).
      doc = applyWrite(doc, { entity: 'camps', entity_id: 'camp-other', field: 'name', value: 'Someone Else Camp' })
      // A completely unrelated entity in the SAME document/transaction — proves the camps mismatch
      // does not abort projectAll's shared transaction for everything else.
      doc = applyWrite(doc, { entity: 'groups', entity_id: 'group-1', field: 'camp_id', value: 'camp-local' })
      doc = applyWrite(doc, { entity: 'groups', entity_id: 'group-1', field: 'name', value: 'Bunk 1' })

      expect(() => projectAll(db, doc)).not.toThrow()

      const allCamps = db.prepare('SELECT id, name FROM camps').all()
      expect(allCamps).toEqual([{ id: 'camp-local', name: 'My Real Camp' }])

      const group = db.prepare('SELECT name FROM groups WHERE id = ?').get('group-1')
      expect(group).toEqual({ name: 'Bunk 1' })
    })

    it('a doc containing ONLY a foreign camp id never deletes this device\'s own camps row', () => {
      const db = freshDb('convergence-delete', 'camp-local')
      dbs.push(db)

      let doc = createEmptyDoc()
      doc = applyWrite(doc, { entity: 'camps', entity_id: 'camp-other', field: 'name', value: 'Foreign' })

      expect(() => projectAll(db, doc)).not.toThrow()

      const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
      expect(camp).toEqual({ id: 'camp-local', name: 'Camp One' })
    })
  })

  it('PIN fields are still stripped from renderer-bound events synthesized from doc diffs', () => {
    const before = createEmptyDoc()
    let after = createEmptyDoc()
    after = writeUser(after, {
      id: 'user-4',
      camp_id: 'camp-1',
      name: 'Redact Me',
      pin_hash: 'super-secret-hash',
      pin_salt: 'super-secret-salt',
      role: 'staff',
    })

    const events = synthesizeOpEvents(after, A.getHeads(before), A.getHeads(after), { deviceId: 'peer-1' })
    const sanitized = events.map(sanitizeOpForIpc)

    const pinEvents = sanitized.filter((e) => e.entity === 'users' && (e.field === 'pin_hash' || e.field === 'pin_salt'))
    expect(pinEvents.length).toBeGreaterThan(0)
    for (const e of pinEvents) {
      expect(e).not.toHaveProperty('value')
    }
    // Non-PIN fields on the same row are untouched.
    const nameEvent = sanitized.find((e) => e.entity === 'users' && e.field === 'name')
    expect(nameEvent.value).toBe('Redact Me')
  })
})
