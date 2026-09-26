// T248 (docs/work/tickets/T248-child-schedule-export.md) — per-camper (child)
// schedule export, the contract T197 never built (ADR docs/adr/2026-09-23-
// elective-run-lifecycle-and-remaining-slices.md decision (d), D12's noted
// gap). Pure renderer utility: does no IPC itself. Callers load a run's
// outer schedule rows via window.shoresh.getElectiveRunOuterSchedule (T248's
// new IPC channel, electron/main.js's getElectiveRunOuterScheduleHandler) and
// pass them in already-camelCase, mirroring exportElectiveRun.js's own
// already-loaded-data signature style.
//
// One row per span HEAD, never one row per covered block: the outer rows
// this consumes already carry span_blocks as the length of a single span
// (electron/ops/electiveRunOuterSchedule.js), so no further span-collapsing
// happens here — this function only groups by camper and resolves day/time
// block/group labels.
//
// v76 (T197, docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4):
// each row now carries cell_kind ('elective' | 'inherited'), and a linked elective choice is
// clustered via clusterLinkedElectiveRows into ONE schedule entry before emission, so it renders
// as one unit rather than N separate cells. format_version bumps 1 -> 2 for this shape change —
// this file's OWN contract, not exportScheduleJson.js's group-schedule contract, which is untouched.
//
// A public contract — bump format_version on any shape change, mirroring
// exportScheduleJson.js's and exportElectiveRun.js's own rule.
import { clusterLinkedElectiveRows } from '../../../utils/clusterLinkedElectiveRows.js'

export function buildChildScheduleExport({
  run,
  campers = [],
  groups = [],
  days = [],
  timeBlocks = [],
  outerRows = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const dayById = new Map(days.map((d) => [d.id, d]))
  const timeBlockById = new Map(timeBlocks.map((t) => [t.id, t]))

  const rowsByCamper = new Map()
  for (const row of outerRows) {
    if (!rowsByCamper.has(row.camperId)) rowsByCamper.set(row.camperId, [])
    rowsByCamper.get(row.camperId).push(row)
  }

  const toScheduleEntry = (unit) => {
    if (unit.kind === 'linked_choice') {
      return { kind: 'linked_choice', label: unit.label, memberRows: unit.memberRows }
    }
    return {
      kind: 'span',
      day: dayById.get(unit.dayId)?.name ?? unit.dayId,
      time_block: timeBlockById.get(unit.timeBlockId)?.name ?? unit.timeBlockId,
      cell_kind: unit.cellKind,
      activity_name: unit.activityName,
      location_name: unit.locationName,
      span_blocks: unit.spanBlocks,
    }
  }

  return {
    format_version: 2,
    run_id: run.id,
    run_name: run.name,
    run_status: run.status,
    generated_at: generatedAt,
    campers: campers.map((camper) => ({
      camper_id: camper.id,
      display_name: camper.display_name,
      group_name: groupById.get(camper.group_id)?.name ?? null,
      schedule: clusterLinkedElectiveRows(rowsByCamper.get(camper.id) ?? []).map(toScheduleEntry),
    })),
  }
}
