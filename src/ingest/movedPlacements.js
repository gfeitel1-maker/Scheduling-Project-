// A pinned slot that is absent on one day, with something else filling exactly
// that gap, is an EXCEPTION to the pinning — not a new activity.
//
// From the owner, 2026-09-12, about the real camp: lunch used to be identical
// across all days. Wednesday was changed later, because a different group's
// pool schedule made it necessary. So the Wednesday cell is "lunch, moved",
// and filing it as a fourth lunch — which is what ingestion does today —
// throws away the one fact that makes it comprehensible.
//
// WHAT THIS IS NOT. It is not a question. The director is told and can move
// past it (owner, same conversation). Nothing here changes what is written;
// this module only observes. That is also why it can afford to be wrong
// occasionally in a way the placement inferences cannot.
//
// WHY THE RULE IS STRUCTURAL AND NOT THE WORD "LUNCH". The owner observed,
// correctly, that "Lunch" is near-universal across camps and a name-specific
// rule would work for this case. The shape is more reliable than the word: it
// holds for a camp that writes Mittagessen, for a swim that moves, and for a
// name nobody anticipated. If the structural rule is later shown not to catch
// a real file, a name-based fallback is a reasonable addition — but it should
// be the fallback, not the primary.
//
// Pure — no I/O, no DB. Same two-orientation walk as fixedEvents.js and
// multiBlockCandidates.js, read through the same canonical spellings.

import { isDayName } from './textGrid.js'
import { activityNamesFromCell, canonicalDay, dayNameFromTitle, cleanTitle } from './extractEntities.js'
import { normalizeName } from './preview.js'

const DAY_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const dayRank = (d) => {
  const i = DAY_ORDER.indexOf(String(d).trim().toLowerCase())
  return i === -1 ? DAY_ORDER.length : i
}
const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))

/**
 * @param {{pages: Array}} parsed        the object passed to extractEntities
 * @param {object} proposal              extractEntities(parsed)'s return
 * @param {Array} fixedEvents            inferFixedEvents(...).fixedEvents
 * @returns {Array<{pinned, pinned_block, moved, moved_block, groups: string[], days: string[]}>}
 *          one note per pinned slot that appears to have moved. Never throws;
 *          returns [] on anything it cannot read.
 */
export function findMovedPlacements(parsed, proposal, fixedEvents) {
  const pages = parsed?.pages ?? []
  const events = Array.isArray(fixedEvents) ? fixedEvents : []
  if (pages.length === 0 || events.length === 0) return []

  const orientation = proposal?.orientation ?? {}
  const groupNameByTitle = proposal?.groupNameByTitle ?? {}
  const canonicalMap = proposal?.canonicalMap
  const compoundCellDecisions = proposal?.compoundCellDecisions

  const groupSpelling = new Map()
  const regGroup = (name) => {
    const norm = normalizeName(name)
    if (!groupSpelling.has(norm)) groupSpelling.set(norm, name)
    return norm
  }

  // activityNorm -> Map(groupNorm -> Map(day -> block)). One pass, shared by
  // both the "is it absent" and the "what filled the gap" questions.
  const footprint = new Map()
  const operatingDays = new Set()
  const add = (activity, group, day, block) => {
    const a = normalizeName(activity)
    if (!footprint.has(a)) footprint.set(a, { display: activity, byGroup: new Map() })
    const byGroup = footprint.get(a).byGroup
    if (!byGroup.has(group)) byGroup.set(group, new Map())
    byGroup.get(group).set(day, block)
  }

  for (const page of pages) {
    if (!Array.isArray(page?.columns) || !Array.isArray(page?.rows)) continue
    if (orientation.columns === 'days') {
      const rawTitle = cleanTitle(page.title)
      const groupName = groupNameByTitle[rawTitle] ?? rawTitle
      if (!groupName) continue
      const group = regGroup(groupName)
      page.columns.forEach((col, i) => {
        if (!isDayName(col)) return
        const day = canonicalDay(col)
        operatingDays.add(day)
        for (const r of page.rows) {
          const block = String(r?.label ?? '').trim()
          for (const n of activityNamesFromCell(r?.cells?.[i], canonicalMap, compoundCellDecisions)) {
            add(n, group, day, block)
          }
        }
      })
    } else {
      const day = dayNameFromTitle(cleanTitle(page.title))
      if (!day) continue
      operatingDays.add(day)
      page.columns.forEach((rawGroup, i) => {
        if (!rawGroup) return
        const group = regGroup(groupNameByTitle[rawGroup] ?? rawGroup)
        for (const r of page.rows) {
          const block = String(r?.label ?? '').trim()
          for (const n of activityNamesFromCell(r?.cells?.[i], canonicalMap, compoundCellDecisions)) {
            add(n, group, day, block)
          }
        }
      })
    }
  }

  // Names already explained as pinnings are not candidates for "the thing that
  // filled the gap" — a second pinned event is its own fact, not an exception
  // to the first.
  const pinnedNorms = new Set(events.map((e) => normalizeName(e.name)))
  const notes = []

  for (const event of events) {
    const entry = footprint.get(normalizeName(event.name))
    if (!entry) continue
    const groups = event.scope?.is_all_groups
      ? new Set(entry.byGroup.keys())
      : new Set((event.scope?.groups ?? []).map(normalizeName))
    if (groups.size === 0) continue

    // The days this pinning is absent for the groups it covers.
    const held = new Set(event.days ?? [])
    const missing = [...operatingDays].filter((d) => !held.has(d))
    if (missing.length === 0) continue
    const missingSet = new Set(missing)

    for (const [norm, candidate] of footprint) {
      if (pinnedNorms.has(norm)) continue
      // The candidate's ENTIRE footprint must be exactly the gap: the same
      // groups, and only the missing days. A name that also appears elsewhere
      // is an ordinary activity that happens to sit there.
      if (!setsEqual(new Set(candidate.byGroup.keys()), groups)) continue
      let fits = true
      const blocks = new Set()
      for (const [, byDay] of candidate.byGroup) {
        if (!setsEqual(new Set(byDay.keys()), missingSet)) { fits = false; break }
        for (const b of byDay.values()) blocks.add(b)
      }
      if (!fits || blocks.size !== 1) continue
      // Whatever TOOK the pinned block is the replacement, not the relocation.
      // On the owner's file, Music sits in Chalutzim's 12:10 lunch slot on
      // Wednesday and fits the gap exactly as well as Lunch 4 does — but the
      // thing that MOVED is by definition somewhere else.
      const movedBlock = [...blocks][0]
      if (movedBlock === event.time_block) continue

      notes.push({
        pinned: event.name,
        pinned_block: event.time_block,
        moved: candidate.display,
        moved_block: movedBlock,
        groups: [...groups].map((g) => groupSpelling.get(g) ?? g).sort((a, b) => a.localeCompare(b)),
        days: missing.sort((a, b) => dayRank(a) - dayRank(b)),
      })
    }
  }

  notes.sort((a, b) => a.pinned.localeCompare(b.pinned) || a.moved.localeCompare(b.moved))
  return notes
}
