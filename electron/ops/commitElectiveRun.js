// Committing a parsed preference sheet and a solved assignment into the
// participant tables (T196/T226, ADR docs/adr/2026-09-17-individual-elective-
// scheduling.md).
//
// Every write goes through appendOp, never a direct INSERT: that is what makes
// these rows replicate to the camp's other devices, and what backs Trash,
// Restore and entity history. A direct INSERT would produce rows that exist on
// one device and nowhere else, with no history — the failure mode the op log
// exists to prevent.
//
// The whole commit is ONE transaction. A part-written run is worse than no run:
// it would leave campers with no preferences, or preferences pointing at a run
// that has no assignments, and nothing downstream distinguishes that from a
// director who genuinely stopped half way.
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic } from './operations.js'
import {
  deriveElectiveChoiceId,
  deriveElectivePreferenceId,
  deriveElectiveAssignmentId,
  opaque,
} from './electiveDerivedIds.js'
import { hasContradictoryRanks } from '../../src/ingest/preferenceSheet.js'

const SOLVER_VERSION = 'buildElectiveAssignments@1'

/**
 * Why this commit would be refused, or null.
 *
 * Exported so a PREVIEW can say "this would be refused, and why" without
 * opening a transaction or a db at all (T226, scripts/preferenceSheetCli.js).
 * Preview and commit must never disagree about that, which is why this is one
 * function called from both rather than a second copy of the wording.
 */
export function describeElectiveRunRefusal(parsed) {
  const sameName = parsed?.sameNameCampers ?? []
  if (sameName.length > 0) {
    const who = sameName.map((c) => `${c.display_name} (rows ${c.rowNumbers.join(', ')})`).join('; ')
    const noun = sameName.length === 1 ? 'camper name appears' : 'camper names appear'
    return (
      `${sameName.length} ${noun} on more than one row with no camper id to tell them apart: ${who}. ` +
      'Resolve these before importing — two children sharing a name would be merged into one record.'
    )
  }
  if (hasContradictoryRanks(parsed)) {
    return 'a camper holds the same preference rank twice — the sheet cannot be read unambiguously.'
  }
  return null
}

/**
 * @returns {{ok: true, runId, counts, findings} | {ok: false, error}}
 */
export function commitElectiveRun(db, {
  campId,
  deviceId,
  authorUserId = null,
  name,
  sourceFilename = null,
  sourceSha256 = null,
  parsed,
  assignments = [],
  occurrences = [],
  scheduleWeekId = null,
  scheduleTemplateId = null,
  runId: providedRunId = null,
}) {
  // REFUSALS FIRST, before a transaction is opened.
  //
  // T226 found that a same-name collision does not merely duplicate a camper:
  // three rows naming one child produced ONE camper holding 75 preferences with
  // three different rank-1 choices. A solver handed that resolves it by taking
  // whichever it saw first — a silent decision about a real child's week. The
  // parser reporting the collision is not enough on its own; refusing to WRITE
  // it is what makes the report load-bearing.
  const refusal = describeElectiveRunRefusal(parsed)
  if (refusal) return { ok: false, error: refusal }

  // H1 — the renderer mints a runId per solve and derives elective_occurrences
  // ids against it BEFORE this handler ever runs (deriveOccurrences.js is
  // called in the render body). Minting a second, unrelated runId here would
  // orphan those already-derived occurrence ids from the run they claim to
  // belong to, and would make a retried commit of the same solve write a
  // SECOND run instead of hitting the same row. Validated with the same
  // opaque-id rule every other surrogate id component uses, rather than a
  // second alphabet -- a client-supplied key that reaches a derived id must
  // not carry free text.
  let runId
  try {
    runId = providedRunId != null ? opaque('run_id', providedRunId) : randomUUID()
  } catch (e) {
    return { ok: false, error: e.message }
  }

  // T244 round 2 — a finalized run is immutable (ADR decision (a): "no
  // reopen IPC exists"). This function used to write status:'draft'
  // UNCONDITIONALLY on every call, including a regeneration against an
  // existing runId. That is the exact H2 hazard in miniature: Device A
  // finalizes locally (status='final'); Device B, whose local copy never saw
  // A's write, legitimately regenerates its own still-draft copy — an
  // ordinary, unrelated action. Once merged, B's status='draft' op is an
  // ordinary per-field LWW write like any other, and if it happens to carry
  // a later timestamp than A's finalize, it silently overwrites 'final' back
  // to 'draft' campwide, with no error and no trace — worse than merely
  // stale, actively wrong. `status` is therefore only ever asserted here on
  // a run's FIRST commit (no existing row); a regeneration of an existing
  // run never touches it, so an already-'final' run stays 'final' through a
  // late-arriving regeneration op, and FINALIZED_AGAINST_STALE_GENERATION
  // (not a silently reverted status) is what surfaces the race to a
  // director.
  // The guard's correctness rests on an invariant held ABOVE this layer, so
  // name it rather than leave it implicit (Red Hat round 2, LOW): "a row
  // exists locally" stands in for "this is a regeneration, not a creation".
  // That holds because a device can only reach the regenerate action through
  // a run its own projection already materialized — the renderer mints
  // providedRunId once at first-solve time. If a future flow ever lets a
  // device commit against a providedRunId it has NOT locally synced (a
  // resume-from-shared-code path, a restore-then-continue), existingRun would
  // be null, status would be re-asserted as 'draft', and the reverted-status
  // hazard above comes straight back. A test pins that this is the deliberate
  // behaviour today, so the assumption breaks loudly rather than silently.
  const existingRun = providedRunId != null
    ? db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId)
    : null

  const camperIds = new Set((parsed?.campers ?? []).map((c) => c.id))
  const occurrenceIds = new Set(occurrences.map((o) => o.id))
  const choiceIdByKey = new Map()

  // The single distinct tier among occurrences, or null when the set's
  // occurrences span more than one tier (or there are none) — T229.
  const distinctTierIds = new Set(occurrences.map((o) => o.tier_id).filter((t) => t != null))
  const tierId = distinctTierIds.size === 1 ? [...distinctTierIds][0] : null

  // T244 round 2 (Red Hat HIGH, docs/adr/2026-09-23-elective-run-lifecycle-
  // and-remaining-slices.md D5/decision (b)): D5's marker existed only in
  // schema (T194/v66) until this fix — nothing ever wrote a non-null
  // solver_generation, so the shared generation-visibility predicate
  // (electiveGenerationPredicate.js) and the FINALIZED_AGAINST_STALE_
  // GENERATION detection it feeds (T244 decision (a)) could never fire
  // against a real commit, only against a hand-forged test row. This is the
  // generating device's stamp: ADR D5 names the generating device as the
  // stamper, and this is the one function that writes solver-produced rows.
  //
  // ONE marker per commit call, written to BOTH the run row and every
  // elective_assignments row this call writes, in the SAME transaction.
  // Both halves or neither is load-bearing, not incidental: the predicate is
  // `source='manual' OR solver_generation IS <run's current>` — stamping the
  // run alone while leaving assignment rows at their old value would
  // instantly hide every solver row this very commit just wrote, since they
  // would no longer match the run's new marker.
  //
  // Regeneration IS commitElectiveRun called again with the same
  // providedRunId (T199's flow). This naturally mints a NEW marker on the
  // run and on the newly-written rows every time, leaving the previous
  // generation's now-superseded solver rows behind, unchanged, at their old
  // marker — exactly D5's "stale rows are inert" behaviour, with no separate
  // re-stamp step required. T245/T246 must NOT re-add a re-stamp-on-
  // regeneration step: the ADR's decision (b)/Red Hat H3 correction deleted
  // that mechanism deliberately (see routeConflicts.js-adjacent history in
  // the ADR) — a locked/manual row survives regeneration by being EXEMPT
  // from the generation predicate (source='manual'), never by having its
  // marker carried forward.
  const solverGeneration = randomUUID()

  // T246 — LOCKED ROWS ARE READ-ONLY TO THIS PASS. A regeneration used to
  // write `source:'solver'` over the derived row a director had locked
  // (setElectiveAssignment writes source:'manual', is_locked:1 to the SAME
  // derived id), which removed that row's `source='manual'` exemption in
  // electiveGenerationPredicate.js: the lock stayed visible but did not
  // survive. Skipping the write entirely — no field, INCLUDING
  // solver_generation, which the ADR's Red Hat H3 correction forbids
  // re-stamping — is what makes a lock survive.
  //
  // This is also the belt-and-braces for H3's own hazard: a lock written on
  // ANOTHER device that this device has not yet synced is invisible to the
  // renderer that produced `assignments`, so `assignments` may well carry a
  // solver placement for a (camper, occurrence) that is locked here. The skip
  // is decided from the local projection at commit time, not from the caller.
  const lockedRows = db
    .prepare('SELECT id, camper_id, occurrence_id, activity_id FROM elective_assignments WHERE run_id = ? AND is_locked = 1')
    .all(runId)

  // DANGLING_MANUAL_ASSIGNMENT, detection only — no auto-repair, no throw; the
  // commit completes around it and a director acts via T245's move/lock IPC.
  // Checked on `source='manual'`, the SUPERSET of locked rows: the ticket's
  // prose says "locked row" in one sentence and "any manual row" in the next,
  // and it is the manual EXEMPTION from the generation predicate that creates
  // the hazard — a manual row pointing at an occurrence a template edit
  // removed stays visible forever with nothing to anchor it to.
  const findings = db
    .prepare("SELECT id, camper_id, occurrence_id FROM elective_assignments WHERE run_id = ? AND source = 'manual'")
    .all(runId)
    .filter((r) => !occurrenceIds.has(r.occurrence_id))
    .map((r) => ({
      kind: 'DANGLING_MANUAL_ASSIGNMENT',
      assignment_id: r.id,
      camper_id: r.camper_id,
      occurrence_id: r.occurrence_id,
      message:
        'A placement made by hand sits in a period this schedule no longer has, so nobody will see ' +
        'it on the grid \u2014 move it to a period that still exists, or remove it.',
    }))

  // A dangling row is outside this pass's occurrence set, so it is excluded
  // from the protected set too — nothing this commit writes could reach it.
  const protectedIds = new Set(
    lockedRows.filter((r) => occurrenceIds.has(r.occurrence_id)).map((r) => r.id)
  )

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

      write('elective_assignment_runs', runId, {
        camp_id: campId,
        schedule_week_id: scheduleWeekId,
        schedule_template_id: scheduleTemplateId,
        tier_id: tierId,
        name,
        // Only asserted on first creation — see the comment above
        // existingRun's declaration. `write` already skips undefined values.
        status: existingRun ? undefined : 'draft',
        source_filename: sourceFilename,
        source_sha256: sourceSha256,
        solver_version: SOLVER_VERSION,
        solver_generation: solverGeneration,
      })

      for (const occ of occurrences) {
        write('elective_occurrences', occ.id, {
          run_id: runId,
          elective_set_id: occ.elective_set_id,
          day_id: occ.day_id,
          time_block_id: occ.time_block_id,
          tier_id: occ.tier_id,
        })
      }

      for (const c of parsed.campers ?? []) {
        write('campers', c.id, {
          camp_id: campId,
          display_name: c.display_name,
          external_id: c.external_id ?? null,
          is_active: 1,
        })
      }

      for (const ch of parsed.choices ?? []) {
        const id = deriveElectiveChoiceId(runId, ch.labelKey)
        choiceIdByKey.set(ch.labelKey, id)
        write('elective_choices', id, { run_id: runId, label: ch.label, is_linked: 0 })
      }

      for (const p of parsed.preferences ?? []) {
        const choiceId = choiceIdByKey.get(p.labelKey)
        if (!choiceId) throw new Error(`preference names a choice the sheet did not list: ${p.labelKey}`)
        write('elective_preferences', deriveElectivePreferenceId(runId, p.camper_id, choiceId), {
          run_id: runId, camper_id: p.camper_id, choice_id: choiceId, rank: p.rank,
        })
      }

      for (const a of assignments) {
        // A solver output naming a camper the sheet never contained means the
        // two halves disagree; committing it would create an assignment row
        // pointing at nothing, which no screen can render and no export can
        // explain. Fail the whole run instead.
        if (!camperIds.has(a.camper_id)) {
          throw new Error(`assignment names a camper the sheet did not contain: ${a.camper_id}`)
        }
        // Same discipline: the two halves (occurrences derived from the
        // schedule, assignments from the solver) must agree, or the whole
        // run fails rather than writing an assignment pointing at nothing.
        if (!occurrenceIds.has(a.occurrence_id)) {
          throw new Error(`assignment names an occurrence not in this run: ${a.occurrence_id}`)
        }
        const assignmentId = deriveElectiveAssignmentId(runId, a.camper_id, a.occurrence_id)
        // The locked row keeps its source, its activity and its marker — see
        // protectedIds above.
        if (protectedIds.has(assignmentId)) continue
        write('elective_assignments', assignmentId, {
          run_id: runId,
          occurrence_id: a.occurrence_id,
          camper_id: a.camper_id,
          activity_id: a.activity_id,
          choice_id: choiceIdByKey.get(a.labelKey) ?? null,
          preference_rank: a.preference_rank ?? null,
          source: 'solver',
          solver_generation: solverGeneration,
        })
      }
    })
  } catch (e) {
    // The transaction rolled back; nothing was written.
    return { ok: false, error: e.message }
  }

  return {
    ok: true,
    runId,
    counts: {
      campers: parsed.campers?.length ?? 0,
      choices: parsed.choices?.length ?? 0,
      preferences: parsed.preferences?.length ?? 0,
      assignments: assignments.length,
    },
    // Run-level state, returned for the run's own screen (T250) — NOT a
    // schedule finding, and never routed into the schedule findings
    // vocabulary (ADR 2026-09-24 amendment).
    findings,
  }
}
