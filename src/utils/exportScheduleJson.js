import { buildScheduleLookups, resolveSlotCell } from './scheduleCells.js'
import { replacedCellLabel, replacedDayLabel, replacedLaneNotes } from '../screens/schedule/replacedLane.js'

// Stable, versioned, machine-readable export of one candidate schedule (M2,
// docs/work/plans/2026-09-01-machine-access.md §M2a). Pure and xlsx-free — the
// MCP server and the renderer both call it; writing the result (renderer
// download / MCP response) is the caller's job. Consumers reconstruct the grid
// from groups × days × time_blocks + cells; only occupied cells are emitted.
// `format_version` is a public contract — bump it on any shape change (pinned by
// exportScheduleJson.test.js). Cell resolution is shared with the Excel export
// via scheduleCells.js, so the two formats cannot drift.
// A replaced day (T350, `replacements` from buildReplacements) keeps its entry
// in `days`, gaining an optional `replaced` record with the special day's grid
// and notes (additive, so format_version stays 1); its hidden normal cells are
// not emitted.
export function buildScheduleExport({
  slots = [],
  activities = [],
  fixedEvents = [],
  groups = [],
  days = [],
  timeBlocks = [],
  electiveSets = [],
  electiveSetActivities = [],
  events = [],
  camp = null,
  week = null,
  route = null,
  replacements = new Map(),
} = {}) {
  const lookups = buildScheduleLookups({ activities, fixedEvents, electiveSets, electiveSetActivities, events })
  const actMap = new Map(activities.map((a) => [a.id, a]))
  const cells = []
  for (const slot of slots) {
    if (replacements.has(slot.day_id)) continue
    const cell = resolveSlotCell(slot, lookups)
    if (cell.kind === 'empty') continue
    const record = {
      group_id: slot.group_id,
      day_id: slot.day_id,
      time_block_id: slot.time_block_id,
      kind: cell.kind,
      ref_id: cell.ref_id,
      name: cell.name,
    }
    if (cell.kind === 'elective') record.members = cell.members
    if (cell.missing) record.missing = true
    cells.push(record)
  }
  return {
    format_version: 1,
    camp: camp ? { id: camp.id, name: camp.name } : null,
    week: week ? { id: week.id, name: week.name ?? null } : null,
    route: route ?? null,
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    days: days.map((d) => {
      const day = { id: d.id, label: d.label, day_of_week: d.day_of_week ?? null }
      const replacement = replacements.get(d.id)
      if (replacement) day.replaced = replacedRecord(replacement, d, week, groups, actMap)
      return day
    }),
    time_blocks: timeBlocks.map((b) => ({ id: b.id, name: b.name, start_time: b.start_time ?? null, end_time: b.end_time ?? null })),
    cells,
  }
}

function replacedRecord(replacement, day, week, groups, actMap) {
  return {
    label: replacedDayLabel(week, day),
    special_day_id: replacement.specialDayId,
    name: replacement.name,
    notes: replacedLaneNotes(replacement),
    blocks: replacement.blocks.map((b) => ({
      id: b.id,
      name: b.name,
      start_time: b.start_time ?? null,
      end_time: b.end_time ?? null,
      cells: groups.map((g) => {
        const { label, activityId } = replacedCellLabel({ replacement, groupId: g.id, blockId: b.id, actMap })
        return { group_id: g.id, name: label, activity_id: activityId }
      }),
    })),
  }
}
