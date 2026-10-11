// Bookkeeping the schedule engine inverts when its repair passes lift a placement (unplace() in
// buildSchedule.js). Each is counted or matched exactly, so an inverse removes only what the
// placement it undoes added.

// "Is this activity already on this day for this group?" A count, not a set: two sessions the same
// day (two locked slots) stay "on today" until both are gone.
export function createDayLedger() {
  const counts = new Map()
  const key = (groupId, dayId, actId) => `${groupId}|${dayId}|${actId}`
  return {
    add(groupId, dayId, actId) {
      const k = key(groupId, dayId, actId)
      counts.set(k, (counts.get(k) || 0) + 1)
    },
    remove(groupId, dayId, actId) {
      const k = key(groupId, dayId, actId)
      const n = (counts.get(k) || 0) - 1
      if (n > 0) counts.set(k, n)
      else counts.delete(k)
    },
    has(groupId, dayId, actId) {
      return counts.has(key(groupId, dayId, actId))
    },
  }
}

// Remove a regular placement's entry from a place's occupancy list: this group's unlabelled
// (non-overlay) entry for this activity, never an overlay's or another activity's.
export function removeOwnPlaceEntry(list, groupId, activityId) {
  if (!list) return
  const idx = list.findIndex((o) => o.groupId === groupId && o.sourceLabel === null && o.activityId === activityId)
  if (idx >= 0) list.splice(idx, 1)
}
