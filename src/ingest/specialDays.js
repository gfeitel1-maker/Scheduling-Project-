// D6 (docs/adr/2026-08-23-unified-schedule-overlay-model.md): a day whose
// grid looks nothing like the rest of that group's week, for most of that
// day's operating groups at once, is proposed as a `special_days` candidate
// — a name only, surfaced then human-filled on SpecialDaysScreen exactly
// like a hand-created one. See docs/adr/2026-08-24-special-day-field-trip-ingest.md
// for the full detector rationale and threshold justification.
//
// Pure inference — no database, no I/O — mirroring inferFixedEvents'
// contract exactly. Deliberately conservative: this ADR only attempts the
// obvious whole-day, all-camp-coincident case (Color War, a camp-wide Field
// Trip). A per-group-varied or partial-day deviation is left alone rather
// than guessed at — missing a candidate costs nothing (the director still
// builds the day by hand, as today); a false positive costs an unwanted
// row on SpecialDaysScreen.
//
// Reuses fixedEvents.js's own per-(group, day, block, activity) tuple walk
// (buildOccupancyTuples) as input. This module runs as a second reducer
// over that same intermediate data — it never re-scans parsed.pages.

import { buildOccupancyTuples } from './fixedEvents.js'
import { normalizeName } from './preview.js'

// Named constants, not buried magic numbers (mirrors confidence.js's
// highThreshold convention) — future slices tune these against real
// reconciliation precision data (ADR Open Question 2).
export const DAY_DEVIATION_RATIO = 0.6
export const DOMINANT_LABEL_COVERAGE = 0.5

/**
 * @param {{ pages: Array }} parsed        the same object passed to extractEntities
 * @param {object} proposal                extractEntities(parsed)'s return
 * @param {{ knownTimeBlockNames?: string[] }} [options]  same option
 *        fixedEvents.js accepts — the camp's existing time_blocks names, so
 *        a non-time period label can still be recognized as a block.
 * @returns {{ specialDayCandidates: ProposedSpecialDay[] }}
 *
 * ProposedSpecialDay: { name, day, support }. `day` and `support` exist for
 * evidence/audit purposes only — never written to the special_days row.
 */
export function inferSpecialDays(parsed, proposal, options = {}) {
  const { occupied, operatingDays } = buildOccupancyTuples(parsed, proposal, options)

  // dayActivities(G, D): the set of (block, activity) pairs G occupies on D.
  // foreignToWeek(G, D): the subset whose activity name never appears for G
  // on any other day of the week.
  //
  // Build, per group, the set of days each (block, activity) name occupies
  // (collapsing period, which is irrelevant to this detector) — then for
  // each (group, day) pair, classify every activity cell as foreign or not.
  const daysByGroupBlockActivity = new Map() // keyOf(group, block, activity) -> Set(days)
  for (const [key, daySet] of occupied) {
    const [group, block, activity] = JSON.parse(key)
    const k = JSON.stringify([group, block, activity])
    if (!daysByGroupBlockActivity.has(k)) daysByGroupBlockActivity.set(k, new Set())
    for (const d of daySet) daysByGroupBlockActivity.get(k).add(d)
  }

  // dayActivities(G, D) reconstructed from the same tuples: every
  // (block, activity) whose day-set contains D.
  const groupDays = new Map() // group -> Set(days) it appears on (from daysByGroupBlockActivity)
  for (const k of daysByGroupBlockActivity.keys()) {
    const [group] = JSON.parse(k)
    if (!groupDays.has(group)) groupDays.set(group, new Set())
  }
  for (const [k, daySet] of daysByGroupBlockActivity) {
    const [group] = JSON.parse(k)
    for (const d of daySet) groupDays.get(group).add(d)
  }

  // All days that appear anywhere.
  const allDays = new Set()
  for (const daySet of operatingDays.values()) for (const d of daySet) allDays.add(d)

  const candidates = []
  for (const day of allDays) {
    // Per-group deviation ratio for this day.
    const qualifyingGroups = [] // { group, foreignNames: Map(normName -> count) }
    let operatingGroupCount = 0
    for (const [group, days] of operatingDays) {
      if (!days.has(day)) continue
      operatingGroupCount += 1

      // dayActivities(G, D): every (block, activity) tuple for this group
      // whose day-set includes `day`.
      const dayActivities = []
      for (const [k, daySet] of daysByGroupBlockActivity) {
        const [g, block, activity] = JSON.parse(k)
        if (g !== group) continue
        if (daySet.has(day)) dayActivities.push({ block, activity })
      }
      if (dayActivities.length === 0) continue

      const foreign = dayActivities.filter(({ block, activity }) => {
        const k = JSON.stringify([group, block, activity])
        const days = daysByGroupBlockActivity.get(k)
        // Foreign to the week: this (block, activity) occurs on no day
        // other than `day` for this group.
        return days.size === 1 && days.has(day)
      })

      const ratio = foreign.length / dayActivities.length
      if (ratio >= DAY_DEVIATION_RATIO) {
        const foreignNames = new Map()
        for (const { activity } of foreign) {
          const norm = normalizeName(activity)
          foreignNames.set(norm, (foreignNames.get(norm) ?? 0) + 1)
        }
        qualifyingGroups.push({ group, foreignNames, foreignCount: foreign.length })
      }
    }

    if (qualifyingGroups.length === 0) continue

    // All-camp coincidence check: does a single normalized name account for
    // a majority of the foreign cells across a majority of qualifying
    // groups?
    const totalForeignCells = qualifyingGroups.reduce((sum, g) => sum + g.foreignCount, 0)
    if (totalForeignCells === 0) continue

    const cellsByName = new Map() // normName -> total foreign cells across qualifying groups
    const groupsByName = new Map() // normName -> Set(group) that has this name in its foreign set
    for (const { group, foreignNames } of qualifyingGroups) {
      for (const [norm, count] of foreignNames) {
        cellsByName.set(norm, (cellsByName.get(norm) ?? 0) + count)
        if (!groupsByName.has(norm)) groupsByName.set(norm, new Set())
        groupsByName.get(norm).add(group)
      }
    }

    let dominant = null
    for (const [norm, cells] of cellsByName) {
      if (cells * 2 <= totalForeignCells) continue // must be a majority of foreign cells
      const groupsWithName = groupsByName.get(norm).size
      if (groupsWithName / qualifyingGroups.length < DOMINANT_LABEL_COVERAGE) continue // majority of qualifying groups
      if (!dominant || cells > dominant.cells) dominant = { norm, cells, groupsWithName }
    }
    if (!dominant) continue

    // Recover a display spelling for the dominant normalized name — the
    // first raw activity name (from occupied) that normalizes to it.
    let displayName = dominant.norm
    for (const key of occupied.keys()) {
      const [, , activity] = JSON.parse(key)
      if (normalizeName(activity) === dominant.norm) { displayName = activity; break }
    }

    candidates.push({
      name: displayName,
      day,
      support: {
        qualifying_groups: qualifyingGroups.length,
        operating_groups: operatingGroupCount,
        dominant_groups: dominant.groupsWithName,
        foreign_cells: dominant.cells,
        total_foreign_cells: totalForeignCells,
      },
    })
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.day.localeCompare(b.day))

  return { specialDayCandidates: candidates }
}
