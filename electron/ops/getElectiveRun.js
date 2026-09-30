// T198 — extracted verbatim from electron/main.js's getElectiveRunHandler (below its
// auth/arg validation, which stays in the IPC handler). See electron/ops/electiveRunProjectionInput.js
// for the one place this and getElectiveRunOuterSchedule are combined into a machine-access
// projection; do not re-derive any of this a second time there.
import { coordinateOf } from '../../src/ingest/preferenceCoordinateKeys.js'
import { resolveOfferingCapacity } from './electiveOfferingCapacity.js'
import { computeFinalizedAgainstStaleGeneration } from './finalizedAgainstStaleGeneration.js'
import {
  electiveGenerationVisibleFragment,
  electiveGenerationStaleSolverFragment,
} from './electiveGenerationPredicate.js'
// T320 (docs/adr/2026-09-30-elective-run-durability.md items 1, 2, 4).
import { computeSnapshotCompleteness } from './electiveRunSnapshotCompleteness.js'
import {
  buildDanglingManualAssignmentFinding,
  danglingOccurrenceMissingOrUnusableFragment,
} from './danglingManualAssignmentFinding.js'
import { computeElectiveRunResourceConflicts } from './electiveRunResourceConflicts.js'

// The review payload: one row per placement, with the camper's name and the
// rank they got, which is what a director actually reads.
//
// T244 (docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
// decision (a)/MEDIUM-4/H2/H3): this now returns an OBJECT, not a bare
// array. Verified callers at the time of this change: src/localClient.js
// (passthrough) and its mock — no UI consumed the bare array yet, so this
// is a safe shape change, but both were updated in the same commit as this
// handler so browser-dev does not build against a lie.
//
//   rows: today's placement rows, filtered by the shared generation-
//     visibility predicate (electiveGenerationPredicate.js) — the ONE
//     fragment every reader of elective_assignments must use, per
//     MEDIUM-4, so the UI and a later export handler (T248) can never
//     silently disagree about which rows are current.
//   staleCount: COUNT of solver-produced rows the predicate's inverse
//     excludes — "N stale placements exist, regenerate."
//   finalizedAgainstStaleGeneration: true iff this run is final AND its
//     CURRENT solver_generation no longer matches the generation recorded
//     on its own snapshot rows (the H2 fix — a later-merged regeneration
//     from another device can silently invalidate an already-exported,
//     supposedly-immutable final run). Defined explicitly for the
//     no-snapshot-rows case: nothing to be stale against, so false. A
//     draft run (not yet finalized) is also false — there is no snapshot
//     generation to compare against yet.
//   overCapacityOccurrences: a post-merge OVER_CAPACITY-class finding
//     (residual of Red Hat H3 — see the ADR's decision (b)). Two
//     independently-valid unlocked placements from two devices can jointly
//     overbook one (occurrence, activity) offering with no per-field
//     conflict to catch it, since deriveElectiveAssignmentId includes
//     camper_id and the two rows never collide. Grouped by
//     (occurrence_id, activity_id) rather than the ticket's literal
//     occurrence_id-only wording — DELIBERATE DEVIATION, Governor decision:
//     elective_occurrences carries no capacity column at all; capacity is
//     per (elective_set, activity) on elective_set_activities, so a bare
//     occurrenceId/capacity/filled tuple is not attributable to anything a
//     director can act on. This is a superset of the ticket's declared
//     shape (adds activityId), not a narrower one. capacity_mode is the
//     authority (schema.sql): 'unlimited' offerings are never checked, and
//     'limited' with a NULL capacity_limit is skipped rather than treated
//     as a fabricated capacity. T316 now emits INVALID_CAPACITY for that
//     ('limited', NULL) case at GENERATION time (buildOfferings.js's
//     findBlankCapacities, surfaced by AssignmentPanel, which refuses to
//     solve while one exists) — a director sees it before a run is ever
//     committed. This READ path's own skip stays silent. It is NOT true
//     that a blocked solve is the only gate standing between a director and
//     this case — that closes the write paths this build controls, not
//     every way a row can land in elective_assignments. Known ways to
//     reach this skip: a run committed before T316; a capacity blanked
//     again after committing; and a row arriving via an Automerge merge
//     from another device — projectAll/PROJECTIONS (electron/automerge/
//     projector.js, driven from syncNode.js's merge path, A.merge then
//     projectAll) writes elective_assignments and elective_set_activities
//     straight into SQLite from document state and never passes through
//     setElectiveAssignment.js's capacity guard, so a peer running an
//     older build (or one that merged before this offering was blanked)
//     can introduce the same overflow here. Fixing any of these is out of
//     this ticket's scope; this comment records that the list is open
//     rather than claiming it is closed.

export function getElectiveRun(db, { runId }) {

  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  const gen = run?.solver_generation ?? null

  const rows = db
    .prepare(
      // T250: source/is_locked are additive — the Draft screen's move/lock
      // table cannot render a lock state it is never told about.
      // T297 adds a.choice_id: an edit has to name the preference row that
      // produced a placement, and the CHOICE is the only link between the two
      // (an assignment names an activity, a preference names a choice).
      `SELECT a.id, a.occurrence_id, a.camper_id, a.activity_id, a.preference_rank,
              a.source, a.is_locked, a.choice_id,
              c.display_name AS camper_name
         FROM elective_assignments a
         LEFT JOIN campers c ON c.id = a.camper_id
        WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}
        ORDER BY a.occurrence_id, c.display_name`
    )
    .all({ runId, gen })

  const staleCount = db
    .prepare(
      `SELECT COUNT(*) c FROM elective_assignments a
        WHERE a.run_id = :runId AND ${electiveGenerationStaleSolverFragment('a')}`
    )
    .get({ runId, gen }).c

  // T296: the run's own occurrence rows, so a screen can name a placement's
  // day and period. The renderer's `occurrences` are AssignmentPanel React
  // state set only by a fresh solve, so a run reopened from the run list had
  // none and every occurrence label degraded to a raw id (runStateCopy.js's
  // occurrenceLabel documents that degradation).
  //
  // NOT generation-filtered, and that is deliberate rather than an oversight.
  // Nothing in electron/ deletes an elective_occurrences row, so this table
  // accumulates the union of every generation's occurrences — the same fact
  // that makes a DB-derived DANGLING_MANUAL_ASSIGNMENT check unsound
  // (AssignmentPanel's note). The difference is the use: a consumer LOOKS UP
  // the occurrence named by an assignment row it already has, so a superseded
  // row it never asks for is inert. Anything needing the exact CURRENT
  // occurrence set must not read this list as that set.
  const occurrences = db
    .prepare(
      `SELECT id, elective_set_id, day_id, time_block_id, tier_id
         FROM elective_occurrences WHERE run_id = ? ORDER BY id`
    )
    .all(runId)

  // T297 — THE RUN'S PREFERENCES, in the shape the engine already reads.
  //
  // Without this a re-solve could only run from `parsed.preferences`, the
  // sheet held in AssignmentPanel React state — so an edit written to the
  // database had no effect on the next solve at all, and the ticket's "change
  // it and re-solve" loop was unreachable however correct the write was.
  //
  // buildElectiveAssignments reads camper_id/choice_id/occurrence_id/rank and
  // resolvePreferenceCoordinates reads `coordinate`, so the two coordinate
  // COLUMNS are folded back into the one object property those readers expect.
  // Both legs null (a whole-run fallback row) yields `coordinate: null`, which
  // is what resolvePreferenceCoordinates treats as "no cell" — an object with
  // two null legs would be a coordinate that names nothing.
  const preferences = db
    .prepare(
      `SELECT id, camper_id, choice_id, occurrence_id, rank, rank_kind,
              coordinate_day_label, coordinate_period_label
         FROM elective_preferences WHERE run_id = ? ORDER BY id`
    )
    .all(runId)
    .map((p) => ({
      // The id is what an EDIT names: setElectivePreference's
      // replacesPreferenceId inherits that row's scope.
      id: p.id,
      camper_id: p.camper_id,
      choice_id: p.choice_id,
      occurrence_id: p.occurrence_id,
      rank: p.rank,
      rank_kind: p.rank_kind,
      coordinate: coordinateOf(p),
    }))

  // T297 — the run's CHOICES, which is the vocabulary an edit is expressed in.
  // A preference names a choice, and a run's choices are the labels its sheet's
  // population actually asked for, so these are what the director picks from.
  // `label` is the RAW label off the sheet, deliberately: the director has to
  // recognise the word the camper wrote.
  const choices = db
    .prepare('SELECT id, label, is_linked FROM elective_choices WHERE run_id = ? ORDER BY label')
    .all(runId)

  // Shared with getElectiveRunOuterScheduleHandler (T248) — see
  // electron/ops/finalizedAgainstStaleGeneration.js.
  const finalizedAgainstStaleGeneration = computeFinalizedAgainstStaleGeneration(db, run)

  const capacityRows = db
    .prepare(
      `SELECT a.occurrence_id, a.activity_id, o.elective_set_id, COUNT(*) AS filled
         FROM elective_assignments a
         JOIN elective_occurrences o ON o.id = a.occurrence_id
        WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}
        GROUP BY a.occurrence_id, a.activity_id`
    )
    .all({ runId, gen })
  const overCapacityOccurrences = []
  for (const row of capacityRows) {
    const setActivity = db
      .prepare('SELECT capacity_mode, capacity_limit FROM elective_set_activities WHERE elective_set_id = ? AND activity_id = ?')
      .get(row.elective_set_id, row.activity_id)
    if (!setActivity) continue
    // T245: one shared resolution of the capacity columns
    // (electron/ops/electiveOfferingCapacity.js). Behaviour here is
    // unchanged — 'unlimited' is never checked, and 'limited' + NULL
    // capacity_limit ('unknownLimit') is still skipped rather than
    // fabricated. T316 surfaces this case at generation time instead (see
    // the block comment above); this read path is untouched and stays
    // silent for it.
    const resolved = resolveOfferingCapacity(setActivity)
    if (resolved.kind !== 'limited') continue
    if (row.filled > resolved.capacity) {
      overCapacityOccurrences.push({
        occurrenceId: row.occurrence_id,
        activityId: row.activity_id,
        capacity: resolved.capacity,
        filled: row.filled,
      })
    }
  }

  // T250 A0.2 — every camper this run has a preference OR an assignment for,
  // group name resolved so a director-facing view can label a camper without
  // a second lookup. Feeds both the cold-regenerate roster (A3) and the
  // same-name disambiguator (B3).
  //
  // KNOWN GAP, named rather than silently absorbed: a camper who was in the
  // original sheet with NEITHER a preference nor an assignment row on this
  // run is not in this set. No schema change closes that — there is no table
  // recording "considered for this run" independent of a preference or a
  // placement — so this stays an open gap rather than an invented column.
  const campers = db
    .prepare(
      `SELECT DISTINCT c.id, c.display_name, c.division_label, c.group_id, c.external_id, c.is_unattributed, g.name AS group_name
         FROM campers c LEFT JOIN groups g ON g.id = c.group_id
        WHERE c.id IN (
          SELECT camper_id FROM elective_preferences WHERE run_id = ?
          UNION
          SELECT camper_id FROM elective_assignments WHERE run_id = ?
        )`
    )
    .all(runId, runId)

  // T320 item 2 — DURABLE DANGLING-ASSIGNMENT DERIVATION, replacing the
  // session-scoped commit-response read as the source of truth. A manual row
  // whose occurrence commitElectiveRun's prune already removed (item 2) is
  // findable on ANY read, including a cold reopen — the whole point of this
  // item. Same finding shape/message as the commit-time detection (shared
  // via buildDanglingManualAssignmentFinding, so wording cannot drift).
  const danglingFindings = db
    .prepare(
      `SELECT a.id, a.camper_id, a.occurrence_id
         FROM elective_assignments a
        WHERE a.run_id = :runId AND a.source = 'manual'
          AND ${danglingOccurrenceMissingOrUnusableFragment('a')}`
    )
    .all({ runId })
    .map(buildDanglingManualAssignmentFinding)

  // T320 item 4 — eligibility findings persisted at commit time, filtered to
  // THIS run's CURRENT solver generation (not pruned on regeneration, unlike
  // occurrences — filtered by generation at read time instead, per the ADR's
  // item 4 "deliberate asymmetry" note).
  const eligibilityFindings = db
    .prepare('SELECT kind, camper_id, choice_id, occurrence_id, message FROM elective_run_findings WHERE run_id = ? AND solver_generation = ?')
    .all(runId, gen)

  // T320 item 4 — resource conflicts computed LIVE for a draft run (the same
  // findRouteConflicts call finalizeElectiveRun.js already makes, one point
  // earlier in the lifecycle); a FINAL run's bucket is provably empty by
  // construction (the finalize gate already refused any run that would have
  // had one), so this skips the call entirely rather than paying its cost
  // for an already-known answer.
  const resourceConflicts = run?.status === 'final' ? [] : computeElectiveRunResourceConflicts(db, run ?? {}, occurrences)

  return {
    rows, staleCount, finalizedAgainstStaleGeneration, overCapacityOccurrences, occurrences,
    preferences, choices, campers, danglingFindings, eligibilityFindings, resourceConflicts,
    // T320 item 1 — cross-handler parity with getElectiveRunOuterSchedule.js:
    // the SAME computeSnapshotCompleteness call.
    ...computeSnapshotCompleteness(db, run),
  }
}
