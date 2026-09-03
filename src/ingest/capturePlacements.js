// Capture the imported grid's actual PLACEMENTS — which activity sat in which
// (group × day × time-block) cell — so an import can be saved as a pull-up-able
// VERSION (a schedule_snapshots row), not just distilled into a catalog and
// then discarded (the "grid = workbench, versions = woodpile" model).
//
// Pure. Mirrors fixedEvents.js's two-orientation walk over the SAME pages/
// proposal shape (reuse, not reinvention), and reads cells through the SAME
// canonical spellings (proposal.canonicalMap) AND the same confirmed compound-
// cell decisions (proposal.compoundCellDecisions, T118 slice 3) so a placement's activityName
// matches the catalog activity/anchor it will resolve to at commit — the
// name-identity invariant, extended to placements. Nothing here writes; commit
// resolves these names → ids and materializes the snapshot.
//
// Scope note (v1): captures one activity name per cell as (group, day, block).
// Multi-block spans flatten to per-block cells (the same activity in each block
// it covered) — visually faithful, structurally not a span; events/elective-set
// cells are not part of the main schedule import's grid. Both are accepted v1
// limitations of the snapshot slot shape (activity_id/anchor_id only).

import { isDayName } from './textGrid.js'
import { activityNamesFromCell, canonicalDay, dayNameFromTitle, cleanTitle } from './extractEntities.js'
import { normalizeName } from './preview.js'

/**
 * @param {{ pages: Array }} parsed   the same object passed to extractEntities
 * @param {object} proposal           extractEntities(parsed)'s return
 * @returns {{ placements: Array<{ groupName, dayName, blockLabel, activityName }> }}
 *          one entry per activity occurrence in a recognized time-block row.
 */
export function capturePlacements(parsed, proposal = {}) {
  const pages = parsed?.pages ?? []
  const orientation = proposal?.orientation ?? {}
  const groupNameByTitle = proposal?.groupNameByTitle ?? {}
  const canonicalMap = proposal?.canonicalMap
  const compoundCellDecisions = proposal?.compoundCellDecisions
  // A row is a time-block row when its label matches a proposed time_block
  // (spelled exactly as extractEntities emitted them). Keyed loosely (trim/case)
  // so "09:00" and " 09:00 " agree; the OUTPUT keeps the proposal's spelling.
  const blockByKey = new Map(
    (proposal?.entities?.time_blocks ?? []).map((b) => [normalizeName(b), b])
  )
  const blockLabelFor = (rawLabel) => blockByKey.get(normalizeName(rawLabel)) ?? null

  const placements = []
  for (const page of pages) {
    if (orientation.columns === 'days') {
      // Orientation A — one page per group, days as columns.
      const groupName = groupNameByTitle[cleanTitle(page.title)]
      if (!groupName) continue
      const dayCols = []
      page.columns.forEach((c, i) => { if (isDayName(c)) dayCols.push({ i, day: canonicalDay(c) }) })
      for (const row of page.rows ?? []) {
        const blockLabel = blockLabelFor(row.label)
        if (!blockLabel) continue
        for (const { i, day } of dayCols) {
          for (const activityName of activityNamesFromCell(row.cells?.[i], canonicalMap, compoundCellDecisions)) {
            placements.push({ groupName, dayName: day, blockLabel, activityName })
          }
        }
      }
    } else {
      // Orientation B — one page per day, groups as columns.
      const dayName = dayNameFromTitle(cleanTitle(page.title))
      if (!dayName) continue
      for (const row of page.rows ?? []) {
        const blockLabel = blockLabelFor(row.label)
        if (!blockLabel) continue
        page.columns.forEach((rawGroupName, i) => {
          if (!rawGroupName) return
          const groupName = groupNameByTitle[rawGroupName] ?? rawGroupName
          for (const activityName of activityNamesFromCell(row.cells?.[i], canonicalMap, compoundCellDecisions)) {
            placements.push({ groupName, dayName, blockLabel, activityName })
          }
        })
      }
    }
  }
  return { placements }
}
