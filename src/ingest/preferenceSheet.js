// Reading a camper ranked-preference sheet into a PROPOSAL (T226), through the
// RESOLVE stage (T279).
//
// docs/work/tickets/T226-camper-preference-import.md,
// docs/work/tickets/T279-preference-etl-canonical-record-and-residue.md,
// docs/adr/2026-09-17-individual-elective-scheduling.md (D12, D14),
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md.
//
// Pure: no database, no IPC, no file reading. It takes the row arrays every
// other ingest consumer takes — plus the camp's own catalog, as plain arrays —
// and returns campers/choices/preferences/residue for a caller to show a
// director and commit. Like extractEntities, it PROPOSES.
//
// WHY A MAPPING RATHER THAN A FIXED LAYOUT. D14 recorded that the real
// submissions arrive through a third-party export nobody has seen (T218). The
// FIELDS are known from the camp's own blank form — a name, a division, a
// 1..N ranking, a swim opt-out — but their column arrangement is not, and a
// parser that hardcodes one arrangement is the thing D14 retired. So the
// layout is an argument: inferPreferenceMapping proposes one from the header,
// and the director corrects it. A new export format is then a mapping, not a
// code change.
//
// THE RULE THIS FILE NOW IMPLEMENTS (ADR §12.0, normative):
//
//   RESOLVE is the stage where every value read out of a file is either matched
//   to an entity the camp already has, or becomes RESIDUE. The elective
//   importer never writes a value it could not resolve without saying so.
//
// Five resolvers, one rule: columns → roles, labels → activities, division
// labels → groups (then tiers), rows → camper identities, coordinates →
// elective cells. Working the seven measured silent misses individually
// produced one answer seven times, which is why this is one stage rather than
// five patches — a reader can ask of any value "which resolver owns this, and
// what happens when it misses?"
//
// CORRECTION (T279) TO THIS FILE'S OWN HEADER. It used to claim:
//
//   "The ranking is GLOBAL — a camper ranks each elective once for the
//    session, not once per time slot."
//
// That is FALSE, and it was false when written. A Kind 2 planner grid gives one
// camper a choice PER CELL, and `elective_preferences.occurrence_id` (nullable,
// v78) exists precisely to carry that. A whole-run ranked list and a per-cell
// planner are both legitimate, which is why a preference's coordinate is
// NULLABLE rather than absent from the model: absent means "this reader cannot
// see cells", nullable means "this sheet does not scope its choices". The
// comment survived because nothing keyed on it; it is corrected rather than
// deleted so the record shows what the reader used to assume.

import { deriveCamperId, electiveChoiceLabelKey } from '../../electron/ops/electiveDerivedIds.js'
import { recognitionKey } from './preview.js'
// T318 round 2 — the three rank_kind values this ETL writes moved to
// src/engine/rankKind.js, the choke point also imported by
// buildElectiveAssignments.js and camperElectiveWeek.js's rankLabel, so the
// persisted string values live in exactly one place.
import { CELL_CHOICE, ORDERED_FALLBACK, UNORDERED_SET } from '../engine/rankKind.js'

// T285 slice A — RANK HEADER RECOGNITION.
//
// `#1` was the only form recognised, and ADR §4.2 measured what that costs: a
// real vendor export writes "First Choice" or "Choice 1", so the bare-`#N` anchor
// "matches essentially nothing". A file whose ranks are unreadable was refused at
// the header, which ADR §14.1 rules is the wrong side of the pipeline.
//
// Three forms, all ORDINAL statements of the same fact, kept as a short explicit
// list rather than a clever parser: a wrong guess about which column is rank 1 is
// a wrong statement about a child's first choice.
const RANK_HEADER = /^#\s*(\d+)$/
const RANK_CHOICE_NUMBER = /^choice\s*#?\s*(\d+)$|^(\d+)\s*(?:st|nd|rd|th)?\s+choice$/i
const ORDINAL_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth',
]
const RANK_ORDINAL_WORD = new RegExp(`^(${ORDINAL_WORDS.join('|')})\\s+choice$`, 'i')

// T285 slice B — a COLUMN-SCOPED coordinate. "Monday Period 3 - First Choice"
// and "Monday #1" carry the cell in the HEADER, one row per camper, which is a
// different dimension from the per-row Day/Period columns: every rank column
// names its own coordinate.
//
// Deliberately conservative. A day or a period is recognised only as a whole
// word, and a column becomes coordinate-scoped ONLY when a rank is also found —
// so a bare "Monday" column (a grid, which is slice F's problem) stays
// unrecognised and is reported rather than half-read. An activity that happens to
// contain a day name ("Monday Night Live") has no rank and so cannot be mistaken
// for a coordinate either.
const DAY_IN_HEADER = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i
const PERIOD_IN_HEADER = /\b(?:period|block)\s*(\d+)\b/i

/**
 * The coordinate and rank a column header names, or null.
 *
 * Labels come back AS WRITTEN (the matched substring), never normalised, because
 * they are stored as provenance — a director has to recognise their own header.
 */
function scopedRankFromHeader(header) {
  const day = DAY_IN_HEADER.exec(header)
  const period = PERIOD_IN_HEADER.exec(header)
  if (!day && !period) return null

  // Whatever is left once the coordinate is removed should name the rank.
  const remainder = header
    .replace(day?.[0] ?? '', ' ')
    .replace(period?.[0] ?? '', ' ')
    .replace(/[-–—:,()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const rank = rankFromHeader(remainder)
  if (rank == null) return null

  return {
    rank,
    coordinate: { dayName: day ? day[0] : null, periodLabel: period ? period[0] : null },
  }
}

/** The rank a header names, or null. */
function rankFromHeader(header) {
  const hash = RANK_HEADER.exec(header)
  if (hash) return Number(hash[1])
  const numbered = RANK_CHOICE_NUMBER.exec(header)
  if (numbered) return Number(numbered[1] ?? numbered[2])
  const word = RANK_ORDINAL_WORD.exec(header)
  if (word) return ORDINAL_WORDS.indexOf(word[1].toLowerCase()) + 1
  return null
}

// `Student` / `Camper` / `Child` alone, not only `Student Name`. The old pattern
// required the literal word "name" somewhere, so a bare `Student` header made the
// whole file "not a camper preference sheet".
const NAME_HEADER = /(camper|student|child).*name|^name$|^(camper|student|child)$/i
// A name SPLIT ACROSS TWO COLUMNS — the default output of most form tools, and so
// probably the most common real file this app rejected outright. Joined
// FIRST-then-LAST with a single space, because `deriveCamperId` keys on the
// canonicalized display name when there is no external id: the wrong order, or a
// "Last, First" rendering, would derive a DIFFERENT id for the same child and
// silently fail to match them on every later import.
// T285 slice C — LONG FORMAT. The rank and the activity are CELL values, one row
// per (camper, rank, activity), which is what a normalised form backend emits.
const RANK_VALUE_HEADER = /^(choice\s*rank|rank|priority|preference\s*(number|rank))$/i
const ACTIVITY_VALUE_HEADER = /^(activity|activity\s*name|choice|choice\s*name|elective)$/i
const FIRST_NAME_HEADER = /^(first|given)\s*name$/i
const LAST_NAME_HEADER = /^(last|family|sur)\s*name$/i
const EXTERNAL_ID_HEADER = /(camper|student|child)\s*(id|number|#)$|^id$/i
const DIVISION_HEADER = /division|bunk|group|unit|edah/i
// A per-row coordinate (T279). A sheet that scopes each choice to a cell says
// so in its own columns; this is the parse-time half of the coordinate
// resolver, and the value it yields is a LABEL PAIR, never an occurrence_id —
// see the `coordinate` note on parsePreferenceSheet.
const DAY_HEADER = /^day(\s*of\s*week)?$/i
const PERIOD_HEADER = /^(period|time\s*block)(\s*(number|#))?$/i
// An UNORDERED set in its own column (ADR §4.1): one cell holding several
// acceptable activities with no ordering evidence. Deliberately narrow — it
// must not swallow a title row like 'Activity Selection' (P12).
const UNORDERED_SET_HEADER = /^(acceptable|preferred|chosen)\s+activities$|^activities\s+chosen$/i

// The three meanings one integer `rank` column cannot carry (ADR §4.2), now
// persisted as `elective_preferences.rank_kind` (v79). Values imported from
// src/engine/rankKind.js — see that module's header.

// A packed multi-value cell's delimiters. One definition, used by both the
// label resolver's split-detection and the unordered-set column.
const PACKED_CELL_SPLIT = /\s*[,;/]\s*/

// The coordinate a row scopes its choices to, as LABELS. Two rows share a
// coordinate when this string matches; a row with no coordinate columns yields
// '', which is the single implicit whole-run "cell" every such row shares.
const coordinateKey = (coordinate) =>
  coordinate ? `${coordinate.dayName ?? ''}\u0000${coordinate.periodLabel ?? ''}` : ''

const cell = (row, index) => (index == null ? '' : String(row?.[index] ?? '').trim())

// Spreadsheet column letters, because that is what a director sees in the
// header row — not the zero-based index the mapping carries. Exported because
// the CLI reports the same letters and already imports from this module; two
// copies of a base-26 conversion is one too many.
export function columnLabel(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * A DAY x PERIOD GRID, detected from a header row and the rows under it.
 *
 * T285 slice G, OWNER RULING: *"the grid is the camper's own sheet, they fill it
 * out and turn it into campminder… our job is not to question what shape the data
 * comes in. we are a lake, the warehouse, and the pipeline."*
 *
 * A planner grid has no camper-name column because IT DOES NOT NEED ONE — the
 * identity comes from the SUBMISSION, not the page. So such a page is ONE
 * SUBJECT, not zero, and every filled cell is that child's answer for that
 * coordinate. Slices E/F read only the named tables and reported the grid as
 * unattributable, which was this program's own defect for the third time: the
 * importer discarding a child's answer because it could not place it.
 *
 * `optionsPerCoordinate` is how a MENU is told from a filled PLANNER, and it is
 * deliberately a statement about ARITY rather than about meaning. A menu offers
 * SEVERAL activities per (day, period); a filled planner records ONE choice. ADR
 * §3.3 is right that no shape inference can tell what a grid MEANS — so nothing
 * here tries. Counting cells per coordinate is checkable, and it is the only
 * separator left once "no camper is named" is known to be what a camper's own
 * sheet looks like.
 *
 * @returns {{periodIndex, dayColumns, optionsPerCoordinate}|null}
 */
export function detectGridLayout(rows = [], headerIndex = 0) {
  const header = (rows[headerIndex] ?? []).map((h) => String(h ?? '').trim())
  // Days name the columns. Two or more, because one column is not a week and a
  // single "Monday" column is far more likely to be an ordinary field.
  const dayColumns = []
  header.forEach((h, index) => {
    const day = DAY_IN_HEADER.exec(h)
    if (day && index > 0) dayColumns.push({ index, dayName: day[0] })
  })
  if (dayColumns.length < 2) return null

  // A day may span SEVERAL columns (an A/B options sub-header), and SheetJS gives
  // the spanned cells an empty header. Those belong to the day on their left.
  const spans = new Map()
  let current = null
  header.forEach((h, index) => {
    if (index === 0) return
    const day = DAY_IN_HEADER.exec(h)
    if (day) current = day[0]
    else if (h !== '') current = null
    if (current) {
      if (!spans.has(current)) spans.set(current, [])
      spans.get(current).push(index)
    }
  })
  const widths = [...spans.values()].map((c) => c.length)
  const optionsPerCoordinate = widths.length > 0 ? Math.max(...widths) : 1

  // The first column must label the periods on at least one row under the header,
  // or this is not a grid keyed by period and nothing here should claim it is.
  const body = rows.slice(headerIndex + 1)
  const labelled = body.filter((r) => PERIOD_IN_HEADER.test(String(r?.[0] ?? '').trim()))
  if (labelled.length === 0) return null

  return {
    periodIndex: 0,
    dayColumns: [...spans.entries()].flatMap(([dayName, indexes]) =>
      indexes.map((index) => ({ index, dayName }))
    ),
    optionsPerCoordinate,
  }
}

/**
 * IS THIS SHEET NOTHING BUT A PLANNER GRID? (T305)
 *
 * ONE definition, called by both `readPreferenceSheet` (which switches the
 * transform into its grid path) and the director's import panel (which skips the
 * mapping screen). They were the same expression written twice: the panel's
 * confirm gate — `nameIndex != null && rankColumns.length > 0` — is the exact
 * complement of the transform's grid branch, so the panel disabled its button on
 * precisely the sheets the transform knew how to read, and asked the director a
 * question that had already been answered. Two copies of one rule drift the moment
 * either moves; this is the choke point.
 *
 * `unmapped` being non-empty is what makes the grid reading RELEVANT, not what
 * makes it true — `detectGridLayout` still has to recognise the shape, and it
 * abstains unless two or more columns are named for days AND some body row's first
 * cell names a period. A sheet that is merely unreadable gets null here and is
 * still asked about, which is the case the mapping screen legitimately exists for.
 */
export function detectWholeSheetGrid(rows = [], mapping = null) {
  if (!mapping || (mapping.unmapped ?? []).length === 0) return null
  return detectGridLayout(rows, 0)
}

/**
 * WHAT A SET OF ROLE ASSIGNMENTS COVERS, and what it leaves out.
 *
 * ONE definition, called by `inferPreferenceMapping` (roles it proposed itself)
 * and by `mappingWithDirectorOverride` (roles a director assigned by hand). These
 * two halves of a mapping are DERIVED from the roles, never stated alongside them:
 * `unrecognisedColumns` becomes a residue item saying a column went unread, and
 * `unmapped` decides whether the sheet is readable at all. Carrying a director's
 * edited roles while keeping the inferencer's derived halves publishes both
 * statements about the wrong sheet — a column reported unread that they just
 * mapped, and a refusal for want of ranks they just supplied.
 *
 * A BLANK header is never reported, because a trailing empty column is a
 * spreadsheet artefact rather than a field the camp asked about.
 */
function describeCoverage(cells, roles) {
  const {
    nameIndex, externalIdIndex, divisionIndex, dayIndex, periodIndex, unorderedSetIndex,
    splitName, longFormat, invertedMatrix, rankColumns = [], tiedColumns = [],
  } = roles

  const claimed = new Set(
    [
      nameIndex, externalIdIndex, divisionIndex, dayIndex, periodIndex, unorderedSetIndex,
      splitName?.firstNameIndex ?? null, splitName?.lastNameIndex ?? null,
      longFormat?.rankValueIndex ?? null, longFormat?.activityValueIndex ?? null,
    ]
      .filter((i) => i != null)
      .concat(rankColumns.map((r) => r.index).filter((i) => i != null))
      .concat(tiedColumns)
      .concat((invertedMatrix ?? []).map((c) => c.index))
  )
  const unrecognisedColumns = cells
    .map((header, index) => ({ header, index, column: columnLabel(index) }))
    .filter((c) => c.header !== '' && !claimed.has(c.index))

  const unmapped = []
  if (nameIndex == null && splitName == null) unmapped.push('name')
  if (
    rankColumns.length === 0 &&
    tiedColumns.length === 0 &&
    unorderedSetIndex == null &&
    longFormat == null &&
    invertedMatrix == null
  ) {
    unmapped.push('ranks')
  }

  return { unrecognisedColumns, unmapped }
}

/**
 * Propose which column is which, from the header row.
 *
 * Every field is nullable and `unmapped` names what was not found — the caller
 * shows that to the director rather than proceeding on a guess.
 *
 * RESOLVER 1 (columns → roles). `unrecognisedColumns` is the new half and it is
 * the highest-leverage fix in the whole ticket: a column this reader cannot
 * assign a role to is REPORTED rather than ignored. That is what makes P18's
 * swim opt-out and comments box visible, and it is the loud half of P38 — a
 * rank column renamed `#3` → `Third Choice` between two imports silently
 * dropped rank 3 for every camper, with ok=true and nothing said. The rename
 * is still not UNDERSTOOD; it is no longer invisible.
 */
export function inferPreferenceMapping(header = [], { catalog } = {}) {
  const cells = header.map((h) => String(h ?? '').trim())
  const findIndex = (re) => {
    const i = cells.findIndex((h) => re.test(h))
    return i === -1 ? null : i
  }

  const ranked = []
  cells.forEach((h, index) => {
    // A column-scoped coordinate wins over a bare rank read: "Monday #1" is rank
    // 1 IN MONDAY, and reading it as a plain rank 1 would merge it with every
    // other day's first choice.
    const scoped = scopedRankFromHeader(h)
    if (scoped) {
      ranked.push({ rank: scoped.rank, index, coordinate: scoped.coordinate })
      return
    }
    const rank = rankFromHeader(h)
    if (rank != null) ranked.push({ rank, index })
  })

  // TWO COLUMNS CLAIMING ONE RANK are not a defect to refuse — they are an
  // UNORDERED SET (ADR §4.1): two equally acceptable choices, a tie among equals.
  // This used to be refused at the header, which both blocked a readable file and
  // stated the wrong thing about it. Coercing cell order into a ranking is the
  // one thing §4.1 forbids, so the duplicated rank's columns lose their rank
  // rather than being ordered arbitrarily; ranks that appear once are untouched.
  // Grouped by (COORDINATE, rank), not by rank alone — two columns both reading
  // rank 1 are a tie only if they name the SAME cell. "Monday #1" and
  // "Wednesday #1" are two different first choices, which is the normal shape of
  // a per-period sheet, and treating them as a duplicated rank would strip both
  // of their rank.
  const byRank = new Map()
  for (const r of ranked) {
    const key = `${coordinateKey(r.coordinate)}\u0000${r.rank}`
    if (!byRank.has(key)) byRank.set(key, { rank: r.rank, coordinate: r.coordinate ?? null, indexes: [] })
    byRank.get(key).indexes.push(r.index)
  }
  const duplicatedRanks = []
  const rankColumns = []
  const tiedColumns = []
  for (const { rank, coordinate, indexes } of byRank.values()) {
    if (indexes.length > 1) {
      duplicatedRanks.push({ rank, columns: indexes.map(columnLabel), indexes })
      tiedColumns.push(...indexes)
    } else {
      rankColumns.push({ rank, index: indexes[0], coordinate })
    }
  }
  rankColumns.sort((a, b) => a.rank - b.rank)
  tiedColumns.sort((a, b) => a - b)

  const externalIdIndex = findIndex(EXTERNAL_ID_HEADER)
  let nameIndex = findIndex(NAME_HEADER)
  // 'Camper ID' matches the name pattern's 'camper' branch only if the name
  // pattern is loosened; keep them disjoint so an id column is never the name.
  if (nameIndex !== null && nameIndex === externalIdIndex) nameIndex = null

  // A split name is used ONLY when there is no single name column, so a sheet
  // carrying both keeps the single column as authoritative.
  const firstNameIndex = findIndex(FIRST_NAME_HEADER)
  const lastNameIndex = findIndex(LAST_NAME_HEADER)
  const splitName =
    nameIndex === null && firstNameIndex !== null && lastNameIndex !== null
      ? { firstNameIndex, lastNameIndex }
      : null

  const divisionIndex = findIndex(DIVISION_HEADER)
  const dayIndex = findIndex(DAY_HEADER)
  const periodIndex = findIndex(PERIOD_HEADER)
  const unorderedSetIndex = findIndex(UNORDERED_SET_HEADER)
  const rankValueIndex = findIndex(RANK_VALUE_HEADER)
  const activityValueIndex = findIndex(ACTIVITY_VALUE_HEADER)
  // LONG FORMAT needs both halves: a rank column and an activity column, each
  // holding a value rather than naming a position.
  const longFormat =
    rankValueIndex !== null && activityValueIndex !== null
      ? { rankValueIndex, activityValueIndex }
      : null

  // INVERTED MATRIX — one column per ACTIVITY, the cell holding the rank.
  //
  // Recognised BY THE CAMP'S OWN CATALOG, which is RESOLVE doing the work rather
  // than a shape heuristic: these headers name entities the camp already has. That
  // matters for constraint 1 (format-agnostic must not become kind-agnostic) —
  // without a catalog there is nothing to recognise, so an unseeded camp does NOT
  // get this layout guessed at, and the sheet is reported unreadable instead of
  // read wrongly.
  //
  // Gated on finding NO ordinary rank columns and at least TWO activity-named
  // headers, so it can never steal a normal sheet that happens to carry one
  // column named after an activity (a swim opt-out flag, say).
  const knownActivities = new Set(
    (catalog?.activities ?? [])
      .map((a) => (typeof a === 'string' ? a : a?.name))
      .filter(Boolean)
      .map((n) => recognitionKey('activities', n))
  )
  const activityColumns =
    ranked.length === 0 && longFormat === null && knownActivities.size > 0
      ? cells
          .map((h, index) => ({ header: h, index }))
          .filter((c) => c.header !== '' && knownActivities.has(recognitionKey('activities', c.header)))
      : []
  const invertedMatrix = activityColumns.length >= 2 ? activityColumns : null

  const { unrecognisedColumns, unmapped } = describeCoverage(cells, {
    nameIndex, externalIdIndex, divisionIndex, dayIndex, periodIndex, unorderedSetIndex,
    splitName, longFormat, invertedMatrix, rankColumns, tiedColumns,
  })

  return {
    nameIndex,
    externalIdIndex,
    divisionIndex,
    dayIndex,
    periodIndex,
    unorderedSetIndex,
    splitName,
    longFormat,
    invertedMatrix,
    rankColumns,
    tiedColumns,
    duplicatedRanks,
    unrecognisedColumns,
    unmapped,
    headerIndex: 0,
  }
}

/**
 * Find the header ROW, then map it. T285 slice A.
 *
 * A real export often carries a title and a season line above the table, and the
 * reader assumed row 1 unconditionally — so a perfectly ordinary sheet was
 * "not a camper preference sheet". This is not a new shape: it is locating the
 * shape that was already there.
 *
 * The chosen row is the FIRST that maps with nothing unmapped, which is a
 * verifiable property rather than a guess — a title row has no rank columns and
 * cannot win. Falling back to row 0 keeps the previous behaviour, and its
 * `unmapped` list is then reported exactly as before rather than being masked by
 * this search.
 */
export function inferPreferenceLayout(rows = [], { maxScan = 10, catalog } = {}) {
  const limit = Math.min(rows.length, maxScan)
  for (let i = 0; i < limit; i += 1) {
    const candidate = inferPreferenceMapping(rows[i], { catalog })
    if (candidate.unmapped.length === 0) return { ...candidate, headerIndex: i }
  }
  return inferPreferenceMapping(rows[0] ?? [], { catalog })
}

/**
 * A DIRECTOR'S MAPPING, made into one the inferencer could itself have produced. T307.
 *
 * The import panel shows the located mapping in an editable corrector, and what the
 * director hands back is that object with some ROLES changed — a different camper-name
 * column, a rank column they added because their camp heads it `Pick A` rather than
 * `#1`. Their answer wins over the inferencer's: this is the same precedence a settled
 * label resolution gets in `makeLabelResolver`, one layer up. It is not evidence to be
 * weighed, it is the answer.
 *
 * What it is NOT is a mapping ready to be used, and passing it through raw makes the
 * transform say two false things.
 *
 * 1. The DERIVED halves still describe the inferencer's reading. `describeCoverage`
 *    recomputes them from the roles actually assigned, so a column the director just
 *    mapped stops being reported as unread, and the column it replaced starts being
 *    reported — both true statements about the sheet as the director now describes it.
 *
 * 2. `parsePreferenceSheet` is ADDITIVE across shapes: `rankColumns`, `longFormat`,
 *    `invertedMatrix`, `tiedColumns` and `unorderedSetIndex` each push cells, with no
 *    precedence between them. `inferPreferenceMapping` keeps them from colliding by
 *    GATING — an inverted matrix is proposed only when no ordinary rank columns were
 *    found, a split name only when no single name column was. A director's edit walks
 *    straight past those gates, and the sheet is then read BOTH ways at once. So the
 *    same gates are re-applied here rather than trusted to hold.
 *
 * Idempotent on an un-edited mapping: the roles are unchanged, so the gates and the
 * coverage produce what inference already produced. That is worth stating because it
 * is what lets the panel send the mapping ALWAYS, rather than trying to detect whether
 * the director touched anything — a comparison that would be wrong the first time a
 * field was added to the object.
 */
function gatedRoles(override) {
  // A rank the director added but never pointed at a column states nothing, and
  // `cell(row, null)` would read column 0 for every one of them.
  const rankColumns = (override.rankColumns ?? [])
    .filter((r) => r.index != null)
    .slice()
    .sort((a, b) => a.rank - b.rank)
  const hasOwnRanks = rankColumns.length > 0 || (override.tiedColumns ?? []).length > 0

  return {
    nameIndex: override.nameIndex ?? null,
    externalIdIndex: override.externalIdIndex ?? null,
    divisionIndex: override.divisionIndex ?? null,
    dayIndex: override.dayIndex ?? null,
    periodIndex: override.periodIndex ?? null,
    unorderedSetIndex: override.unorderedSetIndex ?? null,
    // The inference gates, re-applied to a hand-edited object. A split name is used
    // ONLY when there is no single name column; an inverted matrix ONLY when nothing
    // else already supplies ranks.
    splitName: override.nameIndex == null ? override.splitName ?? null : null,
    longFormat: hasOwnRanks ? null : override.longFormat ?? null,
    invertedMatrix: hasOwnRanks || override.longFormat ? null : override.invertedMatrix ?? null,
    rankColumns,
    tiedColumns: override.tiedColumns ?? [],
  }
}

export function mappingWithDirectorOverride(override, rows = []) {
  if (!override) return null
  const cells = (rows[override.headerIndex ?? 0] ?? []).map((h) => String(h ?? '').trim())
  const roles = gatedRoles(override)

  return {
    ...roles,
    // Carried, not recomputed: a tie is a fact about the FILE's header (two columns
    // headed `#1`), and the corrector offers no way to state or withdraw one.
    duplicatedRanks: override.duplicatedRanks ?? [],
    headerIndex: override.headerIndex ?? 0,
    ...describeCoverage(cells, roles),
  }
}

/**
 * IS THIS MAPPING READY TO USE, and if not, what is wrong with it? T307.
 *
 * The import panel's confirm gate. It exists as a function HERE, beside the rules it
 * asks about, because the alternative is the panel re-stating them — and a re-statement
 * that drifts from the transform is this seam's recurring defect, not a hypothetical.
 * T305 found the confirm gate refusing exactly the sheets the transform could read; the
 * first draft of THIS ticket then rebuilt the same fault one shape over, by keeping
 * `rankColumns.length > 0` as the gate. An inverted-matrix sheet carries its ranks in
 * its cells and has no rank columns at all, so that gate made a director add a dummy
 * rank column to get past it — which, now that the mapping is honoured, is an edit that
 * closes the inverted-matrix gate and destroys the read.
 *
 * `unmapped` is the transform's OWN readability test (`readPreferenceSheet` returns
 * `parsed: null` when it is non-empty and no grid is found), so asking it here means
 * the button enables exactly when the import will land.
 *
 * `collision` is the one failure the transform cannot state, because inference cannot
 * produce it: a column carrying two roles. `parsePreferenceSheet` is additive, so it
 * would read that column twice rather than refuse it. It is a half-finished edit rather
 * than a bad file, so the corrector catches it while the sample rows are still on
 * screen. Roles are collected from the GATED mapping — a pre-gate collision that
 * normalisation is about to remove is not something to nag a director about.
 */
export function describeMappingReadiness(override) {
  if (!override) return { unmapped: ['name', 'ranks'], collision: null }
  const roles = gatedRoles(override)

  // `fixable` marks a role the CORRECTOR gives the director a control for. It is the
  // difference between a question and a dead end, and the distinction is load-bearing
  // rather than tidy: inference can assign two roles to one column all by itself (a
  // header like "Child's Bunk Name" matches both the name and the division pattern,
  // and each is found by its own independent `findIndex`). Refusing THAT would hand a
  // director a disabled button naming two roles, at least one of which they have no
  // way to change — precisely the terminal state M2 exists to forbid. So a collision
  // is reported only when at least one of its roles can be moved from this screen,
  // which means the message always names something the director can act on.
  const assigned = [
    { role: 'Camper name', index: roles.nameIndex, fixable: true },
    { role: 'Camper ID', index: roles.externalIdIndex, fixable: true },
    { role: 'Division', index: roles.divisionIndex, fixable: true },
    { role: 'Day', index: roles.dayIndex },
    { role: 'Period', index: roles.periodIndex },
    { role: 'Choices', index: roles.unorderedSetIndex },
    { role: 'First name', index: roles.splitName?.firstNameIndex },
    { role: 'Last name', index: roles.splitName?.lastNameIndex },
    { role: 'Rank value', index: roles.longFormat?.rankValueIndex },
    { role: 'Activity', index: roles.longFormat?.activityValueIndex },
    ...roles.rankColumns.map((r) => ({ role: `Rank #${r.rank}`, index: r.index, fixable: true })),
    ...roles.tiedColumns.map((i) => ({ role: 'a tied choice', index: i })),
    ...(roles.invertedMatrix ?? []).map((c) => ({ role: `“${c.header}”`, index: c.index })),
  ].filter((a) => a.index != null)

  const doubled = assigned.find((a, i) => {
    if (assigned.findIndex((b) => b.index === a.index) === i) return false
    return assigned.some((b) => b.index === a.index && b.fixable)
  })

  return {
    // `describeCoverage` needs the header cells only for `unrecognisedColumns`; the
    // readability half is derived from the roles alone, so the caller need not hold
    // the sheet to ask this.
    unmapped: describeCoverage([], roles).unmapped,
    collision: doubled
      ? {
          index: doubled.index,
          roles: assigned.filter((a) => a.index === doubled.index).map((a) => a.role),
        }
      : null,
  }
}

/**
 * RESOLVER 2 (labels → activities), against the camp's OWN activity catalog.
 *
 * Returns one of:
 *   {status:'matched'}    the whole cell names a known activity
 *   {status:'packed'}     the cell names nothing, but splitting it yields >= 2
 *                         known activities — genuinely AMBIGUOUS, so it is
 *                         asked about rather than guessed
 *   {status:'unresolved'} the cell names nothing recognisable
 *   {status:'abstained'}  there is nothing to resolve AGAINST (empty catalog)
 *
 * The 'abstained' case is the distinction that matters, and it is not in the
 * ADR — I am drawing it deliberately. With an empty catalog, "no match" is not
 * evidence about the label, it is evidence about the catalog. Treating it as a
 * miss and withholding the write would refuse every FIRST import a camp ever
 * does, which is the refuse-everything class §3.1a had to correct twice. So an
 * abstention WRITES the label and flags every one of them unverified: loud and
 * useless-looking, which §12.3 says is correct, rather than quiet and wrong.
 *
 * T298 adds a fifth, and it is the only one that is not an inference:
 *   {status:'mapped', as}  a DIRECTOR said this label names that activity.
 *
 * `resolutions` is how a settled question stops being asked. It is consulted
 * BEFORE any rule, because a director's answer is not evidence to be weighed
 * against the catalog — it is the answer. Consulting it before the `empty` guard
 * too: an abstention is a statement that there was nothing to resolve against,
 * and a direct instruction is not subject to it.
 */
function makeLabelResolver(activities = [], resolutions = {}) {
  const known = new Map()
  for (const name of activities) {
    const label = typeof name === 'string' ? name : name?.name
    if (label) known.set(recognitionKey('activities', label), label)
  }
  const empty = known.size === 0

  const resolve = (raw) => {
    const decided = resolutions?.[raw]
    if (decided) {
      // MAP_TO_EXISTING carries the camp's own spelling, and the caller stores
      // THAT rather than the file's — which is the whole point of the action. A
      // preference stored under the file's spelling would derive its own
      // elective_choices row and its own labelKey, so it would match no offering
      // and the mapping would have joined nothing.
      if (decided.action === 'map_to_existing' && decided.activityName) {
        return { status: 'mapped', as: decided.activityName }
      }
      // ADD_ACTIVITY needs nothing here: the activity now exists, so the catalog
      // this resolver was built from already matches it on the re-parse. It is
      // listed in `resolutions` for the JOURNAL's sake, not the resolver's.
      //
      // SPLIT_PACKED is the packed reading, confirmed. Splitting on the same
      // expression the detection used, so what the director agreed to and what
      // gets read cannot drift apart.
      if (decided.action === 'split_packed') {
        const parts = raw.split(PACKED_CELL_SPLIT).map((p) => p.trim()).filter(Boolean)
        if (parts.length >= 2) return { status: 'split', parts }
      }
    }
    if (empty) return { status: 'abstained' }
    if (known.has(recognitionKey('activities', raw))) return { status: 'matched' }
    // A packed multi-value cell inside a RANKED column — which §4.1 ruled on
    // only for a set in its OWN column. Splitting is a DETECTION, never a
    // resolution: a camp may have packed three alternatives into one rank, and
    // an activity name may legitimately contain a comma. Both readings are
    // live, so a human answers once.
    const parts = raw.split(PACKED_CELL_SPLIT).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2 && parts.every((p) => known.has(recognitionKey('activities', p)))) {
      return { status: 'packed', parts }
    }
    return { status: 'unresolved' }
  }

  // `empty` travels WITH the resolver rather than being recomputed by the
  // caller: the 'abstained' contract depends on the two agreeing, and two
  // definitions derived from different inputs is how they stop agreeing.
  return { resolve, empty }
}

/**
 * RESOLVER 3 (division labels → groups, then tiers). ADR §12.2a, §13.5.
 *
 * TWO TARGET SETS IN ORDER, and the order is the whole point.
 * `DIVISION_HEADER` conflates four granularities (/division|bunk|group|unit|
 * edah/), and the "division" concept in this codebase is `tiers`, while the
 * referential fact exports and the solver need is `groups`. So:
 *
 *   a `groups` match  → sets group_id (and the tier follows transitively)
 *   a `tiers` match   → sets NOTHING referential, and says which tier it
 *                       matched, so the director can assign groups.
 *                       `campers.tier_id` is deliberately NOT added:
 *                       `groups.tier_id` is the single path from a camper to a
 *                       tier, and a second path is a second thing to disagree.
 *   no match          → group_id stays null, and the label is residue
 *
 * IN EVERY CASE the label is stored verbatim in `campers.division_label`, and
 * IN NO CASE is a group or a tier created. That is T224's lesson stated as a
 * rule: a preference sheet's column headers once became camp groups, and again
 * became tiers.
 */
function makeDivisionResolver({ groups = [], tiers = [] } = {}) {
  const byGroup = new Map(groups.map((g) => [recognitionKey('groups', g.name), g]))
  const byTier = new Map(tiers.map((t) => [recognitionKey('tiers', t.name), t]))

  return (label) => {
    if (!label) return { status: 'absent', groupId: null }
    const group = byGroup.get(recognitionKey('groups', label))
    if (group) return { status: 'group', groupId: group.id }
    const tier = byTier.get(recognitionKey('tiers', label))
    if (tier) return { status: 'tier', groupId: null, tierName: tier.name }
    return { status: 'unmatched', groupId: null }
  }
}

/**
 * The two parts of a residue item, plus the two joined.
 *
 * A residue item is a ROW WITH PARTS, not a paragraph. `head` is the DISTINGUISHING
 * token — the one thing that differs between two items the reader is comparing
 * (`Column F`, `Row 5, column E`, a camper's name). `why` is the bare fact, and is
 * deliberately IDENTICAL for every item that shares a cause: that is what lets the
 * panel print it once above a list of heads instead of repeating the same sentence
 * forty times (`src/screens/elective/assignment/ParseSummary.jsx`). `message` is the
 * two joined, for the CLI and agent surfaces that emit one line per item.
 *
 * Exported because the CLI produces residue of its own (unread tabs, a sheet with no
 * readable choices) and one contract with two constructors is how the halves drift.
 */
export const residueParts = (head, why) => ({ head, why, message: `${head} — ${why}` })

/**
 * Read the sheet under a mapping, resolving every value against the camp.
 *
 * @param {Array<Array>} rows      raw row arrays, header first
 * @param {object}  options
 * @param {string}  options.campId
 * @param {object}  options.mapping    from inferPreferenceMapping
 * @param {object}  [options.catalog]  the camp's OWN entities: {activities,
 *   groups, tiers}. Plain arrays, so this function stays pure — the caller does
 *   the reading. An ABSENT catalog is not the same as an empty one: absent
 *   means the caller did not supply it (the resolver abstains and says so),
 *   which is also what an empty catalog means, so both take the same path.
 *
 * @returns {{campers, choices, preferences, sameNameCampers, skippedRows, residue, coverage}}
 *   `campers[].id` is the derived camper id (two devices reading one sheet
 *   converge on it), and `campers[].division_label` is the source file's own
 *   label, verbatim, with `group_id` the resolved reference or null.
 *   `choices` are distinct RESOLVED labels, keyed by the same canonicalizer the
 *   elective-choice id uses, so a spelling variant folds.
 *   `preferences` carry `label`/`labelKey` rather than a choice id (choice ids
 *   are run-scoped and no run exists at parse time), plus `coordinate` and
 *   `rank_kind`. A preference's `coordinate` is a LABEL PAIR, never an
 *   occurrence_id: a binding names a coordinate and the CALLER resolves it
 *   against deriveOccurrences at solve time, because the two candidate
 *   schedule routes yield two different occurrence_ids for one coordinate and
 *   neither route is canonical — a binding keyed to an occurrence would be a
 *   statement about a schedule rather than about a child.
 *   `residue` is the loud half (§3.4): non-empty by default until each item is
 *   claimed or waived.
 */
export function parsePreferenceSheet(rows = [], { campId, mapping, catalog, grid, subject, resolutions } = {}) {
  const headerIndex = mapping?.headerIndex ?? 0
  const body = rows.slice(headerIndex + 1)
  const campers = []
  const byId = new Map()
  const rowsByName = new Map()
  const choicesByKey = new Map()
  const skippedRows = []
  const residue = []
  const { resolve: resolveLabel, empty: catalogAbsent } = makeLabelResolver(catalog?.activities ?? [], resolutions ?? {})
  const resolveDivision = makeDivisionResolver(catalog ?? {})

  const add = (kind, head, why, extra = {}) => residue.push({ kind, ...residueParts(head, why), ...extra })

  // The rows ABOVE the header, which were read past rather than read. Skipping
  // them is right; not saying so is the same silence §12.0 forbids everywhere
  // else.
  // Nothing is reported as unread if the preamble was READ as a grid (T285 slice
  // G). The whole point of that slice is that those rows are a camper's answers,
  // so calling them skipped would be false — and a residue item that is false is
  // worse than one that is missing.
  if (headerIndex > 0 && !grid?.layout) {
    const preambleRows = Array.from({ length: headerIndex }, (_, i) => i + 1)

    // A TITLE LINE AND AN UNREAD TABLE ARE NOT THE SAME FINDING, and calling the
    // second one the first is worse than saying nothing. Found by measuring slice
    // A: on P23 (a planner grid AND a ranked block on one page) the locator found
    // the ranked block's header, committed it correctly, and described the 8-row
    // x 5-day grid above it as "usually a title or a season line" — a confident
    // wrong characterization of half the document.
    //
    // The discriminator is structure, not content: two or more rows each carrying
    // three or more populated cells is a TABLE, whatever it holds. A title and a
    // season line cannot meet that bar, which is why P12 still gets the calm
    // message and is pinned so this does not cry wolf on every ordinary export.
    const structuredRows = rows
      .slice(0, headerIndex)
      .filter((r) => (r ?? []).filter((v) => String(v ?? '').trim() !== '').length >= 3)

    if (structuredRows.length >= 2) {
      add(
        'UNREAD_TABLE_ABOVE_HEADER',
        `Rows 1-${headerIndex}`,
        // The reason the grid was NOT read stays here rather than in the sentence the
        // director reads: it carries no camper name column, a preference is something a
        // NAMED child asked for, and attributing the grid to the campers listed below
        // would be a guess this import will not make.
        `A second table \u2014 ${structuredRows.length} rows of three or more filled cells, with no ` +
          `camper name column. Only the table starting at row ${headerIndex + 1} was read.`,
        { rows: preambleRows, headerRow: headerIndex + 1, structuredRows: structuredRows.length }
      )
    } else {
      add(
        'SKIPPED_PREAMBLE',
        `Row(s) ${preambleRows.join(', ')}`,
        `Above the table, so not read \u2014 the table starts at row ${headerIndex + 1}.`,
        { rows: preambleRows, headerRow: headerIndex + 1 }
      )
    }
  }

  for (const d of mapping?.duplicatedRanks ?? []) {
    add(
      'DUPLICATED_RANK_HEADER',
      `Rank #${d.rank}`,
      // Why we do not order them: the file does not state an order, and typing order
      // is not one. Give each ranked choice its own number to rank them.
      `Heads ${d.columns.length} columns (${d.columns.join(', ')}), so those choices were kept as ` +
        'equally acceptable rather than ranked.',
      { rank: d.rank, columns: d.columns }
    )
  }

  // RESOLVER 1's output, reported once for the sheet rather than once per row.
  for (const c of mapping?.unrecognisedColumns ?? []) {
    add(
      'UNRECOGNISED_COLUMN',
      // THE HEADER BELONGS IN THE TOKEN, not in the fact. Two unrecognised columns
      // are ONE finding with two instances, and putting each header in its own `why`
      // split them into two groups that then repeated the identical tail verbatim —
      // the exact shape the head/why split exists to prevent.
      `Column ${c.column} (\u201c${c.header}\u201d)`,
      'Not a field this import knows, so nothing on it was read.',
      { header: c.header, column: c.column, index: c.index }
    )
  }

  // PASS 1 — read every row, resolving as we go. Nothing is written for a value
  // that resolves to nothing; it becomes residue instead.
  const candidates = []
  const unverifiedLabels = new Set()
  const unorderedSetRows = []
  let unmeasuredCampers = 0

  body.forEach((row, i) => {
    // 1-based, counting the preamble above the header — what a director sees in
    // their own spreadsheet, which is the only row number worth reporting.
    const rowNumber = headerIndex + i + 2
    // A split First/Last name joins FIRST-then-LAST with one space. Order is
    // load-bearing, not cosmetic: `deriveCamperId` keys on the canonicalized
    // display name when there is no external id, so reversing it derives a
    // different id for the same child and silently fails every later match.
    const displayName = mapping?.splitName
      ? [cell(row, mapping.splitName.firstNameIndex), cell(row, mapping.splitName.lastNameIndex)]
          .filter(Boolean)
          .join(' ')
      : cell(row, mapping?.nameIndex)
    const externalId = cell(row, mapping?.externalIdIndex)
    if (!displayName && !externalId) {
      skippedRows.push({ rowNumber, reason: 'no camper name' })
      return
    }

    const dayName = cell(row, mapping?.dayIndex) || null
    const periodLabel = cell(row, mapping?.periodIndex) || null
    const coordinate = dayName || periodLabel ? { dayName, periodLabel } : null
    // §4.2's three meanings, and the discriminator is the NUMBER of rank
    // columns rather than merely whether a coordinate exists.
    //
    // A planner grid gives one camper ONE activity per cell — that cell is
    // CHOSEN, rank 1 by construction. But a per-cell sheet can also rank WITHIN
    // a cell ("for Monday period 3: first Archery, then Ceramics"), and that is
    // an ordered fallback that happens to be cell-scoped. A coordinate changes
    // the SCOPE of a preference; it does not change what its rank MEANS.
    //
    // Getting this wrong is not cosmetic: an earlier draft forced `rank: 1` for
    // every ranked column whenever a coordinate was present, which collapsed
    // #1/#2/#3 onto one rank inside one cell and refused the sheet with "a
    // camper holds the same preference rank twice" — a refusal that is both
    // wrong and misleading about why. Caught by running the corpus (P33), not by
    // re-reading the code.
    // Counted PER COORDINATE, not over the whole sheet (T285 slice B). A sheet
    // with "Monday #1" and "Wednesday #1" gives each cell exactly one choice —
    // those are CELL CHOICES — while "Monday #1" and "Monday #2" rank two options
    // within one cell, which is an ordered fallback that happens to be
    // cell-scoped.
    const rankColumnsPerCoordinate = new Map()
    for (const rc of mapping?.rankColumns ?? []) {
      const key = coordinateKey(rc.coordinate ?? coordinate)
      rankColumnsPerCoordinate.set(key, (rankColumnsPerCoordinate.get(key) ?? 0) + 1)
    }

    // Every preference cell this row offers, ranked columns and the unordered
    // set column alike, before any of them is known to resolve.
    const cells = []
    for (const rc of mapping?.rankColumns ?? []) {
      const raw = cell(row, rc.index)
      if (!raw) continue // A blank rank is a rank the camper left empty, not a shift.
      // A COLUMN-scoped coordinate wins over the row's. A header that names its
      // own cell ("Monday Period 3 - First Choice") is more specific than a
      // per-row Day column, and a sheet never carries both for one value.
      const cellCoordinate = rc.coordinate ?? coordinate
      const single = cellCoordinate != null && rankColumnsPerCoordinate.get(coordinateKey(cellCoordinate)) === 1
      // The explicit rank is ALWAYS preserved. It is the camper's own statement.
      cells.push({
        raw,
        rank: rc.rank,
        rankKind: single ? CELL_CHOICE : ORDERED_FALLBACK,
        index: rc.index,
        coordinate: cellCoordinate,
      })
    }
    // LONG FORMAT — this row IS one preference: the rank and the activity are
    // both cell values.
    if (mapping?.longFormat) {
      const raw = cell(row, mapping.longFormat.activityValueIndex)
      const rankRaw = cell(row, mapping.longFormat.rankValueIndex)
      const rank = /^\d+$/.test(rankRaw) ? Number(rankRaw) : null
      if (raw) {
        cells.push({
          raw,
          rank,
          // An explicit rank column makes this an ordered statement; a row whose
          // rank cell is not a number states no order, so it stays a tie among
          // equals rather than being given a position it does not claim.
          rankKind: rank == null ? UNORDERED_SET : ORDERED_FALLBACK,
          index: mapping.longFormat.activityValueIndex,
          coordinate,
        })
      }
    }

    // INVERTED MATRIX — the HEADER names the activity, the CELL holds its rank.
    for (const col of mapping?.invertedMatrix ?? []) {
      const rankRaw = cell(row, col.index)
      if (!rankRaw) continue // A blank means this camper did not rank that activity.
      if (!/^\d+$/.test(rankRaw)) continue // Not a rank; nothing to read.
      cells.push({
        raw: col.header,
        rank: Number(rankRaw),
        rankKind: ORDERED_FALLBACK,
        index: col.index,
        coordinate,
      })
    }

    // Columns that shared a rank (ADR §4.1's tie among equals). Rank NULL, never
    // an order invented from column position.
    for (const index of mapping?.tiedColumns ?? []) {
      const raw = cell(row, index)
      if (!raw) continue
      cells.push({ raw, rank: null, rankKind: UNORDERED_SET, index, coordinate })
    }
    if (mapping?.unorderedSetIndex != null) {
      const raw = cell(row, mapping.unorderedSetIndex)
      // §4.1 — a packed cell with no ordering evidence produces bindings with
      // rank: null, NEVER a rank invented from cell order. An unordered set of
      // acceptable activities is a different fact from a ranking, and cell order
      // is not ordering evidence: reading "Swim, Archery, Ceramics" as a top
      // three would fabricate a preference the child never stated. A tie among
      // equals stays a tie.
      const parts = raw.split(PACKED_CELL_SPLIT).map((p) => p.trim()).filter(Boolean)
      for (const part of parts) {
        cells.push({ raw: part, rank: null, rankKind: UNORDERED_SET, index: mapping.unorderedSetIndex, coordinate })
      }
      // §4.1 requires the residue item as well as the null rank, and the two do
      // different jobs: the null is what the solver reads, the residue is what
      // tells a HUMAN that this camper stated no order. Without it, a sheet that
      // ranks nothing looks identical in the ledger to one that ranks
      // everything.
      if (parts.length > 1) unorderedSetRows.push({ rowNumber, count: parts.length })
    }

    const resolved = []
    for (const c of cells) {
      const verdict = resolveLabel(c.raw)
      if (verdict.status === 'matched' || verdict.status === 'abstained') {
        if (verdict.status === 'abstained') unverifiedLabels.add(c.raw)
        resolved.push(c)
        continue
      }
      // T298 — the director said this label names an activity the camp has. The
      // CAMP'S spelling replaces the file's from here on, so the preference
      // derives the same labelKey as the offering and lands on the activity that
      // already exists rather than minting a parallel choice beside it.
      if (verdict.status === 'mapped') {
        resolved.push({ ...c, raw: verdict.as })
        continue
      }
      // T298 — the packed reading, confirmed by a director. Every part becomes
      // its own cell at rank NULL / UNORDERED_SET, which is §4.1's rule for a
      // packed cell and not a new one: the parts arrived in one cell, so their
      // order is cell order, and cell order is not ordering evidence. Reading
      // three packed alternatives as three things at rank N would assert a
      // ranking the child never stated, which is the fabrication §4.1 forbids.
      if (verdict.status === 'split') {
        for (const part of verdict.parts) {
          resolved.push({ ...c, raw: part, rank: null, rankKind: UNORDERED_SET })
        }
        continue
      }
      const column = columnLabel(c.index)
      if (verdict.status === 'packed') {
        add(
          'AMBIGUOUS_PACKED_CELL',
          `Row ${rowNumber}, column ${column}`,
          // Not split automatically: it could be several alternatives packed into one
          // choice, or one activity whose name contains a comma, and only the director
          // can say which.
          `\u201c${c.raw}\u201d is not an activity this camp has, but split up it names ` +
            `${verdict.parts.length} that are. Nothing was read from the cell.`,
          { rowNumber, column, label: c.raw, parts: verdict.parts }
        )
        continue
      }
      add(
        'UNRESOLVED_CHOICE_LABEL',
        `Row ${rowNumber}, column ${column}`,
        // Not minted: inventing an activity would put one on a schedule that does not
        // exist.
        `\u201c${c.raw}\u201d is not an activity this camp has.`,
        { rowNumber, column, label: c.raw }
      )
    }

    // RESOLVER 2's other half — P13. A row whose preference cells resolve to NO
    // known activity is not a camper row at all: `Total Campers`, `Please
    // Return` and `Camp Office Use Only` became campers holding preferences
    // `8` and `by June 1`. No new mechanism — this is why §12.0 calls RESOLVE
    // one answer rather than five.
    //
    // Gated on having had something to resolve AGAINST. With an empty catalog
    // every label abstains rather than misses, so this would skip every row on
    // a camp's first import.
    if (resolved.length === 0) {
      if (!catalogAbsent) {
        skippedRows.push({
          rowNumber,
          reason: 'no rank cell names a known activity',
          contents: (row ?? []).map((v) => String(v ?? '').trim()).filter(Boolean),
        })
        return
      }
      if (cells.length === 0) {
        skippedRows.push({ rowNumber, reason: 'no choices on this row' })
        return
      }
    }

    const divisionLabel = cell(row, mapping?.divisionIndex) || null
    const division = resolveDivision(divisionLabel)

    const id = deriveCamperId(campId, { externalId: externalId || null, displayName: displayName || null })
    if (!byId.has(id)) {
      const camper = {
        id,
        display_name: displayName,
        external_id: externalId || null,
        // §12.2a's deliberate PAIR. `group_id` answers "which camp group is
        // this child in"; `division_label` answers "what did their file say".
        // Collapsing them into one field is how the unresolved case becomes
        // invisible again.
        division_label: divisionLabel,
        group_id: division.groupId,
        // Whether this SHEET carries a division column at all, which is a
        // different question from whether this ROW filled it in. The commit
        // needs the distinction: an empty cell in a division column is a fact
        // to record, while a sheet with no such column must not erase a
        // division an earlier import recorded.
        division_observed: mapping?.divisionIndex != null,
      }
      byId.set(id, camper)
      campers.push(camper)

      // The coverage check is available ONLY for a camper resolved to a GROUP:
      // deriveOccurrences keys occurrences on group.tier_id, and groups are the
      // single path from a camper to a tier. Stated once here rather than as an
      // increment inside each branch below, so the rule is readable without
      // scanning the chain.
      if (division.status !== 'group') unmeasuredCampers += 1

      if (division.status === 'tier') {
        add(
          'DIVISION_MATCHED_TIER',
          `${displayName || externalId}`,
          `Division \u201c${divisionLabel}\u201d matches the tier \u201c${division.tierName}\u201d, not a group.`,
          { label: divisionLabel, camperId: id, tier: division.tierName }
        )
      } else if (division.status === 'unmatched') {
        add(
          'UNMATCHED_DIVISION',
          `${displayName || externalId}`,
          `Division \u201c${divisionLabel}\u201d is not a group or a tier this camp has. Kept as the file ` +
            'wrote it, linked to nothing.',
          { label: divisionLabel, camperId: id }
        )
      }
    }

    if (displayName) {
      const nameKey = electiveChoiceLabelKey(displayName)
      if (!rowsByName.has(nameKey)) rowsByName.set(nameKey, { display_name: displayName, rows: [] })
      rowsByName.get(nameKey).rows.push({
        rowNumber,
        camperId: id,
        hasExternalId: Boolean(externalId),
        divisionLabel,
        // THE SLOTS THIS ROW FILLS — see the identity resolver below. Computed
        // from the row's own resolved cells, so it describes what the row
        // actually says rather than what its layout implies.
        slots: new Set(
          resolved.map((c) =>
            // An unranked cell is distinguished by WHAT it names, since its rank
            // cannot distinguish it: two rows naming the same activity unranked in
            // one cell really do collide, two naming different ones do not.
            c.rank == null
              ? `${coordinateKey(c.coordinate)}\u0000null\u0000${electiveChoiceLabelKey(c.raw)}`
              : `${coordinateKey(c.coordinate)}\u0000${c.rank}`
          )
        ),
      })
    }

    for (const c of resolved) {
      const labelKey = electiveChoiceLabelKey(c.raw)
      // First spelling seen wins for display, matching extractEntities.
      if (!choicesByKey.has(labelKey)) choicesByKey.set(labelKey, { label: c.raw, labelKey })
      candidates.push({
        camper_id: id,
        label: choicesByKey.get(labelKey).label,
        labelKey,
        rank: c.rank,
        rank_kind: c.rankKind,
        // The CELL's coordinate — a column header may name one the row does not.
        coordinate: c.coordinate ?? null,
        rowNumber,
      })
    }
  })

  if (unorderedSetRows.length > 0) {
    const column = columnLabel(mapping.unorderedSetIndex)
    add(
      'UNORDERED_SET',
      `Column ${column}`,
      // Not turned into first/second/third: the file does not say which came first,
      // and guessing from typing order would invent a preference nobody stated.
      `Lists several activities per camper with no order between them, on ${unorderedSetRows.length} ` +
        'row(s). Kept as equally acceptable.',
      { column, index: mapping.unorderedSetIndex, rows: unorderedSetRows }
    )
  }

  // THE GRID, read as ONE SUBJECT (T285 slice G). Deliberately inside this same
  // function rather than a sibling transform: a second transform is a second T224
  // (`src/ingest/scheduleShape.js:14-21` — that incident happened because a path
  // reached extraction without calling the gate the other path called). The grid's
  // cells go through the SAME label resolver, the SAME collision pass and the SAME
  // residue ledger as every other shape.
  if (grid?.layout) {
    const { layout, rows: gridRows, headerIndex: gridHeader } = grid
    if (layout.optionsPerCoordinate > 1) {
      // SEVERAL activities per (day, period) is a menu of OPTIONS, not one
      // camper's choices, and writing them as a child's preferences is T224's
      // incident with better manners. Nothing is written and the ALTERNATIVE
      // reading is named — this does not assert what the document IS.
      add(
        'MULTIPLE_OPTIONS_PER_PERIOD',
        'The grid',
        // Nothing is written and the ALTERNATIVE reading is named, so this does not
        // assert what the document IS. Give each period a single column to import it as
        // one camper's sheet.
        `Gives ${layout.optionsPerCoordinate} activities for each period, so it reads as what is ON ` +
          'OFFER rather than one camper\u2019s choices. Nothing from it was imported.',
        { optionsPerCoordinate: layout.optionsPerCoordinate, rows: gridRows.length }
      )
    } else {
      const subjectName = subject?.displayName || null
      // T299 — an UNATTRIBUTED subject is keyed on (submission, arrival), never on
      // the submission alone: two children who picked the same activities produce
      // byte-identical sheets, and a content-only key made them one camper. An
      // ATTRIBUTED subject (the caller named the child) keeps the ordinary
      // camp-scoped identity, because a name is a fact about the child rather than
      // about the import.
      // One call, branching only the KEY, so the camp and the name are stated once —
      // this is the expression that decides which child a sheet lands on, and a
      // fourth mode should not be two edits with one chance to miss one.
      // A SUBJECT WE HAVE ALREADY LOCATED CARRIES ITS ID, not a recipe for one.
      //
      // Deriving an id is how you MINT a subject; it is the wrong instrument for one
      // that already exists, and the difference is not academic. `deriveCamperId`'s
      // `ext`/`name` arms key on `external_id` and `display_name`, and `campers` is
      // an ordinary admin-writable entity — so an admin fixing a typo in a child's
      // name, or attaching her roster id later, changes the very fields the recipe
      // reads. Re-deriving then yields an id she does not have, and the import mints
      // a SECOND fully-named row holding her week twice. Confirmed by execution:
      // attaching `external_id` after naming moved her from `name` mode to `ext`
      // mode and forked her, with both rows reading the same display name and
      // neither flagged `is_unattributed`, so nothing surfaced it. That is strictly
      // worse than the fork T303 case 4 exists to fix, which at least left one row
      // flagged. Caught by Red Hat, not by the tests that shipped with case 4.
      //
      // So a caller that looked the camper UP passes `camperId` and this derives
      // nothing. One rule, and it is the row itself.
      const subjectId = subject?.camperId
        ? subject.camperId
        : deriveCamperId(campId, subject?.attributed === true
          ? { externalId: subject?.externalId || null, displayName: subjectName }
          : {
              submissionKey: subject?.externalId || null,
              arrivalId: subject?.arrivalId || null,
              displayName: subjectName,
            })
      if (!byId.has(subjectId)) {
        const record = {
          id: subjectId,
          display_name: subjectName ?? '',
          // The SUBMISSION key, not the composite the id is derived from — so two
          // subjects carrying identical answers still share this value, which is how
          // the attention surface can tell a director that they are
          // indistinguishable by content (src/ingest/attentionList.js). Reading the
          // content key back out of the derived id would be parsing it, which
          // electiveDerivedIds.js prohibits.
          external_id: subject?.externalId || null,
          division_label: null,
          group_id: null,
          division_observed: false,
        }
        // Marked so the subject is findable LATER WITHOUT RE-IMPORT. Residue says
        // so at import time, but residue is not persisted, and "land it, then
        // resolve it" is only true if the thing to resolve can be found.
        if (subject?.attributed !== true) record.is_unattributed = 1
        byId.set(subjectId, record)
        campers.push(record)
      }

      if (subject?.attributed !== true) {
        add(
          'UNATTRIBUTED_SUBJECT',
          `Stored as \u201c${subjectName ?? 'unnamed'}\u201d`,
          // The ASK ("name the camper") deliberately lives on the attention surface
          // (src/ingest/attentionList.js), which is navigable, not here, which is not.
          // Owner ruling: unattributed campers live there. One statement, one place to act.
          `Not yet named \u2014 ${gridRows.length} period rows are saved against it.`,
          { subject: subjectName, source: subject?.source ?? 'none' }
        )
      }

      gridRows.forEach((row, i) => {
        const rowNumber = gridHeader + i + 2
        const periodLabel = cell(row, layout.periodIndex) || null
        for (const col of layout.dayColumns) {
          const raw = cell(row, col.index)
          if (!raw) continue
          const verdict = resolveLabel(raw)
          const coordinate = { dayName: col.dayName, periodLabel }
          // T298 — one helper for the three statuses that all mean "read this
          // cell as these activities", so the grid path cannot drift from the
          // ranked path on what a resolution means. `mapped` yields the camp's
          // own spelling, `split` yields the parts, and the other two yield the
          // cell as written.
          const readAs =
            verdict.status === 'mapped' ? [verdict.as]
              : verdict.status === 'split' ? verdict.parts
                : verdict.status === 'matched' || verdict.status === 'abstained' ? [raw]
                  : null
          if (readAs) {
            if (verdict.status === 'abstained') unverifiedLabels.add(raw)
            for (const name of readAs) {
              const labelKey = electiveChoiceLabelKey(name)
              if (!choicesByKey.has(labelKey)) choicesByKey.set(labelKey, { label: name, labelKey })
              candidates.push({
                camper_id: subjectId,
                label: choicesByKey.get(labelKey).label,
                labelKey,
                // One cell, one coordinate: CHOSEN, rank 1 by construction (§4.2).
                //
                // A SPLIT cell is the exception, and it is not a stylistic one: two
                // names at rank 1 for one camper is exactly what
                // `describeElectiveRunRefusal` reads as a camper holding the same
                // rank twice, so a first draft of this made a resolved packed cell
                // REFUSE THE WHOLE SHEET. A packed cell's parts are an unordered set
                // for the same reason §4.1 gives on the ranked path — the parts
                // arrived in one cell and cell order is not evidence — so they take
                // rank NULL here too, and the two paths agree about what a packed
                // cell means rather than each deciding locally.
                rank: verdict.status === 'split' ? null : 1,
                rank_kind: verdict.status === 'split' ? UNORDERED_SET : CELL_CHOICE,
                coordinate,
                rowNumber,
              })
            }
            continue
          }
          const column = columnLabel(col.index)
          if (verdict.status === 'packed') {
            add(
              'AMBIGUOUS_PACKED_CELL',
              `Row ${rowNumber}, column ${column}`,
              `\u201c${raw}\u201d is not an activity this camp has, but split up it names ` +
                `${verdict.parts.length} that are. Nothing was read from the cell.`,
              { rowNumber, column, label: raw, parts: verdict.parts }
            )
            continue
          }
          add(
            'UNRESOLVED_CHOICE_LABEL',
            `${col.dayName} ${periodLabel ?? ''}`.trim(),
            // A fixed event like lunch or instructional swim is expected here; those are not
            // electives, so this is ordinary on a planner grid.
            `\u201c${raw}\u201d is not an activity this camp has.`,
            { rowNumber, column, label: raw, coordinate }
          )
        }
      })
    }
  }

  for (const label of unverifiedLabels) {
    add(
      'UNVERIFIED_CHOICE_LABEL',
      `\u201c${label}\u201d`,
      // Re-import once the activity list exists to have these verified.
      'Imported as a choice, but this camp has no activities set up to check it against.',
      { label }
    )
  }

  // PASS 2 — RANK COLLISION RESOLUTION (§12.2b, §13.3). This is what makes the
  // reported count and the number of rows written ONE NUMBER: P02 reported 200
  // preferences and wrote 160, because `deriveElectivePreferenceId` omits rank
  // from its key and overwrites silently.
  //
  // THE KEY HERE IS DELIBERATELY `deriveElectivePreferenceId`'s OWN KEY, because
  // that is the key two rows actually collide on in STORAGE — resolving against
  // any other key would report a count that storage then disagrees with, which
  // is the very defect this pass exists to close.
  //
  // ROUND 2 (owner ruling): that key now includes the COORDINATE, so this one
  // does too, and the consequence this comment used to name is GONE rather than
  // merely reported. It used to say: "until a caller resolves a coordinate to an
  // occurrence_id, two DIFFERENT cells naming the SAME activity collapse onto
  // one row. The drop is residued rather than silent, which is the honest
  // behaviour available at this layer." That was honest about the symptom and
  // wrong about the cause. Discarding a child's second answer is not a layer
  // limitation — it was storage keying on a schedule fact (the occurrence) to
  // hold a child fact (the coordinate). Two cells are two distinct SCOPES with
  // no template in sight, so they are two rows and there is no collision to
  // resolve. A repeated choice inside ONE scope is still a collision, and is
  // still resolved best-rank-wins below.
  //
  // The three collisions get three treatments, and the asymmetry is the ruling:
  //   same rank, two different choices  → REFUSED (hasContradictoryRanks, below)
  //   same choice, two different ranks  → best (lowest) rank wins, drop residued
  //   same choice, one ranked one not   → the RANKED row wins, and residue names
  //                                       BOTH the drop and the rank_kind
  //                                       disagreement, because a file that said
  //                                       the same thing twice in two different
  //                                       languages is telling us something
  //                                       about itself
  // ONE container. A Map keeps first-seen insertion order and keeps it across a
  // re-set of an existing key, so the resolved set is `[...byKey.values()]` and
  // a winner swap is a single write. Holding a parallel array as well meant
  // writing every swap twice and paying an indexOf scan per collision.
  const byKey = new Map()
  for (const c of candidates) {
    // Mirrors deriveElectivePreferenceId's three arms: an occurrence outranks a
    // coordinate, a coordinate outranks nothing, and a whole-run row keys on the
    // same empty scope every other whole-run row does.
    const scope = c.occurrence_id ?? coordinateKey(c.coordinate)
    const key = `${c.camper_id}\u0000${scope}\u0000${c.labelKey}`
    const held = byKey.get(key)
    if (!held) {
      byKey.set(key, c)
      continue
    }
    const heldRank = held.rank
    const incoming = c.rank
    // Two unranked mentions of one choice are identical, and saying so twice is
    // not a collision worth reporting.
    if (heldRank == null && incoming == null) continue

    // An explicit rank is strictly more information than its absence.
    const incomingWins =
      heldRank == null ? incoming != null : incoming != null && incoming < heldRank
    const loser = incomingWins ? held : c
    const winner = incomingWins ? c : held

    if (incomingWins) byKey.set(key, c)

    add(
      'DROPPED_DUPLICATE_RANK',
      `Row ${loser.rowNumber}`,
      `${winner.label} is named more than once by the same camper for the same period. Kept ` +
        `${winner.rank == null ? 'no rank' : `#${winner.rank}`}, dropped ` +
        `${loser.rank == null ? 'the unranked mention' : `#${loser.rank}`}.`,
      {
        label: winner.label,
        camperId: winner.camper_id,
        keptRank: winner.rank,
        droppedRank: loser.rank,
        rowNumber: loser.rowNumber,
      }
    )

    if (winner.rank_kind !== loser.rank_kind) {
      add(
        'RANK_KIND_DISAGREEMENT',
        `${winner.label}`,
        // Usually a sign the form changed between submissions.
        `Appears for the same camper both as ${loser.rank_kind} and as ${winner.rank_kind}.`,
        { label: winner.label, camperId: winner.camper_id, kept: winner.rank_kind, dropped: loser.rank_kind }
      )
    }
  }

  // PASS 3 — RESOLVER 4 (rows → identities), which OWNS MULTIPLICITY.
  //
  // Two classes, and they get opposite treatment (§12.3, §13.1):
  //
  //  (i) COLLAPSED — one name, ONE derived id, several rows AT THE SAME
  //      COORDINATE (or all of them lacking one). Two children sharing a name
  //      with nothing to tell them apart would be merged into one record, so
  //      this is REFUSED, as it always was.
  //
  //      THE COORDINATE DIMENSION IS NEW, AND IT IS A BLOCKER FIX. The old
  //      filter kept every name with `rowNumbers.length > 1 && ids.size === 1`,
  //      and commitElectiveRun tests it FIRST — so one camper's correctly-read
  //      18-cell planner, read as 18 rows, was REFUSED before
  //      hasContradictoryRanks was even reached. Reproduced by executing the
  //      functions, not by reading them. Rows carrying DISTINCT coordinates are
  //      one camper's per-cell answers, which is the correct reading of a grid.
  //      An absent coordinate collapses to the same empty key for every
  //      whole-run row, so T226's original behaviour is preserved EXACTLY for
  //      that shape: this is a widening of the key, not a replacement of it.
  //
  // (ii) FORKED — one name, SEVERAL derived ids, at least one row lacking an
  //      external id. Two camper records for one child holding disjoint halves
  //      of their preferences, and per the absorbed ADR's Trap 4 those rows are
  //      unremovable. RESIDUE, not a refusal: two children who genuinely share
  //      a name and ARE distinguished by an id is the CORRECT reading of that
  //      shape, and only the director can tell that case from the fork.
  //      Refusing it would punish the camps that export ids.
  const sameNameCampers = []
  for (const entry of rowsByName.values()) {
    if (entry.rows.length < 2) continue
    const ids = new Set(entry.rows.map((r) => r.camperId))

    if (ids.size > 1) {
      if (entry.rows.some((r) => !r.hasExternalId)) {
        add(
          'FORKED_IDENTITY',
          `\u201c${entry.display_name}\u201d`,
          // If they are two different children this is right; if it is one child they now
          // hold half their choices each, and an id on every row fixes it.
          `On rows ${entry.rows.map((r) => r.rowNumber).join(', ')}, which resolve to different camper ` +
            'records because some carry a camper id and some do not.',
          {
            display_name: entry.display_name,
            rows: entry.rows.map((r) => ({
              rowNumber: r.rowNumber,
              divisionLabel: r.divisionLabel,
              hasExternalId: r.hasExternalId,
            })),
          }
        )
      }
      continue
    }

    // One derived id, several rows. A COLLISION IS AN OVERLAP OF SLOTS, and this
    // is the general form of the rule T279 introduced for coordinates — the third
    // layout to force it, so it is stated once here rather than per layout:
    //
    //   A row occupies the (coordinate, rank) SLOTS it fills. Two rows for one
    //   name collide only if their slot sets INTERSECT.
    //
    // A WIDE row fills every rank, so two wide rows always collide at rank 1 —
    // T226's original case, preserved exactly. A PER-CELL row fills one rank in
    // one coordinate, so a planner's 18 rows never collide. A LONG-FORMAT row
    // fills exactly one rank, so one child's three ranked rows never collide,
    // while two rows claiming their FIRST choice still do.
    //
    // Keyed on what the rows SAY, not on what their layout is, which is why one
    // rule covers all three instead of a flag per shape.
    const seenSlots = new Map()
    const collidingRows = new Map()
    for (const r of entry.rows) {
      for (const slot of r.slots) {
        const holder = seenSlots.get(slot)
        if (holder) {
          collidingRows.set(holder.rowNumber, holder)
          collidingRows.set(r.rowNumber, r)
        } else {
          seenSlots.set(slot, r)
        }
      }
    }
    // Rows that carry NO resolved cells cannot be told apart by slot, so they
    // fall back to the original rule: several rows for one name is a collision.
    const emptyRows = entry.rows.filter((r) => r.slots.size === 0)
    if (emptyRows.length > 1) for (const r of emptyRows) collidingRows.set(r.rowNumber, r)

    if (collidingRows.size === 0) continue
    const colliding = [...collidingRows.values()].sort((a, b) => a.rowNumber - b.rowNumber)

    sameNameCampers.push({
      display_name: entry.display_name,
      rowNumbers: colliding.map((r) => r.rowNumber),
      // §12.2a's consequence: the refusal sentence must name each row's
      // division alongside its row number, because the division is exactly
      // what lets a director say "those are two different kids".
      divisionLabels: colliding.map((r) => r.divisionLabel),
    })
  }

  // §13.5's metric construction, carried on the result so a caller cannot
  // compute it a second, different way. The coverage check (how many cells a
  // camper should have selected) is UNAVAILABLE for a camper whose division
  // resolved to neither a group nor a tier — `deriveOccurrences` keys
  // occurrences on `group.tier_id` and SKIPS the slot when it is absent. A
  // design that raised a measured pass rate by pushing pages into the
  // unmeasured bucket must show up as a rising unmeasured count, which is why
  // this is reported BESIDE the number rather than inside it.
  const coverage = {
    measurable: unmeasuredCampers === 0 && !catalogAbsent && campers.length > 0,
    unmeasuredCampers,
    campers: campers.length,
  }

  return {
    campers,
    choices: [...choicesByKey.values()],
    preferences: [...byKey.values()],
    sameNameCampers,
    skippedRows,
    residue,
    coverage,
  }
}

/**
 * Does any camper hold the same rank twice IN THE SAME CELL?
 *
 * This is the CONSEQUENCE of a same-name collision, and the reason
 * `sameNameCampers` is a blocking decision rather than a notice. Observed on a
 * 100-row fabricated sheet: three rows naming one child produced one camper
 * with 75 preferences and three different rank-1 choices. A solver handed that
 * would resolve it by picking whichever it encountered first — a silent,
 * invisible decision about a real child's week.
 *
 * ROUND 3 CORRECTION — this function is now called on BOTH source shapes
 * (round 1's "preferenceSheet.js is out of scope" ruling was wrong and is
 * retracted). Governing this function's ORIGINAL, still-real case is a
 * WHOLE-RUN sheet (no `occurrence_id` at all, exactly what today's parser
 * emits) — there, a camper holding the same rank twice can only mean the
 * same collision this function was built to catch. But a PER-CELL sheet
 * (ADR docs/adr/2026-09-26-per-cell-elective-preferences.md, Decision 1)
 * legitimately gives the same camper rank 1 in Monday period 3 AND rank 1 in
 * Monday period 6 — two independent first choices, not a contradiction. The
 * key therefore includes the occurrence dimension: a duplicate rank WITHIN
 * one occurrence (or within the single implicit whole-run "cell", when
 * `occurrence_id` is absent from every row) is still refused; the same rank
 * across two DIFFERENT occurrences is not. An absent `occurrence_id`
 * collapses to the SAME empty component for every whole-run row, so the
 * original T226 behaviour is preserved exactly for that shape — this is a
 * widening of the key, not a replacement of it.
 *
 * T279 WIDENS THE SAME KEY ONE STEP FURTHER, for the same reason and with the
 * same care. A per-cell sheet read through THIS parser carries a `coordinate`
 * (a day/period LABEL pair) and NOT yet an `occurrence_id` — resolving a
 * coordinate to an occurrence needs a template, and no template exists at parse
 * time (`AssignmentPanel.jsx` runs the whole read before it chooses one). So a
 * correctly-read planner reaches this function with 18 rank-1 rows, an absent
 * occurrence_id on every one, and 18 distinct coordinates — and the pre-T279
 * key collapsed all 18 onto `camper\0\01` and refused the sheet. The
 * coordinate is used only as the FALLBACK for an absent occurrence_id, so a
 * resolved preference keys exactly as it did before, and a whole-run row (no
 * occurrence AND no coordinate) still yields the same empty component for every
 * row.
 *
 * The `\u0000` delimiter is load-bearing (as elsewhere in this codebase —
 * grep with `-a` to find it in a binary-unsafe search): it cannot appear in
 * a camper_id, occurrence_id or rank, so two distinct (camper_id,
 * occurrence_id, rank) triples can never collide onto the same key string.
 *
 * Kept separate from parsePreferenceSheet so the caller can show the director
 * the collision and its effect as two different sentences.
 */
export function hasContradictoryRanks({ preferences = [] } = {}) {
  const seen = new Set()
  for (const p of preferences) {
    // An UNRANKED preference cannot contradict anything, and T279 had to learn
    // this from the corpus (P10). An unordered set is a TIE AMONG EQUALS (§4.1)
    // — "Swim, Archery, Ceramics" is one camper naming three acceptable
    // activities with no ordering evidence — so several rank-null entries for
    // one camper is the CORRECT reading of that sheet, not a contradiction. The
    // pre-fix key treated every null as the same rank and refused the file with
    // "a camper holds the same preference rank twice", about a sheet that states
    // no ranks at all. Two unranked rows for one derived id are identical and
    // are already a no-op in the collision pass.
    if (p.rank == null) continue
    const scope = p.occurrence_id ?? coordinateKey(p.coordinate)
    const key = `${p.camper_id}\u0000${scope}\u0000${p.rank}`
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}
