// Single source of "what is in this schedule cell", shared by every export
// format so they cannot drift (M2, docs/work/plans/2026-09-01-machine-access.md).
//
// A slot's content is one of: an anchor, an event overlay, an elective set, an
// ordinary activity, or empty. resolveSlotCell turns a raw template_slots row
// into a structured cell record; formatCellLabel renders that record to the
// exact human label the Excel export has always produced; buildScheduleExport
// (in exportSchedule.js) emits the structured records verbatim as JSON.
//
// The removed-reference fallbacks match SlotCell's render fallbacks (Red Hat
// fold-in C: render and export stay cosmetically identical).
export const ELECTIVE_REMOVED_LABEL = 'Elective (removed)'
export const EVENT_REMOVED_LABEL = 'Event (removed)'

export function buildScheduleLookups({
  activities = [],
  anchors = [],
  electiveSets = [],
  electiveSetActivities = [],
  events = [],
} = {}) {
  const actLookup = new Map(activities.map((a) => [a.id, a.name]))
  const anchorLookup = new Map(anchors.map((a) => [a.id, a.name]))
  const electiveSetLookup = new Map(electiveSets.map((s) => [s.id, s]))
  const eventLookup = new Map(events.map((e) => [e.id, e]))
  const electiveMembersBySet = new Map()
  for (const m of electiveSetActivities) {
    if (!electiveMembersBySet.has(m.elective_set_id)) electiveMembersBySet.set(m.elective_set_id, [])
    electiveMembersBySet.get(m.elective_set_id).push(m.activity_id)
  }
  return { actLookup, anchorLookup, electiveSetLookup, eventLookup, electiveMembersBySet }
}

// Pure. Given a slot (or a falsy value for an unoccupied cell) and the lookups
// above, return a structured cell record. `missing: true` marks a dangling
// reference (the event/elective it points at was deleted).
export function resolveSlotCell(slot, lookups) {
  if (!slot) return { kind: 'empty', ref_id: null, name: null }
  if (slot.is_anchor) {
    return { kind: 'anchor', ref_id: slot.anchor_id ?? null, name: lookups.anchorLookup.get(slot.anchor_id) ?? null }
  }
  if (slot.event_id) {
    const ev = lookups.eventLookup.get(slot.event_id)
    return { kind: 'event', ref_id: slot.event_id, name: ev ? ev.name : null, missing: !ev }
  }
  if (slot.elective_set_id) {
    const set = lookups.electiveSetLookup.get(slot.elective_set_id)
    const members = (lookups.electiveMembersBySet.get(slot.elective_set_id) || [])
      .map((id) => lookups.actLookup.get(id))
      .filter(Boolean)
    return { kind: 'elective', ref_id: slot.elective_set_id, name: set ? set.name : null, members, missing: !set }
  }
  if (slot.activity_id) {
    return { kind: 'activity', ref_id: slot.activity_id, name: lookups.actLookup.get(slot.activity_id) ?? null }
  }
  return { kind: 'empty', ref_id: null, name: null }
}

// Render a structured cell to the exact label the Excel export produces.
// `anchorBracket` distinguishes the master "All Groups" sheet (`[Anchor] X`)
// from the per-day sheets (`X`, falling back to the literal `Anchor`).
export function formatCellLabel(cell, { anchorBracket = false } = {}) {
  switch (cell.kind) {
    case 'anchor':
      return anchorBracket ? `[Anchor] ${cell.name ?? ''}` : cell.name || 'Anchor'
    case 'event':
      return cell.missing ? EVENT_REMOVED_LABEL : cell.name
    case 'elective':
      if (cell.missing) return ELECTIVE_REMOVED_LABEL
      return cell.members && cell.members.length ? `${cell.name} (${cell.members.join(', ')})` : cell.name
    case 'activity':
      return cell.name || ''
    default:
      return ''
  }
}
