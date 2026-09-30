// Moving/locking a camper inside a DRAFT elective run (T245, docs/adr/
// 2026-09-23-elective-run-lifecycle-and-remaining-slices.md decision (b)).
//
// Writes the SAME derived row the solver writes —
// deriveElectiveAssignmentId(run_id, camper_id, occurrence_id) — so a move is
// an ordinary per-field last-write-wins on one record, which the existing
// conflict machinery already serializes (D4). Same runAtomic/appendOp
// discipline and the same "refusals are returned, not thrown" convention as
// commitElectiveRun.js / finalizeElectiveRun.js.
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic, DELETE_FIELD } from './operations.js'
import { deriveElectiveAssignmentId, electiveChoiceLabelKey } from './electiveDerivedIds.js'
import { mapWithCollisions } from '../../src/ingest/mapWithCollisions.js'
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'
import { resolveOfferingCapacity } from './electiveOfferingCapacity.js'

/**
 * @returns {{ok:true, assignmentId:string|null, removed?:string}
 *  | {ok:false, error:'RUN_NOT_DRAFT'}
 *  | {ok:false, error:'OCCURRENCE_FULL', capacity:number, filled:number}
 *  | {ok:false, error:'INVALID_CAPACITY', activityId:string, setActivityId:string, message:string}
 *  | {ok:false, error:'CAMPER_INELIGIBLE'}
 *  | {ok:false, error:'ASSIGNMENT_NOT_FOUND'}
 *  | {ok:false, error:string}}
 */
export function setElectiveAssignment(db, {
  runId, camperId, occurrenceId, activityId, locked = false,
  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 3) — the
  // dangling-row picker's move/remove contract. Given, the source row named
  // by this id is tombstoned in the SAME transaction as the destination
  // write (a move), or is the ONLY thing this call does (a remove-only, see
  // the guard just below).
  replacesAssignmentId = null,
  authorUserId = null, deviceId,
}) {
  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  if (!run) return { ok: false, error: 'run not found' }
  if (run.status === 'final') return { ok: false, error: 'RUN_NOT_DRAFT' }

  // T320 item 3 — REMOVE-ONLY. occurrenceId/activityId both null with
  // replacesAssignmentId given means "remove the placement, no new
  // occurrence": short-circuits ALL destination validation below (there is
  // no destination), verifies ownership, and tombstones the row.
  if (occurrenceId == null && activityId == null && replacesAssignmentId != null) {
    const owned = db
      .prepare('SELECT run_id, camper_id FROM elective_assignments WHERE id = ?')
      .get(replacesAssignmentId)
    if (!owned || owned.run_id !== runId || owned.camper_id !== camperId) {
      return { ok: false, error: 'ASSIGNMENT_NOT_FOUND' }
    }
    try {
      runAtomic(db, () => {
        appendOp(db, {
          entity: 'elective_assignments', entity_id: replacesAssignmentId, field: DELETE_FIELD, value: 1,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        })
      })
    } catch (e) {
      return { ok: false, error: e.message }
    }
    return { ok: true, assignmentId: null, removed: replacesAssignmentId }
  }

  // A MOVE's source-row ownership check happens up front too, so a bad
  // replacesAssignmentId is refused before any destination write is even
  // validated — matching the remove-only branch's own posture.
  if (replacesAssignmentId != null) {
    const owned = db
      .prepare('SELECT run_id, camper_id FROM elective_assignments WHERE id = ?')
      .get(replacesAssignmentId)
    if (!owned || owned.run_id !== runId || owned.camper_id !== camperId) {
      return { ok: false, error: 'ASSIGNMENT_NOT_FOUND' }
    }
  }

  const occurrence = db.prepare('SELECT * FROM elective_occurrences WHERE id = ?').get(occurrenceId)
  // Plain string, not a machine code: an occurrence that does not exist at all
  // is an input-shape refusal with no director-facing action, per
  // finalizeElectiveRun.js's convention.
  if (!occurrence) return { ok: false, error: 'occurrence not found' }

  // ELIGIBILITY, AND WHAT IT DELIBERATELY DOES NOT COVER.
  //
  // buildElectiveAssignments' internal eligibility is `attends(camperId,
  // occurrenceId)` over an attendance map, built by
  // src/screens/elective/assignment/buildAttendance.js from the camper's
  // `division_label` matched against tier names, narrowed by `group_id`.
  //
  // CORRECTION (board item 9b). This comment used to say that fact "is never
  // persisted: `campers` has no division column, commitElectiveRun never writes
  // one, and campers.group_id is not populated on this path". All three clauses
  // are false and have been since v79: `campers` carries `division_label` and
  // `group_id`, commitElectiveRun writes both (`group_id: c.group_id ??
  // undefined, division_label: ...`), and both are registered in
  // electron/ops/projections.js's `campers` field list, so they materialize. A
  // camper's tier IS derivable here.
  //
  // This handler still does not need it, for a better reason than the one
  // above: the director DROPPED the camper into a specific occurrence, and
  // `elective_occurrences` carries `tier_id`. So `(occurrence_id, activity_id)`
  // names the bundle choice directly through `elective_choice_offerings` — see
  // the choice lookup below. No attendance map, and no inference.
  //
  // WHAT REMAINS UNCOVERED IS UNCHANGED, and is the part worth restating rather
  // than quietly dropping: CAMPER_INELIGIBLE here means the DB-derivable
  // eligibility ONLY — the camper is a participant of this run (has an
  // elective_preferences row for it), and the occurrence belongs to this run.
  // Division/tier attendance is NOT checked. Do not read this as a complete
  // eligibility check.
  if (occurrence.run_id !== runId) return { ok: false, error: 'CAMPER_INELIGIBLE' }
  const participant = db
    .prepare('SELECT 1 FROM elective_preferences WHERE run_id = ? AND camper_id = ? LIMIT 1')
    .get(runId, camperId)
  if (!participant) return { ok: false, error: 'CAMPER_INELIGIBLE' }

  // The (occurrence, activity) pair must be a confirmed offering of the
  // occurrence's set — the same `status ?? 'confirmed'` rule buildOfferings.js
  // applies. A plain string, not CAMPER_INELIGIBLE: nothing about the camper
  // is wrong, and there is no specific director action beyond surfacing it.
  const setActivity = db
    .prepare('SELECT * FROM elective_set_activities WHERE elective_set_id = ? AND activity_id = ?')
    .get(occurrence.elective_set_id, activityId)
  if (!setActivity || (setActivity.status ?? 'confirmed') !== 'confirmed') {
    return { ok: false, error: 'that activity is not a confirmed offering of this occurrence' }
  }

  // Refusals are RETURNED, never thrown (the JSDoc above and the ADR both
  // declare {ok:false, error:string} as the only failure shape). opaque()
  // throws on a malformed id component, so this call has to be wrapped or a
  // malformed camperId/occurrenceId rejects the IPC promise instead — the
  // same wrapping commitElectiveRun.js gives its own opaque('run_id', …).
  let assignmentId
  try {
    assignmentId = deriveElectiveAssignmentId(runId, camperId, occurrenceId)
  } catch (e) {
    return { ok: false, error: e.message }
  }

  // PROVENANCE OF THE ROW BEING OVERWRITTEN.
  //
  // A move lands on an existing SOLVER row (that is the point of the derived
  // id), so any field this write leaves alone keeps describing the PRE-MOVE
  // activity. choice_id/preference_rank are exactly that, and
  // getElectiveRunHandler returns preference_rank to every screen — so they
  // must be re-derived here, the same way commitElectiveRun's commit path
  // derives them: activity name -> electiveChoiceLabelKey -> the run's
  // matching elective_choices row -> that camper's rank for it.
  //
  // elective_choices.label holds the RAW label, so BOTH sides are
  // canonicalized before matching. Two choices in one run canonicalizing to
  // one key are AMBIGUOUS, and mapWithCollisions (the repo's existing shape
  // for exactly this, used by buildAttendance.js) makes an ambiguous key
  // structurally ABSENT rather than bound to whichever row came last: an
  // ambiguous match is no match — null choice, null rank — never a guessed
  // one.
  //
  // The two fields are INDEPENDENT, exactly as they are on the commit path:
  // choice_id names the choice the ACTIVITY belongs to (commitElectiveRun
  // takes it from the solver's labelKey), preference_rank is the CAMPER's rank
  // for it. So a manual placement into an activity this camper did not rank —
  // ordinary, and it must not fail — keeps the matched choice and carries a
  // null rank. Writing both null would give this handler's row a different
  // shape from the solver's, which is the one thing this write path may not do.
  //
  // BOARD ITEM 9b — THE OFFERING TABLE ANSWERS FIRST, and for a linked choice
  // it is the only thing that can.
  //
  // A bundle spanning two divisions produces one elective_choices row PER TIER,
  // all carrying the same label by construction (ADR D6). The label map below
  // therefore collided on every such bundle, `mapWithCollisions` correctly
  // refused to guess, and this handler wrote choice_id null AND preference_rank
  // null — silently, on every camp whose bundles span more than one division.
  // A director dragging a child watched their rank-1 answer go blank.
  //
  // `elective_choice_offerings` holds (choice_id, occurrence_id, activity_id)
  // for exactly those linked choices, and the director named an occurrence when
  // they dropped the camper — so the pair IDENTIFIES the choice rather than
  // narrowing it. Ties break to the lowest choice id, the same rule
  // commitElectiveRun's `bundleChoiceByLabelTier` and the engine's own
  // `choiceByLabelKey` use; two bundles transiently sharing a label and a tier
  // is the case ADR D7 names as possible pre-disambiguation.
  const offeredChoiceId = db
    .prepare('SELECT choice_id FROM elective_choice_offerings WHERE occurrence_id = ? AND activity_id = ? ORDER BY choice_id LIMIT 1')
    .get(occurrenceId, activityId)?.choice_id ?? null

  // THE LABEL FALLBACK, built ONLY from choices that have NO offering rows, and
  // ONLY when the lookup above came back empty.
  //
  // The exclusion is what makes this exact rather than merely usually-right.
  // commitElectiveRun is the sole writer of elective_choice_offerings (verified
  // across electron/, src/ and scripts/: mergeActivity rewrites activity_id on
  // existing rows and deleteElectiveRun removes them, neither creates one), and
  // it writes only the bundles' own choices. So "has an offering row" is
  // exactly "is a linked choice", and excluding those leaves a map over plain
  // choices, whose labels are unique per run by derivation. Without the
  // exclusion the two per-tier rows would still collide the key and the
  // fallback would still return null — the new lookup alone would only mask it
  // for the occurrences that happen to be members.
  //
  // `NOT EXISTS`, not `NOT IN`: correlated, so it can seek per candidate row
  // instead of materializing every run's offerings. This is the interactive
  // path — one director drag — and on the linked-choice case it now runs not at
  // all.
  // The NAME itself stays unconditional — an INVALID_CAPACITY refusal below
  // quotes it, so it is not part of the label fallback's cost.
  const activityName = db.prepare('SELECT name FROM activities WHERE id = ?').get(activityId)?.name
  const resolveByLabel = () => {
    if (!activityName) return null
    const { map: choiceIdByKey } = mapWithCollisions(
      db.prepare(`SELECT id, label FROM elective_choices c
                  WHERE c.run_id = ?
                    AND NOT EXISTS (SELECT 1 FROM elective_choice_offerings o WHERE o.choice_id = c.id)`).all(runId),
      (r) => electiveChoiceLabelKey(r.label),
      (r) => r.id
    )
    return choiceIdByKey.get(electiveChoiceLabelKey(activityName)) ?? null
  }
  const choiceId = offeredChoiceId ?? resolveByLabel()
  // T265 (v78): elective_preferences is now keyed per (day, period) cell, so
  // this lookup is scoped to THIS occurrence too. `LIMIT 1` stays — the
  // derived id's 4-tuple (run_id, camper_id, occurrence_id, choice_id) is the
  // full key, so at most one row can ever match this WHERE clause. That is
  // now PROVABLY safe rather than a latent bug: before occurrence_id existed
  // on this table, two per-cell preference rows for the same camper+choice
  // (a linked choice ranked differently per occurrence) would both match,
  // and LIMIT 1 would silently pick whichever SQLite returned first —
  // possibly the WRONG occurrence's rank. Scoping the WHERE clause is what
  // makes LIMIT 1 correct instead of merely convenient.
  const preferenceRank = choiceId == null
    ? null
    : db
      .prepare(
        'SELECT rank FROM elective_preferences WHERE run_id = ? AND camper_id = ? AND occurrence_id = ? AND choice_id = ? LIMIT 1'
      )
      .get(runId, camperId, occurrenceId, choiceId)?.rank ?? null

  // Capacity, resolved by the ONE helper the engine's offering builder uses
  // (electiveOfferingCapacity.js). An 'unlimited' offering is never checked.
  //
  // ('limited', NULL) — `unknownLimit` — is a MISCONFIGURED offering, not a
  // full one (owner ruling, T316 round 3): refused distinctly as
  // INVALID_CAPACITY, naming the offering the same way buildOfferings.js's
  // findBlankCapacities does, and never run through the `filled >= capacity`
  // comparison a made-up capacity of 0 would otherwise force.
  const capacityResult = resolveOfferingCapacity(setActivity)
  if (capacityResult.kind === 'unknownLimit') {
    return {
      ok: false,
      error: 'INVALID_CAPACITY',
      activityId,
      setActivityId: setActivity.id,
      message: `${activityName ? `"${activityName}"` : 'This offering'} is set to limited capacity but the number is blank — fill it in first.`,
    }
  }
  if (capacityResult.kind === 'limited') {
    const capacity = capacityResult.capacity
    // Generation-visible rows only, via the shared fragment, and EXCLUDING the
    // row being written: a move within the same occurrence must not count
    // itself as an occupant.
    const filled = db
      .prepare(
        `SELECT COUNT(*) c FROM elective_assignments a
          WHERE a.run_id = :runId AND a.occurrence_id = :occurrenceId
            AND a.activity_id = :activityId AND a.id != :assignmentId
            AND ${electiveGenerationVisibleFragment('a')}`
      )
      .get({ runId, occurrenceId, activityId, assignmentId, gen: run.solver_generation }).c
    if (filled >= capacity) return { ok: false, error: 'OCCURRENCE_FULL', capacity, filled }
  }

  try {
    runAtomic(db, () => {
      const fields = {
        run_id: runId,
        occurrence_id: occurrenceId,
        camper_id: camperId,
        activity_id: activityId,
        choice_id: choiceId,
        preference_rank: preferenceRank,
        source: 'manual',
        is_locked: locked ? 1 : 0,
        // Set at THIS write, from the run's current marker, and never touched
        // again by any other path (ADR decision (b) / Red Hat H3). What that
        // buys, exactly: the row stays VISIBLE across a regeneration by being
        // exempt from the generation predicate, rather than by having its
        // marker carried forward. As of T246 the row also SURVIVES a
        // regeneration on a device that has already merged the lock:
        // commitElectiveRun reads `is_locked = 1` before its transaction and
        // skips writing those derived ids entirely, so source/activity_id/
        // solver_generation are all left alone. A lock this device has NOT yet
        // merged is still overwritten with source:'solver' — pre-existing, and
        // T264's scope, not this write path's.
        solver_generation: run.solver_generation,
      }
      for (const [field, value] of Object.entries(fields)) {
        appendOp(db, {
          entity: 'elective_assignments', entity_id: assignmentId, field, value,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        })
      }
      // T320 item 3 — a genuine cross-occurrence MOVE (the destination id
      // differs from the source), inside the SAME transaction as the
      // destination write: either both land or neither does. Re-tombstoning
      // an already-deleted row on a retry is a no-op (idempotent), same
      // guarantee deleteElectiveRun.js's own doc comment states.
      if (replacesAssignmentId != null && replacesAssignmentId !== assignmentId) {
        appendOp(db, {
          entity: 'elective_assignments', entity_id: replacesAssignmentId, field: DELETE_FIELD, value: 1,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        })
      }
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  return { ok: true, assignmentId }
}
