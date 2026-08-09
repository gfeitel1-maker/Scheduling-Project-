// S2a — per-field provenance (operations.source).
// docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md
//
// Covers the ops-level completion evidence: schema fresh-vs-migrated
// equivalence, appendOp round-trip, the complete importer writer census
// ('import' on every field op incl. weather-null + anchors; '__deleted__'
// teardown NULL), the human edit seam, restore provenance preservation, and
// migration-skew tolerance. The replication + Security V1 evidence lives in
// electron/sync/provenance.s2a.test.js (needs the WS/two-device harness).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../db/localDb.js'
import { appendOp, DELETE_FIELD, latestOp } from './operations.js'
import { commitIngest } from './ingest.js'
import { restoreEntity } from './restore.js'

let db, tmpFile, campId
const device_id = 'device-1'

function seedCamp(database, cId) {
  database.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(cId, 'Camp Test', 'a'.repeat(64))
  database.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(device_id, 'Test Device')
  database.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', cId)
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-prov-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  seedCamp(db, campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('schema v29 (evidence #1)', () => {
  it('a fresh install reaches version 29 and has operations.source', () => {
    // CURRENT_SCHEMA_VERSION has since moved on (v30, source_aliases) — this
    // asserts v29's own shape survives, not that it's still the latest.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(29)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    const col = db.pragma('table_info(operations)').find((c) => c.name === 'source')
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0) // NULLABLE — hard requirement (ADR §5 guardrail 1)
  })

  it('a fresh DB and a 28->29 migrated DB have identical PRAGMA table_info(operations)', () => {
    const fresh = new Database(':memory:')
    fresh.pragma('foreign_keys = ON')
    initSchema(fresh)

    // Build a v28-shaped DB (operations WITHOUT source, version stamped 28),
    // then migrate it forward via initSchema so only the v29 block runs.
    const migrated = new Database(':memory:')
    migrated.pragma('foreign_keys = ON')
    initSchema(migrated)
    migrated.exec('ALTER TABLE operations DROP COLUMN source')
    migrated.prepare('DELETE FROM schema_migrations WHERE version >= 29').run()
    expect(getSchemaVersion(migrated)).toBe(28)
    expect(migrated.pragma('table_info(operations)').some((c) => c.name === 'source')).toBe(false)

    initSchema(migrated)
    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)

    const cols = (d) => d.pragma('table_info(operations)').map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}`)
    expect(cols(migrated)).toEqual(cols(fresh))

    fresh.close()
    migrated.close()
  })
})

describe('appendOp round-trips source (evidence #2)', () => {
  it("stores 'import', 'human', and NULL for no-arg", () => {
    const imp = appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'A', device_id, source: 'import' })
    const hum = appendOp(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'B', device_id, source: 'human' })
    const none = appendOp(db, { entity: 'groups', entity_id: 'g3', field: 'name', value: 'C', device_id })

    expect(db.prepare('SELECT source FROM operations WHERE id = ?').get(imp.id).source).toBe('import')
    expect(db.prepare('SELECT source FROM operations WHERE id = ?').get(hum.id).source).toBe('human')
    expect(db.prepare('SELECT source FROM operations WHERE id = ?').get(none.id).source).toBeNull()
  })
})

describe('the importer writer census (evidence #3, R2/R3)', () => {
  const RICH = {
    approved: {
      cohorts: ['Main'],
      tiers: ['Aleph'],
      groups: ['Bunk 1'],
      days_of_operation: ['Monday'],
      time_blocks: ['09:00-09:40'],
      activities: ['Swim'],
    },
    links: { groups: { 'Bunk 1': 'Aleph' } },
    activityRules: { Swim: { min_per_week: 2, priority: 'high', eligible_group_names: ['Bunk 1'] } },
    fixedEvents: [
      { name: 'Flag', time_block: '09:00-09:40', days: ['Monday'], scope: { is_all_groups: true } },
    ],
  }

  it('tags EVERY field op commitPlan writes with source=import (incl. anchors)', () => {
    const res = commitIngest(db, { ...RICH, camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id, mode: 'add' })
    expect(res.held).toBe(false)

    // Every non-sentinel field op is import-authored.
    const fieldOps = db.prepare(`SELECT entity, field, source FROM operations WHERE field != ?`).all(DELETE_FIELD)
    expect(fieldOps.length).toBeGreaterThan(0)
    for (const op of fieldOps) {
      expect(op.source, `${op.entity}.${op.field}`).toBe('import')
    }
    // Anchor writes specifically carried 'import'.
    const anchorOps = db.prepare(`SELECT source FROM operations WHERE entity = 'anchor_activities'`).all()
    expect(anchorOps.length).toBeGreaterThan(0)
    for (const op of anchorOps) expect(op.source).toBe('import')
  })

  it("replace-mode teardown: __deleted__ tombstones stay NULL, weather-null write is 'import'", () => {
    // Seed an activity with a weather alternative so replaceScope emits the
    // weather_alternative_id null-out field op.
    const a1 = randomUUID(); const a2 = randomUUID()
    for (const [id, name] of [[a1, 'Swim'], [a2, 'Archery']]) {
      appendOp(db, { entity: 'activities', entity_id: id, field: 'camp_id', value: campId, device_id, source: 'human' })
      appendOp(db, { entity: 'activities', entity_id: id, field: 'name', value: name, device_id, source: 'human' })
    }
    appendOp(db, { entity: 'activities', entity_id: a1, field: 'weather_alternative_id', value: a2, device_id, source: 'human' })

    const before = db.prepare('SELECT MAX(seq) m FROM operations').get().m

    commitIngest(db, {
      approved: { activities: ['Kayak'] },
      camp_id: campId, author_user_id: 'u1', device_id, mode: 'replace',
    })

    const newOps = db.prepare('SELECT entity, field, value, source FROM operations WHERE seq > ?').all(before)
    const tombstones = newOps.filter((o) => o.field === DELETE_FIELD)
    expect(tombstones.length).toBeGreaterThan(0)
    for (const t of tombstones) expect(t.source, 'tombstone stays NULL').toBeNull()

    const weatherNull = newOps.find((o) => o.field === 'weather_alternative_id' && o.value === null)
    expect(weatherNull, 'weather-null field write emitted').toBeDefined()
    expect(weatherNull.source).toBe('import')
  })
})

describe('the human edit seam and restore (evidence #3)', () => {
  it("a plain appendOp field write with source=human reads back 'human'", () => {
    const op = appendOp(db, { entity: 'groups', entity_id: 'gh', field: 'name', value: 'Hand', device_id, source: 'human' })
    expect(db.prepare('SELECT source FROM operations WHERE id = ?').get(op.id).source).toBe('human')
  })

  it('restoreEntity PRESERVES an import-owned field rather than laundering it to human', () => {
    // Create a group entirely via import provenance, then delete it, then
    // restore. The restored field ops must carry the ORIGINAL 'import' source.
    const gid = randomUUID()
    appendOp(db, { entity: 'groups', entity_id: gid, field: 'camp_id', value: campId, device_id, source: 'import' })
    appendOp(db, { entity: 'groups', entity_id: gid, field: 'name', value: 'Imported Bunk', device_id, source: 'import' })
    appendOp(db, { entity: 'groups', entity_id: gid, field: DELETE_FIELD, value: 1, device_id })

    const before = db.prepare('SELECT MAX(seq) m FROM operations').get().m
    const result = restoreEntity(db, { entity: 'groups', entity_id: gid, author_user_id: 'u1', device_id })
    expect(result.ok).toBe(true)

    const reemitted = db.prepare('SELECT field, source FROM operations WHERE seq > ? AND field != ?').all(before, DELETE_FIELD)
    expect(reemitted.length).toBeGreaterThan(0)
    for (const op of reemitted) {
      expect(op.source, `restored ${op.field}`).toBe('import')
    }
    expect(latestOp(db, 'groups', gid, 'name').source).toBe('import')
  })

  it('restoreEntity maps an unrecoverable (NULL) provenance field to NULL, not import', () => {
    const gid = randomUUID()
    // Pre-v29-style ops: no source recorded (NULL).
    appendOp(db, { entity: 'groups', entity_id: gid, field: 'camp_id', value: campId, device_id })
    appendOp(db, { entity: 'groups', entity_id: gid, field: 'name', value: 'Legacy Bunk', device_id })
    appendOp(db, { entity: 'groups', entity_id: gid, field: DELETE_FIELD, value: 1, device_id })

    const before = db.prepare('SELECT MAX(seq) m FROM operations').get().m
    restoreEntity(db, { entity: 'groups', entity_id: gid, author_user_id: 'u1', device_id })

    const reemitted = db.prepare('SELECT field, source FROM operations WHERE seq > ? AND field != ?').all(before, DELETE_FIELD)
    for (const op of reemitted) expect(op.source).toBeNull()
  })
})

describe('migration-skew tolerance (evidence #5, R5)', () => {
  it('an op carrying a source key is stored, not rejected (nullable additive column)', () => {
    // A source-bearing write on any path is accepted and stored; the column is
    // additive/nullable and the validators are presence-checkers, never a
    // strict allow-list (ADR §5 guardrail 2).
    const op = appendOp(db, { entity: 'groups', entity_id: 'gm', field: 'name', value: 'M', device_id, source: 'human' })
    expect(db.prepare('SELECT COUNT(*) c FROM operations WHERE id = ?').get(op.id).c).toBe(1)
  })
})
