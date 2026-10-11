---
title: "Import keeps an elective's shape: period, eligible groups, and its list of choices"
document_type: adr
authority: normative
status: proposed
implementation_state: not_started
date: 2026-10-11
decided:
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
supersedes: []
amends: []
implements: []
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-30-elective-run-durability.md
  - docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md
  - docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md
  - docs/adr/2026-10-11-import-answer-memory.md
---

# Import keeps an elective's shape: period, eligible groups, and its list of choices

## Owner request and success predicate

Finding F6 of `docs/work/evidence/2026-10-11-synthetic-15-scorecard.md` (11 of 15 synthetic camps print electives; 0 elective slots exist after import on any of them). The owner wants electives to keep their shape on import: limited to some groups or divisions, or camp-wide, with odd shapes (one elective block a week, electives on only some days, uneven choice counts).

**Success predicate.** (a) After import, the imported version on both routes holds the elective in exactly the day, block and groups the file printed it in; once the director restores that version, occurrences exist for every tiered group, and the solver assigns once the director has confirmed the proposed choices. (b) A camp-wide "Electives" is an elective, not a fixed event. (c) A list cell becomes N choices of one set, not one activity named with slashes. (d) The review screen asks at most one question per subject, and an unanswered question never mints a wrong record.

**Non-goals.** No linked bundles inferred from a file (a bundle is a director-authored all-or-nothing claim). No camper assignment. No new tables and no schema change. No live write to `template_slots` (see D2). No change to how Generate solves electives.

## Context: the three defects

1. **Camp-wide elective words become fixed events and raise no question.** `buildElectiveCandidates` (`src/ingest/buildPlan.js:299-417`) drops any header finding whose cell text is a known name, and `isKnownName` (`:334-338`) counts a name in `source.fixedEvents` as known; separately a name claimed by the fixed-event pass is skipped as a shape candidate via `claimedEventKeys` (`:340-342`, `:352`). The header terms (`ELECTIVE_HEADER_TERMS`, `src/ingest/extractEntities.js:316`) are exactly the words a camp-wide row prints, so the fixed-event pass wins and the elective detector never sees them. Scorecard: 0 sets on s02, s09, s11, s15, and the Chugim on s06 and s13.
2. **A group-limited elective asks, but confirming keeps only the name.** The card is `elective_candidate` (`src/ingest/reconciliationReport.js:605-636`). Its commit, `commitElectiveCandidates` (`electron/ops/ingest.js:658-690`, called at `:764`), appends two ops: `name` and `camp_id`. The candidate record (`buildPlan.js:411`) carries only `detector`, `band`, `sourceExcerpt`, `row`, `column`. Day, block and groups are never collected. The same header word also still mints a catalogue activity ("Electives" on s04).
3. **A list cell becomes one activity named with slashes.** `LIST_SHAPED` (`buildPlan.js:296`) recognises the shape only to ask "is this an elective period", and the one opaque finding is recorded "never split into fake offerings" (`buildPlan.js:290-291`). If the director declines, or the heuristic skips it, the entity pass still mints `Hiking / Fishing / Kayaking / Orienteering / Bocce` as an activity (s04, s06, s08, s13).

## What an elective actually is in the data (verified by reading code)

- Occurrences are derived from `template_slots` cells carrying `elective_set_id`, **not** from `elective_sets.day_id` / `time_block_id` (`src/screens/elective/assignment/deriveOccurrences.js:1-8`; those columns, `electron/db/schema.sql:1141-1151`, are storage-only). The occurrence is `(day, time_block, tier)`.
- **Eligibility is per tier.** `deriveOccurrences.js:41-48` skips a slot whose group has no `tier_id` and emits an `UNTIERED_GROUP` finding. A cell on a division-less group exists in the grid but the solver sees nothing.
- The set's choices are `elective_set_activities` (`UNIQUE(elective_set_id, activity_id)`, `schema.sql:1232-1247`) with `status` `potential` or `confirmed` (default `confirmed`, `schema.sql:1240-1241`). `buildOfferings` counts only confirmed (`src/screens/elective/assignment/buildOfferings.js:15`).
- **Import writes no `template_slots` rows.** Imported placements are saved as a VERSION, a `schedule_snapshots` row, by `materializeImportedVersion` (`electron/ops/materializeImportedVersion.js:57-133`; one identical version per route, manual and generated). Three places make elective cells impossible today: `capturePlacements` (`src/ingest/capturePlacements.js:17-19`) lists elective-set cells as an accepted v1 limitation, `resolveImportedPlacements` (`electron/ops/resolveImportedPlacements.js:24`) emits only activity and fixed-event slots, and `commitElectiveCandidates` writes `name` and `camp_id` only.
- A restored version re-binds by name: slots carry `names.elective_set` (`src/utils/snapshotRemap.js:27`) and restore resolves `elective_set_id` by name (`:81`, `:115`). So a version slot with `elective_set_id` plus `names.elective_set` is restorable (read, not run; the Maker pins it with a test).
- In `ingestCommit` (`electron/main.js:529`) `commitIngest` (which runs `commitElectiveCandidates`) executes at `:539`, before `materializeImportedVersion` at `:627`. So the set exists before the version is built; this ordering is load-bearing and gets a test.

**No schema change is needed.** The work is seven coordinated code changes (D2), all on the existing version path.

## Precedence (one bucket per name)

Under the strict amendment of 2026-09-26 (OQ3, answered 2026-10-11) no name sits in two buckets.

**Stated reversal.** Today `buildElectiveCandidates` lets a name that is a live catalogue activity or a fixed event (in the db OR in this import) veto the elective reading (`buildPlan.js:321-338`, `isKnownName`). This ADR changes part of that, explicitly:

- A fixed event **inferred by this same import** no longer vetoes an exact elective header word (that veto is defect 1).
- A **pre-existing row in the database** (a catalogue activity or fixed event the director already has under that name) **still wins**: no elective reading, no set, no question. A director who deliberately made "Electives" an activity keeps it.
- A pre-existing `elective_sets` row of that name is reused (see Re-import).

Order of evidence, for names with no pre-existing row:

1. Exact elective header word (`ELECTIVE_HEADER_TERMS`, whole-cell match): **elective period**. Outranks this import's fixed-event and activity inference.
2. List-shaped cell (D3): elective period with N choices.
3. Fixed event (existing rules).
4. Activity.

## Decision per defect, with options

### D1. Camp-wide and group-limited electives (defects 1 and 2)

- **A. Keep today's design, add data capture only.** Defect 1 stays; every elective needs an answer; the header word keeps a catalogue activity (fails one-bucket).
- **B. Classify silently on exact header word; capture shape from the cells; ask only the escape question.** Shown as a classified item with a flag "Read as electives: Tuesday 2:00, Hawks and Owls" and one action "Not electives". Unanswered = stays elective.
- **C. Always ask, one question per elective, pre-filled shape.** Safest; but 11 of 15 camps print electives and s04 asked 9 questions, the noise the one-question-per-subject rule exists to stop.

**Chosen: B.** Camp-wide vs limited is not a separate path: eligibility is the set of groups whose cells printed the word.

Scopes, decided:

- **"Not electives" is per normalized name**, covering every cell of that name in the file (not per cell). It makes the name a fixed event through the normal path and is remembered per name.
- **A header word printed on one day only** is still an elective, with cells on that day only.
- **A header word printed by a single group** makes ONE set with that group's cells. Sets are per name (plus the different-choices suffix rule in D2), never per group, and never one zero-choice set per group.

### D2. Mapping a printed period to a set, choices and version cells (the version path)

Seven coordinated changes, in dependency order:

0. **Renderer side (`src/screens/ImportScreen.jsx`, the commit-input block around line 1456, and `src/screens/reconciliationTriage.js:216-223`).** (i) An unanswered elective must still reach `commitIngest` as a set: today only candidates answered `confirm` are pushed to `confirmedElectiveSets` (`reconciliationTriage.js:223`), which contradicts "unanswered stays elective". Every elective period the plan classified (silently or by question) is sent unless the director answered "Not electives". (ii) `capturePlacements` must receive the answers before it emits cells, so "Not electives" and "One activity" are applied first: a rejected name emits ordinary placements (fixed event or activity), never elective cells. The captured `placementsRef.current` (`ImportScreen.jsx:1456`) is built from the answered state, not the parse-time proposal.

1. **`capturePlacements` emits elective cells.** For each cell the elective detector claims, emit `{ groupName, dayName, blockLabel, electiveSetName, choices }` alongside activity placements (lifting the v1 limitation at `capturePlacements.js:17-19`), through the same canonical spellings as activity placements.
2. **`resolveImportedPlacements` resolves `elective_set`.** Add `electiveSetIdByName` to its `maps`; a cell resolves to `{ group_id, day_id, time_block_id, elective_set_id, activity_id: null, fixed_event_id: null }`. An unresolved set name goes to `unresolved` with reason `elective_set`, like any other. `describeUnresolved` (`electron/ops/resolveImportedPlacements.js:80`) reads `u.activityName`, which elective placements do not carry (they carry `electiveSetName`), so the left-out notice would show "undefined". Fix: elective placements also set `activityName` to the set name when unresolved (or `describeUnresolved` falls back to `electiveSetName`); a test asserts the notice shows the set's name, never "undefined". `leftOutPlacements` (`src/ingest/leftOutPlacements.js:44`) groups by that same field.

   **A held commit is expected to leave elective cells unresolved.** A held commit skips `commitElectiveCandidates` (`ingest.js:764` guard) but `materializeImportedVersion` still runs, so every elective cell lands in `unresolved` with reason `elective_set`. This is the correct, visible outcome: the director sees those cells in the left-out list under the set's name. Test: a held import yields zero elective slots and one left-out entry per elective name, and no error.
3. **`materializeImportedVersion` builds the `electiveSetIdByName` map** with the existing `nameMap(db, 'elective_sets', campId)` call, built after `commitIngest` has run. The ordering already holds in `ingestCommit` (`main.js:539` before `:627`); a regression test makes a reorder fail loudly.
4. **Restore of an imported version.** Imported versions emit id-only slots (no `names` block); restore works because the ids are live (`snapshotRemap.js` `resolver`: a live id is returned as is; name re-binding applies only when a saved slot carries `names`). Test: a version saved by the import with an elective cell restores with its `elective_set_id` bound to the live set. Name re-binding (`:81`, `:115`) is not exercised by this path and is not relied on.
5. **`commitElectiveCandidates` writes the choices.** For each set: `elective_sets` (name first, then `camp_id`, as today), then `elective_set_activities` rows (same unique-first-field write order as `elective_sets`: write the field that carries the uniqueness first, so a cross-device collision is rejected before an orphan row is materialized; the Maker confirms the registered first field for this table in the projection registry and mirrors it; a collision on `UNIQUE(elective_set_id, activity_id)`, `schema.sql:1247`, is caught per row, treated as "already a choice", never thrown, and never changes the existing row's status), matching activities by `recognitionKey` and otherwise creating them as ordinary activities through the normal entity path. Imported choices are written with **`status: 'potential'`**, not the default `confirmed`, because the director has not vouched for them and the solver counts only confirmed. The review flag says "5 choices proposed; confirm them in Electives". Consequence, stated plainly: until the director confirms, the solver reports `NO_OFFERINGS` for that set (`src/engine/buildElectiveAssignments.js:480`). That is the intended honest state.
6. **Post-import notice tells the director what to do next.** The existing result notice (`src/ingest/leftOutPlacements.js:86-88`) reports only left-out placements; nothing I could find tells the director to restore the imported version before Generate (no "restore" text in `ImportScreen.jsx` or `ReconciliationScreen.jsx`). So this plan adds it: when the saved version contains elective cells, the result says "Your imported schedule is saved as a version named 'Imported from <file>'. Restore it to see the electives, then confirm the proposed choices in Electives before Generate will assign them."

| Imported fact | Lands in |
|---|---|
| Elective name | `elective_sets.name`, one row per normalized name. Cell groups sharing a name but printing different choice lists get the name suffixed with day and time ("Chugim (Tue 2:00)"); same list, one set. |
| Day + block of each cell | A slot in the imported version (`schedule_snapshots.slots`) with `elective_set_id` and `names.elective_set`; NOT `template_slots` and NOT `elective_sets.day_id`/`time_block_id`. |
| Eligible groups / divisions | The groups of those cells; a division label expands to its groups via the links the plan holds (`links.groups`, `divisionSupport`). No `elective_bundle_tiers`. |
| Choices | `elective_set_activities`, `status: 'potential'`. Uneven counts: each set carries its own N. |
| Bare word, no list | A set with zero choices and the same version cells. The review flag says "add choices". No Generate-side flag is claimed: the only code that reports an empty set today is the elective solver's `NO_OFFERINGS`. |
| Linked multi-period offering | Not imported (`elective_bundles*` stay director-authored). |

**Live-write vs version-restore (decision).** Imported cells reach `template_slots` only when the director restores the imported version, exactly like every other imported placement. **Recommended: accept this; do not add a live-write path.** A live write would be a second placement route bypassing version history, would have to pick Manual or Generated (neither is canonical, CLAUDE.md), and could overwrite a hand-built schedule. Confidence in this choice: 75%.

### D3. List-form cells (defect 3)

- **A. Always split on `/`, `,`, `;`.** Breaks "Arts, Crafts & More" and "Lunch/Rest Hour".
- **B. Never split; one opaque finding.** Defect 3 stays by design.
- **C. Split silently only under a strict rule; otherwise ask once, default one activity.**

**Chosen: C.** Silent split requires ALL of: the delimiter is a comma, a semicolon, or a spaced slash (" / "); at least 3 parts; no part empty; no part contains "&" or " and "; every part is at most 4 words. Anything else that looks list-like (two parts, an unspaced slash such as "Arts/Crafts", an "&"/"and" part, a long part) asks ONE question: "Is 'Arts, Crafts & More' one activity or a choice of several?" Unanswered = one activity, nothing split. A name already in the catalogue never asks (`isKnownName` guard).

### D4. Tier and division requirement

An elective cell is useful to the solver only if its group has a division (`tier_id`).

- Cells are always written to the imported version (the grid stays faithful), tiered or not.
- **Imported groups with no division: flag, do not ask.** The fix is in setup, not an answer, and no unanswered question blocks anything. The flag on the elective item: "Hawks has no division yet, so Generate can't use this elective for them. Give them one in Setup." It names exactly the groups that would raise `UNTIERED_GROUP` later.
- Never invent a division to make a cell eligible.

## Question flow on the review screen

At most one question **per subject**, the subject being the normalized elective name. Id `elective_period:<normalized name>` replaces `elective_candidate:<detector>:<column>:<excerpt>` (`reconciliationReport.js:610`).

| Situation | Asks? | Wording | Unanswered default |
|---|---|---|---|
| Exact header word, no pre-existing row | No; flag | "Read as electives: Tuesday, 2:00 PM, Hawks and Owls." Action "Not electives" | Elective set, version cells, no activity, no fixed event |
| Unambiguous list cell (strict rule) | No; flag | "Read as a choice of 5: Hiking, Fishing, Kayaking, Orienteering, Bocce." Action "One activity" | Elective set with 5 potential choices |
| Ambiguous list-like cell, name unknown | Yes, one | "Is 'Arts/Crafts' one activity or a choice of Arts or Crafts?" | One activity |
| Group without a division (D4) | No; flag | see D4 | Cells written; solver ignores them |
| Pre-existing activity or fixed event of that name | No | nothing | Existing row kept |

No banners (flags only). Reduced motion: flags need no animation; the status text is the feedback (DESIGN_STANDARD sections 5 and 8). Nothing new is animated.

### Re-import

- **Keep mode:** `commitElectiveCandidates` skips a name that already has a set (`electron/ops/ingest.js:672`). Change to an upsert: add missing choices as `potential`, never remove or demote existing ones, never change an existing choice's status. The version is saved as usual (the identical-version skip still applies).
- **Replace mode:** does not delete elective sets (elective runs reference them; see the run-durability ADR). A set no longer printed is listed in a flag "'Chugim' is no longer in the file; kept." with no action. Stale sets are reported, never silently left or deleted.
- **Answer memory:** add a new remembered kind `elective_period` (entity `elective_sets`) in `src/ingest/answerMemory.js` and `electron/ops/answerMemory.js`, keyed by normalized name. It is NOT added to `AUTO_APPLY_ELIGIBLE` (`src/ingest/answerMemory.js:42`, a frozen allow-list holding only `confirm_value` on `fixed_events`); a test asserts that list is unchanged. A remembered "Not electives" is a suggestion, not auto-applied.

## Reused vs new

Reused: `elective_sets`, `elective_set_activities`, the version path (`capturePlacements`, `resolveImportedPlacements`, `materializeImportedVersion`, `snapshotRemap`), `deriveOccurrences`, the `name_kind` question shape, `recognitionKey`, the answer-memory store. New: a shape-capturing candidate record, precedence change in the fixed-event and entity passes, elective cells in the captured placements, a choices writer, an upsert for existing sets, and one answer-memory kind. Nothing in `elective_bundles*` is touched.

## Recommendation, confidence, evidence

**Recommend D1-B + D2 (version path, seven changes) + D3-C (strict rule) + D4 (flag untiered groups).** Confidence: **medium, about 65%** (down from 70%: the work is seven coordinated changes across about seven files, though each seam is now cited). Evidence for: occurrences derive from cells only, restore already re-binds elective sets by name, and commit-before-materialize already holds. Evidence against: I read code and ran no test or import; electives are not live until the director restores the version; imported choices are `potential`, so an imported elective is not solvable until the director confirms them. Divergence note: options were generated in one context, not as isolated parallel branches, to honour the cost limit.

## Open questions for the owner

1. Is it acceptable that imported electives appear only after the director restores the imported version, like every other imported placement, and that they confirm the proposed choices in Electives before Generate will assign them? (Recommended: yes.)
2. A bare "Electives" word creates a set with zero choices and an "add choices" flag. Acceptable? (Recommended: yes.)
3. A camp whose real event is literally named "Electives", with no pre-existing row, clicks "Not electives" once, then it is remembered. Acceptable? (Recommended: yes.)

## Test plan

- **Repro grids** (scorecard repro folder, including `repro/r7-electives-for-some-groups.txt`, plus new ones): camp-wide "Electives"; two of four groups; one group only; one block a week; only Mon/Wed; one day only; a division-labelled column; list cells of 2, 3 and 5 choices; "Arts, Crafts & More"; "Arts/Crafts"; groups with no division; a pre-existing activity named "Electives"; re-import in Keep and Replace.
- **Invariants (check occurrences, not just cells):** restore the imported version, then run `deriveOccurrences` over the restored slots. (1) Every printed elective set has at least one occurrence unless all its groups are untiered. (2) The union of occurrence `group_ids` equals the printed groups minus the `UNTIERED_GROUP` groups, and those untiered groups are exactly the ones the review flagged. (3) After commit, no elective-term name is a fixed event or activity. (4) Every cell's `elective_set_id` resolves to an existing set after restore. (5) No activity name contains a delimiter the strict rule split. (6) At most one decision per normalized elective name. (7) Re-import is idempotent: same sets, no duplicate choices, no second question, no stacked identical version. (8) Every imported choice has `status = 'potential'`. (9) `AUTO_APPLY_ELIGIBLE` is unchanged. (10) `commitIngest` runs before `materializeImportedVersion` (ordering test).
- **Harness columns:** elective sets created, version cells written, occurrences derived, `UNTIERED_GROUP` count vs flagged count, choices per set and their status, activities minted with delimiter characters (must be 0), questions per subject (at most 1). F6 closes when sets, version cells and occurrences are non-zero on s02, s04, s06-s09, s11-s15.
- **Test first:** each repro grid as a failing test at the `capturePlacements`, `resolveImportedPlacements`, `commitIngest` and `materializeImportedVersion` seams before any change.
