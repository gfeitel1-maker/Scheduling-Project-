// T350 slice 4 (docs/work/specs/T350-slice4-replaced-day-render.md §9): the
// content of a replaced day, as plain data. The grid lane and the exporters
// both read it, so screen text and printed text cannot drift. Pure; no IPC.

import { timeRangeLabel } from '../../utils/timeBlockLabel'

// dayId -> replacement for this week's bindings. An orphan binding (another
// week, a day not in `days`, a special day that no longer exists) replaces
// nothing, as resolveEffectiveDays does (ADR D4.7).
export function buildReplacements({ days, weekId, placements, specialDays, specialBlocks, specialSlots, conflicts = [] }) {
  const dayIds = new Set(days.map(d => d.id))
  const byId = new Map(specialDays.map(s => [s.id, s]))
  const map = new Map()
  for (const p of placements || []) {
    const sd = byId.get(p.special_day_id)
    if (p.week_id !== weekId || !dayIds.has(p.day_id) || !sd) continue
    const conflict = conflicts.find(c => c.entity === 'special_day_placements' && c.entity_id === p.id)
    map.set(p.day_id, {
      dayId: p.day_id,
      specialDayId: sd.id,
      name: sd.name,
      notes: sd.notes,
      blocks: specialBlocks.filter(b => b.special_day_id === sd.id).sort((a, b) => a.sort_order - b.sort_order),
      slots: specialSlots.filter(s => s.special_day_id === sd.id),
      conflictTitle: conflict ? conflictTitle(conflict, byId, sd) : null,
    })
  }
  return map
}

function conflictTitle(conflict, byId, winner) {
  const names = [conflict.existingOp?.value, conflict.incomingOp?.value]
    .map(id => byId.get(id)?.name)
    .filter(Boolean)
  return [...new Set(names.length ? names : [winner.name])].join(' or ')
}

// A camp activity carries its id (the identity dot); anything else is plain text.
export function replacedCellLabel({ replacement, groupId, blockId, actMap }) {
  const slot = replacement.slots.find(s => s.group_id === groupId && s.time_block_id === blockId)
  const act = slot?.activity_id ? actMap.get(slot.activity_id) : null
  if (act) return { label: act.name, activityId: act.id }
  return { label: slot?.label || '', activityId: null }
}

export function replacedLaneRows({ replacement, groupId, actMap }) {
  return replacement.blocks.map(b => ({
    blockId: b.id,
    blockName: b.name,
    time: timeRangeLabel(b),
    ...replacedCellLabel({ replacement, groupId, blockId: b.id, actMap }),
  }))
}

// Printed label of a replaced day: week name and weekday, never a calendar date
// (owner ruling, T350 slice 6).
export function replacedDayLabel(week, day) {
  return week?.name ? `${week.name} – ${day.label}` : day.label
}

export function replacedLaneNotes(replacement) {
  return (replacement.notes || '').trim()
}
