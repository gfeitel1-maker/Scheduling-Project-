import { buildScheduleLookups, resolveSlotCell } from './scheduleCells.js'

// Stable, versioned, machine-readable export of one candidate schedule (M2,
// docs/work/plans/2026-09-01-machine-access.md §M2a). Pure and xlsx-free — the
// MCP server and the renderer both call it; writing the result (renderer
// download / MCP response) is the caller's job. Consumers reconstruct the grid
// from groups × days × time_blocks + cells; only occupied cells are emitted.
// `format_version` is a public contract — bump it on any shape change (pinned by
// exportScheduleJson.test.js). Cell resolution is shared with the Excel export
// via scheduleCells.js, so the two formats cannot drift.
export function buildScheduleExport({
  slots = [],
  activities = [],
  anchors = [],
  groups = [],
  days = [],
  timeBlocks = [],
  electiveSets = [],
  electiveSetActivities = [],
  events = [],
  camp = null,
  week = null,
  route = null,
} = {}) {
  const lookups = buildScheduleLookups({ activities, anchors, electiveSets, electiveSetActivities, events })
  const cells = []
  for (const slot of slots) {
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
    days: days.map((d) => ({ id: d.id, label: d.label, day_of_week: d.day_of_week ?? null })),
    time_blocks: timeBlocks.map((b) => ({ id: b.id, name: b.name, start_time: b.start_time ?? null, end_time: b.end_time ?? null })),
    cells,
  }
}
