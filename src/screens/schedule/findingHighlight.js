// Which grid cells a finding is "about", so clicking a concern box can light
// them up on the generated schedule.
//
// docs/work/specs/2026-08-01-generated-flag-review.md — the "track changes"
// review. UNFILLABLE rows already carry their own slotIds (one slot each);
// UNDERSERVED and DISTRIBUTION are aggregate findings scoped to a (group,
// activity) pair, and the live findingsRows do NOT carry slot ids for them —
// this is the one new derivation the feature needs, kept pure and tested here
// because it is easy to get subtly wrong (picking up the wrong group's slots,
// or an anchor, or an empty cell that only looks placed).
//
// An aggregate finding can legitimately match ZERO placed slots — UNDERSERVED
// is by definition about something not placed often enough — and that empty
// result is meaningful, not a bug: the caller shows the concern in the list and
// leaves the grid calm rather than lighting nothing and looking broken.

/**
 * The ids of the placed activity slots a finding attaches to.
 *
 * A finding is `{ groupId, activityId, kind, ... }`. A cell counts only if it
 * is a real placement of that activity for that group — anchors and empty
 * cells never match, because a concern about an activity cannot be "about" a
 * slot that holds no activity.
 *
 * Returns `[]` for a missing finding, missing slots, or a finding whose
 * activity simply isn't on the week yet (the absence case).
 */
export function slotIdsForFinding(finding, slots) {
  if (!finding || !Array.isArray(slots)) return []
  return slots
    .filter(
      (s) =>
        s &&
        !s.is_anchor &&
        s.activity_id &&
        s.group_id === finding.groupId &&
        s.activity_id === finding.activityId,
    )
    .map((s) => s.id)
}

/**
 * A `Map<slotId, reason>` for every cell a set of findings-rows attaches to,
 * for one concern kind. This is what the grid reads to decide which cells to
 * outline and what reason to show when one is hovered/focused.
 *
 * `rows` is the already-built findingsRows array (each carries `kind`,
 * `reason`, and — for UNFILLABLE — `slotIds`). For rows that lack `slotIds`
 * (the aggregate findings) it derives them from `slots`. When two rows touch
 * the same cell, the first wins — rows arrive severity-sorted, so the more
 * urgent reason is the one a director sees.
 */
export function highlightMapForKind(kind, rows, slots) {
  const map = new Map()
  if (!kind || !Array.isArray(rows)) return map
  for (const row of rows) {
    if (row.kind !== kind) continue
    const ids = Array.isArray(row.slotIds) ? row.slotIds : slotIdsForFinding(row, slots)
    for (const id of ids) {
      if (!map.has(id)) map.set(id, row.reason)
    }
  }
  return map
}
