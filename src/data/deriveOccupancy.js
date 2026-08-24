// Day Map (B1) — read-only spatial occupancy derivation.
// docs/adr/2026-08-24-run-the-day-on-the-map.md Decision 1.
//
// This mirrors the exact join LocationsScreen.jsx:792-802 already performs
// read-only: schedule_templates (week_id + kind) -> template_slots (template_id,
// day_id, time_block_id) -> activities.location_id -> locations. It deliberately
// never invokes buildSchedule.js/placeUsage (see the ADR's Decision 1) — a
// viewer reads an already-built/hand-edited schedule, it does not re-place it.
//
// Pure function: no React, no IPC, no engine. Callers (DayMapScreen now, a B2
// scrubber later) pass in already-loaded lists.

export function deriveOccupancy({ weekId, kind, dayId, blockId, templates, slots, activities, locations }) {
  const template = (templates || []).find(
    (t) => t.week_id === weekId && (t.kind || 'generated') === kind
  )
  if (!template) return { located: [], unlocated: [], templateFound: false }

  const activityById = new Map((activities || []).map((a) => [a.id, a]))
  const locationById = new Map((locations || []).map((l) => [l.id, l]))

  const relevantSlots = (slots || []).filter(
    (s) => s.template_id === template.id && s.day_id === dayId && s.time_block_id === blockId && s.activity_id
  )

  const byLocation = new Map()
  const unlocated = []

  for (const slot of relevantSlots) {
    const activity = activityById.get(slot.activity_id)
    const locationId = activity?.location_id
    if (!locationId || !locationById.has(locationId)) {
      unlocated.push({
        groupId: slot.group_id,
        activityId: slot.activity_id,
        activityName: activity?.name ?? null,
      })
      continue
    }
    if (!byLocation.has(locationId)) byLocation.set(locationId, [])
    byLocation.get(locationId).push({ groupId: slot.group_id, activityId: slot.activity_id })
  }

  const located = []
  for (const [locationId, groups] of byLocation) {
    const location = locationById.get(locationId)
    const capacity = location.capacity > 0 ? location.capacity : 1
    located.push({
      locationId,
      location,
      groups,
      capacity,
      isJam: groups.length > capacity,
    })
  }

  return { located, unlocated, templateFound: true }
}
