// T146 — the schedule import path (ImportScreen -> workbookToPages ->
// extractEntities) must decline a workbook that is not schedule-shaped,
// instead of extracting residual one-character "activities" from it (a
// campus-map template's grid coordinates and legend keys).
//
// This is deliberately scoped to the SCHEDULE import path only. The
// per-entity template importers (SetupScreenShell's Download Template ->
// Import from Excel, for Locations/Electives/Special Events/germination) are
// non-schedule workbooks BY DESIGN and must never reach this check — so this
// lives as its own module, imported only by that path's entry points, not
// folded into a shared workbook helper both paths use (ticket's Red Hat
// risk #2).
//
// There are TWO such entry points, not one:
//   - src/screens/ImportScreen.jsx  — the director's drag-and-drop import
//   - scripts/ingestCli.js          — runIngestCli, which is also what
//                                     scripts/mcp/tools.js's ingest_preview
//                                     and ingest_commit run (T222)
// The CLI/MCP site was added in T222, after a camper elective-selection
// workbook committed its column headers ('#1', '#2', 'Division') as 33 camp
// groups and 33 tiers through a path that had never called this gate.
//
// KNOWN LIMITATION — this predicate is whole-FILE (`pages.some`) while
// extractEntities is per-PAGE, so one schedule-shaped page admits every other
// page in the file to extraction. A workbook mixing a selection sheet with a
// day x period menu passes here and its selection sheet is still extracted.
// That granularity mismatch is docs/work/tickets/T223-shape-gate-page-
// granularity.md, deliberately not fixed by adjusting a ratio here.
//
// A page (title/columns/rows, the shape workbookToPages and parseTextGrid
// both produce) is positive evidence of a schedule if it has EITHER axis a
// schedule always has, whichever orientation the camp happens to use
// (extractEntities' detectOrientation already distinguishes the two):
//   - a day axis: most of its columns are day names, or its title names a day
//   - a time axis: most of its row labels look like a clock time
// Bias is strongly toward accepting (ticket's Red Hat risk #1) — a single
// qualifying page anywhere in the file set is enough, and the ratios are
// majority (not unanimous) thresholds so a stray blank/footnote row or a
// mislabeled column doesn't tip a real schedule into rejection.

// Not imported from textGrid.js/extractEntities.js on purpose: several
// sibling ImportScreen test files fully replace `../ingest/textGrid` (no
// `importOriginal` spread), so importing isDayName from there would crash
// under those mocks. This list is a closed, stable set (docs/adr/
// 2026-08-01-ingesting-a-prior-year-schedule.md §7) — duplicating it here is
// cheaper than coupling to a module several tests intentionally stub out.
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const TIME_LABEL = /\d{1,2}\s*[:.]\s*\d{2}/

// 'Weds' is the one common abbreviation that is not a prefix of its day
// ('wednesday' goes w-e-d-n), so it is listed rather than derived.
const DAY_ABBREVIATION_ALIASES = { weds: 'wednesday', tues: 'tuesday', thur: 'thursday', thurs: 'thursday' }

// Accepts a day name written in full or abbreviated — 'Mon', 'Mon.', 'MON',
// 'Tues', 'Weds' (T222, Red Hat): a camp whose export abbreviates its headers
// had a real schedule refused by the CLI/MCP gate.
//
// A two-character floor is what keeps this from becoming a wildcard: a single
// letter would make any column starting with S, M, T, W or F a day, and this
// predicate's whole job is to require POSITIVE evidence. Everything here only
// ever moves a file from refused toward accepted, matching this module's
// stated bias, and the 60%/50% majority thresholds below still have to be met.
function isDayName(text) {
  const word = String(text ?? '').trim().toLowerCase().replace(/[^a-z]/g, '')
  if (word.length < 2) return false
  if (DAY_ABBREVIATION_ALIASES[word]) return true
  return DAY_NAMES.some((day) => day.startsWith(word))
}

function hasDayColumns(columns) {
  if (!columns || columns.length === 0) return false
  return columns.filter(isDayName).length >= Math.ceil(columns.length * 0.6)
}

function titleNamesADay(title) {
  return String(title ?? '').split(/[^a-z]+/i).some(isDayName)
}

function hasTimeRowLabels(rows) {
  if (!rows || rows.length === 0) return false
  const matching = rows.filter((r) => TIME_LABEL.test(String(r?.label ?? ''))).length
  return matching >= Math.ceil(rows.length * 0.5)
}

export function isScheduleShaped(pages) {
  return (pages ?? []).some(
    (page) => hasDayColumns(page.columns) || titleNamesADay(page.title) || hasTimeRowLabels(page.rows)
  )
}
