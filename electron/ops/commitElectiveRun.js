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
    // T279 / ADR section 12.2a: the sentence must name each row's DIVISION
    // alongside its row number. The division is exactly what lets a director
    // say "those are two different kids" — the disambiguation evidence the
    // identity ruling rests on — and this message did not carry it, so a
    // director was told two rows collide and given nothing to tell them apart.
    const who = sameName
      .map((c) => {
        const divisions = (c.divisionLabels ?? []).filter(Boolean)
        const where = divisions.length > 0 ? `rows ${c.rowNumbers.join(', ')}: ${divisions.join(', ')}` : `rows ${c.rowNumbers.join(', ')}`
        return `${c.display_name} (${where})`
      })
      .join('; ')
    const noun = sameName.length === 1 ? 'camper name appears' : 'camper names appear'
    return (
      `${sameName.length} ${noun} on more than one row with no camper id to tell them apart: ${who}. ` +
      'Resolve these before importing — two children sharing a name would be merged into one record.'
    )
  }
  if (hasContradictoryRanks(parsed)) {
    return 'a camper holds the same preference rank twice — the sheet cannot be read unambiguously.'
  }
  // T265 (v78, docs/adr/2026-09-26-per-cell-elective-preferences.md) — a
  // preference is EITHER per (day, period) CELL or global to the whole run.
  //
  // ROUND 5 CORRECTION. Round 1 refused every preference with no
  // occurrence_id, reasoning that today's parser (src/ingest/preferenceSheet.js,
  // still out of scope) never emits one, so "absent" could only mean "the
  // parser couldn't extract it". Owner ruling corrects that premise: "we are
  // reading someone's data. we are not choosing how they import it" — a real
  // camp's whole-run ranked list ALSO has no occurrence_id, legitimately, and
  // this app must accept it rather than refuse it as if it were malformed.
  // So "absent" (null/undefined) is now accepted as the whole-run fallback
  // shape; only a MALFORMED occurrence_id — present, but not a non-empty
  // string — is still refused, because that is not "no occurrence given", it
  // is "a broken value was given". This check can only see the PARSED shape
  // (no run context), so it catches "malformed"; the in-transaction write
  // below is the backstop that also catches "a present occurrence_id names an
  // occurrence not in this run" — the two never disagree because a preview
  // and a commit both start from calling this same function.
  const malformedCell = (parsed?.preferences ?? []).find(
    (p) => p.occurrence_id != null && (typeof p.occurrence_id !== 'string' || p.occurrence_id.length === 0)
  )
  if (malformedCell) {
    return (
      `${malformedCell.camper_id ?? 'A camper'}’s ranked choices name a day/period reference this ` +
      'app cannot read. This sheet’s format isn’t supported yet, so there is nothing to fix on it ' +
      '— importing it would risk placing a camper on the wrong day, so this run is refused instead.'
    )
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
  //
  // THE RESIDUAL GAP, stated plainly. `is_locked = 1` is read from THIS
  // device's projection, so a lock that has not yet merged here is invisible
  // and its row is rewritten to source='solver' with the solver's activity
  // while `is_locked` stays 1 — no path in this file writes `is_locked`. That
  // mixed state is pre-existing: the write set before this change never wrote
  // `is_locked` either, so this ticket neither worsens it nor claims to fix it.
  // It is not closed here because closing it needs a mechanism nobody has
  // designed: the ADR's Red Hat H3 correction moved lock survival to the READ
  // side precisely to avoid depending on the regenerating device's local view
  // of which rows are locked, and this skip depends on exactly that view.
  const lockedRows = db
    .prepare('SELECT id, occurrence_id FROM elective_assignments WHERE run_id = ? AND is_locked = 1')
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
          // T279 / ADR section 12.2a — the deliberate PAIR. `group_id` is the
          // RESOLVED reference (null when the file's label matched no group of
          // this camp's, never a group invented from the file); `division_label`
          // is what the file actually said, verbatim. This function used to
          // write four fields and drop the division entirely, which is how 15 of
          // 33 probes lost it — and worse than a lost field, because the owner's
          // stable-identity ruling rests on a unit being attached, so discarding
          // it removed the evidence that ruling depends on.
          //
          // NEITHER IS WRITTEN UNCONDITIONALLY, and the reason is a regression
          // this ticket caused and the gate caught. `write` SKIPS an undefined
          // field, so `undefined` means "this import has nothing to say about
          // that column" while `null` means "assert emptiness" — and asserting
          // emptiness here is destructive:
          //
          //  group_id is ROSTER-OWNED. A camper already in Bunk Alpha, imported
          //  from a preference sheet whose division matched no group, had their
          //  group silently cleared by an unconditional `?? null` — an ordinary
          //  per-field LWW op that clobbers real group membership campwide.
          //  electiveRunOuterInheritance.integration.test.js caught it: the
          //  camper lost their group, so the inherited group-template cell could
          //  no longer be derived. A preference sheet may SET a group it
          //  resolved; it may never clear one it simply failed to resolve.
          //
          //  division_label is this import's own PROVENANCE, so an empty cell in
          //  a division column IS a fact worth recording — but only when the
          //  sheet HAS such a column. A sheet with no division column at all
          //  says nothing about the division, and must not erase what an earlier
          //  import recorded.
          group_id: c.group_id ?? undefined,
          division_label: c.division_label ?? (c.division_observed ? null : undefined),
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
        // Backstop for describeElectiveRunRefusal's "malformed" check above:
        // this also catches an occurrence_id that names a real string but not
        // one of THIS run's occurrences — describeElectiveRunRefusal cannot
        // see that (it has no run context), so this is the one place that
        // can. A NULL occurrence_id (the whole-run fallback, round 5) is
        // deliberately exempt: it names no occurrence to validate against,
        // and is legitimate regardless of which occurrences this run has.
        // deriveElectivePreferenceId's opaque() call is the last backstop for
        // a present-but-malformed occurrence_id reaching this far at all.
        if (p.occurrence_id != null && !occurrenceIds.has(p.occurrence_id)) {
          throw new Error(`preference names an occurrence not in this run: ${p.occurrence_id}`)
        }
        write(
          'elective_preferences',
          deriveElectivePreferenceId(runId, p.camper_id, p.occurrence_id ?? null, choiceId),
          {
            run_id: runId,
            camper_id: p.camper_id,
            // Explicitly `?? null`, never left `undefined`: `write()` skips an
            // undefined field entirely (see its own comment), which would
            // leave a fallback row's occurrence_id at whatever ensureExists's
            // placeholder inserted rather than actually recording NULL.
            occurrence_id: p.occurrence_id ?? null,
            choice_id: choiceId,
            rank: p.rank,
            // T279 (v79) / ADR section 4.2 — `rank` stays an integer; rank_kind
            // says what COMPARING two of them means. A grid cell is CHOSEN
            // ('cell-choice', rank 1 by construction), a "next 5 choices" list
            // is a ranked FALLBACK subordinate to the cells
            // ('ordered-fallback'), and a packed multi-value cell is an
            // 'unordered-set' with no ranking at all — a tie among equals, never
            // a ranking invented from cell order.
            rank_kind: p.rank_kind ?? null,
          }
        )
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
