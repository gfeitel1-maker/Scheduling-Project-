// T256 — the Locations sheet round-trips BY ID. Drives the real pipeline end to end:
// exportWorkbook → real xlsx bytes → a director's edit in those bytes → readEntitySheet →
// the LOCATIONS catalog mapping → parseLocationsSheetRows → resolveLocationImportRow, then
// applies the resolutions to a store and asserts the STORED rows, not the calls.
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { exportWorkbook, LOCATIONS_SHEET, ID_COLUMN } from './exportWorkbook.js'
import { readEntitySheet } from './exportSanitize.js'
import { ENTITY_FIELD_CATALOGS, inferEntityMapping, applyEntityMapping } from '../ingest/entityColumnMapping.js'
import { parseLocationsSheetRows, resolveLocationImportRow } from './importLocationsSheet.js'

const KINDS = new Set(['pool', 'field', 'court'])

function camp() {
  return [
    { id: 'loc-a', name: 'Field', capacity: 10, kind: 'field', sort_order: 1 },
    { id: 'loc-b', name: 'Field', capacity: 20, kind: 'field', sort_order: 2 },
    { id: 'loc-c', name: 'Pool', capacity: 3, kind: 'pool', sort_order: 3 },
  ]
}

// Edits the exported bytes the way a director would in Excel: by cell, under the header.
function editInExcel(bytes, edit) {
  const wb = XLSX.read(bytes, { type: 'array' })
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[LOCATIONS_SHEET], { header: 1, defval: '' })
  edit(aoa)
  wb.Sheets[LOCATIONS_SHEET] = XLSX.utils.aoa_to_sheet(aoa)
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

function reimport(bytes, store) {
  const catalog = ENTITY_FIELD_CATALOGS.locations
  const { rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Locations', requiredColumns: ['name', 'capacity'] })
  const mapping = inferEntityMapping(Object.keys(rows[0] ?? {}), catalog)
  const parsed = parseLocationsSheetRows(applyEntityMapping(rows, mapping, catalog), KINDS)
  const providedKeys = new Set(['name', 'capacity', ...(mapping.roles.kind != null ? ['kind'] : [])])
  const next = store.map((r) => ({ ...r }))
  let n = 0
  for (const row of parsed) {
    if (row.warning) continue
    const { existing, changedFields } = resolveLocationImportRow(row, next, providedKeys)
    if (existing) Object.assign(next.find((r) => r.id === existing.id), changedFields ?? {})
    else next.push({ id: `new-${++n}`, name: row.name, capacity: row.capacity, kind: row.kind })
  }
  return next
}

const exported = (store) => XLSX.write(exportWorkbook({ locations: store }), { type: 'array', bookType: 'xlsx' })

describe('T256 — Locations re-import is id-matched diff-and-update', () => {
  it('puts shoresh_id first on the Locations sheet', () => {
    const header = XLSX.utils.sheet_to_json(exportWorkbook({ locations: camp() }).Sheets[LOCATIONS_SHEET], { header: 1 })[0]
    expect(header[0]).toBe(ID_COLUMN)
    expect(header).toEqual([ID_COLUMN, 'name', 'capacity', 'kind', 'Status'])
  })

  it('a capacity edit lands on the right one of two same-named locations', () => {
    const store = camp()
    const bytes = editInExcel(exported(store), (aoa) => {
      const cap = aoa[0].indexOf('capacity')
      aoa.find((r) => r[0] === 'loc-b')[cap] = 25
    })
    const after = reimport(bytes, store)
    expect(after).toHaveLength(3)
    expect(after.find((r) => r.id === 'loc-a').capacity).toBe(10)
    expect(after.find((r) => r.id === 'loc-b').capacity).toBe(25)
  })

  it('a rename updates the same location instead of creating a second one', () => {
    const store = camp()
    const bytes = editInExcel(exported(store), (aoa) => {
      aoa.find((r) => r[0] === 'loc-c')[aoa[0].indexOf('name')] = 'Lake'
    })
    const after = reimport(bytes, store)
    expect(after).toHaveLength(3)
    expect(after.find((r) => r.id === 'loc-c').name).toBe('Lake')
  })

  it('a hand-added row with a blank id creates a location', () => {
    const store = camp()
    const bytes = editInExcel(exported(store), (aoa) => { aoa.push(['', 'Gym', 4, 'court', '']) })
    const after = reimport(bytes, store)
    expect(after).toHaveLength(4)
    expect(after.find((r) => r.name === 'Gym')).toMatchObject({ capacity: 4, kind: 'court' })
  })

  it('an unknown id creates, never errors and never lands on a same-named row', () => {
    const store = camp()
    const bytes = editInExcel(exported(store), (aoa) => { aoa.push(['loc-gone', 'Pool', 9, 'pool', '']) })
    const after = reimport(bytes, store)
    expect(after).toHaveLength(4)
    expect(after.find((r) => r.id === 'loc-c').capacity).toBe(3)
  })

  it('an untouched re-import changes nothing', () => {
    const store = camp()
    expect(reimport(exported(store), store)).toEqual(store)
  })
})
