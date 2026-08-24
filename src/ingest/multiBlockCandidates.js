// Slice A (docs/adr/2026-08-24-merged-cell-multiblock-ingest.md) reconstructs a
// vertical XLSX merge as `row.blockSpans[cellIndex] = N` — a parallel fact,
// read by nothing until now. This module is that first reader: it surfaces
// every N>=2 merge as a director-facing candidate ("this filled more than one
// time block") without deciding anything about it. The Architect addendum's
// own bias applies here too — a false candidate (Slice A's own Red Hat MED,
// block-count bleed) costs the director one un-pressed button; this module
// never filters, only proposes (§1 of the Slice B addendum).
//
// Pure — no I/O, no DB. Mirrors fixedEvents.js's two-orientation day/group
// resolution over the SAME pages/proposal shape (reuse, not reinvention).
//
// AGGREGATION (Governor round 2, real-file defect against Group Schedules
// 1.xlsx): "Ruach & Shabbat" is a vertical merge on EVERY group's Friday page
// — orientation A pages one per group, so the raw walk below sees it once per
// (group, day) cell, 14 times for a 14-group camp. Left unaggregated, that is
// 14 director-facing chips for what is obviously one recurring Friday block,
// and 14 separate anchor_activities rows at commit instead of one
// is_all_groups row — exactly the "14 anchors instead of one" defect this
// aggregation exists to prevent.
//
// TWO-PASS, not a single union (Red Hat HIGH #2, round 2): a naive single
// pass that unions days AND groups independently over-claims scope when the
// group-set genuinely differs by day — a block present for {A,B} on Monday
// and {C,D} on Tuesday would wrongly collapse to ONE candidate spanning both
// days with groups {A,B,C,D} (or worse, is_all_groups if that union happens
// to equal the camp's full roster), and confirming it would reserve ALL
// groups on BOTH days — A/B never had it Tuesday, C/D never had it Monday.
// So: pass 1 groups raw occurrences by (name, start_block, span_blocks, day)
// into a per-day group-set (every group that showed this exact merge on this
// exact day). Pass 2 then collapses ACROSS days only when two days' group-
// sets are IDENTICAL (same key including the sorted group-set) — a distinct
// group-set is a distinct candidate, each with its own correct days union and
// scope. The owner's validated case (Ruach & Shabbat, every group, Friday
// only) still collapses to ONE is_all_groups candidate under this scheme:
// there is only one day in play, so there is nothing to wrongly union across.
// Unlike fixedEvents.js, there is still no majority-vote/threshold — every
// group/day that ever showed the merge is captured, unconditionally (§1).

import { isDayName } from './textGrid.js'
import { activityNamesFromCell, canonicalDay, dayNameFromTitle, cleanTitle, detectOrientation } from './extractEntities.js'
import { normalizeName } from './preview.js'

const DAY_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const dayRank = (d) => {
  const i = DAY_ORDER.indexOf(String(d).trim().toLowerCase())
  return i === -1 ? DAY_ORDER.length : i
}

/**
 * @param {{ pages: Array }} parsed    the same object passed to extractEntities
 * @param {object} [proposal]          extractEntities(parsed)'s return, for
 *        orientation/groupNameByTitle/entities.groups — optional so a caller
 *        with only pages (as the ADR literally specifies) still gets a
 *        usable, if less precisely-spelled/all-groups-aware, result;
 *        ImportScreen already has `proposal` on hand and should pass it,
 *        same as it does for inferFixedEvents.
 * @returns {{ multiBlockCandidates: MultiBlockCandidate[] }}
 *
 * MultiBlockCandidate — one per logical (name, start_block, span_blocks,
 * exact group-set), every string BY NAME exactly as extractEntities spells
 * it where a spelling is available:
 *   { name, start_block, span_blocks, days: string[],
 *     scope: { is_all_groups: true, groups: null } | { is_all_groups: false, groups: string[] } }
 */
export function inferMultiBlockCandidates(parsed, proposal = {}) {
  const pages = parsed?.pages ?? []
  const orientation = proposal?.orientation ?? detectOrientation(pages)
  const groupNameByTitle = proposal?.groupNameByTitle ?? {}
  const allGroups = proposal?.entities?.groups ?? []
  const allGroupsNorm = new Set(allGroups.map(normalizeName))

  const groupSpelling = new Map() // normalizeName(group) -> first spelling seen
  const regGroup = (name) => {
    const norm = normalizeName(name)
    if (!groupSpelling.has(norm)) groupSpelling.set(norm, name)
    return norm
  }

  // Pass 1 — (name, start_block, span_blocks, day) -> Set(normalized group).
  // The group-set that showed this exact merge on this exact day.
  const dayKeyOf = (name, startBlock, spanBlocks, day) => JSON.stringify([name, startBlock, spanBlocks, day])
  const perDay = new Map()
  const addOccurrence = (name, startBlock, spanBlocks, day, groupRawName) => {
    const key = dayKeyOf(name, startBlock, spanBlocks, day)
    if (!perDay.has(key)) {
      perDay.set(key, { name, start_block: startBlock, span_blocks: spanBlocks, day, groups: new Set() })
    }
    perDay.get(key).groups.add(regGroup(groupRawName))
  }

  for (const page of pages) {
    if (orientation.columns === 'days') {
      // Orientation A — one page per group, days as columns.
      const rawTitle = cleanTitle(page.title)
      const groupName = groupNameByTitle[rawTitle] ?? rawTitle
      if (!groupName) continue
      for (const row of page.rows) {
        if (!row.blockSpans) continue
        const startBlock = (row.label ?? '').trim()
        row.blockSpans.forEach((span, cellIndex) => {
          if (!span || span < 2) return
          const colHeader = page.columns[cellIndex]
          if (!isDayName(colHeader)) return
          const day = canonicalDay(colHeader)
          for (const name of activityNamesFromCell(row.cells?.[cellIndex])) {
            addOccurrence(name, startBlock, span, day, groupName)
          }
        })
      }
    } else {
      // Orientation B — one page per day, groups as columns.
      const day = dayNameFromTitle(cleanTitle(page.title))
      if (!day) continue
      for (const row of page.rows) {
        if (!row.blockSpans) continue
        const startBlock = (row.label ?? '').trim()
        row.blockSpans.forEach((span, cellIndex) => {
          if (!span || span < 2) return
          const rawGroupName = page.columns[cellIndex]
          if (!rawGroupName) return
          const groupName = groupNameByTitle[rawGroupName] ?? rawGroupName
          for (const name of activityNamesFromCell(row.cells?.[cellIndex])) {
            addOccurrence(name, startBlock, span, day, groupName)
          }
        })
      }
    }
  }

  // Pass 2 — collapse across days ONLY when the group-set is identical
  // (Red Hat HIGH #2). A distinct group-set is a distinct candidate.
  const collapsed = new Map()
  for (const entry of perDay.values()) {
    const sortedGroups = [...entry.groups].sort().join(',')
    const key = JSON.stringify([entry.name, entry.start_block, entry.span_blocks, sortedGroups])
    if (!collapsed.has(key)) {
      collapsed.set(key, { name: entry.name, start_block: entry.start_block, span_blocks: entry.span_blocks, days: new Set(), groups: entry.groups })
    }
    collapsed.get(key).days.add(entry.day)
  }

  const candidates = []
  for (const entry of collapsed.values()) {
    const isAll = allGroupsNorm.size > 0 &&
      entry.groups.size === allGroupsNorm.size &&
      [...allGroupsNorm].every((g) => entry.groups.has(g))
    candidates.push({
      name: entry.name,
      start_block: entry.start_block,
      span_blocks: entry.span_blocks,
      days: [...entry.days].sort((a, b) => dayRank(a) - dayRank(b)),
      scope: isAll
        ? { is_all_groups: true, groups: null }
        : {
            is_all_groups: false,
            groups: [...entry.groups].map((g) => groupSpelling.get(g) ?? g).sort((a, b) => a.localeCompare(b)),
          },
    })
  }

  // Deterministic order, same discipline as fixedEvents.js's own sort.
  candidates.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    a.start_block.localeCompare(b.start_block) ||
    a.days.join(',').localeCompare(b.days.join(',')) ||
    (a.scope.groups?.join(',') ?? '').localeCompare(b.scope.groups?.join(',') ?? '')
  )

  return { multiBlockCandidates: candidates }
}
