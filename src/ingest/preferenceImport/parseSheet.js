// T195 — bounded preference-sheet parser. Pure: no db, no IPC.
//
// Reuses the ONE import-read boundary (readWorkbookSafely,
// src/utils/exportSanitize.js:84) and its EXISTING IMPORT_LIMITS — this file
// invents no new size/complexity caps. CSV/TSV route through the same
// XLSX.read call as .xlsx (XLSX.read auto-detects delimited text from a
// buffer; verified against xlsx@0.20.3, the version this repo pins), so
// there is no separate CSV reader.
import * as XLSX from 'xlsx'
import { readWorkbookSafely, unescapeRow } from '../../utils/exportSanitize.js'

/**
 * @param {Buffer|ArrayBuffer} buffer
 * @param {{ sheetName?: string }} [options]
 * @returns {{ headers: string[], rows: Array<Record<string,string>>, sheetNames: string[] }}
 */
export function parsePreferenceSheet(buffer, { sheetName } = {}) {
  const byteLength = buffer?.byteLength ?? buffer?.length ?? 0
  // A browser File read (FileReader/arrayBuffer()) hands over a plain
  // ArrayBuffer; a CLI/Node caller hands over a Buffer. XLSX.read needs to be
  // told which ('array' vs 'buffer') — it does not sniff the JS type itself.
  const type = buffer instanceof ArrayBuffer ? 'array' : 'buffer'
  const workbook = readWorkbookSafely(buffer, { type, byteLength })
  const sheetNames = workbook.SheetNames ?? []
  const targetName = sheetName ?? sheetNames[0]
  const sheet = workbook.Sheets[targetName]
  if (!sheet) {
    throw new Error(`parsePreferenceSheet: sheet '${targetName}' not found`)
  }

  const aoa = XLSX.utils
    .sheet_to_json(sheet, { header: 1, blankrows: false, defval: '', raw: false })
    .map(unescapeRow)

  const headers = (aoa[0] ?? []).map((h) => String(h ?? ''))
  const rows = aoa.slice(1).map((row) => {
    const record = {}
    headers.forEach((header, i) => {
      record[header] = row[i] === undefined ? '' : String(row[i])
    })
    return record
  })

  return { headers, rows, sheetNames }
}
