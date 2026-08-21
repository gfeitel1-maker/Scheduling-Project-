// Headless assembly of buildSchedule()'s legacy-signature inputs
// ({ groups, tiers, days, timeBlocks, activities, anchors, campId,
// locations }) from DB rows, for callers that have no renderer/React tree
// to load through. `locations` IS consumed by buildSchedule (its
// normalizeInput reads `input.locations`, defaulting to [] — an empty
// capacity map — when omitted, per src/engine/buildSchedule.js's own
// comment); this module includes it so a caller that spreads this result
// straight into buildSchedule(...) gets real location-capacity constraints
// instead of silently unconstrained ones. Do not drop it as unused without
// re-checking that call site.
//
// Extracted seam (docs/adr/2026-08-21-mcp-ingestion-server.md, Decision 8):
// the renderer assembles these same inputs in
// src/screens/schedule/useScheduleData.js's `load()` — filter each setup
// list by camp_id, sort groups by tier order then name, sort days/time
// blocks by sort_order, de-dupe days_of_operation by day_of_week, and parse
// the JSON-stringified id-list columns (activities' eligible_tier_ids/
// eligible_group_ids via normalizeActivityEligibility, anchor_activities'
// group_ids via parseIdList) — that logic is entangled with React state
// there, so this module reproduces it against `listEntities` rows instead of
// duplicating a second hand-written copy of the filter/sort/parse rules.
// Keep this in sync with useScheduleData.js's `load()` if that logic changes.
import { listEntities } from './read.js'
import { normalizeActivityEligibility, parseIdList } from '../../src/utils/normalizeActivityEligibility.js'

export function assembleScheduleEngineInputs(db, campId) {
  const groups = listEntities(db, 'groups').filter((x) => x.camp_id === campId)
  const tiers = listEntities(db, 'tiers')
    .filter((x) => x.camp_id === campId)
    .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
  const timeBlocks = listEntities(db, 'time_blocks')
    .filter((x) => x.camp_id === campId)
    .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
  const sortedDays = listEntities(db, 'days_of_operation')
    .filter((x) => x.camp_id === campId)
    .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
  const days = sortedDays.filter((x, i, arr) => arr.findIndex((y) => y.day_of_week === x.day_of_week) === i)
  const activities = listEntities(db, 'activities')
    .filter((x) => x.camp_id === campId)
    .map(normalizeActivityEligibility)
  const anchors = listEntities(db, 'anchor_activities')
    .filter((x) => x.camp_id === campId)
    .map((x) => ({ ...x, group_ids: parseIdList(x.group_ids) }))
  const locations = listEntities(db, 'locations').filter((x) => x.camp_id === campId)

  const tierOrderMap = new Map(tiers.map((tier) => [tier.id, tier.sort_order ?? 0]))
  const sortedGroups = [...groups].sort((x, y) => {
    const ox = tierOrderMap.get(x.tier_id) ?? 999
    const oy = tierOrderMap.get(y.tier_id) ?? 999
    return ox !== oy ? ox - oy : x.name.localeCompare(y.name)
  })

  return { groups: sortedGroups, tiers, days, timeBlocks, activities, anchors, locations }
}
