import { startMinutesForOrdering } from './orderTimeBlocks.js'
import { formatBlockStart12h } from './blockTimeText.js'

// Where an item appears, compactly, so a review card never shows a bare name:
// "Carpool · 140 cells · Mon–Fri 8:40 AM, 3:40 PM · every group".

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MAX_TIMES = 3
const MAX_GROUPS = 3

const dayIndex = (d) => DAYS.indexOf(String(d ?? '').trim().toLowerCase())
const abbr = (i) => `${DAYS[i][0].toUpperCase()}${DAYS[i].slice(1, 3)}`

// Consecutive runs of three or more days read as a range ("Mon–Fri").
function daysText(indices) {
  const parts = []
  for (let i = 0; i < indices.length;) {
    let j = i
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++
    if (j - i >= 2) parts.push(`${abbr(indices[i])}–${abbr(indices[j])}`)
    else for (let k = i; k <= j; k++) parts.push(abbr(indices[k]))
    i = j + 1
  }
  return parts.join(', ')
}

function groupsText(names, allGroups) {
  const all = allGroups.filter(Boolean)
  if (all.length > 0 && all.every((g) => names.has(g))) return 'every group'
  const ordered = all.filter((g) => names.has(g))
  const list = ordered.length > 0 ? ordered : [...names]
  const shown = list.slice(0, MAX_GROUPS).join(', ')
  return list.length > MAX_GROUPS ? `${shown} +${list.length - MAX_GROUPS}` : shown
}

/**
 * @param placements [{ groupName, dayName, blockLabel, activityName }]
 * @returns "Name · N cells · days time(s) · groups", or just the name when the
 *          file's grid says nothing about it.
 */
export function describeAppearance(placements, name, allGroups = []) {
  const a = summarizeAppearance(placements, name, allGroups)
  if (!a) return name
  return `${name} · ${a.cells} cells · ${a.when}${a.more} · ${a.groups}`
}

/**
 * The same facts as pieces a question can carry: { groups, times } where
 * `times` reads "8:40 AM and 3:40 PM". Null when the grid says nothing.
 */
export function appearancePhrase(placements, name, allGroups = []) {
  const a = summarizeAppearance(placements, name, allGroups)
  if (!a) return null
  const t = a.startTimes
  const times = t.length <= 2 ? t.join(' and ') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`
  return { groups: a.groups, times }
}

function summarizeAppearance(placements, name, allGroups) {
  const rows = (placements ?? []).filter((p) => p.activityName === name && dayIndex(p.dayName) >= 0)
  if (rows.length === 0) return null

  // block -> day indices it occurs on
  const daysByBlock = new Map()
  const groups = new Set()
  for (const r of rows) {
    groups.add(r.groupName)
    if (!daysByBlock.has(r.blockLabel)) daysByBlock.set(r.blockLabel, new Set())
    daysByBlock.get(r.blockLabel).add(dayIndex(r.dayName))
  }

  // Blocks sharing the same days read as one entry: "Mon–Fri 8:40 AM, 3:40 PM".
  const timed = [...daysByBlock].map(([block, days]) => ({
    days: [...days].sort((a, b) => a - b),
    minutes: startMinutesForOrdering(block) ?? 0,
    text: formatBlockStart12h(block),
  }))
  timed.sort((a, b) => a.days[0] - b.days[0] || a.minutes - b.minutes)
  const shown = timed.slice(0, MAX_TIMES)
  const entries = []
  for (const t of shown) {
    const key = t.days.join(',')
    const last = entries[entries.length - 1]
    if (last && last.key === key) last.times.push(t.text)
    else entries.push({ key, days: t.days, times: [t.text] })
  }
  return {
    cells: rows.length,
    when: entries.map((e) => `${daysText(e.days)} ${e.times.join(', ')}`).join(', '),
    more: timed.length > shown.length ? ` +${timed.length - shown.length} more` : '',
    startTimes: [...new Set([...timed].sort((x, y) => x.minutes - y.minutes).map((t) => t.text))],
    groups: groupsText(groups, allGroups),
  }
}
