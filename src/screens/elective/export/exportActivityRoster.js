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
// ONE roster GROUP under its label; a camper in that group contributes ONE MEMBER ROW PER
// OCCURRENCE (round 3 correction — a joined "Monday, Wednesday" cell broke the JSON<->XLSX parity
// invariant, since both artifacts are built from this one export), each carrying that occurrence's
// own day/time_block. Count still appears exactly once per group (see the final map below).
import { clusterLinkedElectiveRows } from '../../../utils/clusterLinkedElectiveRows.js'

// T320 round 2, F3 — the same standalone-caller reasoning as
// exportChildSchedule.js's own guard: no live caller invokes this builder
// directly today, but the ADR names it as one of the guarded builders and a
// latent gap here is still a gap the moment a caller is added. `run` was
// already threaded through by exportElectiveRunProjection.js's call site;
// it was simply never read.
export function buildActivityRosterExport({
  run,
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
  if (run?.status === 'final' && run?.snapshotIncomplete) {
    return {
      ok: false,
      error: 'SNAPSHOT_INCOMPLETE',
      expectedSnapshotRows: run.expectedSnapshotRows,
      heldSnapshotRows: run.heldSnapshotRows,
    }
  }
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
    const memberBase = {
      camper_id: camperId,
      camper_name: camper?.display_name ?? null,
      group_name: groupById.get(camper?.group_id)?.name ?? null,
    }
    // ROUND 3 CORRECTION — a bundle's other days must appear on the roster AS
    // THEIR OWN ROWS, not joined into one cell. The first attempt joined a
    // linked member's occurrences into a single string ("Monday, Wednesday"),
    // which broke the JSON<->XLSX parity invariant (both artifacts are built
    // from this ONE export, so a joined cell here is a joined cell in both —
    // but §6(11)'s acceptance test asserts the two surfaces present the SAME
    // per-occurrence facts, which a joined cell cannot). So a clustered
    // member contributes ONE ROSTER ROW PER OCCURRENCE, each carrying THAT
    // occurrence's own day/time_block — exactly like a non-linked unit's
    // single row, just repeated once per memberRow. The GROUP's day/time_block
    // (set above, from the anchor) remain the grouping key's own label and are
    // never read by a member row.
    if (isLinked) {
      for (const row of unit.memberRows) {
        entry.members.push({
          ...memberBase,
          day: dayById.get(row.dayId)?.name ?? row.dayId,
          time_block: timeBlockById.get(row.timeBlockId)?.name ?? row.timeBlockId,
        })
      }
    } else {
      entry.members.push({ ...memberBase, day: entry.day, time_block: entry.time_block })
    }
    // F5 (round 2): `count` is the ASSIGNMENT grain (one per elective_assignments row / member
    // occurrence), not the presentation grain (`members.length`, one per camper) — a linked
    // choice's N occurrences collapse to ONE member entry for display, but must still count as N
    // so this figure reconciles with exportRunSummary.js's per-assignment-row counts_by_rank (the
    // T197 exit clause). A non-linked unit is exactly one row, so the two grains coincide there.
    entry.rowCount = (entry.rowCount ?? 0) + (isLinked ? unit.memberRows.length : 1)
  }

  // ORGANIZER RULING — the count belongs to the GROUP, not to a position in
  // the member list: carried on `members[0]` explicitly (data-driven) rather
  // than inferred by the consumer from array index, so a future re-sort of
  // `members` cannot silently move the printed count to the wrong row.
  return [...groupsByKey.values()].map(({ rowCount, members, ...entry }) => ({
    ...entry,
    count: rowCount,
    members: members.map((m, i) => (i === 0 ? { ...m, count: rowCount } : m)),
  }))
}
