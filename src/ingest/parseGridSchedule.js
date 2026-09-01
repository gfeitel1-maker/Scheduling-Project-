// Shared, pure grid-schedule parser — Consumer 1 (events) and, later,
// Consumer 2 (electives) both build on this.
//
// docs/adr/2026-08-22-event-schedule-import.md §1–§3.
//
// Input is the SAME `{ title, columns, rows: [{ label, cells }] }` page shape
// the existing file->grid extraction already produces (sheetGrid.js's
// sheetToPage/workbookToPages, textGrid.js's parseTextGrid) — reused
// unchanged, not reimplemented here. This module's only job is to figure out
// which axis of a page is TIME and which is GROUP/COLUMN, and normalize the
// result. It knows nothing about event_*/elective_* tables, campId, eventId,
// or writes — that is the consumer's job (eventGridPopulate.js).

import { cleanCellValue, electCanonicalSpellings, canonicalizeActivityName } from './extractEntities.js'

// A row/column label "looks like time" if it contains an H:MM (or H.MM)
// token anywhere — mirrors the shape textGrid.js's looksLikeTime/
// extractEntities.js's stripTimes already match against, not a new pattern.
const TIME_TOKEN = /\d{1,2}[:.]\d{2}/
// Captures an optional am/pm marker on either side of the range, so
// parseTimeLabel can tell an unambiguous time from a bare 12-hour guess.
const TIME_RANGE = /(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i

// The location-key section marker this feature's target file shape uses
// ("WHERE TO GO"). Matched case-insensitively against a row's own label.
const KEY_MARKER = /^where\s+to\s+go$/i
// "Watersports = Field" — a location-key line, wherever it appears (inside a
// marked section, or standalone on its own page).
const KEY_LINE = /^(.+?)\s*=\s*(.+)$/

function looksLikeTimeLabel(text) {
  return TIME_TOKEN.test(String(text ?? '').trim())
}

// A time-name majority test over one axis's labels — the import analogue of
// extractEntities.js's detectOrientation/isDayHeader day-name majority test.
// Only labels that carry text vote; a blank label contributes no signal
// either way (an empty first cell is common where a header does not label
// its own axis, per sheetToPage's doc comment).
function timeMajority(labels) {
  const nonEmpty = labels.map((l) => String(l ?? '').trim()).filter(Boolean)
  if (nonEmpty.length === 0) return false
  const matches = nonEmpty.filter(looksLikeTimeLabel).length
  return matches / nonEmpty.length >= 0.6
}

// "9:30-10:10" -> { name, start_time: '09:30', end_time: '10:10' }. A label
// that carries text but isn't a clean range still becomes a timeAxis entry —
// `name` set, times null — never dropped (spec §1.4).
//
// start_time/end_time are populated ONLY when the reading is unambiguous:
// an explicit am/pm marker, an hour >= 13 (24h notation), or an hour written
// with a leading zero ("09:30" — nobody writes that for 12-hour AM/PM). A
// bare 12-hour hour with none of those ("1:00-1:45") is genuinely ambiguous
// — could be morning or afternoon — so it is left name-only rather than
// silently assumed AM (Red Hat #3: was a silent inversion for PM times).
function isLeadingZeroHour(hourText) {
  return hourText.length === 2 && hourText[0] === '0'
}

function resolve24Hour(hourText, marker) {
  let hour = parseInt(hourText, 10)
  if (marker) {
    const isPM = /p/i.test(marker)
    if (isPM && hour < 12) hour += 12
    if (!isPM && hour === 12) hour = 0
  }
  return hour
}

function parseTimeLabel(label) {
  const text = String(label ?? '').trim()
  const m = text.match(TIME_RANGE)
  if (!m) return { name: text, start_time: null, end_time: null }
  const [, h1, mm1, marker1, h2, mm2, marker2] = m

  const unambiguous =
    Boolean(marker1) || Boolean(marker2) ||
    parseInt(h1, 10) >= 13 || parseInt(h2, 10) >= 13 ||
    isLeadingZeroHour(h1) || isLeadingZeroHour(h2)
  if (!unambiguous) return { name: text, start_time: null, end_time: null }

  const sharedMarker = marker1 || marker2
  const pad = (hourText, mm, marker) => {
    const hour = resolve24Hour(hourText, marker || sharedMarker)
    return `${String(hour).padStart(2, '0')}:${mm}`
  }
  return { name: text, start_time: pad(h1, mm1, marker1), end_time: pad(h2, mm2, marker2) }
}

// Split a page's rows into the actual grid rows and a location-key section
// (ADR §2 "Location key"). ONE detection strategy: a "WHERE TO GO"-style
// marker row — everything after it (marker itself dropped) is the key
// section, regardless of individual line shape. Without a marker, every row
// stays a grid row — there is no unmarked "row.label looks like `a = b`"
// fallback, because that guess silently drops real schedule rows whose
// label happens to contain "=" (e.g. "Red = Blue Scrimmage") with no
// unmapped notice (Red Hat #4). A marker is the only reliable signal.
function splitKeySection(rows) {
  const markerIndex = rows.findIndex((r) => KEY_MARKER.test(String(r.label ?? '').trim()))
  if (markerIndex !== -1) {
    return { gridRows: rows.slice(0, markerIndex), keyRows: rows.slice(markerIndex + 1) }
  }
  return { gridRows: rows, keyRows: [] }
}

// "name = name" lines -> [[activity, location], ...]. Also recognises a
// plain two-column "activity | location" page (no "=" needed) when the page
// itself only has one data column — the shape a location key gets when it
// arrives as its own small sheet rather than a "WHERE TO GO" section.
function keyEntriesFromRows(rows, singleColumn) {
  const entries = []
  for (const row of rows) {
    const label = String(row.label ?? '').trim()
    const m = label.match(KEY_LINE)
    if (m) { entries.push([m[1].trim(), m[2].trim()]); continue }
    if (singleColumn) {
      const filled = (row.cells ?? []).map((c) => String(c ?? '').trim()).filter(Boolean)
      if (label && filled.length === 1) entries.push([label, filled[0]])
    }
  }
  return entries
}

function activityLocationTally(entries) {
  const votes = new Map() // normalized activity name -> Map(locationText -> count)
  for (const [activity, location] of entries) {
    if (!activity || !location) continue
    const key = activity.toLowerCase().replace(/\s+/g, ' ')
    if (!votes.has(key)) votes.set(key, new Map())
    const perLoc = votes.get(key)
    perLoc.set(location, (perLoc.get(location) ?? 0) + 1)
  }
  const best = new Map()
  for (const [key, perLoc] of votes) {
    let top = null
    let topCount = 0
    for (const [loc, n] of perLoc) if (n > topCount) { top = loc; topCount = n }
    if (top) best.set(key, top)
  }
  return best
}

function emptyResult() {
  return {
    orientation: { axis: null, confident: false },
    timeAxis: [],
    groupAxis: [],
    cells: [],
    unmapped: [],
  }
}

/**
 * Normalize one or more grid pages into { orientation, timeAxis, groupAxis,
 * cells, unmapped } — per-cell `locationName` carries the majority-vote
 * location key result (see below); there is no top-level aggregate field.
 * Pure — no db, no entity/table knowledge.
 * See docs/adr/2026-08-22-event-schedule-import.md §2.
 */
export function parseGridSchedule(pages) {
  const list = Array.isArray(pages) ? pages : []
  if (list.length === 0) return emptyResult()

  // The schedule grid is the first page whose row-labels OR column-labels
  // clear the time majority; a lone page is used even if not confident, so
  // the caller gets back the "couldn't tell" signal rather than nothing.
  let gridPageIndex = list.findIndex(
    (p) => timeMajority((p.rows ?? []).map((r) => r.label)) || timeMajority(p.columns ?? [])
  )
  if (gridPageIndex === -1) gridPageIndex = 0
  const gridPage = list[gridPageIndex]

  const allRows = gridPage.rows ?? []
  const columns = gridPage.columns ?? []
  const { gridRows, keyRows } = splitKeySection(allRows)

  const rowsAreTime = timeMajority(gridRows.map((r) => r.label))
  const columnsAreTime = timeMajority(columns)

  // Location-key entries: this page's own key section, plus any OTHER page
  // in the upload that is itself shaped like a key (a separate "WHERE TO
  // GO" sheet rather than a section of the schedule sheet) — best-effort,
  // per ADR §2/§3. Detecting which page a fragile key lives on must never
  // block the grid parse itself.
  const otherPages = list.filter((_, i) => i !== gridPageIndex)
  const keyEntries = [
    ...keyEntriesFromRows(keyRows, columns.length <= 1),
    ...otherPages.flatMap((p) => keyEntriesFromRows(p.rows ?? [], (p.columns ?? []).length <= 1)),
  ]
  const locationVotes = activityLocationTally(keyEntries)

  // Neither axis clears the majority, OR BOTH do (Red Hat #2) — either way
  // the parser cannot tell which side is times, and must say so rather than
  // silently defaulting to rows-are-time.
  if (!rowsAreTime && !columnsAreTime) {
    return emptyResult()
  }
  if (rowsAreTime && columnsAreTime) {
    return emptyResult()
  }

  const axis = rowsAreTime ? 'rows-are-time' : 'columns-are-time'
  const cells = []
  const unmapped = []

  function addCell(rawText, timeIndex, groupIndex) {
    const raw = String(rawText ?? '').trim()
    if (!raw) return
    const activityName = cleanCellValue(raw)
    if (!activityName) {
      unmapped.push({ sourceExcerpt: raw, reason: 'could not read an activity name from this cell' })
      return
    }
    const key = activityName.toLowerCase().replace(/\s+/g, ' ')
    cells.push({
      timeIndex,
      groupIndex,
      activityName,
      locationName: locationVotes.get(key) ?? null,
    })
  }

  let timeAxis
  let groupAxis

  if (rowsAreTime) {
    // Time rows only — a row with no label at all is metadata bleed-through
    // (a repeated day/roll-call row above the real periods), not a period.
    const timedRows = gridRows.filter((r) => String(r.label ?? '').trim())
    timeAxis = timedRows.map((r, i) => ({ ...parseTimeLabel(r.label), sourceLabel: r.label, sourceIndex: i }))
    groupAxis = columns
      .map((name, i) => ({ name: String(name ?? '').trim(), sourceLabel: name, sourceIndex: i }))
      .filter((g) => g.name)
    timedRows.forEach((row, timeIndex) => {
      groupAxis.forEach((g) => addCell(row.cells?.[g.sourceIndex], timeIndex, g.sourceIndex))
    })
  } else {
    timeAxis = columns.map((name, i) => ({ ...parseTimeLabel(name), sourceLabel: name, sourceIndex: i }))
    const namedRows = gridRows.filter((r) => String(r.label ?? '').trim())
    groupAxis = namedRows.map((r, i) => ({ name: String(r.label ?? '').trim(), sourceLabel: r.label, sourceIndex: i }))
    namedRows.forEach((row, groupIndex) => {
      timeAxis.forEach((t) => addCell(row.cells?.[t.sourceIndex], t.sourceIndex, groupIndex))
    })
  }

  // Re-index axes and cells to dense 0..n-1 positions — sourceIndex above was
  // needed to align cells during the pass but downstream consumers (and the
  // deterministic id scheme) want a stable, dense position.
  const timeIndexMap = new Map(timeAxis.map((t, i) => [t.sourceIndex, i]))
  const groupIndexMap = new Map(groupAxis.map((g, i) => [g.sourceIndex, i]))
  // Fold whitespace/case typo-variants of an activity name onto one dominant
  // spelling, exactly as the main schedule import does — so a "Lunch2" cell in
  // an electives/events grid doesn't mint a duplicate of "Lunch 2" (the same
  // regression, this second import surface). No-op when there's no variance.
  const canonicalMap = electCanonicalSpellings(cells.map((c) => c.activityName))
  const reindexedCells = cells.map((c) => ({
    ...c,
    activityName: canonicalizeActivityName(c.activityName, canonicalMap),
    timeIndex: timeIndexMap.get(c.timeIndex) ?? c.timeIndex,
    groupIndex: groupIndexMap.get(c.groupIndex) ?? c.groupIndex,
  }))

  return {
    orientation: { axis, confident: true },
    timeAxis: timeAxis.map(({ sourceIndex: _sourceIndex, ...rest }, i) => ({ ...rest, sourceIndex: i })),
    groupAxis: groupAxis.map(({ sourceIndex: _sourceIndex, ...rest }, i) => ({ ...rest, sourceIndex: i })),
    cells: reindexedCells,
    unmapped,
  }
}
