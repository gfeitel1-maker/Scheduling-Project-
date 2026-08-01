// Turn a spreadsheet into the same page-of-grids shape a PDF's text produces.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §6 — Tier 1.
//
// This is the easy format and the reason the tiers are independently shippable:
// a spreadsheet already has cells, so none of textGrid.js's column
// reconstruction is needed. Everything downstream — orientation detection,
// entity extraction, the preview, the commit — is shared with the PDF path.
//
// Camp Mindy's export is four files, one per group, each with the days across
// the top and a single populated sheet. The group's name is in the FILE name,
// not in the sheet, which is why `title` is passed in rather than read.

const FOOTNOTE = /^\s*\*/

function asText(cell) {
  if (cell === null || cell === undefined) return ''
  return String(cell).replace(/\s+/g, ' ').trim()
}

/**
 * One sheet, as rows of cells (`XLSX.utils.sheet_to_json(ws, { header: 1 })`).
 *
 * The header is the first row that has at least two labelled columns after the
 * first — the first column holds the times and is usually unlabelled, so it
 * cannot be used as the anchor the way "Time" is in the PDFs.
 */
export function sheetToPage(rows, title) {
  const table = (rows ?? []).map((r) => (Array.isArray(r) ? r.map(asText) : []))

  let headerIndex = -1
  for (let i = 0; i < table.length; i++) {
    const labelled = table[i].slice(1).filter(Boolean)
    if (labelled.length >= 1) { headerIndex = i; break }
  }
  if (headerIndex === -1) return null

  const header = table[headerIndex]
  // Trailing empty columns are Excel padding, not columns of the schedule.
  let width = header.length
  while (width > 1 && !header[width - 1]) width -= 1
  const columns = header.slice(1, width)

  const body = []
  for (let i = headerIndex + 1; i < table.length; i++) {
    const row = table[i]
    const label = row[0] ?? ''
    const cells = columns.map((_, c) => row[c + 1] ?? '')

    // "*Schedule are subject to change", "**SPLAT -- Staff Planned Leisure
    // Activity Time". A footnote sits in the first column with nothing beside
    // it; treating it as a period would put it in the camp as a time block.
    if (FOOTNOTE.test(label) && cells.every((c) => !c)) continue
    if (!label && cells.every((c) => !c)) continue

    body.push({ label, cells })
  }

  return { title: asText(title), columns, rows: body }
}

/**
 * A workbook becomes one page per populated sheet.
 *
 * Empty sheets are skipped — Excel ships three by default and Camp Mindy's
 * files use one. A workbook of several real sheets (one per group, say) yields
 * a page each, named for the sheet.
 */
export function workbookToPages(sheets, fileTitle) {
  const built = []
  for (const { name, rows } of sheets ?? []) {
    const page = sheetToPage(rows, name)
    if (page && page.columns.length > 0 && page.rows.length > 0) built.push({ name, page })
  }
  // Only ONE sheet carries a schedule in every file seen so far, and Excel
  // ships two empty ones alongside it. Naming that page "Sheet1" would make
  // every group in the camp "Sheet1"; the filename is what identifies it.
  // A workbook with several real sheets is a different shape — one page per
  // group — and there the sheet names are the group names.
  return built.map(({ name, page }) => ({
    ...page,
    title: built.length > 1 ? name : (fileTitle || name),
  }))
}

/**
 * What a camp calls this group, from the file it arrived in.
 *
 * "Camp Mindy Schedule 2025 - Ruach  A Grades 4 & 5.xlsx" is one group's week,
 * and the only place its name appears is the filename. The camp's own name and
 * the year are shared by every file in the set, so they are not part of what
 * distinguishes this group — strip them and what remains is the group.
 */
export function groupNameFromFilename(filename, sharedPrefix = '') {
  let name = String(filename ?? '').replace(/\.(xlsx|xlsm|xls|csv|tsv|txt)$/i, '')
  if (sharedPrefix && name.startsWith(sharedPrefix)) name = name.slice(sharedPrefix.length)
  return name.replace(/^[\s\-–—_]+/, '').replace(/\s+/g, ' ').trim()
}

/**
 * The longest opening text every filename shares.
 *
 * With one file there is nothing to compare against, so nothing is stripped —
 * guessing which part of a lone filename is boilerplate would be inventing.
 */
export function sharedFilenamePrefix(filenames) {
  const names = (filenames ?? []).map((f) => String(f ?? '').replace(/\.(xlsx|xlsm|xls|csv|tsv|txt)$/i, ''))
  if (names.length < 2) return ''
  let prefix = names[0]
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1
    prefix = prefix.slice(0, i)
  }
  // Trim back to the last whitespace. Two files called "... - 2-3A" and
  // "... - 2-4B" share the text "- 2-", and keeping that would rename the
  // groups "3A" and "4B" — the "2" is part of what each is called.
  return prefix.replace(/\S*$/, '')
}
