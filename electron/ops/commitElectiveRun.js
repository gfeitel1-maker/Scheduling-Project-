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
// isHumanDeleted is the SAME predicate ingest.js's rejectedSlotKeys uses — see
// its definition for why the `=== 'human'` cannot be relaxed to a null check.
import { isHumanOwned, isHumanDeleted } from './fieldProvenance.js'
import {
  deriveElectiveChoiceId,
  deriveElectivePreferenceId,
  deriveElectiveAssignmentId,
  opaque,
} from './electiveDerivedIds.js'
import { hasContradictoryRanks } from '../../src/ingest/preferenceSheet.js'
// T301 slice 3 (docs/adr/2026-09-29-linked-elective-bundles.md D6/D10) — the
// SAME derivation solve-time uses, reused here rather than re-implemented:
// bundles are re-derived fresh at commit time too, never trusted from a
// stale write (D5's own reasoning, one seam over — a second hand-rolled
// scope-resolution would drift from the tested one). electron/ importing a
// pure module from src/ is already established in this exact file family
// (electiveDerivedIds.js, one line above, imports src/ingest/preview.js) —
// not a packaging-boundary exception, since src/ ships in electron-builder's
// `files` list.
import { deriveChoices } from '../../src/screens/elective/assignment/deriveChoices.js'

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
  const camperById = new Map((parsed?.campers ?? []).map((c) => [c.id, c]))

  // T301 slice 3 (ADR D6) — authored bundles for this run's own elective
  // set(s), re-derived fresh via deriveChoices exactly as AssignmentPanel.jsx
  // does at solve time (D10: never trust a stale definition). Read-only, so
  // it happens before the transaction like existingRun/lockedRows/findings
  // above. `occurrences` carries elective_set_id per row (deriveOccurrences.js's
  // own shape); a commit is always for one elective set's run in practice, but
  // this reads whichever set(s) are actually present rather than assuming one.
  const electiveSetIds = [...new Set(occurrences.map((o) => o.elective_set_id).filter((id) => id != null))]
  const bundleRows = electiveSetIds.length === 0 ? [] : db
    .prepare(`SELECT * FROM elective_bundles WHERE elective_set_id IN (${electiveSetIds.map(() => '?').join(',')})`)
    .all(...electiveSetIds)
  const bundleIds = bundleRows.map((b) => b.id)
  const bundlePeriodRows = bundleIds.length === 0 ? [] : db
    .prepare(`SELECT * FROM elective_bundle_periods WHERE bundle_id IN (${bundleIds.map(() => '?').join(',')})`)
    .all(...bundleIds)
  const bundleTierRows = bundleIds.length === 0 ? [] : db
    .prepare(`SELECT * FROM elective_bundle_tiers WHERE bundle_id IN (${bundleIds.map(() => '?').join(',')})`)
    .all(...bundleIds)
  const { choices: bundleChoices, choiceOfferings: bundleChoiceOfferings } = deriveChoices({
    bundles: bundleRows, bundlePeriods: bundlePeriodRows, bundleTiers: bundleTierRows, occurrences, runId,
  })

  // D6 — labelKey -> tierId -> bundle choice id. A label at least one bundle
  // claims (for at least one tier) mints NO plain elective_choices row below;
  // a camper's sheet preference for that label resolves to the entry for
  // THEIR OWN tier instead. Two bundles transiently sharing both a label AND
  // a tier (D7 names this as possible pre-disambiguation) tie-break to the
  // lowest choice id — the same rule the engine's own choiceByLabelKey uses.
  const bundleChoiceByLabelTier = new Map()
  for (const c of [...bundleChoices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!bundleChoiceByLabelTier.has(c.labelKey)) bundleChoiceByLabelTier.set(c.labelKey, new Map())
    const byTier = bundleChoiceByLabelTier.get(c.labelKey)
    if (!byTier.has(c.tier_id)) byTier.set(c.tier_id, c.id)
  }
  // A camper's own tier (D6: campers.group_id -> groups.tier_id, both already
  // stored). Read once, not per-camper — groups is camp-wide and small.
  const tierIdByGroupId = new Map(db.prepare('SELECT id, tier_id FROM groups').all().map((g) => [g.id, g.tier_id]))

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

  // T297 — PREFERENCES A DIRECTOR HAS EDITED ARE PRESERVED, AND SAID OUT LOUD.
  //
  // Four behaviours were available for a re-import meeting a hand-edited
  // preference and only one of them is allowed: overwrite it (a director's
  // decision discarded without being told — the defect class this program
  // exists to remove), preserve it silently (the same loss in the other
  // direction: the import reports success while quietly declining to apply the
  // file), refuse the whole file (one edited row blocking two hundred good
  // ones), or PRESERVE IT AND REPORT IT. The last is what ingest.js already
  // does for hand-edited entity fields under Policy A, so this is the house
  // rule rather than a new one.
  //
  // What the ticket does NOT decide, and this deliberately leaves open: what
  // the director should then be able to DO about the disagreement. That is the
  // whole-file merge strategy T297 explicitly is not. All this owes is that the
  // row is distinguishable and the disagreement is visible, so that question
  // can be answered later without data having already been lost.
  //
  // TWO GATES, because an edit leaves two different traces and only checking one
  // of them would leak the correction back:
  //
  //   a field-level gate — the row still exists and a human wrote its fields, so
  //   isHumanOwned() is the answer (ADR 2026-09-09), and
  //
  //   a TOMBSTONE gate — the load-bearing one. Changing a cell's choice writes
  //   the new row under the `occ` arm of deriveElectivePreferenceId and tombstones
  //   the imported `at`-arm (coordinate) row. Those are DIFFERENT ids, so a
  //   re-import does not collide with the new row at all: it re-creates the old
  //   one, restoring the very preference the director removed, and the cell holds
  //   two rank-1 choices again. Following ingest.js's rejectedSlotKeys, only an
  //   EXPLICIT source==='human' delete suppresses a re-create — an import
  //   teardown's null-source delete is excluded by the `===`.
  const preferencesHeld = []
  // D6 (review round 2) — a camper whose tier a claiming bundle's scope does
  // not cover, collected here rather than left silent: `preferencesHeld`'s own
  // words apply just as well one function up — a camper simply absent from
  // the result "answers a different question than the one they're asking".
  const bundleTierMismatches = []
  // The rows that already exist, read ONCE. The inline per-row existence check
  // this replaces compiled a statement per parsed preference inside the
  // transaction, thousands of times on a real sheet.
  const existingPreferenceIds = new Set(
    db.prepare('SELECT id FROM elective_preferences WHERE run_id = ?').all(runId).map((r) => r.id)
  )
  const heldPreference = (preferenceId) => {
    if (isHumanDeleted(db, 'elective_preferences', preferenceId)) return 'removed'
    if (existingPreferenceIds.has(preferenceId)
        && isHumanOwned(db, 'elective_preferences', preferenceId, 'choice_id')) return 'edited'
    return null
  }

  try {
    runAtomic(db, () => {
      const write = (entity, entity_id, fields, { source = null } = {}) => {
        for (const [field, value] of Object.entries(fields)) {
          if (value === undefined) continue
          appendOp(db, {
            entity, entity_id, field, value,
            author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
            source,
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
          // T285 slice G — a subject whose NAME is not known, from a planner grid
          // that carries no name column because the identity comes from the
          // SUBMISSION rather than the page. `undefined` when absent, so an
          // ordinary named camper is never asserted as attributed-or-not and a
          // later import that DOES name them does not have to clear a flag.
          is_unattributed: c.is_unattributed ?? undefined,
        })
      }

      // T301 slice 3 (ADR D6) — the bundle's own choices/offerings are
      // written FIRST, unconditionally, whether or not any preference this
      // commit carries names their label — a bundle is authored independent
      // of any one run, and a re-solve later in the season must find it here
      // even if this particular sheet had nobody rank it. `is_linked` is now
      // genuinely truthful for the case it names (D6's own note: cosmetic,
      // since tier 1 derives "linked" from member count regardless).
      for (const c of bundleChoices) {
        write('elective_choices', c.id, { run_id: runId, label: c.label, is_linked: c.is_linked })
      }
      for (const co of bundleChoiceOfferings) {
        write('elective_choice_offerings', co.id, {
          choice_id: co.choice_id, occurrence_id: co.occurrence_id, activity_id: co.activity_id,
        })
      }

      for (const ch of parsed.choices ?? []) {
        // D6 — a label a bundle claims (for at least one tier) mints NO
        // separate plain choice; every preference naming it resolves to the
        // bundle's own per-tier choice below instead.
        if (bundleChoiceByLabelTier.has(ch.labelKey)) continue
        const id = deriveElectiveChoiceId(runId, ch.labelKey)
        choiceIdByKey.set(ch.labelKey, id)
        write('elective_choices', id, { run_id: runId, label: ch.label, is_linked: 0 })
      }

      for (const p of parsed.preferences ?? []) {
        const bundleByTier = bundleChoiceByLabelTier.get(p.labelKey)
        let choiceId
        if (bundleByTier) {
          // D6 — resolve to the CAMPER'S OWN tier's choice, never a flat one.
          // A camper whose tier the bundle's scope does not cover (untiered,
          // or a tier a scope_mode 'only'/'except' bundle excludes) has no
          // choice this preference can name — skipped rather than thrown, so
          // one camper's mismatch cannot fail every other good row in the
          // sheet (the same posture `preferencesHeld` above already takes for
          // a hand-edited row). Recorded in `bundleTierMismatches` rather than
          // left silent (review round 2): the ADR left the exact COPY open,
          // not whether a director is told at all, and a camper simply
          // missing from the result is the confident-wrong-answer shape this
          // ticket exists to eliminate.
          const camperTierId = camperById.get(p.camper_id)?.group_id != null
            ? tierIdByGroupId.get(camperById.get(p.camper_id).group_id) ?? null
            : null
          choiceId = camperTierId != null ? bundleByTier.get(camperTierId) : undefined
          if (!choiceId) {
            bundleTierMismatches.push({ camperId: p.camper_id, label: p.label ?? p.labelKey })
            continue
          }
        } else {
          choiceId = choiceIdByKey.get(p.labelKey)
        }
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
        // The COORDINATE joins the key (T279 round 2). Without it, a per-cell
        // sheet imported before any template exists has occurrence_id NULL on
        // every row, so two cells naming one activity derive ONE id and the
        // second silently overwrites the first — the importer discarding a
        // child's answer because it could not yet express it as a row.
        const preferenceId =
          deriveElectivePreferenceId(runId, p.camper_id, p.occurrence_id ?? null, choiceId, p.coordinate ?? null)
        // T297 — A DIRECTOR'S CORRECTION IS NOT OVERWRITTEN, AND NOT SILENTLY
        // KEPT EITHER. See the note above `preferencesHeld`.
        const held = heldPreference(preferenceId)
        if (held) {
          preferencesHeld.push({ preferenceId, camperId: p.camper_id, reason: held })
          continue
        }
        write(
          'elective_preferences',
          preferenceId,
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
            // Stored as the file WROTE them, never canonicalized: the derived id
            // canonicalizes for keying, but these columns are provenance and a
            // director has to recognise their own sheet in them. NULL on a
            // whole-run row, which legitimately has no cell.
            coordinate_day_label: p.coordinate?.dayName ?? null,
            coordinate_period_label: p.coordinate?.periodLabel ?? null,
          },
          // THE SHEET IS THE AUTHOR OF THESE ROWS, and saying so is what makes
          // the human marker mean anything. appendOp defaults `source` to null
          // and isHumanOwned decodes null as HUMAN (ADR 2026-08-08-s2a §2
          // over-protects an unlabelled write on purpose), so while this commit
          // left the field unset EVERY imported preference read back as a
          // director's hand edit — confirmed by execution, not inspection. A
          // marker that is true of every row protects nothing.
          //
          // Scoped to preferences deliberately: the other entities this commit
          // writes (campers, choices, assignments) have their own provenance
          // questions and handing them to the importer here would be an
          // unexamined change to how a later re-import treats a hand-corrected
          // camper name.
          { source: 'import' }
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
    //
    // T297 appends one item PER HELD PREFERENCE rather than one summary count:
    // the director's question is "which child's correction did the file
    // disagree with", and a count answers a different question than the one
    // they are asking (the same argument T232 makes for per-value findings).
    findings: [
      ...findings,
      ...preferencesHeld.map((h) => ({
        kind: 'PREFERENCE_EDIT_HELD',
        preference_id: h.preferenceId,
        camper_id: h.camperId,
        reason: h.reason,
        message:
          h.reason === 'removed'
            ? 'This file still lists a preference you removed by hand, so it was not added back. ' +
              'Your removal stands — nothing on the sheet changed it.'
            : 'You edited this preference by hand and the file disagrees, so the file’s version ' +
              'was not applied. Your edit stands — nothing was overwritten.',
      })),
      // D6 (review round 2) — named per camper, not summarized as a count,
      // for the same T232 reason PREFERENCE_EDIT_HELD is above: a director
      // needs to know WHICH child this happened to, not how many.
      ...bundleTierMismatches.map((m) => ({
        kind: 'BUNDLE_TIER_NOT_COVERED',
        camper_id: m.camperId,
        label: m.label,
        message:
          `${camperById.get(m.camperId)?.display_name ?? 'A camper'} ranked “${m.label}”, which a bundle ` +
          'claims for specific divisions only, and this camper’s own division is not one of them — that ' +
          'preference could not be placed. Nothing else on the sheet was affected.',
      })),
    ],
  }
}
