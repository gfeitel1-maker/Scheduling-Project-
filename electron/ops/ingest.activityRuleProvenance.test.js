// Activity-rule hand-edit provenance — the `_humanFields` follow-up flagged in
// docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md (scope
// note). A director who hand-edits an activity rule during import review
// (min_per_week / max_per_week / priority / eligible_groups) must have that write
// stamped source:'human', not source:'import', so Policy A
// (docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md) protects it:
// a later re-import carrying a DIFFERENT file value must HOLD as stale, never
// silently overwrite the hand-edit.
//
// Same mechanism as the unit fix (item._humanFields side-channel), wired here for
// activity-rule fields per the ADR's generic design.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { latestOp } from './operations.js'
import { commitIngest } from './ingest.js'
import { buildPlan } from '../../src/ingest/buildPlan.js'

let db, tmpFile, campId
const deviceId = 'device-1'
const actor = () => ({ camp_id: campId, device_id: deviceId, author_user_id: 'u1' })

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-arp-${Date.now()}-${Math.random()}.sqlite`)
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

const opCount = () => db.prepare('SELECT COUNT(*) c FROM operations').get().c
const activityId = (name) => db.prepare('SELECT id FROM activities WHERE name = ? AND camp_id = ?').get(name, campId)?.id
const ruleSource = (name, field) => latestOp(db, 'activities', activityId(name), field)?.source
// Typed value from the projection (the op-log stores numbers as text).
const ruleValue = (name, field) => db.prepare(`SELECT ${field} AS v FROM activities WHERE id = ?`).get(activityId(name))?.v

// ---------------------------------------------------------------------------
// buildPlan: item._humanFields is attached, normalized to STORED columns.
// ---------------------------------------------------------------------------
describe('buildPlan attaches _humanFields normalized to stored columns', () => {
  it('CREATE: a hand-edited activity rule carries _humanFields (stored col names)', () => {
    const p = buildPlan({
      approved: { activities: [{ name: 'Swimming', fields: { min_per_week: 3, eligible_groups: ['Alef'] } }] },
      camp_id: campId,
      humanEditedFields: { activities: { Swimming: ['min_per_week', 'eligible_groups'] } },
    })
    const item = p.items.find((i) => i._name === 'Swimming')
    expect(item.op).toBe('create')
    // eligible_groups -> eligible_group_ids (dbFieldFor); scalars unchanged.
    expect(item._humanFields).toEqual(['min_per_week', 'eligible_group_ids'])
  })

  it('UPDATE: a recognized activity whose rule was hand-edited carries _humanFields', () => {
    const p = buildPlan(
      {
        approved: { activities: [{ name: 'Swimming', fields: { min_per_week: 5 } }] },
        camp_id: campId,
        humanEditedFields: { activities: { Swimming: ['min_per_week'] } },
      },
      { activities: [{ id: 'a1', name: 'Swimming', min_per_week: 2 }] },
    )
    const item = p.items.find((i) => i._name === 'Swimming')
    expect(item.op).toBe('update')
    expect(item._humanFields).toEqual(['min_per_week'])
  })

  it('no humanEditedFields → empty _humanFields (nothing marked human)', () => {
    const p = buildPlan({
      approved: { activities: [{ name: 'Swimming', fields: { min_per_week: 3 } }] },
      camp_id: campId,
    })
    const item = p.items.find((i) => i._name === 'Swimming')
    // The landed Decision 2 mechanism always attaches _humanFields (as []).
    expect(item._humanFields).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// CREATE stamps human provenance on the hand-edited field (load-bearing so a
// LATER re-import's Policy A gate has a human op to protect).
// ---------------------------------------------------------------------------
describe('CREATE honors _humanFields', () => {
  it('a hand-edited rule field is stamped source:human; an untouched field stays import', () => {
    const res = commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 3, max_per_week: 5 } },
      humanEditedFields: { activities: { Swimming: ['min_per_week'] } },
    })
    expect(res.held).toBe(false)
    expect(ruleValue('Swimming', 'min_per_week')).toBe(3)
    expect(ruleSource('Swimming', 'min_per_week')).toBe('human')   // director's pick
    expect(ruleSource('Swimming', 'max_per_week')).toBe('import')  // file-inferred
  })
})

// ---------------------------------------------------------------------------
// THE CORE PREDICATE: a re-import must NOT overwrite a hand-edited rule — it
// holds as stale.
// ---------------------------------------------------------------------------
describe('re-import cannot overwrite a hand-edited activity rule (held stale)', () => {
  it('a differing re-import value on a human field HOLDS the whole import, writes nothing', () => {
    // Import 1: director hand-edits min_per_week to 3.
    commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 3 } },
      humanEditedFields: { activities: { Swimming: ['min_per_week'] } },
    })
    expect(ruleSource('Swimming', 'min_per_week')).toBe('human')

    // Import 2: the file now carries a DIFFERENT min_per_week (5), NOT hand-edited.
    const before = opCount()
    const res = commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 5 } },
      // no humanEditedFields — this is a plain file value
    })

    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)                         // nothing written
    expect(ruleValue('Swimming', 'min_per_week')).toBe(3)  // hand-edit untouched
    expect(res.conflicts.some((c) => c.reason === 'stale' && 'min_per_week' in c.fields)).toBe(true)
  })

  it('eligible_groups: a hand-edited eligibility holds against a differing re-import', () => {
    // Seed two groups so eligibility resolves.
    commitIngest(db, { ...actor(), approved: { groups: ['Alef', 'Bet'] } })

    // Import 1: activity restricted to [Alef], hand-edited.
    commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { eligible_group_names: ['Alef'] } },
      humanEditedFields: { activities: { Swimming: ['eligible_groups'] } },
    })
    expect(ruleSource('Swimming', 'eligible_group_ids')).toBe('human')

    // Import 2: file proposes a different eligibility [Bet]. Must hold.
    const before = opCount()
    const res = commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { eligible_group_names: ['Bet'] } },
    })
    expect(res.held).toBe(true)
    expect(opCount()).toBe(before)
    // The stale conflict is keyed by the SOURCE field name (S2b shape).
    expect(res.conflicts.some((c) => c.reason === 'stale' && 'eligible_groups' in c.fields)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Control: a purely file-inferred rule is still freely re-importable — the fix
// must not turn every activity-rule write into friction.
// ---------------------------------------------------------------------------
describe('control — file-inferred rule updates freely on re-import', () => {
  it('no humanEditedFields → source import → a later re-import updates the value, no conflict', () => {
    commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 3 } },
    })
    expect(ruleSource('Swimming', 'min_per_week')).toBe('import')

    const res = commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 5 } },
    })
    expect(res.held).toBe(false)
    expect(res.updated).toBe(1)
    expect(ruleValue('Swimming', 'min_per_week')).toBe(5)
    expect(ruleSource('Swimming', 'min_per_week')).toBe('import')
  })
})

// ---------------------------------------------------------------------------
// Field-level granularity: editing ONE rule field protects only that field; an
// untouched field on the same rule is still freely updatable by a re-import.
// ---------------------------------------------------------------------------
describe('field-level granularity within one rule', () => {
  it('editing min_per_week protects min but leaves max_per_week import-updatable', () => {
    commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 3, max_per_week: 5 } },
      humanEditedFields: { activities: { Swimming: ['min_per_week'] } },
    })
    expect(ruleSource('Swimming', 'min_per_week')).toBe('human')
    expect(ruleSource('Swimming', 'max_per_week')).toBe('import')

    // Re-import changing ONLY max_per_week (min unchanged) → updates freely.
    const ok = commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 3, max_per_week: 8 } },
    })
    expect(ok.held).toBe(false)
    expect(ruleValue('Swimming', 'max_per_week')).toBe(8)

    // Re-import changing min_per_week (the protected field) → holds.
    const held = commitIngest(db, {
      ...actor(),
      approved: { activities: ['Swimming'] },
      activityRules: { Swimming: { min_per_week: 9, max_per_week: 8 } },
    })
    expect(held.held).toBe(true)
    expect(held.conflicts.some((c) => c.reason === 'stale' && 'min_per_week' in c.fields)).toBe(true)
  })
})
