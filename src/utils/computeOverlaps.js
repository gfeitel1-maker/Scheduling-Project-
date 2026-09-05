// OVERLAP — "a slot is booked past a limit it shares with other slots."
//
// Two limits are surfaced, both under the single OVERLAP vocabulary and told
// apart only by their message text:
//   • PLACE capacity — more groups are booked into this PLACE than it holds.
//   • ACTIVITY cap — more groups are booked for this ACTIVITY in one (day,block)
//     than its max_groups_per_slot allows.
// Pre-M2 only the activity cap existed (the marker was keyed by activity_id);
// M2 re-keyed it to location_id for the place limit and dropped the activity
// cap. The director wants both back, reading differently, so they know which
// limit they hit. (A director whose Archery has a 2-group instructor cap still
// needs the warning even before M3 assigns Archery a location.)
//
// Derived at render time from the slots on screen, never persisted: it has the
// same character as the aggregate findings (recomputed fresh, no dismissal
// state), and computing it live is what makes the marker clear from EVERY
// participating cell the moment any one of them is moved.
//
// It exists only on the manual route. There, a clashing placement is ACCEPTED
// and marked — a director building their own week is never blocked and never
// has a placement silently corrected (CONSTITUTION.md Art. V). It is a slot
// `flags` entry only and deliberately does NOT go into buildSchedule()'s
// `conflicts` array, which stays [] until the multi-cohort engine.
//
// Place capacity is a property of the PLACE (ADR D2, docs/adr/2026-08-15-camp-
// locations-entity.md): keyed by the activity's location_id, checked against
// locations.capacity — so two DIFFERENT activities sharing one place are
// counted together (assessment §3.3). An activity with no location_id (interim
// M1→M3 state) has no place, so no place-capacity marker; its activity cap is
// still checked. A location_id that IS set but doesn't resolve to a real
// locations row (dangling — a deleted place, a cross-device race, a stale
// import) gets the same unconstrained treatment as no location_id at all,
// matching buildSchedule's placeBlocked and useSlotMutations' locationFull.
//
// Activity cap null/0 mean "no per-activity cap", matching the engine's
// `act.max_groups_per_slot > 0` guard and normalizeActivityEligibility.
//
// When one slot trips BOTH limits the two reasons are joined into a single
// string, keeping the consumer's marker shape (one reason per slot) unchanged.
//
// Rows carry the persisted snake_case shape (group_id/day_id/time_block_id/
// activity_id), the same shape computeFindings() reads.

import { resolveElectiveOfferingLocations } from '../engine/electiveOccupancy.js'

export function computeOverlaps({ slots, activities, locations, electiveSetActivities }) {
  if (!slots || !activities) return new Map()

  const actMap = new Map(activities.map(a => [a.id, a]))
  const locMap = new Map((locations || []).map(l => [l.id, l]))
  const offeringsBySetId = new Map() // electiveSetId → [activityId, ...]
  for (const m of (electiveSetActivities || [])) {
    if (!offeringsBySetId.has(m.elective_set_id)) offeringsBySetId.set(m.elective_set_id, [])
    offeringsBySetId.get(m.elective_set_id).push(m.activity_id)
  }
  const placeBuckets = new Map() // "dayId|blockId|locationId" → { locId, rows }
  const actBuckets = new Map()   // "dayId|blockId|activityId" → { actId, rows }

  for (const s of slots) {
    if (s.is_anchor) continue

    if (s.activity_id) {
      const locId = actMap.get(s.activity_id)?.location_id ?? null
      if (locId != null) {
        const key = `${s.day_id}|${s.time_block_id}|${locId}`
        let bucket = placeBuckets.get(key)
        if (!bucket) { bucket = { locId, rows: [] }; placeBuckets.set(key, bucket) }
        bucket.rows.push(s)
      }
      // Activity cap runs even with no location_id — that is the point of
      // keeping it: it warns before M3 assigns the activity a place.
      const aKey = `${s.day_id}|${s.time_block_id}|${s.activity_id}`
      let aBucket = actBuckets.get(aKey)
      if (!aBucket) { aBucket = { actId: s.activity_id, rows: [] }; actBuckets.set(aKey, aBucket) }
      aBucket.rows.push(s)
      continue
    }

    // Electives are "a schedule within a schedule": an elective slot carries
    // elective_set_id with activity_id: null, so it fell through the
    // activity_id branch above and never entered placeBuckets — an
    // elective-vs-regular place clash produced no OVERLAP flag. Resolve the
    // set's offerings to real locations the same way buildSchedule.js does
    // (shared via resolveElectiveOfferingLocations, deduped by location —
    // one elective slot may occupy several locations at once, and a
    // colocated pair of offerings is one group's presence, not two). No
    // activity-cap bucket here: max_groups_per_slot is a single activity's
    // instructor/equipment cap, and an elective set has no one activity_id
    // to key that by — only the PLACE limit applies.
    if (s.elective_set_id != null) {
      const offeringLocations = resolveElectiveOfferingLocations(offeringsBySetId.get(s.elective_set_id), actMap)
      for (const locId of offeringLocations.keys()) {
        const key = `${s.day_id}|${s.time_block_id}|${locId}`
        let bucket = placeBuckets.get(key)
        if (!bucket) { bucket = { locId, rows: [] }; placeBuckets.set(key, bucket) }
        bucket.rows.push(s)
      }
    }
  }

  const reasons = new Map() // slot id → [reason, ...]
  const add = (id, reason) => {
    const arr = reasons.get(id)
    if (arr) arr.push(reason)
    else reasons.set(id, [reason])
  }

  for (const { locId, rows } of placeBuckets.values()) {
    const loc = locMap.get(locId)
    // A location_id that doesn't resolve to a real location (deleted place,
    // cross-device race, stale import — "dangling") is unconstrained, not a
    // capacity-1 default: an absent map entry is evidence the place doesn't
    // exist, not evidence of a capacity-1 place. Matches buildSchedule's
    // placeBlocked and useSlotMutations' locationFull, closing the blind
    // spot where the three place-capacity consumers disagreed on this case.
    if (!loc) continue
    const capacity = loc.capacity ?? 1
    const groupCount = new Set(rows.map(r => r.group_id)).size
    if (groupCount <= capacity) continue
    const where = loc.name || 'this location'
    const reason = `${groupCount} groups booked into ${where} — it holds ${capacity}`
    for (const r of rows) add(r.id, reason)
  }

  for (const { actId, rows } of actBuckets.values()) {
    const cap = actMap.get(actId)?.max_groups_per_slot
    if (!(cap > 0)) continue // null/0 = no per-activity cap
    const groupCount = new Set(rows.map(r => r.group_id)).size
    if (groupCount <= cap) continue
    const name = actMap.get(actId)?.name || 'this activity'
    const reason = `${groupCount} groups booked for ${name} — its limit is ${cap} per slot`
    for (const r of rows) add(r.id, reason)
  }

  const overlapping = new Map() // slot id → reason (both limits joined when tripped)
  for (const [id, arr] of reasons) overlapping.set(id, arr.join('; '))
  return overlapping
}

// Merges the derived marker into the flags each cell renders from, leaving the
// persisted rows untouched.
export function withOverlapFlags(slots, activities, locations, electiveSetActivities) {
  const overlapping = computeOverlaps({ slots, activities, locations, electiveSetActivities })
  if (overlapping.size === 0) return slots
  return slots.map(s =>
    overlapping.has(s.id)
      ? { ...s, flags: { ...(s.flags || {}), OVERLAP: true, OVERLAP_reason: overlapping.get(s.id) } }
      : s
  )
}
