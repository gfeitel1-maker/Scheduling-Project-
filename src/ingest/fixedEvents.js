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

// A row label is a period only when it is time-shaped — the same test
// extractEntities uses to decide a label is a time_blocks value.
const isBlockLabel = (label) => /^\d{1,2}[:.]\d{2}/.test(String(label ?? '').trim())

// A collision-safe map key over strings that may themselves contain spaces,
// commas or dashes ("Yeladim 1", "08:40-09:00", "Lunch 1").
const keyOf = (...parts) => JSON.stringify(parts)

/**
 * @param {{ pages: Array }} parsed        the same object passed to extractEntities
 * @param {object} proposal                extractEntities(parsed)'s return
 * @returns {{ fixedEvents: ProposedFixedEvent[] }}
 *
 * ProposedFixedEvent — every string is BY NAME, exactly as the entity proposal
 * spells it:
 *   { name, time_block, days: string[],
 *     scope: { is_all_groups: true, groups: null } | { is_all_groups: false, groups: string[] },
 *     confidence: 'high' | 'low' }
 */
export function inferFixedEvents(parsed, proposal) {
  const pages = parsed?.pages ?? []
  const orientation = proposal?.orientation ?? {}
  const allGroups = proposal?.entities?.groups ?? []
  const groupNameByTitle = proposal?.groupNameByTitle ?? {}

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
  const addTuple = (group, day, block, activity) => {
    const key = keyOf(group, block, activity)
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
        if (!isBlockLabel(row.label)) continue
        const block = row.label.trim()
        for (const { i, day } of dayCols) {
          for (const a of activityNamesFromCell(row.cells?.[i])) addTuple(groupName, day, block, a)
        }
      }
    } else {
      // Orientation B — one page per day, groups as columns.
      const day = dayNameFromTitle(cleanTitle(page.title))
      if (!day) continue
      page.columns.forEach((rawGroupName) => { if (rawGroupName) addOperatingDay(regGroup(rawGroupName), day) })
      for (const row of page.rows) {
        if (!isBlockLabel(row.label)) continue
        const block = row.label.trim()
        page.columns.forEach((rawGroupName, i) => {
          if (!rawGroupName) return
          const groupName = regGroup(rawGroupName)
          for (const a of activityNamesFromCell(row.cells?.[i])) addTuple(groupName, day, block, a)
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
  const collapsed = new Map()
  for (const [key, daySet] of occupied) {
    const [group, block, activity] = JSON.parse(key)
    const operating = operatingDays.get(group)?.size ?? 0
    if (operating === 0) continue
    const occ = daySet.size
    if (occ * 2 <= operating) continue
    const confidenceTier = classifyConfidence(occ / operating, { highThreshold: 1 })
    const confidence = confidenceTier === CONFIDENCE.HIGH ? 'high' : 'low'

    const days = [...daySet].sort((a, b) => dayRank(a) - dayRank(b))
    const collKey = keyOf(activity, block, days.join(','))
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
        maxOcc: occ, pairedOperating: operating, groupStats: new Map(),
      })
    }
    const entry = collapsed.get(collKey)
    entry.groups.add(group)
    entry.groupStats.set(group, { occ, operating })
    if (confidence !== 'high') entry.allHigh = false
    // B4 aggregation choice: the top-level occupied_days/operating_days keep
    // the group with the STRONGEST single-group justification (highest
    // occupied-day count) — a stable "how solid is this, at best" headline
    // number. The FULL per-group breakdown (below, at push time) is what
    // actually explains a 'low' confidence: whichever group's ratio is
    // sub-majority is visible there, so support and confidence never
    // contradict each other.
    if (occ > entry.maxOcc) {
      entry.maxOcc = occ
      entry.pairedOperating = operating
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
