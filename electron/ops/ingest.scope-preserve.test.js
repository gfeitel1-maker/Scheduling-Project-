// T183 PR-2 — a Replace re-import must PRESERVE a director's division scope, not
// silently flatten it. A Recurring Event scoped to an age DIVISION stores
// `unit_ids` (T180); `replaceScope` deletes every camp anchor AND every tier,
// then rebuilds from the file. The file (a grid) has no division column, so
// without preservation the recreated anchor gets a grid-derived `group_ids`
// snapshot and the division choice is lost — reintroducing the exact bug T180
// fixed, via a normal admin workflow ("Re-import last year" in Replace mode).
//
// The tier itself is torn down and recreated with a NEW id, so preservation
// carries the division NAME across the teardown and re-resolves it to the new
// tier id (through the importer's own tierIdByName map). A division the new
// file no longer contains cannot be re-resolved: that is reported residue, not
// silent loss (owner decision: preserve + report).

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const anchorRows = () => db.prepare('SELECT * FROM anchor_activities WHERE camp_id = ?').all(campId)
const tierIdOf = (name) => db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND name = ?').get(campId, name)?.id
const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, ...extra })

const APPROVED = {
  tiers: ['Juniors'],
  groups: ['Bunk 1', 'Bunk 2'],
  days_of_operation: ['Monday'],
  time_blocks: ['09:00-09:40'],
  activities: ['Swim'],
}
const LINKS = { groups: { 'Bunk 1': 'Juniors', 'Bunk 2': 'Juniors' } }
const SWIM = {
  name: 'Swim', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: false, groups: ['Bunk 1', 'Bunk 2'] },
}

// Build a camp whose live Swim anchor is DIVISION-scoped (unit_ids), the shape
// AnchorsScreen writes — the importer only makes group-scoped anchors, so the
// director's division scoping is simulated with a direct UPDATE.
function seedDivisionScopedAnchor() {
  commit({ approved: APPROVED, links: LINKS, fixedEvents: [SWIM], mode: 'add' })
  const jid = tierIdOf('Juniors')
  const [anchor] = anchorRows()
  db.prepare("UPDATE anchor_activities SET is_all_groups = 0, group_ids = '[]', unit_ids = ? WHERE id = ?")
    .run(JSON.stringify([jid]), anchor.id)
  return jid
}

describe('T183 PR-2 — Replace re-import preserves director-set division scope', () => {
  it('preserves unit_ids across replaceScope teardown, re-resolved to the RECREATED tier id', () => {
    const oldJid = seedDivisionScopedAnchor()

    const res = commit({ approved: APPROVED, links: LINKS, fixedEvents: [SWIM], mode: 'replace' })

    const newJid = tierIdOf('Juniors')
    expect(newJid).toBeTruthy()
    expect(newJid).not.toBe(oldJid) // the tier was torn down and recreated with a new id

    const rows = anchorRows()
    expect(rows).toHaveLength(1)
    const anchor = rows[0]
    expect(anchor.is_all_groups).toBe(0)
    expect(JSON.parse(anchor.unit_ids)).toEqual([newJid])       // division preserved, remapped
    expect(JSON.parse(anchor.group_ids)).toEqual([])            // NOT the grid snapshot
    expect(res.fixedEvents.scopePreserved).toContainEqual(
      expect.objectContaining({ name: 'Swim' }),
    )
    expect(res.fixedEvents.scopeFlattened).toEqual([])
  })

  it('reports residue instead of silently flattening when the division is gone from the re-import', () => {
    seedDivisionScopedAnchor()

    // The new file no longer has the Juniors division — the groups come in
    // unlinked. The preserved division name cannot be re-resolved to a tier.
    const res = commit({
      approved: { ...APPROVED, tiers: [] },
      links: {},
      fixedEvents: [SWIM],
      mode: 'replace',
    })

    const rows = anchorRows()
    expect(rows).toHaveLength(1)
    const anchor = rows[0]
    // Could not preserve → recreated with grid scope, but the loss is REPORTED.
    const unitIds = anchor.unit_ids == null ? [] : JSON.parse(anchor.unit_ids)
    expect(unitIds).toEqual([])
    expect(res.fixedEvents.scopeFlattened).toContainEqual(
      expect.objectContaining({ name: 'Swim' }),
    )
    expect(res.fixedEvents.scopePreserved).toEqual([])
  })

  it('a multi-day event with a MIXED per-day outcome is reported as flattened, not hidden as fully preserved (red-hat HIGH)', () => {
    // Swim is division-scoped on Monday AND Tuesday (two anchor rows sharing the
    // name). On re-import the file relabels Tuesday as "Tues", so Monday's slot
    // re-matches and preserves while Tuesday's does not — Tuesday silently
    // reverts to the grid group list. The event must NOT report as fully
    // preserved: that would hide the day that lost its division scope.
    const approvedMonTue = { ...APPROVED, days_of_operation: ['Monday', 'Tuesday'] }
    const swimMonTue = {
      name: 'Swim', time_block: '09:00-09:40', days: ['Monday', 'Tuesday'],
      scope: { is_all_groups: false, groups: ['Bunk 1', 'Bunk 2'] },
    }
    commit({ approved: approvedMonTue, links: LINKS, fixedEvents: [swimMonTue], mode: 'add' })
    const jid = tierIdOf('Juniors')
    for (const anchor of anchorRows()) {
      db.prepare("UPDATE anchor_activities SET is_all_groups = 0, group_ids = '[]', unit_ids = ? WHERE id = ?")
        .run(JSON.stringify([jid]), anchor.id)
    }

    const approvedRelabel = { ...APPROVED, days_of_operation: ['Monday', 'Tues'] }
    const swimRelabel = {
      name: 'Swim', time_block: '09:00-09:40', days: ['Monday', 'Tues'],
      scope: { is_all_groups: false, groups: ['Bunk 1', 'Bunk 2'] },
    }
    const res = commit({ approved: approvedRelabel, links: LINKS, fixedEvents: [swimRelabel], mode: 'replace' })

    expect(res.fixedEvents.scopeFlattened.some((p) => p.name === 'Swim')).toBe(true)
    expect(res.fixedEvents.scopePreserved.some((p) => p.name === 'Swim')).toBe(false)
  })

  it('a whitespace-named division is PRESERVED, not false-flattened (trim-keying, red-hat MEDIUM)', () => {
    // A division name with surrounding whitespace (a common spreadsheet
    // artefact) used to key differently on the untrimmed tierIdByName write
    // than on the trimmed restore lookup, so an unchanged division re-imported
    // in Replace mode false-flattened — reported as lost when it hadn't changed.
    // With the write site trimmed to match the read sites, it re-resolves and
    // preserves cleanly.
    const WS = 'Juniors ' // trailing space
    const approved = { ...APPROVED, tiers: [WS] }
    const links = { groups: { 'Bunk 1': WS, 'Bunk 2': WS } }
    commit({ approved, links, fixedEvents: [SWIM], mode: 'add' })
    const tier = db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND (name = ? OR name = ?)').get(campId, WS, WS.trim())
    expect(tier).toBeTruthy()
    const [anchor] = anchorRows()
    db.prepare("UPDATE anchor_activities SET is_all_groups = 0, group_ids = '[]', unit_ids = ? WHERE id = ?")
      .run(JSON.stringify([tier.id]), anchor.id)

    const res = commit({ approved, links, fixedEvents: [SWIM], mode: 'replace' })

    const newTier = db.prepare('SELECT id FROM tiers WHERE camp_id = ? AND (name = ? OR name = ?)').get(campId, WS, WS.trim())
    const [a2] = anchorRows()
    expect(JSON.parse(a2.unit_ids)).toEqual([newTier.id])
    expect(JSON.parse(a2.group_ids)).toEqual([])
    expect(res.fixedEvents.scopePreserved.some((p) => p.name === 'Swim')).toBe(true)
    expect(res.fixedEvents.scopeFlattened.some((p) => p.name === 'Swim')).toBe(false)
  })
})
