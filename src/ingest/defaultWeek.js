// The camp's deterministic first schedule week. A fresh camp has no week row until something needs one; the
// Schedule screen, materializeImportedVersion and the first import's commit all converge on this one id.
export const defaultWeekId = (campId) => `schedule-week:${campId}:1`

export const defaultWeekFields = (campId) => ({ camp_id: campId, name: 'Week 1', sort_order: '0', is_archived: '0' })

// What an import may bind week-bound items to: the camp's real weeks, or, when it has none, the Week 1 the
// commit will create (willCreate marks it so the UI can say so).
export function weeksForImport(weeks, campId) {
  return weeks.length > 0 ? weeks : [{ id: defaultWeekId(campId), name: 'Week 1', willCreate: true }]
}
