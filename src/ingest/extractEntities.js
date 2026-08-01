// A parsed grid becomes a *proposal* — never a write.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §1, §2, §7.
//
// Everything here is inference. A director laid this grid out for other humans,
// and reading their camp's structure back out of it involves guessing. That is
// why nothing downstream writes without the director seeing and correcting what
// came out (ADR §1): the guess is expected to be wrong sometimes, and the
// preview is what makes that safe rather than damaging.
//
// Over-inclusion is the deliberate bias. A wrong row the director deletes costs
// them a moment; a missing row they never notice costs them the retyping this
// feature exists to remove.

import { isDayName } from './textGrid.js'

// ADR §2 — the entities ingestion may propose, as a whitelist rather than a
// convention. "Entities only" comes under pressure the moment someone notices
// the placements are sitting right there in the parsed grid, and a whitelist is
// the difference between reopening that decision deliberately and doing it by
// accident on a Tuesday afternoon.
export const INGESTIBLE_ENTITIES = Object.freeze([
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities',
])

const DAY_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// Values that are structure, not content. These appear in cells but are never
// activities: a time that wrapped out of its column, or a banner row.
const NOT_AN_ACTIVITY = [
  /^\d{1,2}[:.]\d{2}/,          // a time that leaked into a data column
  /^(block|period)\s*\d*$/i,    // "Block 2"
  /^\d+$/,                      // a bare number
  /^-+$/,
]

// Time-column text overflows into data columns in Camp A, so cells arrive as
// "Instructional Swim 11:45-12:10-" and "Opening 9:40-9:50 Change". The
// activity is in there; the schedule's own timing is not part of its name.
function stripTimes(text) {
  return String(text ?? '')
    .replace(/\d{1,2}[:.]\d{2}\s*[-–—]?\s*(\d{1,2}[:.]\d{2})?/g, ' ')
    .replace(/\bChange\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// A cell repeated down a column accumulates when a page is read too long —
// "Field Field Field Field". One occurrence is the activity.
function collapseRepeats(text) {
  return String(text ?? '').replace(/\b(.+?)\b(?:\s+\1\b)+/gi, '$1').trim()
}

export function cleanCellValue(text) {
  return collapseRepeats(stripTimes(text))
    // Stripping a time leaves its dash behind, so "11:45-12:10- Instructional
    // Swim" became "- Instructional Swim" — a separate activity from the real
    // one, and a frequent one, because the split is systematic rather than
    // occasional.
    .replace(/^[\s\-–—:]+/, '')
    .replace(/[\s\-–—:]+$/, '')
    .trim()
}

function isActivityLike(text) {
  const t = String(text ?? '').trim()
  if (t.length < 2) return false
  if (NOT_AN_ACTIVITY.some((re) => re.test(t))) return false
  return true
}

// "Adom 4's - Matzo Balls Schedule" -> "Adom 4's - Matzo Balls"
// "Monday — All Camp" -> "Monday"
function cleanTitle(title) {
  return String(title ?? '')
    .replace(/\s*[-–—]\s*All Camp\s*$/i, '')
    .replace(/\s+Schedule\s*$/i, '')
    .trim()
}

// How often each value appeared, kept because it is the only honest signal of
// confidence available.
//
// A real activity recurs — "Drama" appears on most of a 33-page bunk schedule.
// A parse artifact ("Lunch Head Counselor", two cells welded together) appears
// once. Nothing is hidden on that basis; the count is shown, the list is
// ordered by it, and the preview uses it only to decide what starts ticked.
function tally(values) {
  const seen = new Map()
  for (const raw of values) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const key = text.toLowerCase().replace(/\s+/g, ' ')
    const found = seen.get(key)
    if (found) found.count += 1
    else seen.set(key, { name: text, count: 1 })
  }
  // Most-seen first, then alphabetical so the order is stable between runs.
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

// Groups, days and periods keep the order they appear in the document — a week
// reads Monday to Friday, not most-frequent first. Only activities are ranked
// by how often they were seen, because only they benefit from it.
function dedupe(values) {
  const seen = new Map()
  for (const raw of values) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const key = text.toLowerCase().replace(/\s+/g, ' ')
    if (!seen.has(key)) seen.set(key, text)
  }
  return [...seen.values()]
}

/**
 * Which way round is this grid?
 *
 * The two real camps' layouts are transposes of each other — one page per
 * group with days as columns, one page per day with groups as columns. A
 * parser that assumes either is wrong for half the corpus, so this is detected
 * and then **shown in the preview for confirmation** (ADR §7). It is never
 * silently relied upon.
 *
 * Day names are the signal: they are a closed set, and group names are not.
 */
export function detectOrientation(pages) {
  if (!pages || pages.length === 0) return { columns: 'unknown', pages: 'unknown', confident: false }

  const columnsAreDays = pages.every(
    (p) => p.columns.length > 0 && p.columns.filter(isDayName).length >= Math.ceil(p.columns.length * 0.6)
  )
  if (columnsAreDays) return { columns: 'days', pages: 'groups', confident: true }

  const titlesAreDays = pages.filter((p) => DAY_ORDER.some((d) => cleanTitle(p.title).toLowerCase().includes(d))).length
  if (titlesAreDays >= Math.ceil(pages.length * 0.6)) {
    return { columns: 'groups', pages: 'days', confident: true }
  }

  // Neither signal is clear. Say so rather than picking — the preview asks.
  return { columns: 'groups', pages: 'days', confident: false }
}

/**
 * Propose the setup entities a grid implies.
 *
 * Returns `{ orientation, entities, counts }`, where `entities` only ever has
 * keys from INGESTIBLE_ENTITIES. Nothing here touches the database.
 */
export function extractEntities(parsed) {
  const pages = parsed?.pages ?? []
  const orientation = detectOrientation(pages)

  const groups = []
  const days = []
  const timeBlocks = []
  const activities = []

  for (const page of pages) {
    const title = cleanTitle(page.title)

    if (orientation.columns === 'days') {
      days.push(...page.columns.filter(isDayName))
      if (title) groups.push(title)
    } else {
      groups.push(...page.columns)
      if (title) {
        const day = DAY_ORDER.find((d) => title.toLowerCase().includes(d))
        if (day) days.push(day[0].toUpperCase() + day.slice(1))
      }
    }

    for (const row of page.rows) {
      // A row label is the period it covers. Rows with no label are banners
      // ("Opening") rather than periods.
      if (row.label && /^\d{1,2}[:.]\d{2}/.test(row.label.trim())) {
        timeBlocks.push(row.label.trim())
      }
      for (const cell of row.cells) {
        // A dash left between two names is the seam where a time used to be:
        // "Instructional Swim - Recreational Swim" is two activities, not one.
        for (const part of cleanCellValue(cell).split(/\s+[-–—]\s+/)) {
          const value = part.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim()
          if (isActivityLike(value)) activities.push(value)
        }
      }
    }
  }

  const entities = {
    groups: dedupe(groups),
    days_of_operation: dedupe(days),
    time_blocks: dedupe(timeBlocks),
    activities: tally(activities).map((v) => v.name),
    // Neither layout carries units or programs — a bunk schedule does not say
    // which division a bunk is in. Proposing a guess would be worse than
    // proposing nothing, so these come back empty and the director fills them
    // in. Saying "we could not tell" is the honest output.
    tiers: [],
    cohorts: [],
  }

  // Per-value occurrence counts, alongside the plain name lists the rest of the
  // pipeline uses. Only activities are ranked this way — a group or a day
  // appears once by construction, so a count would say nothing.
  const seenCounts = { activities: Object.fromEntries(tally(activities).map((v) => [v.name, v.count])) }

  return {
    orientation,
    entities,
    seenCounts,
    counts: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length])),
  }
}
