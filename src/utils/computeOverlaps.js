// OVERLAP — "more groups are booked into this than it holds."
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
// Rows carry the persisted snake_case shape (group_id/day_id/time_block_id/
// activity_id), the same shape computeFindings() reads.

export function computeOverlaps({ slots, activities }) {
  const overlapping = new Map() // slot id → reason

  if (!slots || !activities) return overlapping

  const actMap = new Map(activities.map(a => [a.id, a]))
  const buckets = new Map() // "dayId|blockId|activityId" → slot rows

  for (const s of slots) {
    if (s.is_anchor || !s.activity_id) continue
    const key = `${s.day_id}|${s.time_block_id}|${s.activity_id}`
    const list = buckets.get(key) || []
    list.push(s)
    buckets.set(key, list)
  }

  for (const [key, rows] of buckets) {
    const activityId = key.split('|')[2]
    const act = actMap.get(activityId)
    const capacity = act?.max_groups_per_slot
    if (capacity == null) continue
    const groupCount = new Set(rows.map(r => r.group_id)).size
    if (groupCount <= capacity) continue
    const where = act?.location || act?.name || 'this activity'
    const reason = `${groupCount} groups booked into ${where} — it holds ${capacity}`
    for (const r of rows) overlapping.set(r.id, reason)
  }

  return overlapping
}

// Merges the derived marker into the flags each cell renders from, leaving the
// persisted rows untouched.
export function withOverlapFlags(slots, activities) {
  const overlapping = computeOverlaps({ slots, activities })
  if (overlapping.size === 0) return slots
  return slots.map(s =>
    overlapping.has(s.id)
      ? { ...s, flags: { ...(s.flags || {}), OVERLAP: true, OVERLAP_reason: overlapping.get(s.id) } }
      : s
  )
}
