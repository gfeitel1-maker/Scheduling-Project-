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
  const rows = (placements ?? []).filter((p) => p.activityName === name && dayIndex(p.dayName) >= 0)
  if (rows.length === 0) return name

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
  const when = entries.map((e) => `${daysText(e.days)} ${e.times.join(', ')}`).join(', ')
  const more = timed.length > shown.length ? ` +${timed.length - shown.length} more` : ''

  return `${name} · ${rows.length} cells · ${when}${more} · ${groupsText(groups, allGroups)}`
}

// A card that stands for several decisions lists every one of them.
export function groupedCardLines(decisions) {
  const list = decisions ?? []
  const sameItem = new Set(list.map((d) => d.entityName)).size <= 1
  if (sameItem && !list.some((d) => d.appearsAt)) return []
  return [...new Set(list.map((d) => d.appearsAt ?? d.entityName).filter(Boolean))]
}

// Only when the grouped decisions are about different items is a headline that
// names the first one untrue; otherwise the card keeps its own.
export function groupedCardHeadline(decisions) {
  const names = new Set((decisions ?? []).map((d) => d.entityName))
  if (names.size <= 1) return null
  return decisions[0]?.kind === 'elective_candidate'
    ? `Create an empty elective set for each of these ${decisions.length} periods?`
    : `Use the file's values for these ${decisions.length} items?`
}
