// The stored cells Generate must keep: a locked activity (unless the director
// released that cell), an authored elective cell, an authored event cell.
// buildSchedule skips every one of them; anything else is the engine's to fill.
export function derivePreplacedSlots(storedSlots, activities) {
  const lockedActIds = new Set(activities.filter(a => a.is_locked).map(a => a.id))
  const at = s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id })
  return [
    ...storedSlots
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_fixed_event)
      .map(s => ({ ...at(s), activityId: s.activity_id })),
    ...storedSlots.filter(s => s.elective_set_id).map(s => ({ ...at(s), electiveSetId: s.elective_set_id })),
    ...storedSlots.filter(s => s.event_id).map(s => ({ ...at(s), eventId: s.event_id })),
  ]
}
