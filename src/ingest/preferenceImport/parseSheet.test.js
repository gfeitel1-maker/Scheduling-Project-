// @vitest-environment node
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePreferenceSheet } from './parseSheet.js'
import { IMPORT_LIMITS } from '../../utils/exportSanitize.js'

function xlsxBuffer(aoa, sheetName = 'Sheet1') {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

function csvBuffer(aoa) {
  return Buffer.from(aoa.map((row) => row.join(',')).join('\n'), 'utf8')
}

const AOA = [
  ['Display Name', 'Group', 'External Id', 'Choice 1', 'Choice 2'],
  ['Alice Cohen', 'Bunk A', 'ext-1', 'Swim', 'Art'],
  ['Ben Levi', 'Bunk B', 'ext-2', 'Art', 'Swim'],
]

describe('parsePreferenceSheet', () => {
  it('produces identical headers/rows for an XLSX and a CSV with the same content', () => {
    const xlsx = parsePreferenceSheet(xlsxBuffer(AOA))
    const csv = parsePreferenceSheet(csvBuffer(AOA))
    expect(xlsx.headers).toEqual(AOA[0])
    expect(xlsx.rows).toEqual(csv.rows)
    expect(xlsx.headers).toEqual(csv.headers)
  })

  it('returns row records keyed by header, values as strings', () => {
    const { rows } = parsePreferenceSheet(xlsxBuffer(AOA))
    expect(rows[0]).toEqual({
      'Display Name': 'Alice Cohen',
      Group: 'Bunk A',
      'External Id': 'ext-1',
      'Choice 1': 'Swim',
      'Choice 2': 'Art',
    })
  })

  it('lists every sheet name in the workbook', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(AOA), 'Prefs')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Notes')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const { sheetNames } = parsePreferenceSheet(buf)
    expect(sheetNames).toEqual(['Prefs', 'Notes'])
  })

  it('reads the named sheet when sheetName is given', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(AOA), 'Prefs')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Other']]), 'Notes')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const { headers } = parsePreferenceSheet(buf, { sheetName: 'Notes' })
    expect(headers).toEqual(['Other'])
  })

  it('rejects a file over IMPORT_LIMITS.maxBytes before walking any row', () => {
    const big = Buffer.concat([xlsxBuffer(AOA), Buffer.alloc(IMPORT_LIMITS.maxBytes)])
    expect(() => parsePreferenceSheet(big)).toThrow(/too large/i)
  })
})
