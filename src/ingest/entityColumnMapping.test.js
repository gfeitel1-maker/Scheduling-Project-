// Board item q-export-columns-do-not-round-trip, SLICE A (the binder).
// docs/adr/2026-09-30-format-agnostic-setup-import.md §4.1-4.6, §5, §6, §12.
//
// Pure-module tests only: no screen wiring (slice B), no mappingSeedling
// change (slice B), no atomic-commit change (part 2, §4.9).
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'

import { ENTITY_FIELD_CATALOGS, inferEntityMapping, applyEntityMapping } from './entityColumnMapping.js'
import { normalizeName } from './preview.js'
import { readEntitySheet } from '../utils/exportSanitize.js'
import { buildCampDataWorkbook } from '../utils/buildCampDataWorkbook.js'
import { exportWorkbook, SHEET_LAYOUT, LOCATIONS_SHEET } from '../utils/exportWorkbook.js'

// The six entities exportWorkbook.js (S4a) also covers, keyed by the same
// entity name ENTITY_FIELD_CATALOGS uses — so a test can look either header
// vocabulary up by one name.
const S4A_ENTITIES = new Set(SHEET_LAYOUT.map((l) => l.entity))

describe('ENTITY_FIELD_CATALOGS — fixed_events sheet name (SLICE B2 naming constraint)', () => {
  it('names its sheet "Fixed Events", not "Anchors" — the catalogue never introduces anchor vocabulary', () => {
    expect(ENTITY_FIELD_CATALOGS.fixed_events.sheet).toBe('Fixed Events')
  })
})

describe('ENTITY_FIELD_CATALOGS — per-entity synonym disjointness (authoring gate, ADR §4.2)', () => {
  for (const [entity, catalog] of Object.entries(ENTITY_FIELD_CATALOGS)) {
    it(`${entity}: no two fields share a folded synonym`, () => {
      const seen = new Map()
      for (const field of catalog.fields) {
        for (const synonym of field.synonyms) {
          const folded = normalizeName(synonym)
          const owner = seen.get(folded)
          expect(owner, `"${synonym}" (folded "${folded}") claimed by both ${owner} and ${field.key}`).toBeUndefined()
          seen.set(folded, field.key)
        }
      }
    })
  }
})

describe('inferEntityMapping — recognizes the app\'s own export headers (the measured defect)', () => {
  // buildCampDataWorkbook's human headers, read straight off CAMP_DATA_SHEETS via a real build —
  // not hand-copied, so a header the builder changes tomorrow fails this test rather than
  // silently going stale.
  const wb = buildCampDataWorkbook({
    entities: {
      tiers: [{ id: 't1', name: 'Juniors' }],
      groups: [{ id: 'g1', name: 'Bunk 1', tier_id: 't1', availability: 'all' }],
      locations: [{ id: 'l1', name: 'Main Field', capacity: 40, notes: '' }],
      activities: [{ id: 'a1', name: 'Archery', priority: 'high', min_per_week: 1, max_per_week: 3 }],
      days_of_operation: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
      time_blocks: [{ id: 'tb1', name: 'Period 1', start_time: '09:00', end_time: '10:00', part_of_day: 'morning' }],
      fixed_events: [{ id: 'f1', name: 'Lunch', kind: 'fixed', day_id: 'd1', time_block_id: 'tb1', is_all_groups: true }],
    },
    campName: 'Kinneret',
    asOf: new Date('2026-09-30T12:00:00Z'),
  })

  const campDataHeader = (sheetName) => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false })
    return aoa[1] // row 0 is the meta line, row 1 is the header
  }

  const CAMP_DATA_SHEET_BY_ENTITY = {
    days_of_operation: 'Days',
    groups: 'Groups',
    tiers: 'Age Divisions',
    time_blocks: 'Time Blocks',
    activities: 'Activities',
    fixed_events: 'Fixed Events',
    locations: 'Locations',
  }

  for (const [entity, catalog] of Object.entries(ENTITY_FIELD_CATALOGS)) {
    it(`${entity}: buildCampDataWorkbook's own header binds every required field`, () => {
      const header = campDataHeader(CAMP_DATA_SHEET_BY_ENTITY[entity])
      const mapping = inferEntityMapping(header, catalog)
      const requiredKeys = catalog.fields.filter((f) => f.required).map((f) => f.key)
      for (const key of requiredKeys) expect(mapping.roles[key]).not.toBeUndefined()
      expect(mapping.unmapped).toEqual([])
      expect(mapping.collision).toEqual([])
    })
  }

  // exportWorkbook.js's raw-key vocabulary, for the six entities it covers (ADR §4.1).
  // exportWorkbook's own `columns` list is the ground truth for what it actually exports per
  // entity — e.g. Days exports only `label`, not `day_of_week` — so the assertion is scoped to
  // the columns it writes, not to the catalog's full required-field list.
  for (const layout of SHEET_LAYOUT) {
    const entity = layout.entity
    const catalog = ENTITY_FIELD_CATALOGS[entity]
    if (!catalog) continue
    it(`${entity}: exportWorkbook's raw-key header binds every column it writes`, () => {
      const header = layout.columns.map((c) => c.key) // shoresh_id/Status are enrichment-only, not part of this header
      const mapping = inferEntityMapping(header, catalog)
      const claimedIndexes = new Set(Object.values(mapping.roles))
      header.forEach((key, index) => {
        // `eligible_groups` names a GROUP selection; ActivitiesScreen's import only reads
        // `eligible_tiers` (a TIER selection) off a row — a different fact, not a spelling
        // variant of the same one, so it has no catalog analogue and is legitimate residue.
        if (entity === 'activities' && key === 'eligible_groups') return
        expect(claimedIndexes.has(index), `column "${key}" went unbound`).toBe(true)
      })
    })
  }

  it('locations: exportWorkbook\'s own visible Locations sheet header (identity shape) binds required fields', () => {
    expect(LOCATIONS_SHEET).toBe('Locations')
    const header = ['name', 'capacity', 'kind']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.locations)
    expect(mapping.roles).toEqual({ name: 0, capacity: 1, kind: 2 })
    expect(mapping.unmapped).toEqual([])
  })
})

describe('applyEntityMapping — maps a sample row to canonical keys', () => {
  it('days_of_operation: a human-header row becomes a label/day_of_week-keyed row', () => {
    const header = ['Name', 'Day of Week']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.days_of_operation)
    const rows = [{ Name: 'Monday', 'Day of Week': 1 }]
    const out = applyEntityMapping(rows, mapping, ENTITY_FIELD_CATALOGS.days_of_operation)
    expect(out).toEqual([{ label: 'Monday', day_of_week: 1, sort_order: '' }])
  })

  it('groups: the raw-key export header (unit) becomes a tier_name-keyed row', () => {
    const header = ['name', 'unit', 'availability']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.groups)
    const rows = [{ name: 'Bunk 1', unit: 'Juniors', availability: 'all' }]
    const out = applyEntityMapping(rows, mapping, ENTITY_FIELD_CATALOGS.groups)
    expect(out).toEqual([{ name: 'Bunk 1', tier_name: 'Juniors', availability: 'all' }])
  })
})

describe('inferEntityMapping — a foreign header missing a required synonym', () => {
  it('days_of_operation: a header naming neither label nor day_of_week is unmapped', () => {
    const header = ['Bunk Day', 'Weird Column']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.days_of_operation)
    expect(mapping.unmapped).toEqual(expect.arrayContaining(['label', 'day_of_week']))
    expect(mapping.roles.label).toBeUndefined()
    // describeMappingReadiness-style: the confirm gate would stay disabled until the director
    // supplies the missing required role(s) by hand.
    expect(mapping.unmapped.length).toBeGreaterThan(0)
  })

  it('names every unrecognised column by header text, residue-style', () => {
    const header = ['label', 'Weird Column', 'Another One']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.days_of_operation)
    expect(mapping.unrecognisedColumns.map((c) => c.header)).toEqual(['Weird Column', 'Another One'])
    expect(mapping.unrecognisedColumns.every((c) => c.kind === 'UNRECOGNISED_COLUMN')).toBe(true)
  })

  it('a hand-supplied mapping (the director correcting a role) lets applyEntityMapping proceed', () => {
    const header = ['Bunk Day', 'DOW']
    const inferred = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.days_of_operation)
    expect(inferred.unmapped).not.toEqual([])
    // The director points `label` at column 0 and `day_of_week` at column 1 by hand.
    const corrected = { ...inferred, roles: { ...inferred.roles, label: 0, day_of_week: 1 }, unmapped: [] }
    const rows = [{ 'Bunk Day': 'Monday', DOW: 1 }]
    const out = applyEntityMapping(rows, corrected, ENTITY_FIELD_CATALOGS.days_of_operation)
    expect(out).toEqual([{ label: 'Monday', day_of_week: 1, sort_order: '' }])
  })

  it('two columns both matching one field\'s synonyms is reported as a collision, not last-wins', () => {
    const header = ['name', 'name']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.tiers)
    expect(mapping.roles.name).toBeUndefined()
    expect(mapping.collision).toEqual([{ field: 'name', indexes: [0, 1], columns: ['A', 'B'] }])
  })

  // Regression pin for the Code Reviewer slice-A HIGH: the tiers catalogue must carry
  // sort_order, or TiersScreen's own template (['name','sort_order']) re-imports with
  // sort_order dropped into residue and NaN per row. Dropping the catalogue entry turns
  // this red.
  it('tiers: binds sort_order (its own template\'s second column), not residue', () => {
    const header = ['name', 'sort_order']
    const mapping = inferEntityMapping(header, ENTITY_FIELD_CATALOGS.tiers)
    expect(mapping.roles.sort_order).toBe(1)
    expect(mapping.unrecognisedColumns).toEqual([])
    const out = applyEntityMapping([{ name: 'Juniors', sort_order: 0 }], mapping, ENTITY_FIELD_CATALOGS.tiers)
    expect(out).toEqual([{ name: 'Juniors', sort_order: 0 }])
  })
})

describe('module-level round trip (ADR §5, at the binder level)', () => {
  // exportWorkbook.js, not buildCampDataWorkbook.js: the latter is explicitly a read-only
  // document view that is "never re-imported" (its own header comment) and its sheets carry a
  // meta-line row above the header that readEntitySheet's default `sheet_to_json` cannot skip —
  // a different, already-known non-goal (ADR §2.4), not this binder's job to work around.
  // exportWorkbook's sheets are plain [header, ...rows], which is what a true byte round trip
  // through readEntitySheet needs.
  // SLICE B1 (board q-export-columns-do-not-round-trip, organizer ruling 2026-10-01, option
  // a — the app's own export IS the round-trip format): exportWorkbook's Days sheet now
  // carries `day_of_week` (src/utils/exportWorkbook.js SHEET_LAYOUT) alongside `label`, so the
  // gap slice A recorded as honest-but-open is now CLOSED — a full export binds every required
  // field and `unmapped` is empty. See the ADR's 2026-10-01 amendment lifting §12's freeze for
  // exportWorkbook.
  it('days_of_operation: exportWorkbook now carries day_of_week — a full export binds every required field, unmapped is empty', () => {
    const wb = exportWorkbook({
      days_of_operation: [{ id: 'd1', label: 'Tuesday', day_of_week: 2, sort_order: 0 }],
      camp_id: 'camp1',
    })
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const { rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Days', requiredColumns: [] })
    const header = Object.keys(rows[0])
    const catalog = ENTITY_FIELD_CATALOGS.days_of_operation
    const mapping = inferEntityMapping(header, catalog)
    expect(mapping.roles.label).not.toBeUndefined()
    expect(mapping.roles.day_of_week).not.toBeUndefined()
    expect(mapping.unmapped).toEqual([])
    const out = applyEntityMapping(rows, mapping, catalog)
    expect(out[0].label).toBe('Tuesday')
    expect(String(out[0].day_of_week)).toBe('2')
  })

  // Same closure for Time Blocks: exportWorkbook now writes `part_of_day`
  // (src/utils/exportWorkbook.js SHEET_LAYOUT), which TimeBlocksScreen requires (a blank one
  // warns and the row is skipped) — so a full export no longer imports zero rows.
  it('time_blocks: exportWorkbook now carries part_of_day — a full export binds every required field, unmapped is empty', () => {
    const wb = exportWorkbook({
      time_blocks: [{ id: 'tb1', name: 'Period 1', start_time: '09:00', end_time: '10:00', part_of_day: 'morning' }],
      camp_id: 'camp1',
    })
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const { rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Time Blocks', requiredColumns: [] })
    const header = Object.keys(rows[0])
    const catalog = ENTITY_FIELD_CATALOGS.time_blocks
    const mapping = inferEntityMapping(header, catalog)
    expect(mapping.roles.name).not.toBeUndefined()
    expect(mapping.roles.start_time).not.toBeUndefined()
    expect(mapping.roles.end_time).not.toBeUndefined()
    expect(mapping.roles.part_of_day).not.toBeUndefined()
    expect(mapping.unmapped).toEqual([])
    const out = applyEntityMapping(rows, mapping, catalog)
    expect(out[0].part_of_day).toBe('morning')
  })

  // SLICE B2 (board q-export-columns-do-not-round-trip): fixed_events gets its own "Fixed
  // Events" export sheet (src/utils/exportWorkbook.js SHEET_LAYOUT, `screenImportOnly: true` —
  // re-imported through FixedEventsScreen's own door, never the whole-workbook S4b path). At the
  // binder level this is the same contract every other entity gets: the sheet binds every
  // required field with unmapped === [].
  it('fixed_events: exportWorkbook\'s "Fixed Events" sheet binds every required field by NATURAL KEY (day/time block names, not ids)', () => {
    const wb = exportWorkbook({
      days_of_operation: [{ id: 'd1', label: 'Monday', day_of_week: 1 }],
      time_blocks: [{ id: 'tb1', name: 'First Period', start_time: '09:00', end_time: '10:00' }],
      tiers: [{ id: 't1', name: 'Juniors' }],
      fixed_events: [{ id: 'fe1', name: 'Mifkad', day_id: 'd1', time_block_id: 'tb1', is_all_groups: 0, unit_ids: JSON.stringify(['t1']) }],
      camp_id: 'camp1',
    })
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const { sheet, rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Fixed Events', requiredColumns: [] })
    expect(sheet).toBe('Fixed Events')
    const header = Object.keys(rows[0])
    const catalog = ENTITY_FIELD_CATALOGS.fixed_events
    const mapping = inferEntityMapping(header, catalog)
    expect(mapping.unmapped).toEqual([])
    const out = applyEntityMapping(rows, mapping, catalog)
    expect(out[0].name).toBe('Mifkad')
    expect(out[0].day_label).toBe('Monday')
    expect(out[0].time_block_name).toBe('First Period')
    expect(out[0].tier_names).toBe('Juniors')
  })

  it('groups: exportWorkbook -> bytes -> readEntitySheet -> inferEntityMapping -> applyEntityMapping carries the FK-resolved name by NATURAL KEY', () => {
    const wb = exportWorkbook({
      tiers: [{ id: 't1', name: 'Juniors' }],
      groups: [{ id: 'g1', name: 'Bunk 1', tier_id: 't1', availability: 'all' }],
      camp_id: 'camp1',
    })
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const { rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Groups', requiredColumns: [] })
    const header = Object.keys(rows[0])
    const catalog = ENTITY_FIELD_CATALOGS.groups
    const mapping = inferEntityMapping(header, catalog)
    expect(mapping.unmapped).toEqual([])
    const out = applyEntityMapping(rows, mapping, catalog)
    // Compared by the tier's NAME, per ADR §5 — never a numeric id, since re-import mints new ids.
    expect(out).toEqual([{ name: 'Bunk 1', tier_name: 'Juniors', availability: 'all' }])
  })
})
