// T350 slice 5 (docs/work/specs/T350-slice5-binding-ui.md §2, §10): one special day's
// placements as display data. Orphans (week or day gone) are never shown or counted
// (ADR D4.7/D5). Pure; no IPC.

export const shortDay = (day) => String(day.label ?? '').slice(0, 3)
const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)

export function placementChips({ specialDayId, placements, weeks, days }) {
  const weekById = new Map(weeks.map(w => [w.id, w]))
  const dayById = new Map(days.map(d => [d.id, d]))
  return (placements || [])
    .filter(p => p.special_day_id === specialDayId && weekById.has(p.week_id) && dayById.has(p.day_id))
    .map(p => ({ placement: p, week: weekById.get(p.week_id), day: dayById.get(p.day_id) }))
    .sort((a, b) => bySort(a.week, b.week) || bySort(a.day, b.day))
    .map(({ placement, week, day }) => ({
      placement, week, day,
      label: `${week.name}${week.is_archived ? ' (archived)' : ''} · ${shortDay(day)}`,
    }))
}

export function placementSublabel(args) {
  const chips = placementChips(args)
  if (chips.length === 0) return null
  if (chips.length === 1) return `Placed ${chips[0].week.name} ${shortDay(chips[0].day)}`
  return `Placed ${chips.length} days`
}
