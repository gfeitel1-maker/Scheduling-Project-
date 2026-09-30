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

// The single import-read boundary (Finding 2). Every uploaded-workbook read
// path — the seven per-entity setup importers AND the primary ingest paths —
// goes through here so the F4 caps are applied from ONE place rather than each
// call site re-implementing the assert/read/assert triad (and drifting). Order
// matters: size gate BEFORE the parser runs, then parse, then complexity gate
// BEFORE any cell is walked. `byteLength` is passed explicitly by callers that
// hold the File (file.size) or a Buffer, so the size cap can reject on the
// measured length exactly as ImportScreen already did; it falls back to the
// data's own byteLength/length when omitted. Throws a clear message on a breach;
// the caller imports nothing. This owns the read only — callers still run their
// own sheet_to_json + .map(unescapeRow) on the returned workbook.
export function readWorkbookSafely(data, { type, byteLength, limits = IMPORT_LIMITS } = {}) {
  const len = typeof byteLength === 'number' ? byteLength : (data?.byteLength ?? data?.length ?? 0)
  assertImportFileSize(len, limits)
  const workbook = XLSX.read(data, { type })
  assertWorkbookComplexity(workbook, limits)
  return workbook
}

// ONE READER FOR THE BYTES, one layer above `readWorkbookSafely` (T313): every
// sheet of a workbook as row arrays, cells unescaped, in the shape the preference
// and ingest transforms take. `readWorkbookSafely` owns the READ; this owns the
// read plus the `sheet_to_json` + `unescapeRow` pair that every caller of it was
// repeating, because those options are part of the rule and not a detail.
//
// WHY THIS EXISTS, stated plainly because it was mis-reading real files. The CLI
// sent CSV through here; the import panel hand-split it on `/\t|,/` after a
// `.trim()`. Over the 32-file probe corpus SEVEN files read differently, and they
// were the headline probes rather than curiosities: the packed cell
// `"Archery, Ceramics, Woodworking"` — the entire point of P09 and P10 — became
// THREE columns with literal quote characters inside the activity labels, so the
// director was never offered the `split_packed` resolution; and P17, a probe
// specifically about padded rank headers (`"# 1"`, `"#2 "`), had the padding
// trimmed away before the code under test could see it. A hand-rolled delimited
// reader cannot do RFC4180 quoting, and a preference sheet is exactly the document
// where a comma inside a cell carries meaning.
//
// It also forked IDENTITY, which is the reason this is one function rather than
// two tidy ones: a provisional subject is keyed on `submissionKeyFromRows`, so two
// readers of one file are two keys and one child becomes two campers depending on
// which door their sheet came through (T299/T303). Sharing the digest is not
// enough when the ROWS it digests are produced twice.
//
// Cells are NOT trimmed here. `cell()` in src/ingest/preferenceSheet.js trims
// every value it reads and the layout detectors trim every header, so trimming
// again would be a second rule that changes only the submission key.
export function readWorkbookRows(data, { type, byteLength, limits = IMPORT_LIMITS } = {}) {
  const workbook = readWorkbookSafely(data, { type, byteLength, limits })
  return (workbook.SheetNames ?? []).map((name) => ({
    name,
    rows: XLSX.utils
      .sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false })
      .map(unescapeRow),
  }))
}

// WHICH SHEET holds a given ENTITY's rows — the setup screens' counterpart to
// `selectPreferenceSheet` (T315).
//
// Every per-entity importer read `wb.Sheets[wb.SheetNames[0]]`, so a director whose table sat on any
// tab but the first got one of two outcomes, both measured on a workbook in the app's own export
// order (Programs, Age Divisions, Groups, Days, Time Blocks, Activities):
//
//   * Days and Anchors read the `Programs` tab, found none of their fields, and imported NOTHING;
//   * Groups and Activities read `name` off the `Programs` tab and would have imported the camp's
//     PROGRAM as a group and as an activity — a plausible-looking row that nobody created. Silence
//     with wrong data in it, which is the worse half.
//
// THE ORDER IS THE DESIGN, and each step earns its place:
//   1. the sheet NAME, when the workbook has one (case- and space-insensitive). Exact, and it is what
//      this app's own export writes, so it needs no guessing about columns.
//   2. the required COLUMNS, for a third-party file that names its tabs anything. The FIRST sheet
//      carrying all of them wins; several matching is accept-and-report, not a merge.
//   3. the FIRST sheet, unchanged from before. A single-sheet file — the ordinary third-party case —
//      therefore behaves exactly as it always did, which is what keeps this from being a rewrite of
//      every importer's contract.
//
// Returns the rows as OBJECTS keyed by header, which is what these importers consume — deliberately
// NOT the same shape as `readWorkbookRows` (array-of-arrays, for the preference transforms). Two row
// shapes, because two families of caller genuinely need different ones; one READ boundary underneath
// both, which is the thing that must not fork.
export function readEntitySheet(data, { type, byteLength, sheetName = null, requiredColumns = [], limits = IMPORT_LIMITS } = {}) {
  const workbook = readWorkbookSafely(data, { type, byteLength, limits })
  const names = workbook.SheetNames ?? []

  const fold = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  // FAILS SOFT, and the guard is load-bearing rather than defensive noise: a header probe that
  // throws takes the whole import down, turning "this tab is not the one" into "that import file
  // could not be read". `Array.isArray` because the first element is only an array for a sheet
  // `header: 1` could read as a grid — anything else means this tab tells us nothing about its
  // columns, which is an answer, not an error.
  const headersOf = (name) => {
    let aoa
    try {
      aoa = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '' })
    } catch {
      return new Set()
    }
    return new Set(Array.isArray(aoa?.[0]) ? aoa[0].map(fold) : [])
  }

  // 1. by name.
  let picked = sheetName ? names.find((n) => fold(n) === fold(sheetName)) : undefined

  // 2. by columns.
  if (!picked && requiredColumns.length > 0) {
    picked = names.find((n) => {
      const headers = headersOf(n)
      return requiredColumns.every((c) => headers.has(fold(c)))
    })
  }

  // 3. the first sheet, exactly as before.
  const selected = picked ?? names[0] ?? null

  return {
    sheet: selected,
    rows: selected
      ? XLSX.utils.sheet_to_json(workbook.Sheets[selected], { defval: '' }).map(unescapeRow)
      : [],
    // Named so a screen can say which tab it read, which matters most in the case this fixes: a
    // director who expected tab 2 and a screen that silently took tab 1 had no way to tell.
    otherSheets: names.filter((n) => n !== selected),
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
