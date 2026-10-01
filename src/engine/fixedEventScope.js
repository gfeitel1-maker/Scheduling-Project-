import { assertIdListShape } from './assertIdListShape.js'

/**
 * The groups a fixed/recurring event applies to, resolved from its stored
 * scope against the CURRENT group list.
 *
 * Resolution order: unit_ids > unit_id > is_all_groups > group_ids.
 *
 * T180: `unit_ids` holds the age DIVISIONS the director picked, and resolving
 * them HERE rather than snapshotting groups at save time is the whole point —
 * a group added to one of those divisions afterwards is covered without the
 * event being re-saved. An empty array is not a scope claim and falls through.
 * `unit_id` is the legacy single-division column, kept for pre-v65 rows.
 *
 * Contract: group_ids/unit_ids are arrays of ids. Callers normalize; this
 * engine does not deserialize — see src/screens/schedule/useScheduleData.js.
 */
export function resolveAnchorGroupIds(anchor, groups) {
  const unitIds = Array.isArray(anchor.unit_ids) ? anchor.unit_ids.filter(Boolean) : []
  if (unitIds.length) {
    const wanted = new Set(unitIds)
    return groups.filter((g) => wanted.has(g.tier_id)).map((g) => g.id)
  }
  if (anchor.unit_id != null && anchor.unit_id !== '') {
    return groups.filter((g) => g.tier_id === anchor.unit_id).map((g) => g.id)
  }
  if (anchor.is_all_groups) return groups.map((g) => g.id)
  if (import.meta.env?.DEV) assertIdListShape(anchor.group_ids, 'group_ids', anchor.id)
  return anchor.group_ids || []
}

/**
 * The days a fixed/recurring event covers, resolved against the live day list.
 *
 * A null/empty `day_id` means EVERY day — never "no days". That rule existed in
 * two places the moment the anchored-activity exclusion became day-keyed (Q5):
 * Pass 1's `anchorLookup` in buildSchedule.js, and the exclusion Map itself.
 * Extracted here rather than left duplicated, on the same reasoning that
 * produced resolveAnchorGroupIds one day earlier — two copies of a scope rule
 * is precisely how weekCatalog came to read `group_ids` raw while the engine
 * resolved divisions, and how several sibling defects arose on 2026-09-16.
 *
 * Deliberately NOT a projection and NOT inferential: unlike the unit/division
 * question, there is nothing to infer here and no confidence to carry.
 *
 * `days` must be the LIVE day list at evaluation time, for the same reason
 * resolveAnchorGroupIds takes live groups: a snapshot silently reintroduces the
 * staleness T180 removed, and nothing would fail.
 */
export function resolveAnchorDayIds(anchor, days) {
  const dayId = anchor?.day_id
  if (dayId != null && dayId !== '') return [dayId]
  return (days || []).map((d) => d.id)
}

/**
 * The DIVISION projection of the same scope precedence, for display (the
 * Anchors screen coverage label). Returns a descriptor, not group ids:
 *
 *   { mode: 'all' | 'divisions' | 'none', unitIds: string[], inferred: boolean }
 *
 * It shares ONE precedence with resolveAnchorGroupIds — unit_ids > unit_id >
 * is_all_groups > group_ids — so the two projections can never disagree about
 * WHICH rule fired. `is_all_groups` returns mode 'all' (the word "all", not an
 * enumeration of every division), so the caller never re-encodes "which rule
 * wins" in a screen file. T183 exists because that re-encoding drifted.
 *
 * `inferred` is true ONLY on the legacy fallback: a pre-v65 row with no
 * unit_ids/unit_id whose divisions are derived backward from group_ids. That
 * derivation is lossy — it cannot tell "the whole Juniors division" from "one
 * Juniors bunk" (both yield ['t1']) — so the answer must be flagged an
 * inference and never rendered as stored division scope. The group projection
 * has no such hazard (it returns literal ids) and carries no flag.
 *
 * Same no-deserialize contract as resolveAnchorGroupIds: unit_ids/group_ids
 * must already be arrays, and `groups` must be the live list with tier_id on
 * every element.
 */
export function resolveAnchorUnitIds(anchor, groups) {
  const unitIds = Array.isArray(anchor.unit_ids) ? anchor.unit_ids.filter(Boolean) : []
  if (unitIds.length) return { mode: 'divisions', unitIds, inferred: false }
  if (anchor.unit_id != null && anchor.unit_id !== '') {
    return { mode: 'divisions', unitIds: [anchor.unit_id], inferred: false }
  }
  if (anchor.is_all_groups) return { mode: 'all', unitIds: [], inferred: false }
  const groupIds = Array.isArray(anchor.group_ids) ? anchor.group_ids.filter(Boolean) : []
  if (groupIds.length) {
    const wanted = new Set(groupIds)
    const derived = [...new Set(
      groups.filter((g) => wanted.has(g.id)).map((g) => g.tier_id).filter(Boolean),
    )]
    if (derived.length) return { mode: 'divisions', unitIds: derived, inferred: true }
  }
  return { mode: 'none', unitIds: [], inferred: false }
}
