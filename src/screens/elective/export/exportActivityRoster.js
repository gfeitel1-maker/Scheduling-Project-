// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4) —
// activity roster: the INVERSE projection of elective_assignments, computed from data the Draft/
// Final screens already load. No second roster table. Pure renderer utility, no IPC.
//
// F1 (round 2): the real outer row (electron/main.js's getElectiveRunOuterScheduleHandler) carries
// only camperId — no camperName or groupId. Resolving those from an outer row was reading fields
// that were never on the wire; round-1's test fixtures invented them, which is exactly why this
// stayed green while the real data path shipped blank rosters. Fixed the SAME way
// exportChildSchedule.js already resolves camper/group names: accept `campers` (id, display_name,
// group_id — the shape campers rows already have) and `groups` lookup arrays, and resolve here.
//
// Filters to cell_kind === 'elective' rows only — a roster is who's assigned where, not a
// restatement of the group template (inherited cells are the child-schedule's job, not the
// roster's). Clusters linked choices via clusterLinkedElectiveRows so a bundled choice appears as
// ONE roster row under its label, its members listed once each — never once per member occurrence.
import { clusterLinkedElectiveRows } from '../../../utils/clusterLinkedElectiveRows.js'

export function buildActivityRosterExport({
  campers = [],
  groups = [],
  days = [],
  timeBlocks = [],
  outerRows = [],
  // F3 (round 2): the real shape is getElectiveRunHandler's overCapacityOccurrences —
  // {occurrenceId, activityId, capacity, filled}, no dayId/timeBlockId. Those two are resolved via
  // `occurrences` (elective_occurrences rows, day_id/time_block_id), the same lookup-by-occurrence
  // pattern runStateCopy.js's occurrenceLabel already uses.
  capacityRows = [],
  occurrences = [],
} = {}) {
  const camperById = new Map(campers.map((c) => [c.id, c]))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const dayById = new Map(days.map((d) => [d.id, d]))
  const timeBlockById = new Map(timeBlocks.map((t) => [t.id, t]))
  const occurrenceById = new Map(occurrences.map((o) => [o.id, o]))
  const capacityByCell = new Map()
  for (const c of capacityRows) {
    const occurrence = occurrenceById.get(c.occurrenceId)
    if (!occurrence) continue
    capacityByCell.set(`${occurrence.day_id}|${occurrence.time_block_id}|${c.activityId}`, c.capacity)
  }

  const electiveRows = outerRows.filter((r) => r.cellKind === 'elective')
  const units = clusterLinkedElectiveRows(electiveRows)

  const groupsByKey = new Map()
  for (const unit of units) {
    const isLinked = unit.kind === 'linked_choice'
    const anchor = isLinked ? unit.memberRows[0] : unit
    const key = isLinked ? `choice|${anchor.dayId}|${anchor.timeBlockId}|${unit.choiceId}` : `activity|${anchor.dayId}|${anchor.timeBlockId}|${anchor.activityId}`
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        day: dayById.get(anchor.dayId)?.name ?? anchor.dayId,
        time_block: timeBlockById.get(anchor.timeBlockId)?.name ?? anchor.timeBlockId,
        activity_name: isLinked ? unit.label : anchor.activityName,
        members: [],
        capacity: isLinked ? null : capacityByCell.get(`${anchor.dayId}|${anchor.timeBlockId}|${anchor.activityId}`) ?? null,
      })
    }
    const entry = groupsByKey.get(key)
    const camperId = isLinked ? unit.camperId : anchor.camperId
    const camper = camperById.get(camperId) ?? null
    entry.members.push({
      camper_id: camperId,
      camper_name: camper?.display_name ?? null,
      group_name: groupById.get(camper?.group_id)?.name ?? null,
    })
    // F5 (round 2): `count` is the ASSIGNMENT grain (one per elective_assignments row / member
    // occurrence), not the presentation grain (`members.length`, one per camper) — a linked
    // choice's N occurrences collapse to ONE member entry for display, but must still count as N
    // so this figure reconciles with exportRunSummary.js's per-assignment-row counts_by_rank (the
    // T197 exit clause). A non-linked unit is exactly one row, so the two grains coincide there.
    entry.rowCount = (entry.rowCount ?? 0) + (isLinked ? unit.memberRows.length : 1)
  }

  return [...groupsByKey.values()].map(({ rowCount, ...entry }) => ({ ...entry, count: rowCount }))
}
