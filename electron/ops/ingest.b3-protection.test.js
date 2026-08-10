// B3 — "CONFIRMED survives re-import for every entity" (the ADR's Phase-B B3
// success predicate). docs/adr/2026-08-10-ingestion-reconciliation-semantics.md D5.
//
// SCOPE NOTE (why this file is tests-only, no production change):
// The ADR's D5 framed B3 as "extend the activities-only protected-field list
// (ingest.js:179) to groups.tier_id, tiers, fixed events." That premise was
// STALE (the exact discovery-report conflation B0 flagged). Verified against the
// code:
//   - The Policy-A protection gate is ALREADY field-agnostic, not activities-only:
//     ingest.js `isProtected = !!latest && latest.source !== 'import'` fires for
//     ANY field of any update/clear item. `COMPARABLE_COLUMNS` (ingest.js:174) is
//     the DIFF SCOPE, not the protection list, and already lists groups/tiers.
//   - groups.tier_id human-protection is already implemented AND fully tested in
//     ingest.unit-provenance.test.js (hand-edit survives + real change reconciles
//     + idempotent + clear-protected). This file does NOT duplicate it — see the
//     reference below.
//   - fixed-event protection is already implemented AND tested in
//     ingest.t72.test.js (recognize-then-skip = T72; rejection tombstone = PR #35).
//     This file adds one B3-framed assertion the T72 file did not: a director's
//     in-app hand-edit to an already-live anchor's attributes SURVIVES re-import
//     (the recognize-and-skip branch never touches the live row).
//   - tiers have NO diffable field on re-import: buildPlan builds a recognized
//     entity's diff from record.fields ONLY and excludes index-derived sort_order
//     (buildPlan.js S2c §2), so a recognized tier is always `unchanged` — there is
//     no clobber path to protect. This file locks that (the missing coverage).
//
// So B3 is closed as ALREADY-SATISFIED by S2b + T72 + PR #35; this file is the
// regression net that keeps the "survives re-import for every entity" property
// from silently regressing. It asserts BOTH B3 properties where a write path
// exists: (1) a CONFIRMED value survives re-import, and (2) a genuine source
// change still reconciles (protection must not degrade into ignoring real edits).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { appendOp, latestOp } from './operations.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-b3-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })
const tierRow = (name) => db.prepare('SELECT * FROM tiers WHERE camp_id = ? AND lower(name) = lower(?)').get(campId, name)
const opCount = (entity) => db.prepare('SELECT COUNT(*) c FROM operations WHERE entity = ?').get(entity).c
const anchorGroupIds = (id) => db.prepare('SELECT group_ids, is_all_groups FROM anchor_activities WHERE id = ?').get(id)

// ---------------------------------------------------------------------------
// groups.tier_id — the one field with a real import UPDATE path. Already fully
// covered by ingest.unit-provenance.test.js. We deliberately do NOT duplicate
// that suite; this single guard just makes the B3 predicate legible in one place
// and fails loudly if that suite is ever deleted out from under B3.
// ---------------------------------------------------------------------------
describe('B3 · groups.tier_id — see ingest.unit-provenance.test.js for the full protection suite', () => {
  // Deletion guard only (a bare existsSync — NOT a prose regex, which would fail
  // for an unrelated wording change in the sibling file): B3's "already-satisfied"
  // close depends on that suite still existing to prove both properties
  // (hand-edit survives + real change reconciles). If it's deleted, this fails
  // loudly so the dependency isn't silently lost.
  it('the authoritative groups.tier_id protection suite still exists (B3 depends on it)', () => {
    const p = path.join(new URL('.', import.meta.url).pathname, 'ingest.unit-provenance.test.js')
    expect(fs.existsSync(p)).toBe(true)
  })

  // Legacy/provenance-class characterization (Red Hat MEDIUM): the Policy-A gate
  // protects any field whose latest op source is NOT 'import' — which includes a
  // NULL-source (pre-provenance-column) op. This is DELIBERATE fail-safe
  // over-protection: a legacy value is held, never silently clobbered. Locking it
  // guards against a future "fix" that flips the gate to `source === 'human'`,
  // which would turn this fail-safe hold into a silent overwrite of real data.
  it('a NULL-source (legacy) tier_id is protected too — held, never clobbered', () => {
    const seed = (entity, id, fields) => {
      for (const [field, value] of Object.entries(fields)) {
        appendOp(db, {
          entity, entity_id: id, field, value,
          author_user_id: 'u1', device_id: deviceId, parent_op_id: null,
          client_write_id: randomUUID(), source: 'import',
        })
      }
    }
    const tA = randomUUID(); const tB = randomUUID(); const g = randomUUID()
    seed('tiers', tA, { camp_id: campId, name: 'Kfar Alef', sort_order: 0 })
    seed('tiers', tB, { camp_id: campId, name: 'Kfar Bet', sort_order: 1 })
    seed('groups', g, { camp_id: campId, name: 'Chagalls' })
    // A legacy tier_id op with NO source (undefined ⇒ NULL column), pointing at tA.
    appendOp(db, {
      entity: 'groups', entity_id: g, field: 'tier_id', value: tA,
      author_user_id: 'u1', device_id: deviceId, parent_op_id: null,
      client_write_id: randomUUID(), source: undefined,
    })
    expect(latestOp(db, 'groups', g, 'tier_id').source).toBeNull()

    // Re-import proposes a DIFFERENT unit (Kfar Bet) — a genuine source change.
    const res = commit({ approved: { groups: ['Chagalls'] }, links: { groups: { Chagalls: 'Kfar Bet' } } })
    // Fail-safe: held for review, NOT silently overwritten.
    expect(res.held).toBe(true)
    expect(res.conflicts.some((c) => c.reason === 'stale')).toBe(true)
    expect(db.prepare('SELECT tier_id FROM groups WHERE id = ?').get(g).tier_id).toBe(tA)
  })
})

// ---------------------------------------------------------------------------
// tiers — no diffable field on re-import ⇒ a recognized tier is always
// `unchanged`, so there is no clobber path to protect. Lock that: re-importing
// the same tier writes ZERO new tier ops and preserves its provenance.
// ---------------------------------------------------------------------------
describe('B3 · tiers — a recognized tier re-imports as unchanged (no clobber path)', () => {
  it('re-importing the same tier name writes zero new tier ops', () => {
    const first = commit({ approved: { tiers: ['Kfar Alef'] } })
    expect(first.created.tiers).toBe(1)
    const tier = tierRow('Kfar Alef')
    expect(tier).toBeTruthy()
    const opsAfterFirst = opCount('tiers')

    const second = commit({ approved: { tiers: ['Kfar Alef'] } })
    expect(second.created.tiers).toBe(0) // recognized, not re-created
    expect(opCount('tiers')).toBe(opsAfterFirst) // zero new tier ops — nothing clobbered
    // Same row id, unchanged.
    expect(tierRow('Kfar Alef').id).toBe(tier.id)
  })

  it('a hand-edit to the tier row is NOT reachable by a re-import diff (sort_order excluded)', () => {
    commit({ approved: { tiers: ['Kfar Alef', 'Kfar Bet'] } })
    const tier = tierRow('Kfar Bet')
    // Director hand-renames the tier's sort_order via a direct human op (the only
    // stored field a re-order would touch). buildPlan excludes index-derived
    // sort_order from a recognized diff (S2c §2), so re-import cannot overwrite it.
    appendOp(db, {
      entity: 'tiers', entity_id: tier.id, field: 'sort_order', value: 99,
      author_user_id: 'u1', device_id: deviceId, parent_op_id: null,
      client_write_id: randomUUID(), source: 'human',
    })
    expect(latestOp(db, 'tiers', tier.id, 'sort_order').source).toBe('human')

    // Re-import the same tiers in a DIFFERENT order (index 0 now, was index 1).
    const res = commit({ approved: { tiers: ['Kfar Bet', 'Kfar Alef'] } })
    expect(res.held).toBe(false) // no spurious stale conflict from a re-order
    // The hand-set sort_order survives untouched; latest op is still the human one.
    expect(latestOp(db, 'tiers', tier.id, 'sort_order').source).toBe('human')
    expect(db.prepare('SELECT sort_order FROM tiers WHERE id = ?').get(tier.id).sort_order).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// fixed events (anchor_activities) — recognize-then-skip (T72) means an
// already-live slot is left untouched on re-import, so a director's in-app
// hand-edit to that anchor's attributes survives. T72's suite proves the
// deletion/rejection half; this adds the hand-EDIT-survives half, B3-framed.
// ---------------------------------------------------------------------------
const BASE = {
  approved: {
    groups: ['Bunk 1', 'Bunk 2'],
    days_of_operation: ['Monday'],
    time_blocks: ['09:00-09:40'],
    activities: ['Swim'],
  },
}
const MIFKAD_ALL = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: true, groups: [] },
}

describe('B3 · fixed events — a director hand-edit to a live anchor survives re-import (T72 skip = protection)', () => {
  it('re-import leaves a hand-narrowed anchor scope untouched', () => {
    const first = commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    expect(first.fixedEvents.created).toBe(1)
    const [{ id: anchorId }] = db
      .prepare('SELECT id FROM anchor_activities WHERE camp_id = ?').all(campId)
    expect(anchorGroupIds(anchorId).is_all_groups).toBe(1)

    // Director hand-edits the anchor in-app: narrow "all groups" to just Bunk 1.
    const bunk1 = db.prepare('SELECT id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'Bunk 1')
    for (const [field, value] of Object.entries({ is_all_groups: 0, group_ids: JSON.stringify([bunk1.id]) })) {
      appendOp(db, {
        entity: 'anchor_activities', entity_id: anchorId, field, value,
        author_user_id: 'u1', device_id: deviceId, parent_op_id: null,
        client_write_id: randomUUID(), source: 'human',
      })
    }
    expect(anchorGroupIds(anchorId).is_all_groups).toBe(0)
    expect(JSON.parse(anchorGroupIds(anchorId).group_ids)).toEqual([bunk1.id])

    // Re-import the SAME file (which still says "all groups"). T72 recognizes the
    // slot and skips — the director's narrowed scope must survive untouched.
    const second = commit({ ...BASE, fixedEvents: [MIFKAD_ALL] })
    expect(second.fixedEvents.created).toBe(0)
    expect(second.fixedEvents.unchanged).toBe(1)
    expect(anchorGroupIds(anchorId).is_all_groups).toBe(0) // hand-edit survived
    expect(JSON.parse(anchorGroupIds(anchorId).group_ids)).toEqual([bunk1.id])
    expect(latestOp(db, 'anchor_activities', anchorId, 'is_all_groups').source).toBe('human')
  })

  // Deletion guard only (bare existsSync, not a prose regex): the T72 suite proves
  // the recognize-skip idempotency and the PR #35 rejection tombstone that B3's
  // fixed-event close leans on. If it's deleted, this fails loudly.
  it('the T72/PR-#35 rejection+idempotency suite still exists (B3 depends on it)', () => {
    const p = path.join(new URL('.', import.meta.url).pathname, 'ingest.t72.test.js')
    expect(fs.existsSync(p)).toBe(true)
  })
})
