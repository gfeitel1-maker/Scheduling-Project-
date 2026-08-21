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
// M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D2): 'locations'
// sits immediately after 'time_blocks' and before 'activities' — the order
// commitPlan's create loop follows, so a location this same import proposes is
// already a live row (and in locationIdByName) by the time any activity's
// location field resolves. Order is normative here, not just set membership —
// ingest.test.js's set-equality check pairs with this array's own order.
export const INGESTIBLE_ENTITIES = Object.freeze([
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities',
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
export function canonicalDay(text) {
  const name = String(text).trim().toLowerCase()
  return name[0].toUpperCase() + name.slice(1)
}

// A page title that names a day ("Monday — All Camp" -> "Monday"), for the
// one-page-per-day layout. Returns null when the title names no day. Exported
// so fixed-event detection spells day names identically to the entity proposal
// by sharing this code rather than re-deriving it (the name-identity invariant).
export function dayNameFromTitle(title) {
  const day = DAY_ORDER.find((d) => String(title ?? '').toLowerCase().includes(d))
  return day ? day[0].toUpperCase() + day.slice(1) : null
}

// The activity names a single grid cell holds. A dash left between two names is
// the seam where a time used to be: "Instructional Swim - Recreational Swim" is
// two activities, not one. Exported so fixed-event detection reads a cell to the
// exact same names extractEntities does (the name-identity invariant).
export function activityNamesFromCell(cell) {
  const names = []
  for (const part of cleanCellValue(cell).split(/\s+[-–—]\s+/)) {
    const value = part.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim()
    if (isActivityLike(value)) names.push(value)
  }
  return names
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

// The third camp's titles are separator-less positional codes — "KA", "1A",
// "RB", "K1 (ECC)" — where the grade prefix IS the unit and the whole code is
// the group. splitUnitAndGroup needs a whitespace-delimited "Unit - Bunk" and
// cannot read these, so the unit is inferred from the prefix instead (spec §3c):
// a leading letter ("KA" -> "K") or a leading digit run ("1A" -> "1"). The
// {1,2}-char section and `$` anchor mean a real word cannot match ("Zahav"
// leaves "ah"/"av" over), so a bunk with no code keeps unit=null. Applied only
// on unlabeled pages; the two labelled camps never reach it, which is what keeps
// splitUnitAndGroup — and Camp A's "Zahav"/"2-3A" guards — untouched.
export function inferUnitFromCode(title) {
  const m = String(title ?? '').match(/^([A-Za-z]|\d+)\s*[A-Za-z0-9]{1,2}(\s*\([^)]*\))?$/)
  return m ? m[1] : null
}

// W6: a group-column header with no "Unit - Bunk" hyphen still often carries a
// division, spelled as a leading word (or words) followed by a trailing bunk
// number — "Yeladim 1", "Tzofim 2", "Chalutzim 3A". The bunk keeps the FULL
// header as its name (owner decision, 2026-08-21) rather than just the
// number, because "1" is not a usable bunk name on its own. A header with no
// trailing number ("CIT") returns null — the caller's job, not this one's, to
// decide what a token with no number becomes.
function splitDivisionWord(title) {
  const m = String(title ?? '').match(/^([A-Za-z][A-Za-z\s]*?)\s+(\d+[A-Za-z]?)$/)
  if (!m) return null
  return { unit: m[1].trim(), group: String(title).trim() }
}

// "Adom 4's - Matzo Balls Schedule" -> "Adom 4's - Matzo Balls"
// "Monday — All Camp" -> "Monday"
// Exported so fixed-event detection keys a page title into groupNameByTitle the
// same way extractEntities does.
export function cleanTitle(title) {
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

// Locations' candidate tally, same shape as tally() above but keyed
// TRIM-only/case-sensitive rather than case-folded — this has to match
// recognitionKey('locations', name) (preview.js), which is the ONE entity
// where "pool" and "Pool" are two legitimate rows, not one entity two
// spellings of (§D3). Folding case here, like every other entity's tally(),
// silently collapsed both spellings into a single candidate while the
// per-activity pairing below stays keyed by exact text — an activity paired
// with the spelling that lost the fold then matched no ticked candidate and
// its location was silently omitted. See docs/adr/2026-08-15-locations-
// import-export-roundtrip.md §D3, §D5.
function tallyExact(values) {
  const seen = new Map()
  for (const raw of values) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const found = seen.get(text)
    if (found) found.count += 1
    else seen.set(text, { name: text, count: 1 })
  }
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
  // Q8 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5): candidate
  // place names captured from textGrid.js's parallel `row.locations[]` (a room
  // line the parser used to silently discard). Tallied like every other
  // proposed entity; the per-activity pairing below is a majority vote, same
  // convention groupUnits already uses for "one value per name".
  const locations = []
  const activityLocationVotes = new Map() // normalized activity key -> Map(locationText -> count)
  // T36 — the residual report. A cell that cleans to real text but still fails
  // isActivityLike (a stray "Block 2", a bare room number sitting in a data
  // column) is content the director laid out and the parser is about to throw
  // away with no record. This is the transparency half of T36: not a parser
  // fix, a tally of what the parser already decided not to use, honestly
  // captured (raw cleaned text, not a fabricated entity).
  const residualCellValues = []

  for (const page of pages) {
    const title = cleanTitle(page.title)

    if (orientation.columns === 'days') {
      // A day is not the camp's vocabulary, it is the calendar's. One camp
      // writes "MONDAY", another "Monday"; both mean the same day and the app
      // should not shout because a spreadsheet did.
      days.push(...page.columns.filter(isDayName).map(canonicalDay))
      if (title) {
        // The new family's title is a positional code (unlabeled time column);
        // the group keeps the whole code and the unit is inferred from its
        // prefix. The two labelled camps keep calling splitUnitAndGroup (spec §3c).
        // This is the third behaviour gated on `!labeled` (with strip + banner in
        // textGrid.js); the coupling is spec R3.
        // Whichever heuristic matches the page's labeling is tried first; the
        // OTHER heuristic is then tried as a fallback whenever the primary one
        // found no unit — neither ever overrides a unit the other already
        // found, and a title matching neither shape stays null (ADR
        // 2026-08-09 Decision 2: a wrong unit is worse than a blank one).
        const primary = page.timeColumnLabeled === false
          ? { unit: inferUnitFromCode(title), group: title }
          : splitUnitAndGroup(title)
        const unit = primary.unit ?? (page.timeColumnLabeled === false ? null : inferUnitFromCode(title))
        const group = primary.group
        groups.push({ title, unit, group })
        if (unit) units.push(unit)
      }
    } else {
      // Columns are group names on this layout. The header is the raw
      // group/bunk name. Three heuristics, tried in order, each only taken
      // when the previous one found nothing (W6, owner-ratified 2026-08-21):
      //
      // 1. splitUnitAndGroup — the "Unit - Bunk" hyphen heuristic the
      //    pages-orientation titles use above (ADR 2026-08-09 Decision 2).
      // 2. splitDivisionWord — "Word Number" ("Yeladim 1", "Tzofim 2"): the
      //    real Camp B fixture's actual shape. The bunk keeps the FULL
      //    header as its name, not just the trailing number.
      // 3. Lone-token fallback — no hyphen, no trailing number ("CIT"): the
      //    header becomes its own division AND its own bunk. This
      //    intentionally overturns the old guard against reusing
      //    inferUnitFromCode here (which would have minted "C" from "CIT");
      //    the guard's real intent — never mint "C" from "CIT" — still
      //    holds, because this path always keeps the division as the WHOLE
      //    token, never a prefix carved out of it.
      page.columns.forEach((c) => {
        const hyphen = splitUnitAndGroup(c)
        const divisionWord = hyphen.unit ? null : splitDivisionWord(c)
        const { unit, group } = hyphen.unit
          ? hyphen
          : divisionWord ?? { unit: String(c ?? '').trim(), group: String(c ?? '').trim() }
        groups.push({ title: c, unit, group })
        if (unit) units.push(unit)
      })
      if (title) {
        const day = dayNameFromTitle(title)
        if (day) days.push(day)
      }
    }

    // Which page (bunk) each activity showed up on, so rarity can be judged
    // within a unit rather than across the whole camp, and so eligibility can
    // be inferred (T35). On the `days` layout one page IS one group, so every
    // cell on it shares the page title as its key. On the `groups` layout the
    // page is a day and the GROUP is the column — page.columns[cellIndex] is
    // that column's header, which is exactly the title `groups.push` above
    // filed this same column under, so it resolves through groupNameByTitle
    // the same way. No new parsing, just reusing the header→group mapping
    // that already exists for this branch.
    const pageKey = orientation.columns === 'days' ? title : null

    for (const row of page.rows) {
      // A row label is the period it covers. Rows with no label are banners
      // ("Opening") rather than periods.
      if (row.label && /^\d{1,2}[:.]\d{2}/.test(row.label.trim())) {
        timeBlocks.push(row.label.trim())
      }
      row.cells.forEach((cell, cellIndex) => {
        const names = activityNamesFromCell(cell)
        if (names.length === 0) {
          // Same cleaning activityNamesFromCell itself applies, so what's
          // reported is exactly the text that failed to become an activity —
          // not the raw cell, which would show a time or a dash artifact
          // that was never really "dropped content".
          //
          // DELIBERATE BOUNDARY: this is WHOLE-CELL residual only. A cell
          // where the dash-split yields at least one activity-like part
          // ("Art - Rm 3" -> keeps "Art") never reaches this branch at all —
          // names.length > 0 — so the OTHER fragment ("Rm 3") is never
          // reported as residual, on purpose. Those trailing fragments are
          // almost always an intentional room/person annotation (the same
          // " - " pattern T16/activityNamesFromCell's own dash-split exists
          // to read), not dropped content, and flagging every one would
          // drown the director in benign "not recognised" noise for text
          // that is doing exactly what it was written to do. Partial-cell
          // residual is out of scope here — only a cell that produced ZERO
          // activities is a genuine unmatched-content case.
          const cleaned = cleanCellValue(cell)
          if (cleaned && !/^-+$/.test(cleaned)) residualCellValues.push(cleaned)
        }
        for (const value of names) {
          activities.push(value)
          const cellKey = pageKey ?? page.columns[cellIndex] ?? null
          if (cellKey) {
            const key = value.toLowerCase().replace(/\s+/g, ' ')
            if (!activityPages.has(key)) activityPages.set(key, new Set())
            activityPages.get(key).add(cellKey)
          }
        }
        // Q8: textGrid.js only captures a location line on `!labeled` pages, so
        // `row.locations` is undefined on the two labelled camp families —
        // this whole block is then a no-op, zero regression to their behavior.
        const locText = String(row.locations?.[cellIndex] ?? '').trim()
        if (locText && names.length > 0) {
          locations.push(locText)
          for (const value of names) {
            // `value` is already trimmed (activityNamesFromCell's own .trim(),
            // line 122) — this key and activityLocations' below rely on that,
            // not on re-trimming here.
            const key = value.toLowerCase().replace(/\s+/g, ' ')
            if (!activityLocationVotes.has(key)) activityLocationVotes.set(key, new Map())
            const votes = activityLocationVotes.get(key)
            votes.set(locText, (votes.get(locText) ?? 0) + 1)
          }
        }
      })
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
    // Q8: ranked by how often seen, same treatment activities gets — a place
    // printed once is more likely a misread than a real room. tallyExact, not
    // tally — see its comment above.
    locations: tallyExact(locations).map((v) => v.name),
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

  // Page title -> the group name that title resolves to (short or full), so
  // both fixed-event detection and activity-rule inference can map a
  // one-page-per-group title to the exact group name the entity proposal
  // spells. Derived from data already computed, not new logic.
  const groupNameByTitleMap = new Map(groups.map((g, i) => [g.title, groupNames[i]]))

  // normalized(activity name) -> array of group NAMES (not page titles) that
  // had it, for T35 rule inference. Serializable (plain object of arrays) so
  // it can cross the same boundaries seenCounts already does. Titles are
  // mapped through groupNameByTitle here so activityRules.js stays a pure
  // function of names and never needs that map itself.
  const activityPagesOut = {}
  for (const [key, pageTitles] of activityPages) {
    activityPagesOut[key] = [...pageTitles].map((title) => groupNameByTitleMap.get(title) ?? title)
  }

  // Q8: normalized(activity name) -> the single place name it was most often
  // captured next to, mirroring groupUnits' "one value per name" convention.
  // A presentation simplification (§D5) — not a claim an activity can only
  // ever have one place — for a future slice to revisit if a real camp needs it.
  const activityLocations = {}
  for (const [key, votes] of activityLocationVotes) {
    let best = null
    let bestCount = 0
    for (const [loc, n] of votes) if (n > bestCount) { best = loc; bestCount = n }
    if (best) activityLocations[key] = best
  }

  return {
    orientation,
    entities,
    groupUnits: Object.fromEntries(groupUnits),
    groupNameByTitle: Object.fromEntries(groupNameByTitleMap),
    activityPages: activityPagesOut,
    activityLocations,
    seenCounts,
    counts: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length])),
    // T36 — most-seen first, same convention tally() uses for activities, so a
    // repeated artifact ("Block 2" on every page) reads as one line with a
    // count rather than a wall of duplicates.
    residual: { cells: tally(residualCellValues).map((v) => ({ value: v.name, count: v.count })) },
  }
}
