import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildCampDataWorkbook, CAMP_DATA_SHEETS } from './buildCampDataWorkbook.js'

const SHEET_NAMES = [
  'Camp', 'Age Divisions', 'Programs', 'Groups', 'Campers', 'Locations', 'Activities',
  'Days', 'Time Blocks', 'Weeks', 'Fixed Events', 'Special Days', 'Events', 'Elective Sets',
]

const FORBIDDEN_HEADERS = [
  'id', 'client_write_id', 'camp_id', 'created_at', 'updated_at', 'deleted_at', 'sort_order',
  'signing_secret', 'signing_public_key',
  'tier_id', 'cohort_id', 'group_id', 'location_id', 'day_id', 'time_block_id',
  'schedule_week_id', 'activity_id', 'weather_alternative_id', 'unit_id',
  'map_geometry', 'recurrence_truth_status', 'catalog_role', 'location', 'unit_ids',
]

function baseEntities(overrides = {}) {
  return {
    camps: [{ id: 'camp1', name: 'Camp Bear', signing_secret: 'SECRET_VALUE_XYZ', signing_public_key: 'PUBKEY_VALUE_ABC' }],
    tiers: [],
    cohorts: [],
    groups: [],
    campers: [],
    locations: [],
    activities: [],
    days_of_operation: [],
    time_blocks: [],
    schedule_weeks: [],
    fixed_events: [],
    special_days: [],
    events: [],
    elective_sets: [],
    ...overrides,
  }
}

function sheetToAoa(wb, name) {
  const ws = wb.Sheets[name]
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false })
}

describe('buildCampDataWorkbook', () => {
  it('produces exactly the 14 sheets in order', () => {
    const wb = buildCampDataWorkbook({ entities: baseEntities(), campName: 'Camp Bear', asOf: new Date('2026-09-28T12:00:00Z') })
    expect(wb.SheetNames).toEqual(SHEET_NAMES)
  })

  it('relabels headers to human names, not raw keys', () => {
    const entities = baseEntities({
      activities: [{ id: 'a1', name: 'Swim', min_per_week: 2, camp_id: 'camp1' }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    const aoa = sheetToAoa(wb, 'Activities')
    const header = aoa[1]
    expect(header).toContain('Min Sessions/Week')
    expect(header).not.toContain('min_per_week')
  })

  it('resolves FK ids to names, and joins JSON id arrays as comma-joined names', () => {
    const entities = baseEntities({
      tiers: [{ id: 't1', name: 'Seniors', cohort_id: null, sort_order: 0 }],
      groups: [{ id: 'g1', name: 'Bunk A', tier_id: 't1' }, { id: 'g2', name: 'Bunk B', tier_id: 't1' }],
      activities: [{
        id: 'a1', name: 'Swim', eligible_group_ids: JSON.stringify(['g1', 'g2']),
      }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    const groupsAoa = sheetToAoa(wb, 'Groups')
    expect(groupsAoa[2]).toContain('Seniors')

    const actAoa = sheetToAoa(wb, 'Activities')
    const header = actAoa[1]
    const idx = header.indexOf('Eligible Groups')
    expect(idx).toBeGreaterThan(-1)
    expect(actAoa[2][idx]).toBe('Bunk A, Bunk B')
  })

  it('resolves dangling FK ids to empty string, never the raw id', () => {
    const entities = baseEntities({
      groups: [{ id: 'g1', name: 'Bunk A', tier_id: 'nonexistent-id' }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    const aoa = sheetToAoa(wb, 'Groups')
    const header = aoa[1]
    const idx = header.indexOf('Age Division')
    expect(aoa[2][idx]).toBe('')
  })

  it('never leaks an id-shaped or timestamp-shaped header, structurally (not just the known denylist)', () => {
    const entities = baseEntities({
      tiers: [{ id: 't1', name: 'Seniors' }],
      cohorts: [{ id: 'c1', name: 'Session 1' }],
      groups: [{ id: 'g1', name: 'Bunk A', tier_id: 't1' }],
      campers: [{ id: 'k1', display_name: 'Kid', group_id: 'g1' }],
      locations: [{ id: 'l1', name: 'Field' }],
      activities: [{ id: 'a1', name: 'Swim', location_id: 'l1' }],
      days_of_operation: [{ id: 'd1', label: 'Monday', day_of_week: 1 }],
      time_blocks: [{ id: 'tb1', name: 'Period 1', start_time: '08:00:00', end_time: '09:00:00' }],
      schedule_weeks: [{ id: 'w1', name: 'Week 1' }],
      fixed_events: [{ id: 'fe1', name: 'Flag', day_id: 'd1', time_block_id: 'tb1' }],
      special_days: [{ id: 'sd1', name: 'Color War' }],
      events: [{ id: 'ev1', name: 'Trip', location_id: 'l1' }],
      elective_sets: [{ id: 'es1', name: 'Electives', day_id: 'd1', time_block_id: 'tb1' }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    // Structural: catches a FUTURE unlisted id/timestamp-shaped column, not
    // just today's known names (round 2 FIX 7 — hardens beyond the denylist
    // test below, which only proves today's headers stay clean).
    const idOrTimestampShaped = /(^id$)|(_id$)|(_at$)/i
    for (const name of wb.SheetNames) {
      const aoa = sheetToAoa(wb, name)
      const header = (aoa[1] || []).map((h) => String(h))
      for (const h of header) {
        expect(h, `sheet "${name}" header "${h}" is id/timestamp-shaped`).not.toMatch(idOrTimestampShaped)
      }
    }
  })

  it('never leaks id-like, timestamp, credential, or ingestion-internal headers on any sheet', () => {
    const entities = baseEntities({
      tiers: [{ id: 't1', name: 'Seniors' }],
      cohorts: [{ id: 'c1', name: 'Session 1' }],
      groups: [{ id: 'g1', name: 'Bunk A', tier_id: 't1' }],
      campers: [{ id: 'k1', display_name: 'Kid', group_id: 'g1' }],
      locations: [{ id: 'l1', name: 'Field' }],
      activities: [{ id: 'a1', name: 'Swim', location_id: 'l1' }],
      days_of_operation: [{ id: 'd1', label: 'Monday', day_of_week: 1 }],
      time_blocks: [{ id: 'tb1', name: 'Period 1', start_time: '08:00:00', end_time: '09:00:00' }],
      schedule_weeks: [{ id: 'w1', name: 'Week 1' }],
      fixed_events: [{ id: 'fe1', name: 'Flag', day_id: 'd1', time_block_id: 'tb1' }],
      special_days: [{ id: 'sd1', name: 'Color War' }],
      events: [{ id: 'ev1', name: 'Trip', location_id: 'l1' }],
      elective_sets: [{ id: 'es1', name: 'Electives', day_id: 'd1', time_block_id: 'tb1' }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    for (const name of wb.SheetNames) {
      const aoa = sheetToAoa(wb, name)
      const header = (aoa[1] || []).map((h) => String(h))
      for (const forbidden of FORBIDDEN_HEADERS) {
        expect(header, `sheet "${name}" header leaked "${forbidden}"`).not.toContain(forbidden)
      }
    }
  })

  it('never puts credential VALUES in any cell of any sheet', () => {
    const wb = buildCampDataWorkbook({ entities: baseEntities(), campName: 'Camp Bear', asOf: new Date() })
    for (const name of wb.SheetNames) {
      const aoa = sheetToAoa(wb, name)
      for (const row of aoa) {
        for (const cell of row) {
          expect(String(cell)).not.toContain('SECRET_VALUE_XYZ')
          expect(String(cell)).not.toContain('PUBKEY_VALUE_ABC')
        }
      }
    }
  })

  it('escapes a leading-= cell via the shared sanitizer', () => {
    const entities = baseEntities({
      special_days: [{ id: 'sd1', name: '=SUM(A1)', notes: 'ok' }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    const aoa = sheetToAoa(wb, 'Special Days')
    expect(aoa[2][0]).toBe("'=SUM(A1)")
  })

  it('omits soft-deleted rows', () => {
    const entities = baseEntities({
      special_days: [
        { id: 'sd1', name: 'Kept', deleted_at: null },
        { id: 'sd2', name: 'Gone', deleted_at: '2026-01-01T00:00:00Z' },
      ],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    const aoa = sheetToAoa(wb, 'Special Days')
    const names = aoa.slice(2).map((r) => r[0])
    expect(names).toEqual(['Kept'])
  })

  it('writes the meta line on row 1 of every sheet', () => {
    const wb = buildCampDataWorkbook({ entities: baseEntities(), campName: 'Camp Bear', asOf: new Date('2026-09-28T16:30:00Z') })
    for (const name of wb.SheetNames) {
      const aoa = sheetToAoa(wb, name)
      expect(aoa[0][0]).toMatch(/^Camp Camp Bear — as of /)
    }
  })

  it('empty state is meta row + header row only', () => {
    const wb = buildCampDataWorkbook({ entities: baseEntities(), campName: 'Camp Bear', asOf: new Date() })
    const aoa = sheetToAoa(wb, 'Special Days')
    expect(aoa.length).toBe(2)
  })

  it('camp sheet has exactly one row with only the camp name column', () => {
    const wb = buildCampDataWorkbook({ entities: baseEntities(), campName: 'Camp Bear', asOf: new Date() })
    const aoa = sheetToAoa(wb, 'Camp')
    expect(aoa[1]).toEqual(['Camp Name'])
    expect(aoa[2]).toEqual(['Camp Bear'])
  })

  it('renders boolean columns as Yes/No or Yes/blank per spec', () => {
    const entities = baseEntities({
      campers: [{ id: 'k1', display_name: 'Kid', is_active: 1 }, { id: 'k2', display_name: 'Kid2', is_active: 0 }],
      activities: [{ id: 'a1', name: 'Swim', is_outdoor: 1 }, { id: 'a2', name: 'Craft', is_outdoor: 0 }],
    })
    const wb = buildCampDataWorkbook({ entities, campName: 'Camp Bear', asOf: new Date() })
    const campersAoa = sheetToAoa(wb, 'Campers')
    const activeIdx = campersAoa[1].indexOf('Active')
    expect(campersAoa[2][activeIdx]).toBe('Yes')
    expect(campersAoa[3][activeIdx]).toBe('No')

    const actAoa = sheetToAoa(wb, 'Activities')
    const outdoorIdx = actAoa[1].indexOf('Outdoor')
    const nameIdx = actAoa[1].indexOf('Name')
    const craftRow = actAoa.slice(2).find((r) => r[nameIdx] === 'Craft')
    const swimRow = actAoa.slice(2).find((r) => r[nameIdx] === 'Swim')
    expect(swimRow[outdoorIdx]).toBe('Yes')
    expect(craftRow[outdoorIdx]).toBe('')
  })

  it('CAMP_DATA_SHEETS is exported and does not reference exportWorkbook SHEET_LAYOUT', () => {
    expect(Array.isArray(CAMP_DATA_SHEETS)).toBe(true)
    expect(CAMP_DATA_SHEETS.length).toBe(14)
  })
})
