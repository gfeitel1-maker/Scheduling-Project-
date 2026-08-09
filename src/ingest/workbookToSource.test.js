// S4b — the enrichment-workbook re-import ADAPTER (pure). Asserts the security
// allowlist, the baseline-diff, the <clear> tri-state, the id hazards, and the
// fail-closed metadata gate — all against a workbook produced by the real S4a
// export, edited in memory and read back.
//
// docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md §2

import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { exportWorkbook, META_SHEET, ID_COLUMN } from '../utils/exportWorkbook.js'
import { workbookToSource, CLEAR_TOKEN } from './workbookToSource.js'

function fixture(overrides = {}) {
  return {
    camp_id: 'camp-1', cohort_id: 'coh-1', base_generation: 42,
    tiers: [{ id: 'unit-a', name: 'Aleph', sort_order: 10 }, { id: 'unit-b', name: 'Bet', sort_order: 20 }],
    groups: [
      { id: 'grp-1', name: 'Bunk 1', tier_id: 'unit-a', availability: 'AM' },
      { id: 'grp-2', name: 'Bunk 2', tier_id: 'unit-b', availability: '' },
    ],
    activities: [
      { id: 'act-1', name: 'Swim', priority: 'high', min_per_week: 1, max_per_week: 3, eligible_group_ids: JSON.stringify(['grp-1', 'grp-2']), location: 'Pool' },
      { id: 'act-2', name: 'Archery', priority: 'low', max_per_week: 2, eligible_group_ids: '[]', location: '' },
    ],
    ...overrides,
  }
}

// Build a workbook, mutate a cell in a sheet, and return the re-read workbook.
function editWorkbook(wb, sheet, rowIndex, header, value) {
  const ws = wb.Sheets[sheet]
  const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1 })[0]
  const c = headerRow.indexOf(header)
  const addr = XLSX.utils.encode_cell({ c, r: rowIndex })
  ws[addr] = { t: typeof value === 'number' ? 'n' : 's', v: value }
  return wb
}

// Round-trip a workbook through XLSX write/read so it matches an uploaded file.
function reread(wb) {
  return XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' })
}

describe('workbookToSource — baseline diff (RISK D)', () => {
  it('an unchanged workbook yields records with NO field deltas', () => {
    const wb = reread(exportWorkbook(fixture()))
    const src = workbookToSource(wb, { camp_id: 'camp-1', cohort_id: 'coh-1' })
    for (const entity of Object.keys(src.approved)) {
      for (const rec of src.approved[entity]) {
        expect(rec.id).toBeTruthy()
        expect(Object.keys(rec.fields)).toEqual([])
        expect(rec.clears).toEqual([])
      }
    }
    expect(src.base_generation).toBe(42)
    expect(src.mode).toBe('add')
  })

  it('only the director-CHANGED cell becomes a delta', () => {
    let wb = exportWorkbook(fixture())
    wb = editWorkbook(wb, 'Activities', 1, 'max_per_week', 9) // act-1 row
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const swim = src.approved.activities.find((r) => r.id === 'act-1')
    expect(String(swim.fields.max_per_week)).toBe('9')
    // Every OTHER field on that row (and every other row) is untouched.
    expect(Object.keys(swim.fields)).toEqual(['max_per_week'])
    const archery = src.approved.activities.find((r) => r.id === 'act-2')
    expect(archery.fields).toEqual({})
  })
})

describe('workbookToSource — <clear> tri-state (ADR §3)', () => {
  it('an exact <clear> token records a clear; a blank cell preserves', () => {
    let wb = exportWorkbook(fixture())
    wb = editWorkbook(wb, 'Activities', 1, 'location', CLEAR_TOKEN)   // clear
    wb = editWorkbook(wb, 'Activities', 1, 'priority', '')            // blank = preserve
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const swim = src.approved.activities.find((r) => r.id === 'act-1')
    expect(swim.clears).toContain('location')
    expect('priority' in swim.fields).toBe(false)
    expect('location' in swim.fields).toBe(false)
  })
})

describe('workbookToSource — id hazards (RISK J/K)', () => {
  it('a duplicate shoresh_id on two rows flags both as duplicate_id', () => {
    let wb = exportWorkbook(fixture())
    wb = editWorkbook(wb, 'Activities', 2, ID_COLUMN, 'act-1') // act-2 now reuses act-1's id
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const flagged = src.approved.activities.filter((r) => r._workbookConflict?.reason === 'duplicate_id')
    expect(flagged.length).toBe(2)
  })

  it('a blank id on a row whose name was exported flags possible_lost_id', () => {
    let wb = exportWorkbook(fixture())
    wb = editWorkbook(wb, 'Activities', 1, ID_COLUMN, '') // Swim keeps its name, loses its id
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const swim = src.approved.activities.find((r) => r.name === 'Swim')
    expect(swim.id).toBeUndefined()
    expect(swim._workbookConflict?.reason).toBe('possible_lost_id')
  })

  it('a genuinely new row (blank id, new name) is a plain create candidate', () => {
    let wb = exportWorkbook(fixture())
    const ws = wb.Sheets['Activities']
    // Append a brand-new row with no id.
    const ref = XLSX.utils.decode_range(ws['!ref'])
    const r = ref.e.r + 1
    ws[XLSX.utils.encode_cell({ c: 1, r })] = { t: 's', v: 'Kayaking' } // name col
    ws['!ref'] = XLSX.utils.encode_range({ s: ref.s, e: { c: ref.e.c, r } })
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const nu = src.approved.activities.find((x) => x.name === 'Kayaking')
    expect(nu).toBeTruthy()
    expect(nu.id).toBeUndefined()
    expect(nu._workbookConflict).toBeUndefined()
  })
})

describe('workbookToSource — security allowlist (Security F1)', () => {
  it('drops an unknown sheet entirely', () => {
    const wb = exportWorkbook(fixture())
    const evil = XLSX.utils.aoa_to_sheet([[ID_COLUMN, 'name'], ['x', 'DROP TABLE']])
    XLSX.utils.book_append_sheet(wb, evil, 'activities); DROP TABLE')
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    // Only the known entity keys exist; the crafted sheet reached no entity.
    expect(Object.keys(src.approved).sort()).toEqual(
      ['activities', 'cohorts', 'days_of_operation', 'groups', 'tiers', 'time_blocks'].sort()
    )
  })

  it('drops an unknown header (never a field/clear target)', () => {
    const wb = exportWorkbook(fixture())
    const ws = wb.Sheets['Activities']
    // Inject a rogue column header "tier_id" (a privileged column) + a value.
    const ref = XLSX.utils.decode_range(ws['!ref'])
    const c = ref.e.c + 1
    ws[XLSX.utils.encode_cell({ c, r: 0 })] = { t: 's', v: 'weather_alternative_id' }
    ws[XLSX.utils.encode_cell({ c, r: 1 })] = { t: 's', v: CLEAR_TOKEN }
    ws['!ref'] = XLSX.utils.encode_range({ s: ref.s, e: { c, r: ref.e.r } })
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const swim = src.approved.activities.find((r) => r.id === 'act-1')
    expect(swim.fields.weather_alternative_id).toBeUndefined()
    expect(swim.clears).not.toContain('weather_alternative_id')
  })

  it('never reads Status or shoresh_id as a field', () => {
    let wb = exportWorkbook(fixture())
    wb = editWorkbook(wb, 'Activities', 1, 'Status', 'Confirmed-EDITED')
    const src = workbookToSource(reread(wb), { camp_id: 'camp-1' })
    const swim = src.approved.activities.find((r) => r.id === 'act-1')
    expect('Status' in swim.fields).toBe(false)
    expect('shoresh_id' in swim.fields).toBe(false)
  })
})

describe('workbookToSource — fail-closed metadata (ADR §4)', () => {
  it('rejects a workbook with no metadata sheet', () => {
    const wb = exportWorkbook(fixture())
    delete wb.Sheets[META_SHEET]
    wb.SheetNames = wb.SheetNames.filter((n) => n !== META_SHEET)
    expect(() => workbookToSource(wb, { camp_id: 'camp-1' })).toThrow(/missing the information/i)
  })

  it('rejects a camp mismatch (hard reject, never a held import)', () => {
    const wb = reread(exportWorkbook(fixture()))
    expect(() => workbookToSource(wb, { camp_id: 'other-camp' })).toThrow(/different camp/i)
  })

  it('rejects a program (cohort) mismatch', () => {
    const wb = reread(exportWorkbook(fixture()))
    expect(() => workbookToSource(wb, { camp_id: 'camp-1', cohort_id: 'other-coh' })).toThrow(/different program/i)
  })

  it('never defaults base_generation to 0 when it is edited out', () => {
    const wb = exportWorkbook(fixture())
    // Blank out base_generation in the metadata sheet.
    const meta = wb.Sheets[META_SHEET]
    const rows = XLSX.utils.sheet_to_json(meta, { header: 1 })
    const rIdx = rows.findIndex((r) => r[0] === 'base_generation')
    meta[XLSX.utils.encode_cell({ c: 1, r: rIdx })] = { t: 's', v: '' }
    expect(() => workbookToSource(reread(wb), { camp_id: 'camp-1' })).toThrow()
  })
})
