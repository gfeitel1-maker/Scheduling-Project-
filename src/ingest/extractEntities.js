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
  const raw = String(text ?? '')
  // "Change" is only noise when it labels a transition next to a time, as in
  // Camp A's "11:10-11:20 Change". Camp Mindy has "Change/SPLAT" and "Change
  // Time/Snack" as real activities, and stripping the word unconditionally
  // turned those into "/SPLAT" and "Time/Snack".
  const hasTime = /\d{1,2}[:.]\d{2}/.test(raw)
  let out = raw.replace(/\d{1,2}[:.]\d{2}\s*[-–—]?\s*(\d{1,2}[:.]\d{2})?/g, ' ')
  if (hasTime) out = out.replace(/\bChange\b/gi, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

// A cell repeated down a column accumulates when a page is read too long —
// "Field Field Field Field". One occurrence is the activity.
//
// Only in a value long enough for the repeat to be accidental. Camp Mindy has
// an activity written "Change/Ga Ga" — two words, both meant — while Camp A
// produces "Transition to Dismissal Dismissal" and "Field Field Field Field".
// Collapsing any doubled word turned "Ga Ga" into "Ga"; refusing to collapse
// doubles left the four-word artifacts intact. Word count separates them.
function collapseRepeats(text) {
  const value = String(text ?? '').trim()
  if (value.split(/\s+/).length <= 2) return value
  return value.replace(/\b(.+?)\b(?:\s+\1\b)+/gi, '$1').trim()
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

// A page title on a per-bunk schedule usually names the unit as well as the
// bunk: "Adom 4's - Matzo Balls", "Maccabiah- Rookies", "Omanut- Chagalls".
//
// An earlier version of this file asserted that "a bunk schedule does not say
// which division a bunk is in". That was wrong, and wrong in an expensive way:
// it left a 33-bunk camp with 13 units to type in and 33 bunks to file by hand,
// when the file states both. 29 of Camp A's 33 titles carry the unit.
//
// Titles with no separator (Zahav, Gesher) are bunks with no unit, which is a
// real shape and not a parse failure.
// "MONDAY" -> "Monday". Only ever applied to text isDayName already accepted.
function canonicalDay(text) {
  const name = String(text).trim().toLowerCase()
  return name[0].toUpperCase() + name.slice(1)
}

export function splitUnitAndGroup(title) {
  // The separator must have whitespace on at least one side. Camp Mindy has a
  // group called "2-3A" — grades 2 and 3, section A — and a bare hyphen rule
  // read it as unit "2", group "3A", quietly renaming the group and inventing
  // a unit called "2". Camp A's real separators all have a space somewhere:
  // "Adom 4's - Matzo Balls", "Omanut- Chagalls", "Kesef 3- Cooking".
  const match = String(title ?? '').match(/^(.+?)(?:\s+[-–—]\s*|[-–—]\s+)(.+)$/)
  if (!match) return { unit: null, group: String(title ?? '').trim() }
  const unit = match[1].trim()
  const group = match[2].trim()
  // A one-character unit, or one with no letters in it, is far more likely to
  // be part of the group's own name than a division of the camp.
  if (unit.length < 2 || !/[A-Za-z]/.test(unit)) {
    return { unit: null, group: String(title ?? '').trim() }
  }
  return { unit, group }
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
  const activityPages = new Map()
  // Which unit each group belongs to, where the file says so.
  const groupUnits = new Map()
  const units = []
  const days = []
  const timeBlocks = []
  const activities = []

  for (const page of pages) {
    const title = cleanTitle(page.title)

    if (orientation.columns === 'days') {
      // A day is not the camp's vocabulary, it is the calendar's. One camp
      // writes "MONDAY", another "Monday"; both mean the same day and the app
      // should not shout because a spreadsheet did.
      days.push(...page.columns.filter(isDayName).map(canonicalDay))
      if (title) {
        const { unit, group } = splitUnitAndGroup(title)
        groups.push({ title, unit, group })
        if (unit) units.push(unit)
      }
    } else {
      // Columns are group names on this layout, with no unit information.
      groups.push(...page.columns.map((c) => ({ title: c, unit: null, group: c })))
      if (title) {
        const day = DAY_ORDER.find((d) => title.toLowerCase().includes(d))
        if (day) days.push(day[0].toUpperCase() + day.slice(1))
      }
    }

    // Which page (bunk) each activity showed up on, so rarity can be judged
    // within a unit rather than across the whole camp.
    const pageKey = orientation.columns === 'days' ? title : null

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
          if (!isActivityLike(value)) continue
          activities.push(value)
          if (pageKey) {
            const key = value.toLowerCase().replace(/\s+/g, ' ')
            if (!activityPages.has(key)) activityPages.set(key, new Set())
            activityPages.get(key).add(pageKey)
          }
        }
      }
    }
  }

  // A bunk keeps its short name where that is unambiguous — "Matzo Balls"
  // reads better than "Adom 4's - Matzo Balls" once the unit is a field. Two
  // units can use the same bunk name though (Rimon and Zayit both have a
  // "Traditional"), and groups are UNIQUE(camp_id, name), so a name used twice
  // keeps its full title.
  const shortNameUses = new Map()
  for (const g of groups) shortNameUses.set(g.group.toLowerCase(), (shortNameUses.get(g.group.toLowerCase()) ?? 0) + 1)
  const groupNames = groups.map((g) => {
    const name = shortNameUses.get(g.group.toLowerCase()) === 1 ? g.group : g.title
    if (g.unit) groupUnits.set(name, g.unit)
    return name
  })

  const entities = {
    groups: dedupe(groupNames),
    days_of_operation: dedupe(days),
    time_blocks: dedupe(timeBlocks),
    activities: tally(activities).map((v) => v.name),
    tiers: dedupe(units),
    // Programs really are absent from both layouts — nothing in a weekly grid
    // says which session it belongs to. Proposing a guess would be worse than
    // proposing nothing.
    cohorts: [],
  }

  // Per-value occurrence counts, alongside the plain name lists the rest of the
  // pipeline uses. Only activities are ranked this way — a group or a day
  // appears once by construction, so a count would say nothing.
  const seenCounts = { activities: Object.fromEntries(tally(activities).map((v) => [v.name, v.count])) }

  // How much of a single unit an activity covers.
  //
  // Product owner, 2026-08-01: "count frequency within the unit". A camp with
  // many programs has activities that are rare overall and completely normal
  // where they happen — only the Omanut bunks do Ceramics, only Gesher does
  // SSL Hours. Judged against the whole camp those look like misreads; judged
  // against their own unit they are universal.
  //
  // So the measure is a share, not a count: of the bunks in the unit where
  // this activity appears most, how many do it? A real specialty activity
  // scores 1.0 in its own unit while appearing twice in a 33-page document.
  const unitOfGroup = new Map()
  for (const g of groups) if (g.unit) unitOfGroup.set(g.title, g.unit)
  const groupsPerUnit = new Map()
  for (const g of groups) {
    const unit = g.unit ?? `\u0000${g.title}`
    groupsPerUnit.set(unit, (groupsPerUnit.get(unit) ?? 0) + 1)
  }

  const unitShare = {}
  for (const [key, pageSet] of activityPages) {
    const perUnit = new Map()
    for (const pageTitle of pageSet) {
      const unit = unitOfGroup.get(pageTitle) ?? `\u0000${pageTitle}`
      perUnit.set(unit, (perUnit.get(unit) ?? 0) + 1)
    }
    let best = 0
    for (const [unit, seen] of perUnit) {
      const total = groupsPerUnit.get(unit) ?? 1
      best = Math.max(best, seen / total)
    }
    unitShare[key] = best
  }
  seenCounts.activityUnitShare = unitShare

  return {
    orientation,
    entities,
    groupUnits: Object.fromEntries(groupUnits),
    seenCounts,
    counts: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length])),
  }
}
