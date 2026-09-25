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
// A public contract — bump format_version on any shape change, mirroring
// exportScheduleJson.js's and exportElectiveRun.js's own rule.
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

  return {
    format_version: 1,
    run_id: run.id,
    run_name: run.name,
    run_status: run.status,
    generated_at: generatedAt,
    campers: campers.map((camper) => ({
      camper_id: camper.id,
      display_name: camper.display_name,
      group_name: groupById.get(camper.group_id)?.name ?? null,
      schedule: (rowsByCamper.get(camper.id) ?? []).map((row) => ({
        day: dayById.get(row.dayId)?.name ?? row.dayId,
        time_block: timeBlockById.get(row.timeBlockId)?.name ?? row.timeBlockId,
        activity_name: row.activityName,
        location_name: row.locationName,
        span_blocks: row.spanBlocks,
      })),
    })),
  }
}
