// @vitest-environment node
//
// Positive verification that the two v32 entities (`locations`,
// `week_location_exclusions`) are registered in every place the ADR's registry
// checklist names — especially the FOUR silent-failure registries, where an
// omission produces no test failure of its own:
//   1. PROJECTIONS            — omission => writes append to the op log and are
//                               silently discarded
//   3. DOMAIN_SNAPSHOT_TABLES — omission => first-pairing clients never receive
//                               the (migration-created, op-less) rows
//   4. permissions.ENTITIES   — omission => silently admin-only (INV-3)
// plus DIRECT_CAMP_ENTITIES / PARENT_SCOPED_ENTITIES, RESTORE_DECISIONS,
// MOCK_WRITE_ALLOWLIST, and ENTITY_LABEL.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECTIONS } from './projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES, DOMAIN_SNAPSHOT_ORDER } from './campScopedEntities.js'
import { RESTORE_DECISIONS } from './restore.js'
import { PERMISSIONS, ENTITIES } from '../auth/permissions.js'
import { MOCK_WRITE_ALLOWLIST, MOCK_SCOPE_KEYS } from '../../src/localClient.mock.js'
import { ENTITY_LABEL } from '../../src/screens/recordLabels.js'
import { openLocalDb } from '../db/localDb.js'
import { duplicateWeek } from './duplicateWeek.js'
import { deleteWeek } from './deleteWeek.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('v32 registry coverage — locations', () => {
  it('is a projected entity (writes materialize, not silently discarded)', () => {
    expect(PROJECTIONS.locations).toBeTruthy()
    expect(PROJECTIONS.locations.fields).toEqual(
      expect.arrayContaining(['camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry'])
    )
  })

  it('is a direct-camp-scoped entity (list() + first-pairing full_sync)', () => {
    expect(DIRECT_CAMP_ENTITIES.has('locations')).toBe(true)
  })

  it('is in the client first-pairing snapshot (DOMAIN_SNAPSHOT_TABLES + columns)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    // Present in the single-sourced snapshot order (syncClient.js's
    // DOMAIN_SNAPSHOT_TABLES = DOMAIN_SNAPSHOT_ORDER, imported from
    // campScopedEntities.js as of T88 — no more literal array to regex).
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('locations')
    // ...and has a column list (so applyFullSync knows what to insert).
    expect(src).toMatch(/locations:\s*\['id', 'camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry', 'kind', 'grid_x', 'grid_y', 'map_id'\]/)
    // activities.location_id must also travel in the snapshot (migration side effect, no op).
    expect(src).toMatch(/activities:[\s\S]*?'location_id'/)
  })

  it('is in permissions.ENTITIES (INV-3 — not silently admin-only)', () => {
    expect(ENTITIES).toContain('locations')
  })

  it('has a restore decision, a mock write allowlist, and a director-facing label', () => {
    expect(RESTORE_DECISIONS.locations).toBe('restorable')
    expect(MOCK_WRITE_ALLOWLIST.locations).toEqual(
      expect.arrayContaining(['camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry'])
    )
    // Label is 'Location' — W1 (docs/work/specs/2026-08-21-vocabulary-
    // unification-design.md) retired the M3 design's "Place" word; the area/
    // screen and each individual item are both "Location" now, one canonical
    // word per concept.
    expect(ENTITY_LABEL.locations).toBe('Location')
  })

  it('registers activities.location_id everywhere activities is projected/mocked', () => {
    expect(PROJECTIONS.activities.fields).toContain('location_id')
    expect(MOCK_WRITE_ALLOWLIST.activities).toContain('location_id')
  })
})

describe('v32 registry coverage — week_location_exclusions', () => {
  it('is a projected, parent-scoped entity keyed by week_id', () => {
    expect(PROJECTIONS.week_location_exclusions).toBeTruthy()
    expect(PROJECTIONS.week_location_exclusions.fields).toEqual(['week_id', 'location_id'])
    expect(PARENT_SCOPED_ENTITIES.week_location_exclusions).toEqual({
      table: 'week_location_exclusions',
      parentTable: 'schedule_weeks',
      parentKey: 'week_id',
    })
  })

  it('is in permissions.ENTITIES (INV-3) and refused for restore, like its v28 siblings', () => {
    expect(ENTITIES).toContain('week_location_exclusions')
    expect(RESTORE_DECISIONS.week_location_exclusions).toMatch(/^refused:/)
  })

  it('has a mock write allowlist matching its projection fields', () => {
    expect(MOCK_WRITE_ALLOWLIST.week_location_exclusions).toEqual(['week_id', 'location_id'])
  })

  it('is shipped by the server first-pairing snapshot, like its v28 siblings', () => {
    // syncServer.js imports DOMAIN_PARENT_SCOPED_ENTITIES from
    // campScopedEntities.js (T88 single-sourcing) rather than declaring its
    // own literal array — assert against the single source it consumes.
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('week_location_exclusions')
    expect(PARENT_SCOPED_ENTITIES.week_location_exclusions).toBeTruthy()
  })
})

describe('RESTORE_DECISIONS covers every projected entity (restore.test.js guard, restated)', () => {
  it('has an entry for both new entities so the build does not fail on an unlisted projection', () => {
    for (const entity of Object.keys(PROJECTIONS)) {
      expect(RESTORE_DECISIONS[entity], `missing RESTORE_DECISIONS for ${entity}`).toBeDefined()
    }
  })
})

// M5 — the five hand-enumerated week-lifecycle surfaces M1 deliberately left
// unwired (docs/work/runs/2026-08-16-locations-m5-week-availability.md §3).
// Every one of these would pass CI today with week_location_exclusions
// silently unwired — that is exactly the blind spot this describe block
// closes: it fails loudly if any of the five regresses.
describe('v32 registry coverage — the five week-lifecycle surfaces (M5)', () => {
  it('staff hold week_location_exclusions.delete, the toggle-off exception', () => {
    expect(PERMISSIONS.staff).toContain('week_location_exclusions.delete')
  })

  it('main.js SCOPED_LIST_ENTITIES accepts week_location_exclusions (listByScope)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
    expect(src).toMatch(/SCOPED_LIST_ENTITIES\s*=\s*new Set\(\[[\s\S]*?'week_location_exclusions'[\s\S]*?\]\)/)
  })

  it('src/localClient.mock.js MOCK_SCOPE_KEYS matches the real parentKey (week_id)', () => {
    expect(MOCK_SCOPE_KEYS.week_location_exclusions).toBe('week_id')
  })

  it('ingest.js PARENT_SCOPED_DEPENDENTS clears week_location_exclusions on a Replace import', () => {
    const src = fs.readFileSync(path.join(__dirname, 'ingest.js'), 'utf8')
    expect(src).toMatch(/PARENT_SCOPED_DEPENDENTS\s*=\s*Object\.freeze\(\[[\s\S]*?'week_location_exclusions'[\s\S]*?\]\)/)
  })

  it('src/localClient.mock.js dependentTables clears week_location_exclusions on a Replace import', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/localClient.mock.js'), 'utf8')
    expect(src).toMatch(/dependentTables\s*=\s*\[[\s\S]*?'week_location_exclusions'[\s\S]*?\]/)
  })

  it('duplicateWeek copies week_location_exclusions rows to the new week', () => {
    const file = path.join(os.tmpdir(), `shoresh-locregistries-dup-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(file)
    try {
      db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
      db.prepare(
        "INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev1', 'Dev', 'authorized', ?)"
      ).run(new Date().toISOString())
      db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)')
        .run('week-1', 'camp1', 'Week 1')
      db.prepare('INSERT INTO week_location_exclusions (id, week_id, location_id) VALUES (?, ?, ?)')
        .run('wlx-1', 'week-1', 'loc-pool')

      const result = duplicateWeek(db, { sourceWeekId: 'week-1', campId: 'camp1' }, { author_user_id: null, device_id: 'dev1' })
      expect(result.ok).toBe(true)
      const copied = db.prepare('SELECT * FROM week_location_exclusions WHERE week_id = ?').all(result.newWeekId)
      expect(copied).toHaveLength(1)
      expect(copied[0].location_id).toBe('loc-pool')
    } finally {
      db.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix)
      }
    }
  })

  it('deleteWeek removes week_location_exclusions rows, leaving no orphans', () => {
    const file = path.join(os.tmpdir(), `shoresh-locregistries-del-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(file)
    try {
      db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
      db.prepare(
        "INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev1', 'Dev', 'authorized', ?)"
      ).run(new Date().toISOString())
      db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)')
        .run('week-1', 'camp1', 'Week 1')
      db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 1, 0)')
        .run('week-2', 'camp1', 'Week 2')
      const templateId = deriveScheduleTemplateId('week-1', 'generated')
      db.prepare('INSERT INTO schedule_templates (id, camp_id, week_id, name, kind) VALUES (?, ?, ?, ?, ?)')
        .run(templateId, 'camp1', 'week-1', 'Generated', 'generated')
      db.prepare('INSERT INTO week_location_exclusions (id, week_id, location_id) VALUES (?, ?, ?)')
        .run('wlx-1', 'week-1', 'loc-pool')

      const result = deleteWeek(db, { weekId: 'week-1', campId: 'camp1' }, { author_user_id: null, device_id: 'dev1' })
      expect(result.ok).toBe(true)
      expect(db.prepare('SELECT COUNT(*) as c FROM week_location_exclusions WHERE week_id = ?').get('week-1').c).toBe(0)
    } finally {
      db.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix)
      }
    }
  })
})
