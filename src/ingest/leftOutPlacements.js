// The import result's "left out" section: placements the saved version could
// not carry, grouped one entry per name so 124 cells read as a handful of
// lines, each saying where (day, 12-hour time, groups) and what to do.

const MAX_NAMES = 5
const MAX_SPOTS = 4
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const SETUP_SCREEN = { group: ['groups', 'Open Groups'], day: ['days', 'Open Days'], block: ['timeblocks', 'Open Time Blocks'] }

function dayRank(day) {
  const i = DAY_ORDER.indexOf(String(day ?? '').slice(0, 3).toLowerCase())
  return i === -1 ? DAY_ORDER.length : i
}

function joinList(list) {
  if (list.length <= 2) return list.join(' and ')
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
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
    const cells = [...e.cells.values()].sort((a, b) => dayRank(a.day) - dayRank(b.day))
    const spots = cells.slice(0, MAX_SPOTS).map((c) => `${c.day} ${c.time}: ${joinList(c.groups)}`)
    return {
      name: e.name,
      spots,
      moreSpots: Math.max(0, cells.length - MAX_SPOTS),
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
