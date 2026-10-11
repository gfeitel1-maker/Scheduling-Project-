// @vitest-environment node
// Import answer memory through the camp document: two devices, backup, handoff, purge
// (docs/adr/2026-10-11-import-answer-memory.md test plan 6, 7, 10, 13).
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import * as A from '@automerge/automerge'
import fs from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { applyWrites, listRecordIds, readRecord, recordKey } from './campDocument.js'
import { projectAll } from './projector.js'
import { seedAllFromSqlite } from './seed.js'
import { signTombstone } from './tombstoneSignature.js'
import { reconcile } from './reconcile.js'
import { recordConflicts } from './conflictStore.js'
import { DELETE_FIELD } from '../ops/operations.js'
import { rememberColumnMapping } from '../ops/rememberColumnMapping.js'
import { bindingFromMapping, recallColumnMapping } from '../../src/ingest/mappingSeedling.js'
import { HANDOFF_TABLES } from '../auth/hostHandoff.js'
import { PURGE_WIPED_TABLES } from './purgeCollateral.js'
import { rememberImportAnswers, liveRecords, matchImportAnswers, forgetAnswer, changeAnswer } from '../ops/answerMemory.js'

afterAll(() => cleanupTemplatedDbs())

const CAMP = 'camp-1'
const devices = []
let base = null
beforeEach(() => { base = null })
let actorCounter = 0
function device(name) {
  const t = openTemplatedDb()
  const db = t.db
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP, 'Camp One')
  db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, ?, ?, ?, 'authorized')")
    .run(`dev-${name}`, name, new Date().toISOString(), `sec-${name}`)
  for (const [id, role, uname] of [['u-admin', 'admin', 'Dana'], ['u-staff', 'staff', 'Sam']]) {
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)').run(id, CAMP, uname, 'h', 's', role)
  }
  // Every device starts from one seeded document (camp, users) with its own actor, as paired devices do.
  if (!base) base = seedAllFromSqlite(db)
  actorCounter += 1
  const actor = actorCounter.toString(16).padStart(32, '0')
  const d = { db, file: t.file, deviceId: `dev-${name}`, doc: A.clone(base, { actor }), replayed: 0 }
  devices.push(d)
  return d
}
afterEach(() => {
  for (const d of devices.splice(0)) {
    d.db.close()
    if (fs.existsSync(d.file)) fs.unlinkSync(d.file)
  }
})

// What the dual-write does for every appendOp: the same writes, in op order, into this device's document.
function sync(d) {
  const rows = d.db.prepare("SELECT seq, entity_id, field, value, author_user_id FROM operations WHERE entity = 'camp_seedlings' AND seq > ? ORDER BY seq").all(d.replayed)
  if (rows.length === 0) return d.doc
  d.replayed = rows[rows.length - 1].seq
  d.doc = applyWrites(d.doc, rows.map((r) => ({
    entity: 'camp_seedlings', entity_id: r.entity_id, field: r.field, value: r.field === DELETE_FIELD ? 1 : r.value, author_user_id: r.author_user_id,
  })))
  return d.doc
}
function pull(into, from) {
  sync(from)
  sync(into)
  into.doc = A.merge(A.clone(into.doc), A.clone(from.doc))
  recordConflicts(into.db, reconcile(into.doc).conflicts)
  const failures = projectAll(into.db, into.doc)
  return failures
}

const fixed = (name, over = {}) => ({
  id: `fe:${name}`, kind: 'confirm_value', entity: 'fixed_events', entityId: null, entityName: name,
  timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], evidence: { basis: 'daily' }, ...over,
})
const REJECT = { action: 'edited' }
const ACCEPT = { action: 'looks_right' }
let clock = Date.parse('2026-10-01T10:00:00Z')
const tick = () => new Date((clock += 60_000))
const remember = (d, entries, author = 'u-admin', importId = 'imp-1') =>
  rememberImportAnswers(d.db, { campId: CAMP, authorUserId: author, deviceId: d.deviceId, importId, entries, now: tick })
const match = (d, decision) => matchImportAnswers(d.db, { campId: CAMP, decisions: [decision] })[decision.id]

describe('the document holds each payload as one ImmutableString', () => {
  it('a payload is an ImmutableString, and an answer costs a stated budget of ops', () => {
    const a = device('a')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    sync(a)
    const id = listRecordIds(a.doc, 'camp_seedlings')[0]
    expect(A.isImmutableString(a.doc.camp_seedlings[recordKey(id, 'payload')])).toBe(true)
    const meta = A.getChangesMetaSince(a.doc, [])
    const last = meta[meta.length - 1]
    // 7 seedling fields + 7 author entries + 7 provenance markers, each one op as an ImmutableString
    // (measured 63; the ADR's "about 8" counted the fields only).
    expect(last.maxOp - last.startOp + 1).toBeLessThanOrEqual(70)
  })

  it('a column mapping written as Text before and ImmutableString after both recall', () => {
    const a = device('a')
    const header1 = ['Camper', 'Pick A']
    const header2 = ['Name', 'First Choice']
    const b1 = bindingFromMapping({ headerIndex: 0, nameIndex: 0, externalIdIndex: null, divisionIndex: null, rankColumns: [{ rank: 1, index: 1 }] }, header1)
    const b2 = bindingFromMapping({ headerIndex: 0, nameIndex: 0, externalIdIndex: null, divisionIndex: null, rankColumns: [{ rank: 1, index: 1 }] }, header2)
    rememberColumnMapping(a.db, { campId: CAMP, matchKey: b1.matchKey, payload: b1.payload, authorUserId: 'u-admin', deviceId: a.deviceId })
    rememberColumnMapping(a.db, { campId: CAMP, matchKey: b2.matchKey, payload: b2.payload, authorUserId: 'u-admin', deviceId: a.deviceId })
    sync(a)
    const [first, second] = listRecordIds(a.doc, 'camp_seedlings')
    // Re-create the first as pre-change Text: a plain string assignment in a change.
    const key = recordKey(first, 'payload')
    const text = a.doc.camp_seedlings[key].toString()
    a.doc = A.change(a.doc, (d) => { d.camp_seedlings[key] = text })
    expect(A.isImmutableString(a.doc.camp_seedlings[key])).toBe(false)
    expect(A.isImmutableString(a.doc.camp_seedlings[recordKey(second, 'payload')])).toBe(true)
    const b = device('b')
    projectAll(b.db, a.doc)
    const list = b.db.prepare('SELECT * FROM camp_seedlings').all()
    expect(recallColumnMapping(list, header1, null)).toBeTruthy()
    expect(recallColumnMapping(list, header2, null)).toBeTruthy()
  })
})

describe('across devices', () => {
  it('answer on A, sync, recall on B: exact, labelled with A\'s user', () => {
    const a = device('a')
    const b = device('b')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    expect(match(b, fixed('Lunch 1'))).toBeNull()
    expect(pull(b, a)).toEqual([])
    const got = match(b, fixed('Lunch 1'))
    expect(got).toMatchObject({ match: 'exact', autoApply: true, answeredByName: 'Dana', answer: { action: 'edited' } })
  })

  it('concurrent same-signature answers: same answer is one answer; different answers are a contradiction', () => {
    const a = device('a')
    const b = device('b')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }], 'u-admin')
    remember(b, [{ decision: fixed('Lunch 1'), answer: REJECT }], 'u-staff')
    pull(a, b)
    expect(liveRecords(a.db, CAMP).answers).toHaveLength(2)
    expect(match(a, fixed('Lunch 1'))).toMatchObject({ match: 'exact', autoApply: true })
    const c = device('c')
    const d = device('d')
    remember(c, [{ decision: fixed('Lunch 2'), answer: REJECT }])
    remember(d, [{ decision: fixed('Lunch 2'), answer: ACCEPT }], 'u-staff')
    pull(c, d)
    expect(match(c, fixed('Lunch 2'))).toMatchObject({ match: 'near', autoApply: false, contradiction: 2 })
  })

  it('a concurrent Change on A and B leaves two live heads, and a third Change that has seen both leaves one', () => {
    const a = device('a')
    const b = device('b')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    pull(b, a)
    sync(b)
    const id = liveRecords(a.db, CAMP).answers[0].id
    changeAnswer(a.db, { campId: CAMP, authorUserId: 'u-admin', deviceId: a.deviceId, memoryId: id, verdict: 'accept', now: tick })
    changeAnswer(b.db, { campId: CAMP, authorUserId: 'u-staff', deviceId: b.deviceId, memoryId: id, verdict: 'reject', now: tick })
    pull(a, b)
    const heads = liveRecords(a.db, CAMP).answers
    expect(heads).toHaveLength(2)
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    const after = liveRecords(a.db, CAMP).answers
    expect(after).toHaveLength(1)
    expect(after[0].supersedes.sort()).toEqual(heads.map((h) => h.id).sort())
    pull(b, a)
    expect(liveRecords(b.db, CAMP).answers).toHaveLength(1)
  })

  it('two devices superseding one record do not create a conflicts row', () => {
    const a = device('a')
    const b = device('b')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    pull(b, a)
    sync(b)
    const id = liveRecords(a.db, CAMP).answers[0].id
    forgetAnswer(a.db, { campId: CAMP, authorUserId: 'u-admin', deviceId: a.deviceId, memoryId: id })
    forgetAnswer(b.db, { campId: CAMP, authorUserId: 'u-staff', deviceId: b.deviceId, memoryId: id })
    pull(a, b)
    expect(a.db.prepare('SELECT COUNT(*) c FROM conflicts').get().c).toBe(0)
    expect(liveRecords(a.db, CAMP).answers).toHaveLength(0)
  })

  it('a clock-skewed device does not win by timestamp: the causally later answer from B (higher seq) does', () => {
    const a = device('a')
    const b = device('b')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    pull(b, a)
    sync(b)
    // B answers later (higher seq, supersedes A's record). A's clock then claims it is a day ahead.
    remember(b, [{ decision: fixed('Lunch 1'), answer: ACCEPT }], 'u-staff')
    pull(a, b)
    a.db.prepare("UPDATE camp_seedlings SET confirmed_at = '2099-01-01T00:00:00.000Z' WHERE status = 'superseded'").run()
    expect(match(a, fixed('Lunch 1')).answer).toEqual({ action: 'looks_right' })
  })
})

describe('durability', () => {
  it('survives host handoff (nothing to hand over) and a replacement device by sync', () => {
    expect(HANDOFF_TABLES).not.toContain('camp_seedlings')
    expect(PURGE_WIPED_TABLES).not.toContain('camp_seedlings')
    const host = device('host')
    remember(host, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    const successor = device('successor')
    pull(successor, host)
    expect(match(successor, fixed('Lunch 1')).match).toBe('exact')
  })

  it('a camper purge regenerates the document with the payload still an ImmutableString', () => {
    const a = device('a')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    const regenerated = seedAllFromSqlite(a.db)
    const id = listRecordIds(regenerated, 'camp_seedlings')[0]
    expect(A.isImmutableString(regenerated.camp_seedlings[recordKey(id, 'payload')])).toBe(true)
    expect(readRecord(regenerated, 'camp_seedlings', id).kind).toBe('import_answer')
  })

  it('backup then restore into a fresh database for the same camp: recall, forgotten state and a veto are identical', () => {
    const a = device('a')
    remember(a, [{ decision: fixed('Specialty 1'), answer: REJECT }, { decision: fixed('Specialty 2'), answer: REJECT }, { decision: fixed('Specialty 3'), answer: REJECT }], 'u-admin', 'imp-a')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    sync(a)
    const staleBeforeForget = A.clone(a.doc)
    const forgotten = liveRecords(a.db, CAMP).answers.find((x) => x.parts[0] === 'lunch 1').id
    forgetAnswer(a.db, { campId: CAMP, authorUserId: 'u-admin', deviceId: a.deviceId, memoryId: forgotten })
    sync(a)
    const backupBytes = A.save(a.doc)
    const restored = device('restored')
    restored.doc = A.load(backupBytes)
    expect(projectAll(restored.db, restored.doc)).toEqual([])
    const left = liveRecords(a.db, CAMP)
    const right = liveRecords(restored.db, CAMP)
    expect(right.answers.map((x) => x.id).sort()).toEqual(left.answers.map((x) => x.id).sort())
    expect(match(restored, fixed('Lunch 1'))).toBeNull()
    expect(match(restored, fixed('Specialty 1')).match).toBe('exact')
    // A stale peer that still holds the pre-forget state cannot resurrect it on sync.
    const stalePeer = device('peer')
    stalePeer.doc = A.load(A.save(staleBeforeForget))
    pull(stalePeer, restored)
    expect(match(stalePeer, fixed('Lunch 1'))).toBeNull()
  })

  it('a forgotten answer stays forgotten when a peer that held the live state syncs in', () => {
    const a = device('a')
    const b = device('b')
    remember(a, [{ decision: fixed('Lunch 1'), answer: REJECT }])
    pull(b, a)
    sync(b)
    const id = liveRecords(a.db, CAMP).answers[0].id
    forgetAnswer(a.db, { campId: CAMP, authorUserId: 'u-admin', deviceId: a.deviceId, memoryId: id })
    pull(b, a)
    pull(a, b)
    expect(match(a, fixed('Lunch 1'))).toBeNull()
    expect(match(b, fixed('Lunch 1'))).toBeNull()
  })

  it('a record that arrives after a tombstone for something it names is excluded', () => {
    const a = device('a')
    const change = { id: 'groups:g1', kind: 'confirm_change', entity: 'groups', entityId: 'g1', entityName: 'G', field: ['unit'], proposedValue: 'U1', currentValue: 'U0' }
    a.db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', CAMP, 'G')
    remember(a, [{ decision: change, answer: { choice: 'keep' } }])
    expect(liveRecords(a.db, CAMP).answers).toHaveLength(1)
    a.db.prepare("INSERT INTO tombstones (id, entity, version, sig) VALUES ('g1', 'groups', 1, 'x')").run()
    expect(liveRecords(a.db, CAMP).answers).toHaveLength(0)
  })
})

describe('T233 erasure hook', () => {
  const named = { id: 'groups:camper-1', kind: 'confirm_change', entity: 'groups', entityId: 'camper-1', entityName: 'G', field: ['unit'], proposedValue: 'U1', currentValue: 'U0' }
  function withHostKey(d) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex')
    d.db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)').run(pub, priv, new Date().toISOString())
    d.db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(pub, CAMP)
  }
  const tombstone = (d) => {
    const sig = signTombstone(d.db, { id: 'camper-1', entity: 'campers', version: 1 })
    return applyWrites(d.doc, [
      { entity: 'tombstones', entity_id: 'camper-1', field: 'entity', value: 'campers' },
      { entity: 'tombstones', entity_id: 'camper-1', field: 'version', value: 1 },
      { entity: 'tombstones', entity_id: 'camper-1', field: 'sig', value: sig },
    ])
  }

  it('a record already projected is dropped when its tombstone is applied, and does not come back', () => {
    const a = device('a')
    withHostKey(a)
    remember(a, [{ decision: named, answer: { choice: 'keep' } }])
    sync(a)
    expect(projectAll(a.db, a.doc)).toEqual([])
    expect(a.db.prepare("SELECT COUNT(*) c FROM camp_seedlings WHERE kind = 'import_answer'").get().c).toBe(1)
    a.doc = tombstone(a)
    expect(projectAll(a.db, a.doc)).toEqual([])
    expect(a.db.prepare("SELECT COUNT(*) c FROM camp_seedlings WHERE kind = 'import_answer'").get().c).toBe(0)
    projectAll(a.db, a.doc)
    expect(a.db.prepare("SELECT COUNT(*) c FROM camp_seedlings WHERE kind = 'import_answer'").get().c).toBe(0)
  })

  it('a record that arrives AFTER its tombstone is never projected', () => {
    const a = device('a')
    const b = device('b')
    withHostKey(b)
    remember(a, [{ decision: named, answer: { choice: 'keep' } }])
    sync(a)
    b.doc = tombstone(b)
    projectAll(b.db, b.doc)
    b.doc = A.merge(A.clone(b.doc), A.clone(a.doc))
    projectAll(b.db, b.doc)
    expect(b.db.prepare("SELECT COUNT(*) c FROM camp_seedlings WHERE kind = 'import_answer'").get().c).toBe(0)
  })
})
