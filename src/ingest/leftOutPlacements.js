// The import result's "left out" section: placements the saved version could
// not carry, grouped one entry per name so 124 cells read as a handful of
// lines, each saying where (days, 12-hour time, groups) and what to do.

const MAX_NAMES = 5
const MAX_SPOTS = 4
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const SETUP_SCREEN = { group: ['groups', 'Open Groups'], day: ['days', 'Open Days'], block: ['timeblocks', 'Open Time Blocks'] }

const dayIndex = (d) => DAYS.indexOf(String(d ?? '').trim().toLowerCase())
const abbr = (d) => {
  const i = dayIndex(d)
  return i === -1 ? String(d) : `${DAYS[i][0].toUpperCase()}${DAYS[i].slice(1, 3)}`
}

// Consecutive days read as a range ("Mon–Thu"); two stay separate ("Mon, Tue").
function daysText(days) {
  const sorted = [...days].sort((a, b) => dayIndex(a) - dayIndex(b))
  const known = sorted.every((d) => dayIndex(d) >= 0)
  const parts = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (known && j + 1 < sorted.length && dayIndex(sorted[j + 1]) === dayIndex(sorted[j]) + 1) j++
    if (j - i >= 2) parts.push(`${abbr(sorted[i])}–${abbr(sorted[j])}`)
    else for (let k = i; k <= j; k++) parts.push(abbr(sorted[k]))
    i = j + 1
  }
  return parts.join(', ')
}

// "Bunk 1, Bunk 2, Bunk 3, Bunk 4" reads "Bunk 1–4"; anything else is listed.
function groupsText(groups) {
  const parsed = groups.map((g) => /^(.*\D)(\d+)$/.exec(g))
  if (groups.length >= 3 && parsed.every(Boolean) && parsed.every((m) => m[1] === parsed[0][1])) {
    const nums = parsed.map((m) => Number(m[2])).sort((a, b) => a - b)
    if (nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return `${parsed[0][1]}${nums[0]}–${nums[nums.length - 1]}`
  }
  return groups.join(', ')
}

/**
 * @param {{ unresolvedItems?: Array<{activityName, groupName, dayName, blockText, reason}> }} version
 * @returns {null | { count, headline, entries: Array<{name, spots: string[], moreSpots, action}>, moreNames, setupActions }}
 */
export function leftOutPlacements(version) {
  const items = version?.unresolvedItems ?? []
  if (items.length === 0) return null

  const byName = new Map()
  for (const it of items) {
    if (!byName.has(it.activityName)) byName.set(it.activityName, { name: it.activityName, reasons: new Set(), cells: new Map() })
    const e = byName.get(it.activityName)
    e.reasons.add(it.reason)
    const key = `${it.dayName}|${it.blockText}`
    if (!e.cells.has(key)) e.cells.set(key, { day: it.dayName, time: it.blockText, groups: [] })
    const cell = e.cells.get(key)
    if (!cell.groups.includes(it.groupName)) cell.groups.push(it.groupName)
  }

  const all = [...byName.values()]
  const entries = all.slice(0, MAX_NAMES).map((e) => {
    // Cells with the same time and the same groups merge into one line over their days.
    const lines = new Map()
    for (const c of e.cells.values()) {
      const groups = [...c.groups].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      const key = `${c.time}|${groups.join('|')}`
      if (!lines.has(key)) lines.set(key, { time: c.time, groups, days: [] })
      lines.get(key).days.push(c.day)
    }
    const ordered = [...lines.values()].sort((a, b) => Math.min(...a.days.map(dayIndex)) - Math.min(...b.days.map(dayIndex)))
    return {
      name: e.name,
      spots: ordered.slice(0, MAX_SPOTS).map((l) => `${daysText(l.days)} ${l.time} · ${groupsText(l.groups)}`),
      moreSpots: Math.max(0, ordered.length - MAX_SPOTS),
      action: e.reasons.has('activity') ? { kind: 'addActivity', label: `Add “${e.name}” as an activity` } : null,
    }
  })

  const reasons = new Set(items.map((i) => i.reason))
  const setupActions = ['group', 'day', 'block'].filter((r) => reasons.has(r)).map((r) => ({ kind: 'openSetup', screen: SETUP_SCREEN[r][0], label: SETUP_SCREEN[r][1] }))

  const count = items.length
  return {
    count,
    headline: version.created
      ? `${count} placement${count === 1 ? '' : 's'} left out of the imported schedule — your setup has no matching activity, group, day or time for ${count === 1 ? 'it' : 'them'}.`
      : `Your imported schedule wasn't saved: none of its ${count} placement${count === 1 ? '' : 's'} matched your setup.`,
    entries,
    moreNames: Math.max(0, all.length - MAX_NAMES),
    setupActions,
  }
}
