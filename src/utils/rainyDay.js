import { resolveElectiveOfferingLocations } from '../engine/electiveOccupancy.js'

// Decides a "Rainy day" switch for one day of the week on screen. Pure: the caller writes the result.
// Capacity mirrors computeOverlaps.js (activities.max_groups_per_slot, locations.capacity), counted per
// (block): groups already in the rain plan or its place that are not being switched away.

export const RAIN_PLAN_FULL_TEXT = 'Rain plan full: choose another'

const isPlainActivityCell = (s) => Boolean(s.activity_id) && !s.is_fixed_event && s.elective_set_id == null && s.event_id == null

export function planRainyDay({ slots, activities, locations = [], timeBlocks = [], electiveSetActivities = [], dayId }) {
  const actMap = new Map(activities.map(a => [a.id, a]))
  const locMap = new Map(locations.map(l => [l.id, l]))
  const order = new Map(timeBlocks.map(b => [b.id, b.sort_order ?? 0]))
  const daySlots = slots.filter(s => s.day_id === dayId)
  const offeringsBySet = new Map()
  for (const m of electiveSetActivities) {
    if (!offeringsBySet.has(m.elective_set_id)) offeringsBySet.set(m.elective_set_id, [])
    offeringsBySet.get(m.elective_set_id).push(m.activity_id)
  }

  const isTail = (s) => s.is_span_head === false
  const hasTail = (s) => daySlots.some(o => o.group_id === s.group_id && isTail(o) && o.activity_id === s.activity_id
    && (order.get(o.time_block_id) ?? 0) > (order.get(s.time_block_id) ?? 0))

  const candidates = []
  const spans = []
  const noPlan = []
  for (const s of daySlots) {
    if (!isPlainActivityCell(s) || !actMap.get(s.activity_id)?.is_outdoor) continue
    if (isTail(s) || hasTail(s)) { spans.push(s); continue }
    const alt = actMap.get(actMap.get(s.activity_id).weather_alternative_id)
    if (!alt || alt.is_outdoor) { noPlan.push(s); continue }
    candidates.push({ slot: s, alt })
  }
  const leaving = new Set(candidates.map(c => c.slot.id))

  const actGroups = new Map() // "block|activity" -> Set(group)
  const locGroups = new Map() // "block|location" -> Set(group)
  const add = (map, key, groupId) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(groupId)
  }
  const book = (s, activityId) => {
    add(actGroups, `${s.time_block_id}|${activityId}`, s.group_id)
    const locId = actMap.get(activityId)?.location_id
    if (locId != null) add(locGroups, `${s.time_block_id}|${locId}`, s.group_id)
  }
  for (const s of daySlots) {
    if (s.activity_id && !leaving.has(s.id)) book(s, s.activity_id)
    else if (s.elective_set_id != null) {
      for (const locId of resolveElectiveOfferingLocations(offeringsBySet.get(s.elective_set_id), actMap).keys()) {
        add(locGroups, `${s.time_block_id}|${locId}`, s.group_id)
      }
    }
  }

  const switches = []
  const full = []
  for (const { slot, alt } of candidates) {
    const actCap = alt.max_groups_per_slot > 0 ? alt.max_groups_per_slot : Infinity
    const loc = alt.location_id != null ? locMap.get(alt.location_id) : null
    const locCap = loc ? (loc.capacity ?? 1) : Infinity
    const actUsed = actGroups.get(`${slot.time_block_id}|${alt.id}`)?.size ?? 0
    const locUsed = loc ? (locGroups.get(`${slot.time_block_id}|${loc.id}`)?.size ?? 0) : 0
    if (actUsed >= actCap || locUsed >= locCap) {
      full.push(slot)
      book(slot, slot.activity_id)
    } else {
      switches.push({ slot, toActivityId: alt.id })
      book(slot, alt.id)
    }
  }
  return { switches, full, noPlan, spans }
}

export function outdoorActivitiesMissingRainPlan({ slots, activities }) {
  const placed = new Set(slots.filter(isPlainActivityCell).map(s => s.activity_id))
  return activities.filter(a => a.is_outdoor && placed.has(a.id) && !a.weather_alternative_id)
}

export function rainyReceiptText(dayLabel, plan) {
  const parts = []
  if (plan.switches.length) parts.push(`${plan.switches.length} switched to rain plans`)
  if (plan.full.length) parts.push(`${plan.full.length} full`)
  if (plan.noPlan.length) parts.push(`${plan.noPlan.length} without a rain plan`)
  if (plan.spans.length) parts.push(`${plan.spans.length} longer than one block, left as is`)
  return `Rainy ${dayLabel}: ${parts.length ? parts.join(', ') : 'nothing outdoors to switch'}`
}
