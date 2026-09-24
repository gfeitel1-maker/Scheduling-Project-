// Finalizing an elective run: draft -> final (T244, docs/adr/2026-09-23-
// elective-run-lifecycle-and-remaining-slices.md decision (a)).
//
// Every write goes through appendOp inside ONE transaction, same discipline
// as commitElectiveRun.js — a part-written finalize (status flipped, no
// snapshot; or snapshot written, status still draft) is worse than no
// finalize at all.
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic } from './operations.js'
import { deriveElectiveRunOuterSnapshotId } from './deriveElectiveRunOuterSnapshotId.js'
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'
import { deriveOccurrences } from '../../src/screens/elective/assignment/deriveOccurrences.js'
import { findRouteConflicts } from '../../src/engine/routeConflicts.js'

// Maps a raw template_slots row into the shape findRouteConflicts/buildSchedule
// expect (src/engine/routeConflicts.js), keyed off the same mutually-exclusive
// column group projections.js already enforces (elective_set_id / event_id /
// is_anchor+anchor_id / activity_id).
function mapTemplateSlot(row) {
  const base = { groupId: row.group_id, cohort_id: null, dayId: row.day_id, blockId: row.time_block_id }
  if (row.elective_set_id != null) return { ...base, type: 'elective', electiveSetId: row.elective_set_id }
  if (row.event_id != null) return { ...base, type: 'event', eventId: row.event_id }
  if (row.is_anchor) return { ...base, type: 'anchor', anchorId: row.anchor_id }
  if (row.activity_id != null) return { ...base, type: 'activity', activityId: row.activity_id }
  return { ...base, type: null }
}

/**
 * @returns {{ok:true, finalizedAt:string, snapshotRows:number}
 *  | {ok:false, error:'ALREADY_FINAL'}
 *  | {ok:false, error:'STALE_OUTER_SCHEDULE', findings:Array}
 *  | {ok:false, error:'OUTER_RESOURCE_CONFLICT', findings:Array}
 *  | {ok:false, error:string}}
 */
export function finalizeElectiveRun(db, { runId, authorUserId = null, deviceId }) {
  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  if (!run) return { ok: false, error: 'run not found' }
  if (run.status === 'final') return { ok: false, error: 'ALREADY_FINAL' }

  const recordedOccurrences = db.prepare('SELECT * FROM elective_occurrences WHERE run_id = ?').all(runId)
  if (recordedOccurrences.length === 0) return { ok: false, error: 'run has no assignments' }

  // 1. Re-derive occurrences live from template_slots and diff against what
  // the run recorded (deriveOccurrences.js — the same pure derivation the
  // renderer's generation path already uses). Grouped by the run's distinct
  // elective_set_ids, since a run may span more than one set.
  const setIds = [...new Set(recordedOccurrences.map((o) => o.elective_set_id).filter((x) => x != null))]
  const groups = db.prepare('SELECT id, tier_id FROM groups').all()
  const liveOccurrences = []
  for (const setId of setIds) {
    const slots = db
      .prepare('SELECT * FROM template_slots WHERE elective_set_id = ? AND template_id = ?')
      .all(setId, run.schedule_template_id)
    const { templates } = deriveOccurrences({ slots, groups, electiveSetId: setId, runId })
    liveOccurrences.push(...(templates[run.schedule_template_id]?.occurrences ?? []))
  }
  const recordedIds = new Set(recordedOccurrences.map((o) => o.id))
  const liveIds = new Set(liveOccurrences.map((o) => o.id))
  const staleFindings = []
  for (const id of recordedIds) {
    if (!liveIds.has(id)) staleFindings.push({ kind: 'OCCURRENCE_REMOVED', occurrenceId: id })
  }
  for (const id of liveIds) {
    if (!recordedIds.has(id)) staleFindings.push({ kind: 'OCCURRENCE_ADDED', occurrenceId: id })
  }
  if (staleFindings.length > 0) return { ok: false, error: 'STALE_OUTER_SCHEDULE', findings: staleFindings }

  // 2. routeConflicts over the live schedule state, scoped to the day/block
  // cells this run's occurrences touch — reused unmodified (src/engine/
  // routeConflicts.js), never forked.
  const cellKeys = new Set(recordedOccurrences.map((o) => `${o.day_id}|${o.time_block_id}`))
  const scopedSlots = []
  if (run.schedule_template_id != null) {
    const rows = db.prepare('SELECT * FROM template_slots WHERE template_id = ?').all(run.schedule_template_id)
    for (const row of rows) {
      if (cellKeys.has(`${row.day_id}|${row.time_block_id}`)) scopedSlots.push(mapTemplateSlot(row))
    }
  }
  const conflicts = findRouteConflicts({
    slots: scopedSlots,
    activities: db.prepare('SELECT * FROM activities').all(),
    anchors: db.prepare('SELECT * FROM anchor_activities').all(),
    electiveSetActivities: db.prepare('SELECT * FROM elective_set_activities').all(),
    events: db.prepare('SELECT * FROM events').all(),
    locations: db.prepare('SELECT * FROM locations').all(),
  })
  if (conflicts.length > 0) return { ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: conflicts }

  // 3. Build the snapshot rows: one per generation-visible elective_assignments
  // row this run holds today, at the (camper, day, time_block) its occurrence
  // resolves to. day_id/time_block_id are NOT NULL on the snapshot table
  // (schema.sql) — deriveOccurrences already skips any placement missing
  // either (INCOMPLETE_PLACEMENT), so a live-matching occurrence always has
  // both; skip-and-report defensively rather than let a stray row crash the
  // whole finalize.
  const assignmentRows = db
    .prepare(
      `SELECT a.camper_id, a.activity_id, o.day_id, o.time_block_id
         FROM elective_assignments a
         JOIN elective_occurrences o ON o.id = a.occurrence_id
        WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}`
    )
    .all({ runId, gen: run.solver_generation })

  const activityById = new Map(db.prepare('SELECT * FROM activities').all().map((a) => [a.id, a]))
  const locationById = new Map(db.prepare('SELECT * FROM locations').all().map((l) => [l.id, l]))

  const snapshots = []
  const skipped = []
  for (const row of assignmentRows) {
    if (row.day_id == null || row.time_block_id == null) {
      skipped.push({ camperId: row.camper_id, reason: 'missing day_id or time_block_id' })
      continue
    }
    const activity = activityById.get(row.activity_id) ?? null
    const location = activity?.location_id != null ? locationById.get(activity.location_id) ?? null : null
    snapshots.push({
      id: deriveElectiveRunOuterSnapshotId(runId, row.camper_id, row.day_id, row.time_block_id),
      camper_id: row.camper_id,
      day_id: row.day_id,
      time_block_id: row.time_block_id,
      activity_id: row.activity_id,
      activity_name: activity?.name ?? null,
      location_id: activity?.location_id ?? null,
      location_name: location?.name ?? null,
      span_blocks: activity?.span_blocks ?? null,
      solver_generation: run.solver_generation,
    })
  }

  const finalizedAt = new Date().toISOString()

  try {
    runAtomic(db, () => {
      const write = (entity, entity_id, fields) => {
        for (const [field, value] of Object.entries(fields)) {
          if (value === undefined) continue
          appendOp(db, {
            entity, entity_id, field, value,
            author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
          })
        }
      }
      for (const s of snapshots) {
        write('elective_run_outer_snapshots', s.id, {
          run_id: runId,
          camper_id: s.camper_id,
          day_id: s.day_id,
          time_block_id: s.time_block_id,
          activity_id: s.activity_id,
          activity_name: s.activity_name,
          location_id: s.location_id,
          location_name: s.location_name,
          span_blocks: s.span_blocks,
          solver_generation: s.solver_generation,
        })
      }
      write('elective_assignment_runs', runId, {
        status: 'final',
        finalized_at: finalizedAt,
        finalized_by: authorUserId,
      })
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  return { ok: true, finalizedAt, snapshotRows: snapshots.length }
}
