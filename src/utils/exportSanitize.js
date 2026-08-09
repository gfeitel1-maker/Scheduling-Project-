import * as XLSX from 'xlsx'

// Formula/CSV-injection sanitizer boundary for every xlsx/CSV Shoresh writes.
// docs/adr/2026-08-08-export-formula-injection-sanitizer.md
//
// A user-controlled string that begins with =, +, -, @ (or a leading tab/CR/LF)
// is interpreted by Excel/Sheets/LibreOffice as a live formula when the file is
// reopened — the classic CSV/formula-injection payload. Every export routes its
// string cells through here; it is the ONLY sheet-builder the export paths use
// for user data.

// The OWASP CSV-injection trigger set, plus tab/CR/LF (F5 — leading whitespace
// control chars are injection vectors in some parsers).
const FORMULA_TRIGGERS = /^[=+\-@\t\r\n]/

// Prefix a string cell that begins with a trigger with a single leading
// apostrophe — the spreadsheet-standard "treat as literal text" escape. Applied
// to STRING cells only; numbers/dates are written as typed and never reach here.
// Lossless: the reader sees the same value, and unescapeCell reverses it exactly.
export function sanitizeCell(value) {
  if (typeof value !== 'string') return value
  return FORMULA_TRIGGERS.test(value) ? `'${value}` : value
}

// Build a worksheet from an array-of-arrays, escaping every string cell first.
// The one call the exports use in place of XLSX.utils.aoa_to_sheet on user data.
export function aoaToSanitizedSheet(rows) {
  return XLSX.utils.aoa_to_sheet(rows.map((row) => row.map(sanitizeCell)))
}

// Reverse the escape on the import READ path — a CONDITIONAL strip. Remove ONE
// leading apostrophe ONLY when the remainder still begins with a trigger char,
// i.e. only when this apostrophe could have been our sanitizer's escape.
//   'Round the Campfire  → unchanged  (apostrophe guards ordinary text)
//   '=SUM(A1)            → =SUM(A1)    (our escape reversed, lossless)
//   =SUM (Excel quotePrefix, no literal ') → unchanged (already the value)
export function unescapeCell(value) {
  if (typeof value !== 'string') return value
  return value.startsWith("'") && FORMULA_TRIGGERS.test(value.slice(1))
    ? value.slice(1)
    : value
}

// Apply the conditional unescape to every cell of an imported row — an
// array-of-arrays row or a sheet_to_json object row. So an escaped literal a
// previous export wrote round-trips clean and never re-enters as a live formula.
export function unescapeRow(row) {
  if (Array.isArray(row)) return row.map(unescapeCell)
  const out = {}
  for (const key of Object.keys(row)) out[key] = unescapeCell(row[key])
  return out
}

// Import size/complexity caps (ADR §3a / F4). Comfortably above any real camp,
// far below a resource-exhaustion payload. Recorded here so they are a decision,
// not an accident.
export const IMPORT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxSheets: 32,
  maxRowsPerSheet: 20000,
}

// Fail closed BEFORE reading the bytes into a parser — a crafted xlsx (zip bomb,
// millions of rows) must never reach XLSX.read. Throws a clear message; the
// caller imports nothing.
export function assertImportFileSize(byteLength, limits = IMPORT_LIMITS) {
  if (byteLength > limits.maxBytes) {
    throw new Error(
      `That file is too large to import (over ${Math.round(limits.maxBytes / (1024 * 1024))} MB). Nothing was imported.`
    )
  }
}

// Fail closed AFTER parse but BEFORE reading any cell — bound sheet and per-sheet
// row counts so a decompressed bomb cannot be walked. Throws; imports nothing.
export function assertWorkbookComplexity(workbook, limits = IMPORT_LIMITS) {
  const names = workbook.SheetNames ?? []
  if (names.length > limits.maxSheets) {
    throw new Error(
      `That file has too many sheets (over ${limits.maxSheets}) to import safely. Nothing was imported.`
    )
  }
  for (const name of names) {
    const ws = workbook.Sheets[name]
    const ref = ws?.['!ref']
    if (!ref) continue
    const rows = XLSX.utils.decode_range(ref).e.r + 1
    if (rows > limits.maxRowsPerSheet) {
      throw new Error(
        `A sheet in that file has too many rows (over ${limits.maxRowsPerSheet}) to import safely. Nothing was imported.`
      )
    }
  }
}
