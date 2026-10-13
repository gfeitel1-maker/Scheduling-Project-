// The camp's deterministic first schedule week. A fresh camp has no week row until something needs one; the
// Schedule screen, materializeImportedVersion and the first import's commit all converge on this one id.
export const defaultWeekId = (campId) => `schedule-week:${campId}:1`

export const defaultWeekFields = (campId) => ({ camp_id: campId, name: 'Week 1', sort_order: '0', is_archived: '0' })

// What an import may bind week-bound items to: the camp's real weeks, or, when it has none, the Week 1 the
// commit will create (willCreate marks it so the UI can say so).
export function weeksForImport(weeks, campId) {
  return weeks.length > 0 ? weeks : [{ id: defaultWeekId(campId), name: 'Week 1', willCreate: true }]
}

// The week a trip or whole day binds to unless the director picks another (board ruling 2026-10-13): the open
// week, else the camp's first week by sort order, skipping archived ones while any other remains. Never null for
// a non-empty list, so a trip is never left unbound and never imports as an activity for want of a week.
export function tripDefaultWeekId(importWeeks, openWeekId = null) {
  if (!Array.isArray(importWeeks) || importWeeks.length === 0) return null
  if (openWeekId && importWeeks.some((w) => w.id === openWeekId)) return openWeekId
  const sorted = [...importWeeks].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
  return (sorted.find((w) => String(w.is_archived ?? '0') !== '1') ?? sorted[0]).id
}
