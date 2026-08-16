import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import {
  exportWorkbook,
  SHEET_LAYOUT,
  META_SHEET,
  ID_COLUMN,
  STATUS_COLUMN,
  PLAN_VERSION,
} from './exportWorkbook.js'

// A small but complete camp fixture (localClient.list shape, snake_case).
function fixture() {
  return {
    camp_id: 'camp-1',
    cohort_id: 'coh-1',
    base_generation: 42,
    cohorts: [{ id: 'coh-1', name: 'Main' }],
    tiers: [
      { id: 'unit-a', name: 'Aleph', sort_order: 10 },
      { id: 'unit-b', name: 'Bet', sort_order: 20 },
    ],
    groups: [
      { id: 'grp-1', name: 'Yeladim 1', tier_id: 'unit-a', availability: 'AM', source: 'human' },
      { id: 'grp-2', name: 'Yeladim 2', tier_id: 'unit-b', availability: '', source: 'import' },
    ],
    days_of_operation: [
      { id: 'day-1', label: 'Monday', sort_order: 1 },
      { id: 'day-2', label: 'Tuesday', sort_order: 2 },
    ],
    time_blocks: [
      { id: 'tb-1', name: 'First Period', start_time: '08:40:00', end_time: '09:30:00', sort_order: 1 },
      { id: 'tb-2', name: 'Second Period', start_time: '09:40', end_time: '10:30', sort_order: 2 },
    ],
    // M4: locations is an extra input, resolved into the activities sheet's
    // `location` column (not a sheet of its own — see SHEET_LAYOUT).
    locations: [{ id: 'loc-pool', name: 'Pool' }],
    activities: [
      {
        id: 'act-1', name: 'Swim', priority: 'high', min_per_week: 1, max_per_week: 3,
        eligible_group_ids: JSON.stringify(['grp-1', 'grp-2']), location_id: 'loc-pool', source: 'human',
      },
      {
        id: 'act-2', name: 'Archery', priority: 'low', min_per_week: null, max_per_week: 2,
        eligible_group_ids: '[]', location_id: null, source: 'import',
      },
    ],
  }
}

// Read a sheet back as objects keyed by header, in document order.
function sheetRows(wb, sheetName) {
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false })
}
function metaMap(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[META_SHEET], { header: 1, defval: '', raw: false })
  return Object.fromEntries(rows.slice(1).map((r) => [r[0], r[1]]))
}

describe('exportWorkbook — sheets + columns', () => {
  it('has one sheet per ingestible entity plus the hidden metadata sheet', () => {
    const wb = exportWorkbook(fixture())
    const expected = SHEET_LAYOUT.map((l) => l.sheet)
    for (const name of expected) expect(wb.SheetNames).toContain(name)
    expect(wb.SheetNames).toContain(META_SHEET)
    // One sheet per entity + meta, nothing else.
    expect(wb.SheetNames.length).toBe(expected.length + 1)
  })

  it('each entity sheet starts with shoresh_id and ends with Status', () => {
    const wb = exportWorkbook(fixture())
    for (const layout of SHEET_LAYOUT) {
      const header = XLSX.utils.sheet_to_json(wb.Sheets[layout.sheet], { header: 1 })[0]
      expect(header[0]).toBe(ID_COLUMN)
      expect(header[header.length - 1]).toBe(STATUS_COLUMN)
      for (const col of layout.columns) expect(header).toContain(col.key)
    }
  })

  it('every row carries its shoresh_id and its editable fields', () => {
    const wb = exportWorkbook(fixture())
    const groups = sheetRows(wb, 'Groups')
    expect(groups.map((r) => r[ID_COLUMN])).toEqual(['grp-1', 'grp-2'])
    expect(groups[0].name).toBe('Yeladim 1')
    expect(groups[0].availability).toBe('AM')

    const acts = sheetRows(wb, 'Activities')
    expect(acts[0][ID_COLUMN]).toBe('act-1')
    expect(acts[0].name).toBe('Swim')
    expect(acts[0].priority).toBe('high')
    expect(String(acts[0].min_per_week)).toBe('1')
    expect(String(acts[0].max_per_week)).toBe('3')
    expect(acts[0].location).toBe('Pool')
  })

  it('renders FK ids as human labels: group unit + activity eligible_groups', () => {
    const wb = exportWorkbook(fixture())
    const groups = sheetRows(wb, 'Groups')
    expect(groups[0].unit).toBe('Aleph')
    expect(groups[1].unit).toBe('Bet')

    const acts = sheetRows(wb, 'Activities')
    expect(acts[0].eligible_groups).toBe('Yeladim 1, Yeladim 2')
    expect(acts[1].eligible_groups).toBe('')
  })

  it('Status reflects inferred/confirmed from provenance', () => {
    const wb = exportWorkbook(fixture())
    const groups = sheetRows(wb, 'Groups')
    expect(groups[0][STATUS_COLUMN]).toBe('Confirmed') // source: human
    expect(groups[1][STATUS_COLUMN]).toBe('Inferred') // source: import
    // Explicit status word wins.
    const wb2 = exportWorkbook({ ...fixture(), tiers: [{ id: 'u', name: 'X', status: 'Unknown' }] })
    expect(sheetRows(wb2, 'Units')[0][STATUS_COLUMN]).toBe('Unknown')
  })
})

describe('exportWorkbook — sort_order is persisted, never a row index (RISK E)', () => {
  it('carries the stored sort_order into the baseline regardless of input order', () => {
    const forward = exportWorkbook(fixture())
    const reversed = exportWorkbook({
      ...fixture(),
      tiers: [
        { id: 'unit-b', name: 'Bet', sort_order: 20 },
        { id: 'unit-a', name: 'Aleph', sort_order: 10 },
      ],
    })
    const bf = JSON.parse(metaMap(forward).baseline)
    const br = JSON.parse(metaMap(reversed).baseline)
    // Same persisted sort_order per id, independent of the row's position.
    expect(bf.tiers['unit-a'].sort_order).toBe(10)
    expect(bf.tiers['unit-b'].sort_order).toBe(20)
    expect(br.tiers['unit-a'].sort_order).toBe(10)
    expect(br.tiers['unit-b'].sort_order).toBe(20)
  })
})

describe('exportWorkbook — canonical text time columns (RISK F)', () => {
  it('writes HH:MM:SS as text and forces text cell format', () => {
    const wb = exportWorkbook(fixture())
    const ws = wb.Sheets['Time Blocks']
    // tb-1 row 2, start_time is column index 2 (shoresh_id, name, start_time...)
    const start = ws[XLSX.utils.encode_cell({ c: 2, r: 1 })]
    expect(start.t).toBe('s') // string, never coerced to a number/date serial
    expect(start.v).toBe('08:40:00')
    expect(start.z).toBe('@') // text format layered on top
    // "09:40" (no seconds) is canonicalized to HH:MM:SS text on the second row.
    const start2 = ws[XLSX.utils.encode_cell({ c: 2, r: 2 })]
    expect(start2.v).toBe('09:40:00')
    expect(start2.t).toBe('s')
  })

  it('a time_block round-trips its stored value as text (no serial coercion)', () => {
    const wb = exportWorkbook(fixture())
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const round = XLSX.read(buf, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json(round.Sheets['Time Blocks'], { defval: '', raw: false })
    expect(rows[0].start_time).toBe('08:40:00')
    expect(rows[0].end_time).toBe('09:30:00')
  })
})

describe('exportWorkbook — metadata sheet (RISK D)', () => {
  it('carries plan_version, camp_id, cohort_id, base_generation and the baseline', () => {
    const wb = exportWorkbook(fixture())
    const meta = metaMap(wb)
    expect(String(meta.plan_version)).toBe(String(PLAN_VERSION))
    expect(meta.camp_id).toBe('camp-1')
    expect(meta.cohort_id).toBe('coh-1')
    expect(String(meta.base_generation)).toBe('42')
    const baseline = JSON.parse(meta.baseline)
    // The baseline records exactly the value the export wrote, keyed by shoresh_id.
    expect(baseline.activities['act-1'].max_per_week).toBe(3)
    expect(baseline.groups['grp-1'].unit).toBe('Aleph')
  })

  it('the metadata sheet is hidden', () => {
    const wb = exportWorkbook(fixture())
    const idx = wb.SheetNames.indexOf(META_SHEET)
    expect(wb.Workbook.Sheets[idx].Hidden).toBe(1)
    // Entity sheets are visible.
    const gi = wb.SheetNames.indexOf('Groups')
    expect(wb.Workbook.Sheets[gi].Hidden).toBe(0)
  })

  it('base_generation passes through as given (sourced by the caller)', () => {
    const wb = exportWorkbook({ ...fixture(), base_generation: 7 })
    expect(String(metaMap(wb).base_generation)).toBe('7')
  })
})

describe('exportWorkbook — every string cell is sanitized (Security F3)', () => {
  it('escapes a =-leading activity name in the workbook', () => {
    const wb = exportWorkbook({
      ...fixture(),
      activities: [{ id: 'act-x', name: '=HYPERLINK("http://evil")', priority: 'low', eligible_group_ids: '[]' }],
    })
    const ws = wb.Sheets['Activities']
    const nameCell = ws[XLSX.utils.encode_cell({ c: 1, r: 1 })] // name column
    expect(nameCell.t).toBe('s')
    expect(nameCell.f).toBeUndefined() // no live formula
    expect(nameCell.v).toBe('\'=HYPERLINK("http://evil")')
  })

  it('the escape survives a write/read round-trip as inert text', () => {
    const wb = exportWorkbook({
      ...fixture(),
      tiers: [{ id: 'u', name: '@SUM', sort_order: 1 }],
    })
    const round = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' })
    const cell = round.Sheets['Units'][XLSX.utils.encode_cell({ c: 1, r: 1 })]
    expect(cell.t).toBe('s')
    expect(cell.f).toBeUndefined()
    expect(cell.v).toBe("'@SUM")
  })
})

// Structural gate (ADR §2a / Security F3): the builder must never bypass the
// sanitizer with a raw aoa_to_sheet on user data or a hand-built `.v` cell.
describe('exportWorkbook — styling did not bypass the sanitizer', () => {
  const src = readFileSync(join(process.cwd(), 'src/utils/exportWorkbook.js'), 'utf8')

  it('does not call raw XLSX.utils.aoa_to_sheet', () => {
    expect(src).not.toMatch(/aoa_to_sheet/)
  })

  it('never assigns a cell .v directly', () => {
    expect(src).not.toMatch(/\.\s*v\s*=/)
    expect(src).not.toMatch(/\]\s*=\s*\{[^}]*\bv:/)
  })

  it('builds sheets through aoaToSanitizedSheet', () => {
    expect(src).toMatch(/aoaToSanitizedSheet/)
  })
})

describe('exportWorkbook — empty camp', () => {
  it('produces header-only sheets and an empty baseline without throwing', () => {
    const wb = exportWorkbook({ camp_id: 'c', cohort_id: null, base_generation: 0 })
    expect(wb.SheetNames).toContain('Activities')
    const header = XLSX.utils.sheet_to_json(wb.Sheets['Activities'], { header: 1 })[0]
    expect(header[0]).toBe(ID_COLUMN)
    expect(JSON.parse(metaMap(wb).baseline).activities).toEqual({})
  })
})
