// T350 (docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D4): a day of
// a week bound to a special day is REPLACED — the engine places nothing on it
// and judges goals only over the days that still run. Pure; no IPC.

// Placements are this week's special_day_placements rows. An orphan — another
// week, a day not in `days`, or a special day that does not resolve — replaces
// nothing (D4.7: tolerated, never thrown).
export function resolveEffectiveDays({ days, placements, weekId, specialDays }) {
  const dayIds = new Set(days.map(d => d.id))
  const specialDayIds = new Set((specialDays || []).map(s => s.id))
  const replaced = new Set()
  for (const p of placements || []) {
    if (p.week_id === weekId && dayIds.has(p.day_id) && specialDayIds.has(p.special_day_id)) replaced.add(p.day_id)
  }
  return { days: days.filter(d => !replaced.has(d.id)), replacedDayIds: [...replaced] }
}

// Engine-shape pre-placements ({ dayId, ... }).
export function dropReplacedPreplaced(preplacedSlots, replacedDayIds) {
  const replaced = new Set(replacedDayIds)
  return (preplacedSlots || []).filter(p => !replaced.has(p.dayId))
}

// Absent is a caller bug, not "nothing replaced" — fail loudly rather than
// silently schedule onto a special day. [] is the explicit "none".
export function requireReplacedDayIds(replacedDayIds, where) {
  if (!Array.isArray(replacedDayIds)) throw new Error(`${where}: replacedDayIds is required ([] when no day is replaced)`)
  return replacedDayIds
}

// A prefer_before_day goal whose target day is replaced cannot be judged — the
// day it counts up to is not running. Say so instead of dropping the goal.
export function replacedTargetFinding(group, act) {
  return {
    kind: 'DISTRIBUTION', groupId: group.id, activityId: act.id, severity: 'info',
    reason: `Goal: ${act.prefer_before_day_min}× before day ${act.prefer_before_day} can't be met — that day is a special day this week (group: ${group.name}, activity: ${act.name})`,
    requiredBefore: act.prefer_before_day_min, byDay: act.prefer_before_day, targetReplaced: true,
  }
}
