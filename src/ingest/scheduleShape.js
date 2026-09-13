// T146 — the schedule import path (ImportScreen -> workbookToPages ->
// extractEntities) must decline a workbook that is not schedule-shaped,
// instead of extracting residual one-character "activities" from it (a
// campus-map template's grid coordinates and legend keys).
//
// This is deliberately scoped to the SCHEDULE import path only. The
// per-entity template importers (SetupScreenShell's Download Template ->
// Import from Excel, for Locations/Electives/Special Events/germination) are
// non-schedule workbooks BY DESIGN and must never reach this check — so this
// lives as its own module, imported only from ImportScreen.jsx, not folded
// into a shared workbook helper both paths use (ticket's Red Hat risk #2).
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

function isDayName(text) {
  return DAY_NAMES.includes(String(text ?? '').trim().toLowerCase())
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
