// T301 slice 2 — scope resolution and the authoring-time overlap warning.
// Pure, no React, no IPC — the same discipline as this screen family's other
// derive*.js helpers, so the algorithm is testable without mounting anything.
//
// WHY WARN AT AUTHORING TIME AT ALL. Two bundles of one activity whose
// effective divisions intersect at a shared cell are BOTH refused by the
// solver's tier 1 (buildElectiveAssignments.js case (c) — an accepted,
// documented limit of the two-pass construction, not a bug: see the 2026-09-23
// ADR's decision (c)). That finding only ever reaches a director after a
// solve; this surfaces the same fact while they are still authoring, because
// the condition is fully checkable client-side and catching it before a solve
// is strictly better than a runtime finding.
//
// WHY NOT WARN ON A RAW SHARED CELL. Two bundles scoped to disjoint divisions
// sharing a cell is fine — no camper is eligible for both, so nothing is
// actually refused. Warning there would be crying wolf.

/**
 * The tier ids a bundle's scope actually covers, restricted to the divisions
 * genuinely present at one cell (never the camp's full division list — a
 * division not scheduled in this cell at all cannot be "covered" by
 * anything).
 *
 * @param {'all'|'only'|'except'} scopeMode
 * @param {string[]} namedTierIds   the bundle's own elective_bundle_tiers list
 *   (read only when scopeMode is 'only' or 'except' — ignored under 'all',
 *   matching deriveChoices.js's own D2 resolution rule)
 * @param {string[]} divisionsAtCell tier ids actually present at this cell
 * @returns {string[]}
 */
export function resolveScope(scopeMode, namedTierIds, divisionsAtCell) {
  const named = new Set(namedTierIds)
  if (scopeMode === 'only') return divisionsAtCell.filter((t) => named.has(t))
  if (scopeMode === 'except') return divisionsAtCell.filter((t) => !named.has(t))
  return [...divisionsAtCell]
}

/**
 * The first sibling bundle (of the SAME activity) whose effective divisions
 * intersect this bundle's at the given cell, or null. Order of
 * `siblingBundles` decides which one is reported when more than one
 * collides — deterministic by construction (the caller controls that order),
 * not by any tie-break inside this function.
 *
 * @param {object} params
 * @param {string} params.activityId
 * @param {{day_id: string, time_block_id: string}} params.cell
 * @param {string[]} params.effectiveDivisions  THIS bundle's own resolveScope() output for `cell`
 * @param {string[]} params.divisionsAtCell     tier ids present at `cell`, both routes unioned
 * @param {{id, name, activity_id, scope_mode, tierIds: string[], periods: {day_id, time_block_id}[]}[]} params.siblingBundles
 *   every OTHER bundle to check against — the caller excludes the bundle
 *   being edited itself; this function has no id of its own to self-filter by.
 * @returns {{bundleId: string, bundleName: string, divisionIds: string[]} | null}
 */
export function findBundleOverlap({ activityId, cell, effectiveDivisions, divisionsAtCell, siblingBundles = [] }) {
  const mine = new Set(effectiveDivisions)
  for (const sib of siblingBundles) {
    if (sib.activity_id !== activityId) continue
    const sharesCell = sib.periods.some((p) => p.day_id === cell.day_id && p.time_block_id === cell.time_block_id)
    if (!sharesCell) continue
    const sibDivisions = resolveScope(sib.scope_mode, sib.tierIds, divisionsAtCell)
    const overlap = sibDivisions.filter((t) => mine.has(t))
    if (overlap.length > 0) return { bundleId: sib.id, bundleName: sib.name, divisionIds: overlap }
  }
  return null
}
