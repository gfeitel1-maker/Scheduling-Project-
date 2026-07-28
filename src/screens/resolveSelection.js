// Keep the user's current selection across a reload; default only when there
// isn't a valid one.
//
// T10: ScheduleScreen's loadAll() ended with an unconditional
//
//   if (d.length > 0) setSelectedDay(d[0].id)
//
// which is correct on first load and wrong on every reload after it. loadAll()
// re-runs on every `op-applied` event, so each drop in Day View threw the user
// back to Monday — while the write they just made succeeded on the day they
// were actually looking at. Same bug in the Group View selector one line above.
//
// This is deliberately a pure function rather than an inline ternary: "what is
// selected now" is a rule with four distinct cases, and the reload path is
// exactly where it was previously got wrong without anything catching it.

export function resolveSelection(currentId, items) {
  const list = Array.isArray(items) ? items : []
  // Still there? Keep it — the user chose it, and a background reload is not a
  // reason to move them somewhere else.
  if (currentId && list.some(item => item?.id === currentId)) return currentId
  // Otherwise fall back to the first available: covers genuine first load, and
  // the case where whatever was selected has since been deleted.
  return list.length > 0 ? list[0].id : null
}
