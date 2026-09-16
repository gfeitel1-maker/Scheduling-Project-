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
