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
  // Read cells through the SAME canonical spellings the entity proposal and
  // inferFixedEvents use, so a whitespace/case typo in a multi-block (merged)
  // cell doesn't surface a candidate spelled differently from the catalog
  // activity — the name-identity invariant, third seam (Red Hat).
  const canonicalMap = proposal?.canonicalMap
  // T118 slice 3 — same seam as canonicalMap above: a confirmed compound-cell
  // wrapper must resolve to its anchor here too, or a multi-block wrapper cell
  // surfaces a merged-cell candidate under its own (never-to-exist) name.
  const compoundCellDecisions = proposal?.compoundCellDecisions
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
          for (const name of activityNamesFromCell(row.cells?.[cellIndex], canonicalMap, compoundCellDecisions)) {
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
          for (const name of activityNamesFromCell(row.cells?.[cellIndex], canonicalMap, compoundCellDecisions)) {
            addOccurrence(name, startBlock, span, day, groupName)
          }
        })
      }
    }
  }

  // COMPANION TAILS (T143). The walk above sees only XLSX vertical merges.
  // A camp that writes a two-block session as two separately-named adjacent
  // cells — "Swim" then "Swim Return" — is invisible to it, so a swim reads as
  // two sessions and the travel block becomes independently schedulable.
  //
  // The pattern is structural, not lexical (no name-substring test: a tail is
  // as likely to be "Cleanup" or "Return to Bunk" as "<head> Return"):
  //
  //   B is the TAIL of A iff, across the whole file,
  //     (1) B NEVER occupies a block that A does not immediately precede;
  //     (2) B occurs at least twice (one adjacency is coincidence);
  //     (3) A is followed by B in at least TWO THIRDS of A's occurrences;
  //     (4) B's name CONTINUES A's name — "Swim" -> "Swim Return".
  //
  // (3) rejects a decoy that clause (1) cannot. In the owner's real file
  // Menucha ALWAYS sits in the block right after Lunch 1 and never stands
  // alone, so (1)+(2) would weld Lunch 1 + Menucha into a fake two-block
  // lunch. But Lunch 1 runs five days a week and is followed by Menucha on
  // only some of them (6 of 25 occurrences), so (3) rejects it. Swim passes at
  // 17 of 18 — the one miss being the "Swim Returning" typo in Alufim 2's
  // Wednesday cell, which is why (3) is a ratio and not "always". That typo
  // forms its own 1-of-18 pair and is rejected too, so the pair is not
  // duplicated.
  //
  // (4) was added after measuring (1)-(3) against that same file, which is the
  // only reason it is here: a purely structural rule is far too loose. It
  // welded THREE pairs that are nothing of the kind — "Group Time + Mifkad"
  // (two separate daily anchors that simply always run in that order, on every
  // group, every day), "CIT Block 1 + CIT Block 2" (a numbered chain), and
  // "Ruach + Shabbat" (two distinct all-camp Friday events). Rigid sequence is
  // not the same relation as "second half of one session", and nothing in the
  // grid's shape separates them. The name does: a travel/return block is
  // written as its activity plus a qualifier, so requiring B to begin with A's
  // full name plus at least one more word rejects all three (Mifkad does not
  // continue "Group Time"; "CIT Block 2" does not continue "CIT Block 1";
  // Shabbat does not continue "Ruach") while keeping Swim + Swim Return.
  //
  // The cost is a tail named for something other than its head — a "Swim" ->
  // "Towel Time" camp gets no candidate. That is the right trade here: this
  // detector INFERS a pairing the camp never marked up, unlike the merged-cell
  // walk above where the camp explicitly merged the cells and over-inclusion is
  // cheap. A wrong weld silently makes two sessions into one.
  //
  // Emits into the SAME candidate stream as the merge walk, so the director
  // confirms one kind of thing; `tail_name` is what lets the review surface
  // say "Swim + Swim Return" rather than silently renaming a block.
  const COMPANION_MIN_RATIO = 2 / 3
  const heads = new Map()      // normalized name -> total occurrences
  const tails = new Map()      // normalized name -> total occurrences
  const pairCounts = new Map() // keyOf(headNorm, tailNorm) -> count
  const tailPrecededBy = new Map() // tailNorm -> Set(headNorm seen directly before it)
  const tailStandalone = new Map() // tailNorm -> occurrences with NO filled block before
  // Every raw adjacency, kept so a confirmed pair can be replayed into the
  // same (day, group-set) aggregation the merge walk uses.
  const adjacencies = []
  const pairKey = (a, b) => JSON.stringify([a, b])
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

  // Walk each (group, day) column top to bottom in block order, recording what
  // sits directly above what. `cellsByBlock` is built per orientation so the
  // two share one adjacency pass, exactly as the merge walk shares addOccurrence.
  const walkColumn = (cells, groupRawName, day) => {
    for (let i = 0; i < cells.length; i++) {
      const { block, names } = cells[i]
      const prev = i > 0 ? cells[i - 1] : null
      for (const name of names) {
        const norm = normalizeName(name)
        bump(tails, norm)
        const prevNames = prev?.names ?? []
        if (prevNames.length === 0) {
          bump(tailStandalone, norm)
          continue
        }
        if (!tailPrecededBy.has(norm)) tailPrecededBy.set(norm, new Set())
        for (const headName of prevNames) {
          const headNorm = normalizeName(headName)
          tailPrecededBy.get(norm).add(headNorm)
          bump(pairCounts, pairKey(headNorm, norm))
          adjacencies.push({
            headName, tailName: name,
            headNorm, tailNorm: norm,
            start_block: prev.block, tail_block: block,
            day, groupRawName,
          })
        }
      }
    }
  }
  // `heads` counts an activity wherever it appears, tail or not — clause (3)'s
  // denominator is "every time A happened", not "every time A had something
  // under it".
  const countHead = (names) => { for (const n of names) bump(heads, normalizeName(n)) }

  for (const page of pages) {
    if (orientation.columns === 'days') {
      const rawTitle = cleanTitle(page.title)
      const groupName = groupNameByTitle[rawTitle] ?? rawTitle
      if (!groupName) continue
      // The merge walk above is guarded by `row.blockSpans`, which a page
      // without rows/columns simply never has. This walk reads the grid
      // directly, so it needs the shape checks stated outright — a parsed page
      // is not guaranteed to carry either.
      if (!Array.isArray(page.columns) || !Array.isArray(page.rows)) continue
      page.columns.forEach((colHeader, cellIndex) => {
        if (!isDayName(colHeader)) return
        const day = canonicalDay(colHeader)
        const cells = page.rows.map((r) => ({
          block: (r.label ?? '').trim(),
          names: [...activityNamesFromCell(r.cells?.[cellIndex], canonicalMap, compoundCellDecisions)],
        }))
        cells.forEach((c) => countHead(c.names))
        walkColumn(cells, groupName, day)
      })
    } else {
      const day = dayNameFromTitle(cleanTitle(page.title))
      if (!day) continue
      if (!Array.isArray(page.columns) || !Array.isArray(page.rows)) continue
      page.columns.forEach((rawGroupName, cellIndex) => {
        if (!rawGroupName) return
        const groupName = groupNameByTitle[rawGroupName] ?? rawGroupName
        const cells = page.rows.map((r) => ({
          block: (r.label ?? '').trim(),
          names: [...activityNamesFromCell(r.cells?.[cellIndex], canonicalMap, compoundCellDecisions)],
        }))
        cells.forEach((c) => countHead(c.names))
        walkColumn(cells, groupName, day)
      })
    }
  }

  // Resolve which (head, tail) pairs qualify. A tail preceded by more than one
  // distinct head is not a companion at all — it follows whatever happens to
  // be above it that day — so it is rejected outright rather than attributed
  // to its most frequent predecessor.
  const confirmedPairs = new Map() // tailNorm -> headNorm
  for (const [key, count] of pairCounts) {
    const [headNorm, tailNorm] = JSON.parse(key)
    if (headNorm === tailNorm) continue
    const tailTotal = tails.get(tailNorm) ?? 0
    if (tailTotal < 2) continue
    if ((tailStandalone.get(tailNorm) ?? 0) > 0) continue
    if ((tailPrecededBy.get(tailNorm)?.size ?? 0) !== 1) continue
    if (count !== tailTotal) continue // every occurrence of B follows this A
    // Clause (4): B continues A's name. Anchored at a word boundary so "Swim"
    // does not claim "Swimming Pool" — a different activity, not a tail.
    if (!tailNorm.startsWith(`${headNorm} `)) continue
    const headTotal = heads.get(headNorm) ?? 0
    if (headTotal === 0 || count / headTotal < COMPANION_MIN_RATIO) continue
    confirmedPairs.set(tailNorm, headNorm)
  }

  // Replay the confirmed adjacencies through the SAME per-day aggregation the
  // merge walk feeds, so scope/day collapsing (and its Red Hat HIGH #2
  // two-pass discipline) applies identically to both kinds of candidate.
  const tailNameByPair = new Map() // dayKey -> tail display spelling
  for (const adj of adjacencies) {
    if (confirmedPairs.get(adj.tailNorm) !== adj.headNorm) continue
    addOccurrence(adj.headName, adj.start_block, 2, adj.day, adj.groupRawName)
    tailNameByPair.set(dayKeyOf(adj.headName, adj.start_block, 2, adj.day), adj.tailName)
  }

  // Pass 2 — collapse across days ONLY when the group-set is identical
  // (Red Hat HIGH #2). A distinct group-set is a distinct candidate.
  const collapsed = new Map()
  for (const entry of perDay.values()) {
    const sortedGroups = [...entry.groups].sort().join(',')
    const key = JSON.stringify([entry.name, entry.start_block, entry.span_blocks, sortedGroups])
    if (!collapsed.has(key)) {
      collapsed.set(key, { name: entry.name, start_block: entry.start_block, span_blocks: entry.span_blocks, days: new Set(), groups: entry.groups, tail_name: null })
    }
    collapsed.get(key).days.add(entry.day)
    // Present only on a companion-tail candidate (T143); a merged-cell
    // candidate has no second name to report and stays null.
    const tail = tailNameByPair.get(dayKeyOf(entry.name, entry.start_block, entry.span_blocks, entry.day))
    if (tail) collapsed.get(key).tail_name = tail
  }

  const candidates = []
  for (const entry of collapsed.values()) {
    const isAll = allGroupsNorm.size > 0 &&
      entry.groups.size === allGroupsNorm.size &&
      [...allGroupsNorm].every((g) => entry.groups.has(g))
    candidates.push({
      name: entry.name,
      ...(entry.tail_name ? { tail_name: entry.tail_name } : {}),
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
