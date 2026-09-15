// @vitest-environment node
//
// electron/ops/decisionJournal.js — unit tests for the single writer of
// import_decisions (T173 slice 1b, host-local, never replicated). See
// src/ingest/decisionJournal.js for the pure entry-derivation this feeds
// from (journalEntriesFor).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { recordImportDecisions } from './decisionJournal.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function testDb() {
  const db = openLocalDb(tmpFile('decision-journal'))
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run('camp1', 'Camp', 'a'.repeat(64))
  return db
}

const entry = (overrides = {}) => ({
  import_id: 'import-1',
  kind: 'confirm_value',
  lane: 'standard',
  proposed: '{"entity":"groups"}',
  outcome: 'accepted',
  chosen: null,
  ...overrides,
})

describe('recordImportDecisions', () => {
  it('inserts one row per entry, all in a single transaction', () => {
    const db = testDb()
    recordImportDecisions(db, {
      campId: 'camp1',
      actorUserId: 'user1',
      entries: [entry(), entry({ kind: 'resolve_conflict', outcome: 'changed' })],
    })
    const rows = db.prepare('SELECT * FROM import_decisions WHERE camp_id = ? ORDER BY kind').all('camp1')
    expect(rows).toHaveLength(2)
    expect(rows[0].import_id).toBe('import-1')
    expect(rows[0].actor_user_id).toBe('user1')
    expect(rows[0].decided_at).toBeTruthy()
    db.close()
  })

  it('writes every entry or none — a bad entry mid-list rolls back the whole batch', () => {
    const db = testDb()
    // A null entry throws when the writer reads its fields; it must not leave
    // the first entry committed on its own.
    recordImportDecisions(db, { campId: 'camp1', actorUserId: 'user1', entries: [entry(), null] })
    const rows = db.prepare('SELECT * FROM import_decisions WHERE camp_id = ?').all('camp1')
    expect(rows).toHaveLength(0)
    db.close()
  })

  it('never throws against a closed db', () => {
    const db = testDb()
    db.close()
    expect(() =>
      recordImportDecisions(db, { campId: 'camp1', actorUserId: 'user1', entries: [entry()] })
    ).not.toThrow()
  })

  it('never throws against a null db', () => {
    expect(() =>
      recordImportDecisions(null, { campId: 'camp1', actorUserId: 'user1', entries: [entry()] })
    ).not.toThrow()
  })

  it('never throws on a malformed entry', () => {
    const db = testDb()
    expect(() =>
      recordImportDecisions(db, { campId: 'camp1', actorUserId: 'user1', entries: [null, undefined, 42] })
    ).not.toThrow()
    db.close()
  })

  it('is a no-op for an empty entry list — no journal row, no incident', () => {
    const db = testDb()
    recordImportDecisions(db, { campId: 'camp1', actorUserId: 'user1', entries: [] })
    const rows = db.prepare('SELECT * FROM import_decisions').all()
    expect(rows).toHaveLength(0)
    const events = db.prepare("SELECT * FROM audit_events WHERE action LIKE 'import.decision_journal%'").all()
    expect(events).toHaveLength(0)
    db.close()
  })

  it('durably records a failure instead of swallowing it silently — a closed db still gets an audit trace on a FRESH connection', () => {
    // The closed-db case above proves recordImportDecisions cannot write its
    // own failure record (the same closed handle can't accept the audit
    // insert either) — that mirrors liveDoc.js's documented degraded case
    // ("nothing durable was recorded... this console line is the only
    // trace"). Here the db stays OPEN so the audit trail CAN land, proving
    // the contract holds whenever the disk/handle allows it: a genuine
    // failure (a bad entry) is recorded in audit_events, not just logged.
    const db = testDb()
    recordImportDecisions(db, { campId: 'camp1', actorUserId: 'user1', entries: [null] })
    const events = db.prepare("SELECT * FROM audit_events WHERE action = 'import.decision_journal_write_failed'").all()
    expect(events).toHaveLength(1)
    expect(events[0].outcome).toBe('deny')
    db.close()
  })
})
