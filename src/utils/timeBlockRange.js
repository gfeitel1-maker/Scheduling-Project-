// Pure time-range checks for time_blocks rows ({ start_time, end_time } as "HH:MM" or
// "HH:MM:SS" — both are stored). Overlap lives in src/engine/blockOverlap.js.

function minutes(time) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(time ?? '').trim())
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function range(block) {
  const start = minutes(block?.start_time)
  const end = minutes(block?.end_time)
  return start === null || end === null ? null : { start, end }
}

export function isBackwardsBlock(block) {
  const r = range(block)
  return r !== null && r.end <= r.start
}

// A default only — the director can still pick any part of day.
export function partOfDayForStart(startTime) {
  const m = minutes(startTime)
  if (m === null) return null
  if (m < 12 * 60) return 'morning'
  if (m < 17 * 60) return 'afternoon'
  return 'evening'
}
