// T377 (consistency audit 2026-10-12, A9): Fixed and Recurring Events are stored one row per day, so a
// camp's daily lineup was five identical rows. The table shows one row per event NAME instead; this is
// that grouping. It only reads: storage stays per day, and edits fan out to each day's row.

const nameKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// The weekday's short name, not the label's first letters: a custom label ("Color War Day") would read "Col".
const short = (day) => DOW_SHORT[day?.day_of_week] ?? String(day?.label ?? '').slice(0, 3)
const dayOrder = (days) => [...days].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.day_of_week ?? 0) - (b.day_of_week ?? 0))
const sameValue = (values) => values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]))

// "Mon–Fri", "Mon, Wed, Fri", "Mon–Wed, Fri"; one day reads as its full name. Consecutive means next
// to each other in the camp's own list of days (its Days screen), so a range never hides a camp day the
// event skips. Runs of two are listed, not ranged.
export function compactDays(dayIds, days) {
  const ordered = dayOrder(days)
  const index = new Map(ordered.map((d, i) => [d.id, i]))
  const picked = [...new Set(dayIds)].filter((id) => index.has(id)).sort((a, b) => index.get(a) - index.get(b))
  if (picked.length === 1) return ordered[index.get(picked[0])].label
  const parts = []
  let run = []
  const flush = () => {
    if (run.length >= 3) parts.push(`${short(ordered[run[0]])}–${short(ordered[run[run.length - 1]])}`)
    else parts.push(...run.map((i) => short(ordered[i])))
    run = []
  }
  for (const id of picked) {
    const i = index.get(id)
    if (run.length && i !== run[run.length - 1] + 1) flush()
    run.push(i)
  }
  if (run.length) flush()
  return parts.join(', ')
}

// One entry per event name, in the order the names first appear; its rows sorted by camp day order.
// A field the days disagree on is flagged (timesVary, scopeVaries, weeksVary) and its shared value is null.
export function groupFixedEvents(events, days) {
  const index = new Map(dayOrder(days).map((d, i) => [d.id, i]))
  const byKey = new Map()
  for (const event of events) {
    const key = nameKey(event.name)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(event)
  }
  return [...byKey.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort((a, b) => (index.get(a.day_id) ?? 99) - (index.get(b.day_id) ?? 99))
    const timesVary = !sameValue(sorted.map((e) => e.time_block_id ?? null))
    const scopeVaries = !sameValue(sorted.map((e) => [Boolean(e.is_all_groups), [...(e.unit_ids ?? [])].sort(), [...(e.group_ids ?? [])].sort()]))
    const weeksVary = !sameValue(sorted.map((e) => e.schedule_week_id ?? null))
    return {
      key,
      name: String(sorted[0].name ?? '').trim(),
      events: sorted,
      dayIds: sorted.map((e) => e.day_id),
      daysLabel: compactDays(sorted.map((e) => e.day_id), days),
      timesVary,
      timeBlockId: timesVary ? null : sorted[0].time_block_id ?? null,
      scopeVaries,
      weeksVary,
      weekId: weeksVary ? null : sorted[0].schedule_week_id ?? null,
    }
  })
}
