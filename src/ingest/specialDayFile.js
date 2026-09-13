// T40 slice 3 — recognise a ONE-DAY special schedule and propose it as a
// special day, instead of forcing it through the weekly grid.
//
// PURE. No database, no I/O — this proposes, the director confirms, same
// discipline as every other module in this directory.
//
// WHY THIS EXISTS, measured 2026-09-13 on the ticket's own sample:
//
//   days_of_operation: []   a weekly schedule with no days is impossible
//   time_blocks:       1    all five periods collapsed into one
//   activities:        12   six of them junk — "Sylvia Values", "Unit Heads",
//                           "Laura Gym", "Lunch Lunch"
//
// and none of that is refused anywhere: the file has a real time axis, so
// T146's schedule-shape gate (src/ingest/scheduleShape.js) correctly accepts
// it. It IS a schedule. It is just not a WEEK.
//
// THE SIGNAL is the ticket's own observation: "one day with no day column at
// all". A weekly file always names its days somewhere — across the top, or one
// page per day with the day in the page title. That is what makes it weekly.
// So: one page, times down the side, and no day name anywhere.
//
// BIASED AGAINST CLAIMING, deliberately and asymmetrically. A false positive
// routes a camp's real weekly schedule into a throwaway single day. A false
// negative merely leaves today's behaviour in place. Every real sample in the
// corpus is pinned as a negative in the tests.
//
// KNOWN LIMIT, stated rather than hidden: this reads the `pages` shape, which
// for a SPREADSHEET (the ticket's sample is one) is one row per sheet row and
// is exactly right. The plain-TEXT path's blank-line block logic mangles this
// shape before it gets here — it joins the whole grid into one block, because
// a one-day file has no blank lines between periods. Text-pasted special days
// are therefore not supported by this slice; the spreadsheet path is.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const TIME_LABEL = /\d{1,2}\s*[:.]\s*\d{2}/
// The same separator the weekly path reads as activity-location. Here the tail
// is a STAFF NAME ("Pool - Unit Heads"), which is why this module handles it
// itself rather than reusing that split — see splitCell below.
const DETAIL_SEPARATOR = /\s+-\s+| - /

const norm = (s) => String(s ?? '').trim().toLowerCase()
const namesADay = (text) => String(text ?? '').split(/[^a-z]+/i).some((w) => DAY_NAMES.includes(norm(w)))

function timeRowCount(rows) {
  return (rows ?? []).filter((r) => TIME_LABEL.test(String(r?.label ?? ''))).length
}

/**
 * @param {Array<{title, columns, rows}>} pages
 * @returns {boolean} true only for a single-day grid, never for a weekly one
 */
export function looksLikeSpecialDayFile(pages) {
  if (!Array.isArray(pages) || pages.length !== 1) return false
  const [page] = pages
  const columns = page?.columns ?? []
  const rows = page?.rows ?? []
  // Two columns and two timed rows is the smallest thing that is recognisably
  // a grid rather than a stray list.
  if (columns.length < 2 || timeRowCount(rows) < 2) return false
  // A day named ANYWHERE means the file is placing itself within a week.
  if (columns.some(namesADay)) return false
  if (namesADay(page?.title)) return false
  return true
}

// "Pool - Unit Heads" -> { activityName: 'Pool', note: 'Unit Heads' }.
//
// The weekly path reads this separator as activity-LOCATION and would mint
// "Unit Heads" as a room. On a special day the tail is a person (the ticket's
// sample: "Stem - Sylvia", "Values - Laura"), and the owner ruled
// person-per-cell out of scope. So the tail is neither minted as an entity nor
// silently dropped — it is carried as a note on the slot, where the director
// can see what the file said and decide.
function splitCell(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const parts = text.split(DETAIL_SEPARATOR)
  const activityName = parts[0].trim()
  if (!activityName) return null
  const note = parts.length > 1 ? parts.slice(1).join(' - ').trim() : ''
  return { activityName, note: note || null }
}

/**
 * @param {Array} pages
 * @returns {{name, timeBlocks: string[], columnNames: string[], activityNames: string[],
 *           slots: Array<{groupName, blockLabel, activityName, note}>}|null}
 *          null for anything this does not recognise — a half-proposal would
 *          be worse than none, since the director is asked to confirm it.
 */
export function proposeSpecialDay(pages) {
  if (!looksLikeSpecialDayFile(pages)) return null
  const [page] = pages
  const columnNames = page.columns.map((c) => String(c).trim()).filter(Boolean)

  const timeBlocks = []
  const slots = []
  const activityNames = new Set()

  for (const row of page.rows) {
    const label = String(row?.label ?? '').trim()
    // Only timed rows are periods. An untimed row in this shape is a banner or
    // a note, not a block the day runs in.
    if (!TIME_LABEL.test(label)) continue
    if (!timeBlocks.includes(label)) timeBlocks.push(label)
    columnNames.forEach((groupName, i) => {
      const cell = splitCell(row?.cells?.[i])
      if (!cell) return
      activityNames.add(cell.activityName)
      slots.push({ groupName, blockLabel: label, activityName: cell.activityName, note: cell.note })
    })
  }

  return {
    // The day names ITSELF — "Among Us", a colour war, a trip. It is not the
    // camp's name and never becomes one.
    name: String(page.title ?? '').trim(),
    timeBlocks,
    columnNames,
    // Sorted so the same file proposes the same list twice; slots keep file
    // order, which is the order a director reads the grid in.
    activityNames: [...activityNames].sort(),
    slots,
  }
}
