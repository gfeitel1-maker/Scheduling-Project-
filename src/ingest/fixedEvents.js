// A parsed grid encodes more than a list of activity names. Some activities sit
// at the SAME period every day for a given group — Mifkad, Lunch, Swim, a
// staggered Lunch 1/2/3. Reading them back as bare names throws away the
// pinning; this module recovers it as proposed "Fixed Events" (anchor_activities).
//
// docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
// docs/work/specs/2026-08-03-ingest-fixed-events-design.md §3.
//
// Pure inference — no database, no I/O. Like extractEntities, it proposes; a
// director confirms in the preview before anything is written. Over-inclusion
// is the deliberate bias: a wrong fixed event the director unticks costs a
// moment; a missing one costs the rebuild this feature exists to remove.
//
// Name identity is load-bearing: the commit path resolves a fixed event's
// block/days/groups BY NAME against created-or-existing rows, so every name
// here must be spelled exactly as extractEntities spells it. That is why the
// naming code is shared from extractEntities.js, not re-implemented (§3.2).

import { isDayName } from './textGrid.js'
import { activityNamesFromCell, canonicalDay, dayNameFromTitle, cleanTitle } from './extractEntities.js'
import { normalizeName } from './preview.js'
import { CONFIDENCE, classifyConfidence, tierFromHighFlag } from './confidence.js'

const DAY_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const dayRank = (d) => {
  const i = DAY_ORDER.indexOf(String(d).trim().toLowerCase())
  return i === -1 ? DAY_ORDER.length : i
}

// A row label is a period when it is time-shaped — the same test
// extractEntities uses to decide a label is a time_blocks value — OR when it
// matches one of the camp's own already-configured time_blocks names byte for
// byte modulo trim/case. Without the second arm, a camp whose periods are
// named "Period 1"/"Lunch" rather than printed times produces zero fixed-event
// detection: nothing in the row labels looks time-shaped, so every row is
// silently skipped. `knownBlockNames` is the camp's EXISTING time_blocks rows
// (threaded in from ImportScreen), not this file's own freshly-parsed
// proposal — a brand-new camp with non-time period names and no prior setup
// still gets no detection here (there is nothing yet to recognize against),
// which is an accepted limitation: this is a re-import/update scenario fix,
// not a from-nothing one.
//
// `knownBlockNames` as threaded in from ImportScreen is flattened across all
// of the camp's cohorts, so a block name that only exists in one cohort can
// false-positive a label in a different cohort's rows. That is an accepted
// instance of this module's deliberate over-inclusion bias (a wrong match
// costs the director an untick; missing one costs the rebuild this feature
// exists to remove) — not a defect to fix here, and cohort-scoping is
// intentionally out of scope for this slice.
const isBlockLabel = (label, knownBlockNames) => {
  const trimmed = String(label ?? '').trim()
  if (/^\d{1,2}[:.]\d{2}/.test(trimmed)) return true
  if (!trimmed || !knownBlockNames || knownBlockNames.size === 0) return false
  return knownBlockNames.has(trimmed.toLowerCase())
}

// A collision-safe map key over strings that may themselves contain spaces,
// commas or dashes ("Yeladim 1", "08:40-09:00", "Lunch 1").
const keyOf = (...parts) => JSON.stringify(parts)

// A cell's own text sometimes carries the true period ("Lunch 12:00") even
// though the row itself has one shared label ("Lunch") that every group's
// cell sits under. cleanCellValue/stripTimes (extractEntities.js) strips that
// time out of the NAME on purpose — "Lunch 12:00" and "Lunch 12:30" are the
// same activity — but doing so also erases the one signal that these are
// staggered occurrences of it, not one shared occurrence. Reading the time
// back out of the raw cell (before it's cleaned) and folding it into the
// merge key stops two groups' genuinely different times from silently
// collapsing into a single all-groups event. It is never surfaced on the
// output event — fe.time_block always stays the row's own block, so the
// by-name resolution invariant (§3.2) is untouched.
//
// The extracted fragment is CANONICALIZED (zero-padded hour, unified ':'
// separator) before it is used as a key, mirroring how group names are
// canonicalized via normalizeName elsewhere in this file. Without this, the
// SAME actual time written differently across days ("9:00" vs "09:00")
// produced a different key per day, fragmenting a genuinely-daily-recurring
// event into single-day buckets that each fail the majority threshold and
// get silently dropped (Red Hat HIGH).
//
// The fragment is also validated as a real clock value (hour <= 23, minute
// <= 59) and anchored so it can't match inside a longer alphanumeric/decimal
// token ("v2.05"). Otherwise a per-group annotation that merely looks
// time-shaped but isn't (a level/score suffix) could be misread as a
// staggered period and wrongly split a shared event (Red Hat LOW).
const TIME_TOKEN_RE = /(?<![\w.])(\d{1,2})[:.](\d{2})(?![\w.])/
const cellPeriod = (cell) => {
  const m = String(cell ?? '').match(TIME_TOKEN_RE)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${m[2]}`
}

/**
 * @param {{ pages: Array }} parsed        the same object passed to extractEntities
 * @param {object} proposal                extractEntities(parsed)'s return
 * @param {{ knownTimeBlockNames?: string[] }} [options]  the camp's own
 *        already-configured time_blocks names (existing rows, not this file's
 *        proposal), so a non-time period label ("Period 1") can still be
 *        recognized as a block. See isBlockLabel.
 * @returns {{ fixedEvents: ProposedFixedEvent[] }}
 *
 * ProposedFixedEvent — every string is BY NAME, exactly as the entity proposal
 * spells it:
 *   { name, time_block, days: string[],
 *     scope: { is_all_groups: true, groups: null } | { is_all_groups: false, groups: string[] },
 *     confidence: 'high' | 'low' }
 */
export function inferFixedEvents(parsed, proposal, options = {}) {
  const pages = parsed?.pages ?? []
  const orientation = proposal?.orientation ?? {}
  const allGroups = proposal?.entities?.groups ?? []
  const groupNameByTitle = proposal?.groupNameByTitle ?? {}
  const knownBlockNames = new Set(
    (options.knownTimeBlockNames ?? []).map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean)
  )

  // Every group-identity key below is normalizeName'd so two spellings of the
  // same group (whitespace, casing) collapse into one — the SAME function
  // extractEntities/buildPlan resolve groups by, end to end (Red Hat Risk 5).
  // The first spelling seen is kept for display (mirrors extractEntities'
  // dedupe tie-break).
  const groupSpelling = new Map() // normalizeName(group) -> first spelling seen
  const regGroup = (name) => {
    const norm = normalizeName(name)
    if (!groupSpelling.has(norm)) groupSpelling.set(norm, name)
    return norm
  }

  // keyOf(groupNorm, block, activity) -> Set of days it occupied that block.
  const occupied = new Map()
  // groupNorm -> Set of the days that group operates (its denominator for majority).
  const operatingDays = new Map()

  const addOperatingDay = (group, day) => {
    if (!operatingDays.has(group)) operatingDays.set(group, new Set())
    operatingDays.get(group).add(day)
  }
  const addTuple = (group, day, block, activity, period) => {
    const key = keyOf(group, block, activity, period)
    if (!occupied.has(key)) occupied.set(key, new Set())
    occupied.get(key).add(day)
  }

  for (const page of pages) {
    if (orientation.columns === 'days') {
      // Orientation A — one page per group, days as columns.
      const rawGroupName = groupNameByTitle[cleanTitle(page.title)]
      if (!rawGroupName) continue
      const groupName = regGroup(rawGroupName)
      const dayCols = []
      page.columns.forEach((c, i) => {
        if (isDayName(c)) {
          const day = canonicalDay(c)
          dayCols.push({ i, day })
          addOperatingDay(groupName, day)
        }
      })
      for (const row of page.rows) {
        if (!isBlockLabel(row.label, knownBlockNames)) continue
        const block = row.label.trim()
        for (const { i, day } of dayCols) {
          const cell = row.cells?.[i]
          for (const a of activityNamesFromCell(cell)) addTuple(groupName, day, block, a, cellPeriod(cell))
        }
      }
    } else {
      // Orientation B — one page per day, groups as columns.
      const day = dayNameFromTitle(cleanTitle(page.title))
      if (!day) continue
      page.columns.forEach((rawGroupName) => { if (rawGroupName) addOperatingDay(regGroup(rawGroupName), day) })
      for (const row of page.rows) {
        if (!isBlockLabel(row.label, knownBlockNames)) continue
        const block = row.label.trim()
        page.columns.forEach((rawGroupName, i) => {
          if (!rawGroupName) return
          const groupName = regGroup(rawGroupName)
          const cell = row.cells?.[i]
          for (const a of activityNamesFromCell(cell)) addTuple(groupName, day, block, a, cellPeriod(cell))
        })
      }
    }
  }

  // Majority + confidence per (group, block, activity) — mirrors the rare-entity
  // lowConfidence split. Below a strict majority is dropped; every operating day
  // is high; a majority-but-not-all is low (§3.4). Then collapse across groups by
  // (activity, block, sorted-day-set): the sharing groups are the scope; all
  // groups -> is_all_groups. A whole unit falls out naturally as its groups, with
  // no unit special-casing (§3.5).
  // First pass: majority-filter every (group, block, activity, period) tuple
  // down to the ones that survive, without collapsing across groups yet.
  const filtered = []
  for (const [key, daySet] of occupied) {
    const [group, block, activity, period] = JSON.parse(key)
    const operating = operatingDays.get(group)?.size ?? 0
    if (operating === 0) continue
    const occ = daySet.size
    if (occ * 2 <= operating) continue
    const confidenceTier = classifyConfidence(occ / operating, { highThreshold: 1 })
    const confidence = confidenceTier === CONFIDENCE.HIGH ? 'high' : 'low'
    const days = [...daySet].sort((a, b) => dayRank(a) - dayRank(b))
    filtered.push({ group, block, activity, period, days, occ, operating, confidence })
  }

  const collapsed = new Map()
  const pushEntries = (entries, periodKey, activity, block, days) => {
    // `periodKey` (representative of this bucket, or null) is part of the
    // collapse key but never the output — fe.time_block always stays the
    // row's own block, so the by-name resolution invariant (§3.2) is
    // untouched.
    const collKey = keyOf(activity, block, periodKey, days.join(','))
    if (!collapsed.has(collKey)) {
      collapsed.set(collKey, {
        name: activity, time_block: block, days, groups: new Set(), allHigh: true,
        // B4 support (docs/adr/2026-08-10-ingestion-evidence-persistence.md):
        // seeded from the first group merged into this collapsed event.
        // groupStats: one occ/operating pair PER contributing group (the
        // outer `occupied` map has exactly one tuple per (group, block,
        // activity), so this Map never gets a second write for the same
        // group) — Red Hat round-1: without this, `support` kept only the
        // single strongest group's numbers even when a DIFFERENT weak group
        // was the one that actually dragged confidence to 'low', so the
        // eventual "why?" panel could show "held 6 of 6" next to
        // confidence=low with no way to see the group that caused it.
        maxOcc: 0, pairedOperating: 0, groupStats: new Map(),
      })
    }
    const entry = collapsed.get(collKey)
    for (const e of entries) {
      entry.groups.add(e.group)
      entry.groupStats.set(e.group, { occ: e.occ, operating: e.operating })
      if (e.confidence !== 'high') entry.allHigh = false
      // B4 aggregation choice: the top-level occupied_days/operating_days keep
      // the group with the STRONGEST single-group justification (highest
      // occupied-day count) — a stable "how solid is this, at best" headline
      // number. The FULL per-group breakdown (below, at push time) is what
      // actually explains a 'low' confidence: whichever group's ratio is
      // sub-majority is visible there, so support and confidence never
      // contradict each other.
      if (e.occ > entry.maxOcc) {
        entry.maxOcc = e.occ
        entry.pairedOperating = e.operating
      }
    }
  }

  // Second pass: group the filtered tuples by (activity, block, days) —
  // ignoring period — since that's the true collapse boundary; period then
  // only decides whether the SAME (activity, block, days) group splits.
  // A null period (a bare cell, no embedded time) is a WILDCARD that merges
  // with whichever non-null period is present, so a mostly-bare row with one
  // annotated cell still resolves to a single event instead of fragmenting
  // (Red Hat MEDIUM). Two DIFFERENT non-null periods are still a genuine
  // stagger and split into separate events, exactly as before (Bug A).
  const rowGroups = new Map()
  for (const f of filtered) {
    const rowKey = keyOf(f.activity, f.block, f.days.join(','))
    if (!rowGroups.has(rowKey)) rowGroups.set(rowKey, [])
    rowGroups.get(rowKey).push(f)
  }

  for (const entries of rowGroups.values()) {
    const { activity, block, days } = entries[0]
    const nonNullPeriods = new Set(entries.filter((e) => e.period != null).map((e) => e.period))
    if (nonNullPeriods.size <= 1) {
      // At most one distinct real time in play — every entry (including any
      // bare/null-period ones) merges into a single event.
      pushEntries(entries, null, activity, block, days)
    } else {
      // A genuine stagger: split by period. A bare cell has no time to
      // disambiguate which occurrence it belongs to, so it keeps its own
      // null-period bucket rather than being guessed into one of the real
      // ones.
      const byPeriod = new Map()
      for (const e of entries) {
        if (!byPeriod.has(e.period)) byPeriod.set(e.period, [])
        byPeriod.get(e.period).push(e)
      }
      for (const [period, es] of byPeriod) pushEntries(es, period, activity, block, days)
    }
  }

  // "every group" is compared normalized on both sides — the rest of the
  // pipeline resolves groups by normalizeName, and in orientation B a column
  // spelled with different casing/spacing across day-pages would otherwise
  // fragment an all-groups event into a partial scope (Red Hat round-1).
  const allGroupsNorm = new Set(allGroups.map(normalizeName))

  // entry.groups are already normalizeName'd keys (regGroup above); the
  // footprint below (dual-use test) is keyed the same way, and display
  // spellings are recovered from groupSpelling only at the very end.
  const fixedEvents = []
  for (const entry of collapsed.values()) {
    const isAll = allGroupsNorm.size > 0 &&
      entry.groups.size === allGroupsNorm.size &&
      [...allGroupsNorm].every((g) => entry.groups.has(g))
    fixedEvents.push({
      name: entry.name,
      time_block: entry.time_block,
      days: entry.days,
      scope: isAll
        ? { is_all_groups: true, groups: null }
        : {
            is_all_groups: false,
            groups: [...entry.groups].map((g) => groupSpelling.get(g) ?? g).sort((a, b) => a.localeCompare(b)),
          },
      // footprint (normalized groups) used only for the dual-use test below.
      _footprintGroups: isAll ? allGroupsNorm : entry.groups,
      confidence: tierFromHighFlag(entry.allHigh) === CONFIDENCE.HIGH ? 'high' : 'low',
      // B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md): the
      // compact observation this event's days/scope were inferred from.
      // `groups` (the per-group occ/operating breakdown) and
      // `min_occupied_days`/`min_operating_days` (the weakest contributor)
      // are what make a 'low' confidence explainable alongside the headline
      // occupied_days/operating_days — see the aggregation-choice comment
      // in the collapse loop above.
      support: (() => {
        const groups = [...entry.groupStats.entries()]
          .map(([g, s]) => ({ name: groupSpelling.get(g) ?? g, occupied_days: s.occ, operating_days: s.operating }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const weakest = groups.reduce((min, g) =>
          g.occupied_days / g.operating_days < min.occupied_days / min.operating_days ? g : min
        )
        return {
          days: entry.days,
          occupied_days: entry.maxOcc,
          operating_days: entry.pairedOperating,
          groups_in_scope: [...entry.groups].map((g) => groupSpelling.get(g) ?? g).sort((a, b) => a.localeCompare(b)),
          groups,
          min_occupied_days: weakest.occupied_days,
          min_operating_days: weakest.operating_days,
        }
      })(),
    })
  }

  // dualUseNames — a SEED for the review UI's default tick-state, never a
  // routing verdict buildPlan consumes (ADR Decision 1, C2). A confirmed
  // fixed event's name is dual-use iff the SAME normalized name also has an
  // `occupied` tuple (pre-majority-filter) OUTSIDE the union of that name's
  // own confirmed fixed events' (group, time_block) footprint.
  const footprintByActivity = new Map() // normalizeName(activity) -> Set("groupNorm|block")
  const displaySpellingByActivity = new Map() // normalizeName(activity) -> display spelling
  for (const fe of fixedEvents) {
    const activityNorm = normalizeName(fe.name)
    if (!footprintByActivity.has(activityNorm)) footprintByActivity.set(activityNorm, new Set())
    if (!displaySpellingByActivity.has(activityNorm)) displaySpellingByActivity.set(activityNorm, fe.name)
    const footprint = footprintByActivity.get(activityNorm)
    for (const g of fe._footprintGroups) footprint.add(`${g}|${fe.time_block}`)
  }

  const dualUseNorms = new Set()
  for (const key of occupied.keys()) {
    const [group, block, activity] = JSON.parse(key)
    const activityNorm = normalizeName(activity)
    const footprint = footprintByActivity.get(activityNorm)
    if (!footprint) continue // not a confirmed fixed event at all
    if (!footprint.has(`${group}|${block}`)) dualUseNorms.add(activityNorm)
  }
  const dualUseNames = [...dualUseNorms].map((n) => displaySpellingByActivity.get(n))

  for (const fe of fixedEvents) delete fe._footprintGroups

  // Deterministic order so the same fixture in either orientation yields
  // identical output (the transpose invariant).
  fixedEvents.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    a.time_block.localeCompare(b.time_block) ||
    a.days.join(',').localeCompare(b.days.join(',')) ||
    (a.scope.groups?.join(',') ?? '').localeCompare(b.scope.groups?.join(',') ?? '')
  )

  return { fixedEvents, dualUseNames }
}
