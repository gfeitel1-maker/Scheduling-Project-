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
import { appendOp, runAtomic, DELETE_FIELD } from './operations.js'
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
// Board item 9b — the ONE camper-tier rule, shared with AssignmentPanel's own
// solve path so the commit and the solve cannot disagree about which tier a
// camper is in.
import { makeCamperIdentityResolver } from './camperElectiveIdentity.js'
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
import { buildDanglingManualAssignmentFinding } from './danglingManualAssignmentFinding.js'
import { deriveElectiveRunFindingId, ELIGIBILITY_FINDING_KINDS } from './deriveElectiveRunFindingId.js'

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
  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 4) — the
  // eligibility findings buildElectiveAssignments already computed at solve
  // time (AssignmentPanel.jsx), passed through so they can be PERSISTED here
  // rather than only ever existing in the renderer's React state. Filtered
  // to ELIGIBILITY_FINDING_KINDS below; any other kind is ignored, not
  // guessed into the table (open question 2, T320 ticket).
  findings: solverFindings = [],
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
  //
  // T319 — `name` and `source_filename` now join `status` in this same
  // first-creation-only guard, and the owner ruling behind it is the mirror
  // image of T244's: the run id is content-derived, so two byte-identical
  // arrivals (different filenames, possibly a director's panel commit then a
  // machine retry) legitimately land on ONE row via `existingRun`, and writing
  // `name`/`source_filename` unconditionally on every commit meant the LAST
  // arrival silently renamed the run out from under the first — a specific,
  // confident, false label (docs/work/tickets/T319-a-run-is-named-after-the-
  // import-event.md). `source_filename` therefore names the run's FIRST
  // arrival, not its most recent one, and a later arrival never renames it.
  //
  // Red Hat round 2, MEDIUM — name/source_filename ride on the SAME "a row
  // exists locally" assumption as status above, and for these two fields the
  // gap that comment calls a FUTURE flow is not future at all: the CLI/MCP
  // run id is content-derived, so two devices can each import the identical
  // bytes before either has synced with the other. `existingRun` is a purely
  // LOCAL sqlite read, so BOTH devices see no row and BOTH write name and
  // source_filename as a "first creation" — device A's clock-stamped name
  // next to device B's filename, or vice versa, once the per-field LWW merge
  // settles. This is NOT prevented by this guard or by anything else in this
  // function; the pair can end up internally inconsistent (a name that claims
  // one sheet count sitting beside a source_filename from a different
  // arrival). Flagged, not fixed — closing it would mean deriving the run id
  // from the declared arrival too, which is the T303 non-goal this ticket
  // also declined to reopen.
  const existingRun = providedRunId != null
    ? db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId)
    : null

  // T320 part 2 — a finalized run is immutable (ADR 2026-09-23 decision (a):
  // "no reopen IPC exists"). T244 round 2 stopped this function REASSERTING
  // status/name/source_filename onto an existing row; it never refused the
  // commit. DraftRunView's guardedRegenerate carries a best-effort
  // listElectiveRuns status re-read precisely because this refusal did not
  // exist. The re-read stays (it is the courtesy: it stops the solve before the
  // director waits for it); THIS is the guarantee.
  //
  // LOCAL and best-effort, and saying so is part of the design: a device whose
  // SQLite has not yet merged another device's finalize will not fire this.
  // What stops `final` being reverted campwide is T244 round 2's field-level
  // guard above, not this.
  if (existingRun?.status === 'final') return { ok: false, error: 'RUN_IS_FINAL' }

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
  // A camper's own tier. D6 named ONE route to it (campers.group_id ->
  // groups.tier_id), and for a whole class of camps that route does not exist:
  // when the sheet's Division column carries a TIER name rather than a bunk
  // name, `parsePreferenceSheet` resolves `division_label` and leaves
  // `group_id` NULL (T279 §12.2a — it never invents a group). Every linked
  // choice in such a camp therefore resolved to nothing and landed as a
  // BUNDLE_TIER_NOT_COVERED mismatch for campers the bundle covers perfectly
  // well. `makeCamperIdentityResolver` is the ONE rule now, shared with the
  // panel — see its header for why the sheet's division outranks the roster
  // group's tier (binding from the roster's tier binds a choice the camper can
  // never be placed into, because `buildAttendance` seats them by division).
  //
  // Read once, before the transaction, like every other read in this block.
  //
  // The roster read is the CAMP's campers, not an `id IN (...)` over the sheet's
  // ids. One camp per device db, so the row set is the same either way — and a
  // placeholder list built per sheet is SQL text better-sqlite3's statement
  // cache can never reuse. `makeCamperIdentityResolver` only fills gaps for ids
  // the sheet actually carries, so the extra rows cost nothing.
  const identity = makeCamperIdentityResolver({
    sheetCampers: parsed?.campers ?? [],
    rosterCampers: db.prepare('SELECT id, group_id, division_label FROM campers WHERE camp_id = ?').all(campId),
    groups: db.prepare('SELECT id, tier_id FROM groups').all(),
    tiers: db.prepare('SELECT id, name FROM tiers WHERE camp_id = ?').all(campId),
  })

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
    .map(buildDanglingManualAssignmentFinding)

  // T320 item 2 \u2014 the "did not re-derive" set: this regeneration's currently-
  // recorded occurrence ids minus the ones it just freshly derived
  // (occurrenceIds, above). Read alongside the other pre-transaction reads,
  // using the SAME occurrenceIds Set the dangling-finding query above relies
  // on. Only elective_occurrences rows are pruned \u2014 NOT cascaded into
  // elective_preferences/elective_assignments (a manual row pointing at a
  // pruned occurrence stays exactly as it is; that dangling state IS the
  // finding this item makes durable, not a defect to clean up here).
  const existingOccurrenceIds = new Set(
    db.prepare('SELECT id FROM elective_occurrences WHERE run_id = ?').all(runId).map((r) => r.id)
  )
  const occurrencesToPrune = [...existingOccurrenceIds].filter((id) => !occurrenceIds.has(id))

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
  // T320 part 2 item 3 — the camper ids this commit has a preference ROW for,
  // whether newly written or HELD (a held row is still a row this run has for
  // that camper, so it counts). Feeds the roster findings below.
  const preferencesWritten = new Set()
  // D6 (review round 2) — a camper whose tier a claiming bundle's scope does
  // not cover, collected here rather than left silent: `preferencesHeld`'s own
  // words apply just as well one function up — a camper simply absent from
  // the result "answers a different question than the one they're asking".
  const bundleTierMismatches = []
  // T318 round 2 — the assignment loop now reports into the SAME array (a
  // camper's placement can hit this independently of their preference), so
  // this dedupes a camper/label pair reported from both loops into one
  // finding.
  const bundleTierMismatchKeys = new Set()
  // ONE recorder, so the dedupe invariant lives where the arrays do rather than
  // in each loop that appends. A camper hitting this on both a preference and an
  // assignment for the same label is told once.
  //
  // DEDUPED ON labelKey, REPORTED WITH `label`, and the two must not be confused:
  // the preference loop has the sheet's own spelling ("Archery") and the
  // assignment loop has only the canonical key ("archery"), so keying on
  // whichever the caller happened to pass would let one camper's single problem
  // be reported twice.
  // Round 3 (Red Hat F3) — `tierId` carries the SAME value
  // `resolveWriteChoiceId` just resolved for this exact camper+label, so the
  // finding's grouping never has to re-derive it later against a possibly-
  // different snapshot of the camper's roster row (an empty-division-cell
  // camper's commit-time division_label write happens in the SAME
  // transaction, after this resolution — re-deriving at render time against
  // the now-written-null value silently falls through to the camper's GROUP
  // tier instead, which can name a different division than the one this
  // mismatch was actually generated against).
  // board item 9b round 3 (item 3) — `choiceId` added so the persistence
  // write loop (below the SHEET_CAMPER_WITHOUT_PREFERENCE loop) can store the
  // SAME flat choice `resolveWriteChoiceId` already resolved for this
  // mismatch, rather than re-resolving it a second time.
  const noteMismatch = (camperId, labelKey, label, tierId, choiceId) => {
    const dedupeKey = `${camperId}::${labelKey}`
    if (bundleTierMismatchKeys.has(dedupeKey)) return
    bundleTierMismatchKeys.add(dedupeKey)
    bundleTierMismatches.push({ camperId, label, tierId: tierId ?? null, choiceId: choiceId ?? null })
  }
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

  // T318 round 2 — the ONE resolution rule (D6: a bundle-claimed label
  // resolves to the CAMPER'S OWN tier's bundle choice; anything else resolves
  // to the plain choice this run minted for that label), shared by both write
  // sites below. Before this extraction the assignment loop read
  // `choiceIdByKey` directly, which line ~468's `continue` never populates
  // for a bundle-claimed label — so a solver placement on that label
  // persisted with `choice_id: null` while the preference for the very same
  // label correctly resolved to the bundle's choice. One helper, called from
  // both loops, is what makes that impossible to redrift.
  //
  // BOARD ITEM 9b — a mismatch now carries a choice as well as the flag. The
  // caller decides what to do with each: the preference loop WRITES the row
  // against the flat choice (a camper's ranking is theirs whether or not the
  // bundle reaches them — Art. V: surface the conflict, never absorb the
  // answer), while the assignment loop keeps its skip-to-null posture, which
  // its own round-2 comment records as the fix for a real outage.
  const resolveWriteChoiceId = (labelKey, camperId) => {
    const bundleByTier = bundleChoiceByLabelTier.get(labelKey)
    if (!bundleByTier) return { choiceId: choiceIdByKey.get(labelKey) ?? null }
    const camperTierId = identity.tierIdOf(camperId)
    const choiceId = camperTierId != null ? bundleByTier.get(camperTierId) : undefined
    // Round 3 (Red Hat F3) — `tierId` is the tier THIS RESOLUTION actually
    // used (identity.tierIdOf, called ONCE, right here), carried onto the
    // mismatch so a caller never has to re-derive it later against a
    // different snapshot of the same camper's roster row. See noteMismatch's
    // own comment for why re-deriving at render time was a real bug.
    return choiceId ? { choiceId } : { choiceId: choiceIdByKey.get(labelKey) ?? null, mismatch: true, tierId: camperTierId }
  }

  // WHICH BUNDLE-CLAIMED LABELS STILL NEED A PLAIN CHOICE ROW, decided before
  // the transaction because the choice-minting loop runs before the preference
  // loop that discovers the need.
  //
  // D6 mints a plain row "only for a label no bundle claims". This narrows that
  // by exactly one case — see the dated amendment under D6 in
  // docs/adr/2026-09-29-linked-elective-bundles.md. A camper the bundle's scope
  // genuinely excludes has a real, ranked answer and nowhere to put it;
  // dropping the row is the engine absorbing a conflict it is required to
  // surface (CONSTITUTION Art. V). So the label gets its ordinary choice too,
  // and that camper's ranking is bound to it.
  //
  // ON DEMAND, never always. Minting unconditionally would add a row to every
  // camp whose bundles cover everyone — a stored-state change for camps that
  // were never broken, which is a migration wearing a bugfix's clothes.
  // Asks `resolveWriteChoiceId` rather than re-deciding coverage, for that
  // helper's own stated reason ("one helper, called from both loops, is what
  // makes that impossible to redrift") — a third copy of the rule is a third
  // thing to keep in step, and the copy that got missed would decide whether a
  // choice row exists for a preference that names it. Only `.mismatch` is read,
  // which does not depend on `choiceIdByKey` being populated yet.
  const labelsNeedingFlatChoice = new Set()
  for (const p of parsed?.preferences ?? []) {
    // The set is keyed on LABEL, so one uncovered camper settles the question for
    // that label — the rest of a thousand-row sheet need not be asked again.
    if (labelsNeedingFlatChoice.has(p.labelKey)) continue
    if (resolveWriteChoiceId(p.labelKey, p.camper_id).mismatch) labelsNeedingFlatChoice.add(p.labelKey)
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
        // Only asserted on first creation — see the T319 comment above
        // existingRun's declaration. `write` already skips undefined values.
        name: existingRun ? undefined : name,
        status: existingRun ? undefined : 'draft',
        source_filename: existingRun ? undefined : sourceFilename,
        source_sha256: sourceSha256,
        solver_version: SOLVER_VERSION,
        solver_generation: solverGeneration,
      })

      // T320 item 2 — prune the occurrences this regeneration no longer
      // derives, through the op log (DELETE_FIELD), following
      // deleteElectiveRun.js's exact tombstone discipline. Before the
      // occurrence-write loop below: the fresh set is about to be (re)written
      // anyway, and pruning first means a retried commit re-derives the
      // identical prune set idempotently.
      const del = (entity, entity_id) =>
        appendOp(db, {
          entity, entity_id, field: DELETE_FIELD, value: 1,
          author_user_id: authorUserId, device_id: deviceId,
        })
      for (const id of occurrencesToPrune) del('elective_occurrences', id)

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
        // bundle's own per-tier choice below instead. UNLESS some camper who
        // named it is outside the bundle's scope, in which case their ranking
        // needs an ordinary choice to hang on — see labelsNeedingFlatChoice.
        if (bundleChoiceByLabelTier.has(ch.labelKey) && !labelsNeedingFlatChoice.has(ch.labelKey)) continue
        const id = deriveElectiveChoiceId(runId, ch.labelKey)
        choiceIdByKey.set(ch.labelKey, id)
        write('elective_choices', id, { run_id: runId, label: ch.label, is_linked: 0 })
      }

      for (const p of parsed.preferences ?? []) {
        // D6 — resolve to the CAMPER'S OWN tier's choice, never a flat one, when
        // a bundle claims this label.
        //
        // BOARD ITEM 9b — a camper the bundle's scope genuinely does not cover
        // (a tier a scope_mode 'only'/'except' bundle excludes, or no
        // resolvable tier at all) KEEPS THEIR ROW, bound to the ordinary choice
        // minted for this label above, carrying their own rank. Until now it
        // was dropped, and the director was told about it — which is half of
        // Art. V. A child wrote down an answer; the bundle not reaching them is
        // a fact about the bundle, not a reason to forget what they asked for.
        // Both halves, always: the row AND the finding.
        const resolved = resolveWriteChoiceId(p.labelKey, p.camper_id)
        if (resolved.mismatch) noteMismatch(p.camper_id, p.labelKey, p.label ?? p.labelKey, resolved.tierId, resolved.choiceId)
        const choiceId = resolved.choiceId
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
          preferencesWritten.add(p.camper_id)
          continue
        }
        preferencesWritten.add(p.camper_id)
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
        // T318 round 2 — same resolution as the preference write above (D6),
        // via the shared helper.
        //
        // ROUND 2 CORRECTION (found against the real §6 acceptance fixture,
        // not reasoned about). The first cut of this fix threw here on the
        // premise that "the solver only ever places a camper into a choice
        // offered to their own tier" makes a mismatch unreachable. That
        // premise is false: buildElectiveAssignments's `attends` predicate
        // (src/engine/buildElectiveAssignments.js) does not gate placement by
        // tier at all, and a camper whose sheet division matched no group
        // (T279 §12.2a — `group_id` stays null rather than inventing one) is
        // routinely FALLBACK-placed by the solver into whatever capacity
        // remains, including a bundle-claimed occurrence its own (absent)
        // tier cannot resolve. The acceptance fixture's own "Younger"-division
        // camper hit exactly this and a hard throw failed the whole commit —
        // turning an ordinary roster gap into a director-facing outage. So
        // this mirrors the PREFERENCE loop's posture instead: keep the
        // placement (it is real — the camper WAS put there), and say so via
        // the same BUNDLE_TIER_NOT_COVERED finding the preference loop
        // already emits, deduped so a camper hitting this on both a
        // preference and an assignment for the same label is told once.
        //
        // BOARD ITEM 9b round 2 — `choice_id` now binds to `resolved.choiceId`
        // UNCONDITIONALLY, the same value the preference loop above wrote for
        // this camper+label, rather than being nulled out on a mismatch. That
        // id IS the on-demand flat choice `resolveWriteChoiceId` mints for a
        // bundle-claimed label a camper's tier doesn't reach (see
        // `labelsNeedingFlatChoice` above) — binding to it, not discarding it,
        // is what lets the assignment↔preference join (buildPreferenceLookup,
        // src/screens/elective/run/camperElectiveWeek.js) find the camper's
        // own rank instead of rendering the unordered bucket for a rank-1
        // request. `resolved.choiceId` is still genuinely null for an
        // assignment-only mismatch (a solver fallback placement for a camper
        // who never ranked this label at all): `labelsNeedingFlatChoice` is
        // computed from preferences only, so no flat choice was ever minted
        // to bind to, and null is the correct, not a leftover, answer there.
        const resolved = resolveWriteChoiceId(a.labelKey, a.camper_id)
        if (resolved.mismatch) noteMismatch(a.camper_id, a.labelKey, a.labelKey, resolved.tierId, resolved.choiceId)
        write('elective_assignments', assignmentId, {
          run_id: runId,
          occurrence_id: a.occurrence_id,
          camper_id: a.camper_id,
          activity_id: a.activity_id,
          choice_id: resolved.choiceId,
          preference_rank: a.preference_rank ?? null,
          source: 'solver',
          solver_generation: solverGeneration,
        })
      }

      // T320 item 4 — persist the eligibility-class findings solve time already
      // produced (buildElectiveAssignments, passed in as `solverFindings`), in
      // the SAME transaction, keyed on THIS commit's solverGeneration so two
      // devices computing the identical finding from the identical commit
      // converge on one row (D4). NOT pruned on regeneration (unlike
      // occurrences) — filtered by generation at read time instead; see the
      // ADR's item 4 "deliberate asymmetry" note.
      //
      // UNSUPPORTED_LINKED_CHOICE (this slice's only allowlisted kind,
      // src/engine/buildElectiveAssignments.js) is per-CHOICE, not per-camper:
      // it carries `choice_ids` (usually one, sometimes several sharing an
      // occurrence) and either a single `occurrence_id` or an `occurrence_ids`
      // array. One row is written per choice_id so each choice's finding is
      // independently derivable; camper_id is null (the finding names no
      // camper) and occurrence_id takes the singular field when present, else
      // the first of the array — the row's `message` carries the full,
      // un-truncated detail regardless.
      for (const f of solverFindings) {
        if (!ELIGIBILITY_FINDING_KINDS.includes(f.kind)) continue
        const choiceIds = f.choice_ids ?? (f.choice_id != null ? [f.choice_id] : [null])
        const occurrenceId = f.occurrence_id ?? (Array.isArray(f.occurrence_ids) ? f.occurrence_ids[0] ?? null : null)
        for (const choiceId of choiceIds) {
          const findingId = deriveElectiveRunFindingId(runId, solverGeneration, f.kind, null, choiceId, occurrenceId)
          // Field ORDER matters: run_id/solver_generation/kind/message are
          // the four columns ensureExists waits on before it stub-inserts
          // the row (projections.js), so they must come FIRST — a field
          // written before the stub exists yet UPDATEs zero rows and is
          // silently lost, exactly the trap deriveElectiveRunOuterRows'
          // sibling entry avoids by ordering its own required fields first.
          write('elective_run_findings', findingId, {
            run_id: runId,
            solver_generation: solverGeneration,
            kind: f.kind,
            message: f.message,
            camper_id: null,
            choice_id: choiceId,
            occurrence_id: occurrenceId,
          })
        }
      }

      // T320 part 2 item 3 — THE RUN'S CAMPER UNIVERSE, MADE TRUE.
      // getElectiveRun derived it as (preferences ∪ assignments), so a camper
      // who was on the sheet and ranked nothing was invisible to a cold
      // regenerate. This is the durable record of "in scope for this run",
      // written where the fact is known — and it is a genuine finding in its
      // own right, not a roster table wearing a disguise: a child appeared on
      // the director's sheet and this run has nothing for them, which is
      // exactly the kind of thing Art. V says we surface rather than absorb.
      // NOT filtered by solver_generation at read time (unlike the eligibility
      // kinds above) — a roster is cumulative across generations by definition.
      const placedOrRanked = new Set([
        ...preferencesWritten,
        ...assignments.map((a) => a.camper_id),
      ])
      for (const c of parsed.campers ?? []) {
        if (placedOrRanked.has(c.id)) continue
        const findingId = deriveElectiveRunFindingId(
          runId, solverGeneration, 'SHEET_CAMPER_WITHOUT_PREFERENCE', c.id, null, null
        )
        // Same field-ORDER trap as the loop above: run_id/solver_generation/
        // kind/message are the four columns ensureExists waits on before it
        // stub-inserts the row.
        write('elective_run_findings', findingId, {
          run_id: runId,
          solver_generation: solverGeneration,
          kind: 'SHEET_CAMPER_WITHOUT_PREFERENCE',
          message:
            'This camper was on the sheet but has no ranked choice and no placement on this run. ' +
            'They are still counted when it is regenerated.',
          camper_id: c.id,
          choice_id: null,
          occurrence_id: null,
        })
      }

      // board item 9b round 3 (item 3) — BUNDLE_TIER_NOT_COVERED, persisted
      // through the SAME T320 durability path, mirroring the
      // SHEET_CAMPER_WITHOUT_PREFERENCE loop immediately above: a PARALLEL
      // loop, deliberately NOT folded into the ELIGIBILITY_FINDING_KINDS loop
      // earlier in this transaction — that loop gates the ENGINE's
      // solverFindings array; `bundleTierMismatches` is a different array,
      // built by commitElectiveRun's own D6 resolution (resolveWriteChoiceId/
      // noteMismatch above), not the engine. Without this, a cold-reopened
      // draft shows no grouped bundle-mismatch row at all — DraftRunView.jsx's
      // bundleMismatchGroups previously read only the commit-RESPONSE
      // `findings` array below, which is empty the moment this function
      // returns.
      //
      // NO NEW COLUMN. `tier_id` is NOT persisted — elective_run_findings has
      // no such column, and groupBundleTierNotCoveredFindings
      // (src/screens/elective/run/runStateCopy.js) already has the fallback
      // for exactly a finding missing it: re-derive via
      // makeCamperIdentityResolver against the CURRENT roster. TRADEOFF,
      // stated for Red Hat to challenge rather than to reassure: the live
      // (session, commit-response) finding below carries the commit-time
      // tier; this persisted, cold-reopened row re-derives against whatever
      // the roster looks like at READ time, so a roster edit between commit
      // and reopen can name a different division than the one this mismatch
      // was actually generated against.
      //
      // `message` is NAME-FREE, unlike the response-only message built below
      // (which embeds camperById.get(...).display_name) — the same privacy
      // posture SHEET_CAMPER_WITHOUT_PREFERENCE's persisted message already
      // takes (no real name into a replicated table, T249/ADR 2026-09-23
      // Q4). The director-facing name is resolved on the READ side instead,
      // exactly as groupBundleTierNotCoveredFindings already does for the
      // response-only shape.
      //
      // `label` is NOT stored either — recovered on read via a LEFT JOIN to
      // elective_choices on choice_id (getElectiveRun.js). Incidental
      // consequence: the preference loop's response label (p.label, the
      // sheet's own spelling) and the assignment loop's (a.labelKey, the
      // lowercase canonical key) disagree in casing today; reading the label
      // back through elective_choices.label normalizes BOTH to the choice's
      // one stored spelling.
      //
      // Derived id includes `choiceId`: noteMismatch dedupes on
      // `${camperId}::${labelKey}` and each labelKey resolves to one flat
      // choiceId, so two distinct mismatches for one camper (two different
      // bundle labels) carry two distinct choice_ids and so two distinct
      // rows — pinned by this file's own "two DISTINCT rows" test.
      //
      // KNOWN RESIDUAL (round 2 review F4, NOT fixed this round) — that only
      // holds when a flat choice was actually minted. An ASSIGNMENT-ONLY
      // mismatch (a solver fallback placement for a camper who never ranked
      // the label) has `choiceId: null` — `labelsNeedingFlatChoice` above is
      // built from `parsed.preferences` only, so no flat choice is ever
      // minted to bind to for a label no one ranked. Two such mismatches for
      // ONE camper on two DIFFERENT labels both derive the SAME id (same
      // camperId, same null choiceId), so the second write collapses into
      // the first and one mismatch is lost from this table — pinned as a
      // known defect, not fixed, by this file's own "F4" test. The obvious
      // fix (pre-scan assignments too) is not small: it would also change
      // what the assignment loop above writes into `choice_id` for an
      // assignment-only mismatch, which an earlier round deliberately set to
      // null to fix a real outage — a design decision for the owner.
      for (const m of bundleTierMismatches) {
        const findingId = deriveElectiveRunFindingId(
          runId, solverGeneration, 'BUNDLE_TIER_NOT_COVERED', m.camperId, m.choiceId, null
        )
        write('elective_run_findings', findingId, {
          run_id: runId,
          solver_generation: solverGeneration,
          kind: 'BUNDLE_TIER_NOT_COVERED',
          message:
            'This camper is linked to a choice that a bundle claims for specific divisions only, and ' +
            'their own division is not one of them — so it was kept as an ordinary choice for them ' +
            'instead of as part of the bundle. Their ranking still counts; nothing else on the sheet ' +
            'was affected.',
          camper_id: m.camperId,
          choice_id: m.choiceId,
          occurrence_id: null,
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
      //
      // T318 round 2 — this array now also collects ASSIGNMENT-side
      // mismatches (a solver fallback placement, not a ranked preference), so
      // the wording no longer assumes "ranked": a camper can hit this with no
      // preference at all for the label.
      ...bundleTierMismatches.map((m) => ({
        kind: 'BUNDLE_TIER_NOT_COVERED',
        camper_id: m.camperId,
        label: m.label,
        // Round 3 (Red Hat F3) — the tier THIS COMMIT actually resolved for
        // this camper, carried on the finding so a grouping screen never has
        // to re-derive it later (see noteMismatch's own comment for why
        // re-deriving is a real bug, not a hypothetical one).
        tier_id: m.tierId ?? null,
        // Round 2 F1 — same `choiceId` resolveWriteChoiceId already resolved
        // for this mismatch (noteMismatch's own param), so the SESSION
        // response and the PERSISTED finding (getElectiveRun.js's LEFT JOIN)
        // agree on the same identity. Without this, DraftRunView.jsx's merge
        // Map could not key two distinct mismatches for one camper apart —
        // see that file's `bundleMismatchFindings` comment.
        choice_id: m.choiceId ?? null,
        message:
          // BOARD ITEM 9b — the tail ("could not be resolved to the bundle's
          // choice") became FALSE the moment the ranking was kept. A message
          // that overstates a loss is the same defect class as one that hides
          // it: the director acts on a child who is fine.
          `${camperById.get(m.camperId)?.display_name ?? 'A camper'} is linked to “${m.label}”, which a bundle ` +
          'claims for specific divisions only, and this camper’s own division is not one of them — so it was ' +
          'kept as an ordinary choice for them instead of as part of the bundle. Their ranking still counts; ' +
          'nothing else on the sheet was affected.',
      })),
    ],
  }
}
