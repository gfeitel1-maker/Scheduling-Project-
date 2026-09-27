---
title: "Campers and per-cell elective preferences enter through the general ingest path — but by declared document kind, not by shape"
document_type: adr
status: proposed
authority: normative
implementation_state: not-started
date: 2026-09-26
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/DESIGN_STANDARD.md
related_adrs:
  - docs/adr/2026-09-26-per-cell-elective-preferences.md
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-18-schedule-shape-gate-per-page-granularity.md
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
  - docs/adr/2026-08-15-locations-import-export-roundtrip.md
related_tickets:
  - docs/work/tickets/T226-camper-preference-import.md
  - docs/work/tickets/T265-minimum-headcount-to-run.md
---

# Campers and per-cell elective preferences enter through the general ingest path — but by declared document kind, not by shape

## The owner's requirement, verbatim

> *"it is filled out anywhere else - google sheet, campminder form, formstack - doesn't matter where.
> we should be able to take it in. because we are establishing a few things - activities in a given
> period, campers' preferences per period, running the choices, and then validated results, with
> asking to reconfirm after. that should not matter what the import looks like"*

This ADR covers the **second** of those five stages — *campers' preferences per period* — and the
camper identity it depends on. Stage 1 (activities in a period) is the existing elective-set /
template-slot path. Stages 3 and 4 (running the choices, validated results) are
`docs/adr/2026-09-26-per-cell-elective-preferences.md`, which is accepted and normative here.
Stage 5 (**asking to reconfirm after**) is not built and is not in scope — see §7 for where it
attaches.

## 1. The finding, challenged rather than confirmed

The brief this design was commissioned from framed the situation as: *the two things arriving from a
family-filled form are precisely the two that bypassed the machinery built to make format
irrelevant.* Read as an observation about **surface area**, that is correct and the code confirms it:

- `src/ingest/extractEntities.js:35-37` freezes `INGESTIBLE_ENTITIES` at seven — `cohorts`, `tiers`,
  `groups`, `days_of_operation`, `time_blocks`, `locations`, `activities`. Neither campers nor
  preferences appear. `electron/ops/ingest.js:52-54` holds the same seven on the write side as
  `RENDERER_WHITELIST`'s counterpart.

  **Correction, and it changes the work.** An earlier draft of this ADR said the two arrays are
  asserted to agree *by set and order* in `src/ingest/ingest.test.js`. **There is no such file, and
  no such assertion.** The two real sites are `electron/ops/ingest.test.js:43` and
  `src/ingest/extractEntities.test.js:22`, and **both compare sorted sets**
  (`expect([...INGESTIBLE_ENTITIES].sort()).toEqual(...)`). Order is normative in the *code*
  (`extractEntities.js:32-34` and `ingest.js:50-53` both say so in comments, the second one citing
  the same phantom filename) but **nothing tests it**. `extractEntities.test.js:22` additionally
  pins a hardcoded seven-name literal, which is a third edit site. See §8 gate 2: the tripwire this
  design leaned on has to be *built*, not inherited.
- Preferences instead have `src/ingest/preferenceSheet.js`, a 163-line reader driven by
  `scripts/preferenceSheetCli.js`, `scripts/mcp/tools.js` and — a consumer the brief missed —
  `src/screens/elective/assignment/AssignmentPanel.jsx:15`, which parses the sheet **in the
  renderer** and commits through `window.shoresh.commitElectiveRun`. There is no
  `preference-sheet` IPC handler; `scripts/preferenceSheetCli.js:18-19`'s claim that it shares a pair
  "the app's IPC handler drives" is stale.

Read as a diagnosis of **oversight**, it is wrong, and the correction is the most load-bearing thing
in this document.

**The bypass is deliberate, documented, and defect-driven.** `src/ingest/scheduleShape.js:16-33`
records why:

> *"The CLI/MCP site was added in T224, after a camper elective-selection workbook committed its
> column headers ('#1', '#2', 'Division') as 33 camp groups and 33 tiers through a path that had
> never called this gate."*

and then, for T223:

> *"A workbook mixing a selection sheet with a day x period menu passed the whole-file gate and had
> its selection sheet extracted too, laundering its column headers ('#1', 'Division', ...) into
> groups/tiers."*

`partitionSchedulePages` exists **specifically to keep a preference sheet out of
`extractEntities`**. The hazard is live — but for **one** of the three shapes in §5, not all of
them, and the earlier draft overstated it. `hasDayColumns` (`scheduleShape.js:81`) returns true when
at least 60% of the columns are day names, which is exactly what a **Shape A** day × period
selection grid looks like: its row-1 header cells *are* bare day names. A Shape A preference sheet
is, by that predicate, schedule-shaped, and `isSchedulePage` (`:94`) will admit it.

**Shapes B and C are not schedule-shaped, and it matters that this ADR says so.** `isDayName`
(`:72`) strips every non-alpha character from the *whole* cell and then prefix-tests the result, so
`"Monday Period 3 - 1st choice"` becomes `"mondayperiodstchoice"` and returns **false**. A Shape B
header therefore yields no day columns at all, and Shape C's day names live in values rather than
headers, which `hasDayColumns` never inspects. So the shape gate admits Shape A and *declines*
B and C. Both directions are wrong for this feature — an admitted Shape A gets laundered (T224), a
declined Shape B or C is silently refused — and neither is fixed by tuning a threshold. The
declared-kind entry point is what fixes both, which is the argument of this section.

So the honest statement of the problem is not *"someone forgot to generalise."* It is:

> **"Format-irrelevant" was achieved by making the general path refuse documents it cannot safely
> guess at. A preference sheet is one of those documents. Generalising therefore means adding a
> declared document kind, not widening the guess.**

The owner's requirement survives this intact — *what the import looks like* stops mattering. What
starts mattering is one thing the director already knows and can state in one click: **which of
their documents this is.** That is not a format question, and pretending the app can infer it is how
33 fake camp groups got created.

## 2. Two halves, two scopes — the decision that structures everything else

The brief treats "campers and preferences" as one problem. The schema says they are two, and they
cannot be solved the same way.

**`campers` is camp-durable data.** `electron/db/schema.sql:1301` — `campers(id, camp_id,
display_name, group_id, external_id, is_active)`. Keyed to the camp, not to a run. It is shaped
exactly like every other ingestible entity: a name, a parent reference, a camp id.

**`elective_preferences` is run-scoped.** Per `docs/adr/2026-09-26-per-cell-elective-preferences.md`
and the v78 shape on this branch: `elective_preferences(id, run_id NOT NULL, camper_id,
occurrence_id NOT NULL, choice_id, rank)`. Every one of the three non-camper columns is minted by a
run:

- `run_id` is minted per solve (`AssignmentPanel.jsx:282`, `crypto.randomUUID()`).
- `choice_id` is run-scoped (`preferenceSheet.js` itself says so: *"choice ids are run-scoped and no
  run exists at parse time"*) and written by `commitElectiveRun.js:293`.
- `occurrence_id` is **derived, not ingested**. `src/screens/elective/assignment/deriveOccurrences.js`
  builds occurrences from the *confirmed schedule template's own slots* — the distinct
  `(day_id, time_block_id, tier_id)` cells where `elective_set_id` matches — and the id is
  `deriveElectiveOccurrenceId(runId, electiveSetId, day_id, time_block_id, tier_id)`.

**Decision 2.1 — `campers` becomes the eighth ingestible entity. `elective_preferences` does not,
and cannot.** `commitPlan` has no run and no `runId`; `electron/ops/ingest.js:688-689` throws
`"ingest: <entity> cannot be created by an import"` on any key outside the seven. A preference has
no name to be keyed by, no camp-durable identity, and one of its three legs does not exist until a
director picks a schedule template and presses solve. Preferences therefore keep
`commitElectiveRun` as their **writer**, and move only their **reader** onto the general machinery.

This is the single most consequential correction to the brief's framing, and it is why the answer to
its question 1 is "a new concept" rather than "an extension".

## 3. The brief's hardest claim is false, and the design turns on why

> *"a preference is a THREE-WAY binding (camper x occurrence x choice) where all three sides are
> fuzzy-matched names"*

**All three sides are not fuzzy-matched names. Only two are, and the third is not a name at all.**

| Leg | What the file carries | How it resolves |
|---|---|---|
| camper | a name, sometimes an external id | fuzzy, against `campers` — the new eighth entity |
| choice | an activity label | fuzzy, against `activities` — **already** in the seven |
| occurrence | a *coordinate* — "Monday", "Period 3" | **not fuzzy against occurrences at all.** The day and period halves resolve against `days_of_operation` and `time_blocks` — also already in the seven. The `tier_id` half is **not in the file**: it comes from the camper's group's tier (`deriveOccurrences.js:32`). The `occurrence_id` is then *computed* at solve time. |

Two consequences follow, and both simplify the design sharply:

1. **A preference proposal proposes no new entity type.** Its camper leg needs one new entity
   (§2.1); its other two legs resolve against entities the general path already proposes, in the
   order it already proposes them.
2. **A preference cannot carry an `occurrence_id` through ingest, ever.** Occurrence ids are
   run-scoped; an ingest that stamped one would be inventing a run. What ingest can produce and
   persist-in-session is a **cell coordinate** `(day_id, time_block_id)` plus a rank and a choice
   label. Binding that to an `occurrence_id` is late, at solve time, against `deriveOccurrences`'s
   output — which is also the only place the tier is known.

`docs/adr/2026-09-26-per-cell-elective-preferences.md` states that
*"`src/ingest/preferenceSheet.js` is unchanged — out of scope … so every sheet-imported preference
today has no `occurrence_id` and is refused until a per-cell ingest format exists."* This ADR is
that format, and the reason the three currently-failing test files fail. §6 says what to do with
them.

## 4. Decision — a preference is a confirmed *binding*, and it is a new concept

### 4.1 The proposal shape

**Decision.** A preference enters as a `preference_bindings` proposal: a flat stream of

```
{ camperName, camperExternalId|null, dayName, periodLabel, choiceLabel, rank,
  source: { page, row, column } }
```

produced by a reader, resolved against the same-import proposal for `campers`, `activities`,
`days_of_operation` and `time_blocks`, and carried to the elective run as
`{ camper_id, day_id, time_block_id, choice_label, rank }`.

**It is a new concept, not an extension of the existing one, and the defence is mechanical rather
than aesthetic.** `INGESTIBLE_ENTITIES` membership is a promise with four parts that a binding
cannot keep: (a) `commitPlan`'s create loop walks the array in order and creates a **named row** per
member; (b) `electron/ops/ingest.js:264` builds one recognition map per member, keyed by
`recognitionKey(entity, name)` (`src/ingest/preview.js`); (c) `U2_DELETE_ORDER`
(`electron/ops/ingest.js:43-45`) is the reverse of it, for Replace; (d) `U2_DELETABLE_ENTITIES`
(`electron/ops/undoReferences.js:136-138`) is asserted to be exactly this array plus
`anchor_activities` (`undoReferences.schemaParity.test.js:295-298`), which drags every member into
Undo-Import's deletion slice and its referential model. A binding has no name, so (b) is undefined for it; it
is not camp-durable, so (c) is meaningless; and it is written by a different writer entirely, so (a)
does not apply. Forcing it in would reproduce the `anchor_activities` bug documented at
`src/screens/reconciliationResolutions.js:118-127` — a stray key the whitelist then rejects,
converting a legitimate hold-back into a hard commit failure.

**So bindings travel beside `approved`, not inside it** — the same architectural position
`fixedEvents[]` already occupies (`reconciliationResolutions.js:128-134`: *"`approved` never gates
'anchor_activities' … so a fixed-event confirm_value needs its OWN hold-back"*). That precedent is
the model: a second gated array with its own hold-back rule, not an eighth `approved` key.

### 4.2 What the director confirms

**Not one card per binding.** 400 campers × 18 selectable cells is ~7,200 bindings, and a director
cannot confirm that. The confirmable units are the **vocabulary** and the **layout**, which are
small:

1. **The layout reading** — one confirmation for the whole file (§5).
2. **The camper roster** — ordinary `campers` cards on the general path, one per new name.
3. **The choice vocabulary** — the distinct activity labels, folded by
   `whitespaceInsensitiveName` (`src/ingest/preview.js:24`), as ordinary `activities` cards.
4. **The cell vocabulary** — the distinct day and period labels, as ordinary
   `days_of_operation` / `time_blocks` cards.

Every binding whose four legs all resolve to a confirmed name rides in silently. Every binding with
an unresolved leg is **held back and named** — it does not fail the import and does not silently
vanish. That is the exception-only review shape, and it is what makes the volume tractable.

### 4.3 Ranks and idempotency

A duplicate `(camper, cell, rank)` is a **hard refusal with both source cells shown**, never a
last-write-wins. This is not new discipline: `hasContradictoryRanks`
(`preferenceSheet.js:149-163`) already exists for exactly this reason, and its header records the
observed damage — *"three rows naming one child produced one camper with 75 preferences and three
different rank-1 choices."* It is retained and re-scoped from `(camper, rank)` to
`(camper, cell, rank)`, because per `docs/adr/2026-09-26-per-cell-elective-preferences.md` Decision
1 a rank-1 in Monday period 3 and a rank-1 in Monday period 6 are two independent first choices, not
a contradiction. **The existing global-scoped check would refuse every correct per-cell sheet.**

**Re-scoping the check opens four contradiction classes the global check never had to consider, and
each needs a ruling here rather than in Maker's head.**

- **(a) The same activity ranked twice in one cell** — "Swim 1st, Swim 2nd" in Monday period 3.
  Distinct `(camper, cell, rank)` keys, so the re-scoped check passes it, and the solver then burns a
  rank on an activity the camper already holds. **Ruling: a duplicated `choice_label_key` within one
  `(camper, cell)` is a held-back binding with a named finding, not a refusal.** It is a filled-in
  form, not a corrupt file, and the director can see it and decide.
- **(b) Rank gaps** — a cell carrying ranks 1 and 3. The accepted per-cell ADR forbids baking in an
  N, so the reader cannot tell a gap from a two-rank cell. **Ruling: gaps are accepted and
  renumbered densely per cell, in file order, with the original rank carried in the binding's
  `source` for the finding text.** Refusing would require the N this design is forbidden to assume.
- **(c) A cell the camper is not eligible for** — a family form that let a child rank Lunch. §12 Q3
  covers only the *ungrouped* camper. **Ruling: a binding whose cell is not a selectable occurrence
  for that camper's tier is held back with an `UNSELECTABLE_CELL` finding and never reaches the
  solver.** §5's "not every cell is selectable" is the reader-side half; this is the binding-side
  half.
- **(d) An exactly duplicated row** — routine when a family submits the form twice. This hits the
  *identical* key, and the paragraph above would therefore **hard-refuse the whole import**, which is
  wrong. **Ruling: identical duplicates are deduplicated silently; only a *conflicting* duplicate —
  same `(camper, cell, rank)`, different `choice_label_key` — is the hard refusal.** The refusal is
  for ambiguity, and two identical rows are not ambiguous.

Re-importing the same file must be idempotent. The binding key
`(camper_id, day_id, time_block_id, choice_label_key, rank)` is deterministic from confirmed ids, so
a second import of an unchanged file proposes the same bindings.

**The divergence check is route-scoped, and the design must say which route.** A cell that would
*change* an already-committed preference in a **final** run is not overwritten — it surfaces as a
divergence, because `finalizeElectiveRun` is the point after which a run is a published fact. But
`deriveOccurrences` groups by `template_id` (`deriveOccurrences.js:23`) and neither route is
canonical (CLAUDE.md), so one `(camper, day, time_block)` coordinate yields **two different
`occurrence_id`s** — one per candidate schedule — while the binding key above is template-agnostic.
**Decision: a binding is route-neutral, and the divergence is computed on the coordinate, not on the
`occurrence_id`.** A binding is a statement about what a child wants on Monday in period 3, which is
a fact about the child and not about which of two candidate schedules the director is looking at. The
consequence to accept explicitly: importing the same sheet against the Manual route after finalizing
a Generated run surfaces the divergence, rather than writing a second silent set of preferences under
a different occurrence id. That is the intended behaviour, and it is the reason the key is
template-agnostic rather than an oversight in it.

## 5. Where per-period structure comes from — design for all three shapes, detect by header

The brief says *"the real artifact is a day x period grid, but a Google Form export is probably one
row per camper with columns like 'Monday Period 3 - 1st choice'. Do not assume either shape."*
Correct, and there are **three**, not two. The first two are the same file structurally and differ
only in where the day and period live:

- **Shape A — two-row header grid.** Row 1 names days (merged across their periods), row 2 names
  periods. One row per camper.

  **An earlier draft claimed `src/ingest/twoRowSplit.js` "already exists for precisely this header
  form and is reused rather than reinvented." That is false, and it was load-bearing for S2's size.**
  `twoRowSplit.js` is Slice 1 of `docs/adr/2026-08-23-two-rows-multipattern-split.md` — splitting one
  dual-use *activity* into a pinned row plus a flexible row. Its exports are `DEFAULT_SPLIT_SUFFIX`,
  `pinActivityAsserted` and `emitTwoRowSplit`; it reads no headers at all. The name collides with the
  concept and nothing else. **There is no two-row-header reader anywhere in `src/ingest/`.** Shape A's
  reader is UNBUILT, and S2 is sized accordingly in §10: three readers to write, not two plus a reuse.
- **Shape B — compound single header.** One header row, each cell naming both axes: `"Monday Period
  3 - 1st choice"`. **Detection cannot use `isDayName`**, and this is the same correction as §1:
  `isDayName` (`scheduleShape.js:72`) strips non-alpha from the whole string before prefix-testing, so
  it answers `false` for every Shape B header. The usable primitive is `titleNamesADay`'s tokenizing
  split (`:86-88`, `String(title).split(/[^a-z]+/i).some(isDayName)`), which does reach the `Monday`
  token — or a new tokenizer if the rank and period tokens want extracting in the same pass. **S2 must
  either call `titleNamesADay`'s split or write its own; it must not call `isDayName` on a whole
  header cell.**
- **Shape C — tidy/long.** One row per `(camper, cell, rank)`, with `Camper` / `Day` / `Period` /
  `Choice` / `Rank` columns. Detected by a column whose *values* — not header — are mostly day
  names.

**Detection is a proposal, not a gate.** The reader proposes a reading with a stated confidence and
names the alternative; the director confirms or flips it. This follows the path's own bias, recorded
at `extractEntities.js:11-13`: *"Over-inclusion is the deliberate bias. A wrong row the director
deletes costs them a moment; a missing row they never notice costs them the retyping this feature
exists to remove."* A file matching none of the three is not refused either — it falls back to the
manual column mapping `inferPreferenceMapping` already implements, re-scoped per cell. **A new
export format must remain a mapping, not a code change**, which is the one commitment
`preferenceSheet.js:9-18` got right and this ADR preserves verbatim.

**The layout is confirmed per import and not persisted.** This is deliberate and it is the choice
that keeps this ADR schema-free (§8). Persisting a per-camp layout so a returning director skips the
step is a later slice, and it is the only part of this design that would need a table. §9 Trap 6
states the cost of not persisting it, which is not zero.

**Where the coordinate becomes an `occurrence_id`: the caller, at solve time — not
`commitElectiveRun`.** §8 of an earlier draft assigned this to `commitElectiveRun`, which *cannot* do
it: it **receives** `occurrences` as an argument (`commitElectiveRun.js:85`), refuses any preference
lacking an `occurrence_id` (`:61`), and throws on one naming an occurrence outside the run's set
(`:305-306`). It is the *enforcer* of the binding, never the binder. **Decision: the caller binds.**
`AssignmentPanel.jsx` (and, after S4, the CLI/MCP harness) resolves each binding's
`(camper_id, day_id, time_block_id)` against `deriveOccurrences`'s output — the only place the
camper's group's tier is known — and passes fully-formed preferences down. `commitElectiveRun`'s two
refusals stay exactly as they are and become the backstop that proves the caller did it.

**Ranks are not fixed at N.** Per `docs/adr/2026-09-26-per-cell-elective-preferences.md` Decision 1,
*"How many ranks per cell is a per-camp setting, not a constant … Do not bake in an N."* The reader
discovers the rank count per cell from the file. A cell with one selection and no alternates is a
rank-1-only cell, not an error.

**Not every cell is selectable.** The same ADR records 18 of 35 cells taking a selection. A cell the
sheet marks fixed, "no selection needed", or Shabbat contributes no bindings and generates no
finding. An importer that manufactures an unresolved binding for Lunch is wrong.

### 5.1 The declared kind must be per-PAGE, because T223 was a per-page defect — the mixed workbook

**Decision: the declared kind is per-PAGE, resolved by `partitionSchedulePages`' existing
per-page seam, and a mixed workbook is imported as both kinds in one pass.**

This has to be ruled rather than left implicit, because the shape it addresses is *the literal T223
artifact*. `src/ingest/scheduleShape.js:23-27` records it: *"A workbook mixing a selection sheet with a
day × period menu passed the whole-file gate and had its selection sheet extracted too, laundering its
column headers into groups/tiers."* T223's fix was moving the gate from whole-file to per-page
(`docs/adr/2026-09-18-schedule-shape-gate-per-page-granularity.md`). **A per-import declared kind
would re-introduce whole-file granularity at the layer above the fix**, and both readings are bad:
declare "preference sheet" and the schedule tab's real entities vanish silently; declare "schedule" and
the selection tab is laundered again, which is T223 verbatim.

So the director declares per page: each page is schedule, preference sheet, or neither. Pages already
carry a title and are already partitioned one at a time, so this is the existing seam, not a new one.
The default per page is the shape gate's own verdict — which §1 establishes admits Shape A and declines
B and C — shown as a proposal the director flips.

**And the honest accounting of what the declared kind buys, because an earlier draft overclaimed it.**
It does not remove the class of defect; it **moves one guess and adds another**:

- *Removed:* the parser guessing whether a day-column grid is a schedule. The director states it.
- *Added:* the director confirming a **layout reading** whose consequence they cannot see. §4.2 turns a
  preference sheet's own header vocabulary into confirmable cards across **four** entity types —
  `campers`, `activities`, `days_of_operation`, `time_blocks` — while this section calls layout detection
  *"a proposal, not a gate."* Combined with `ImportScreen.jsx:1253`'s unfiltered copy into `approved`,
  **one wrongly-confirmed layout is T224's shape with a tired director's click substituted for the
  parser's guess.** `'#1'` and `'Division'` become `time_blocks` and `tiers` just as readily when a human
  waves a bad layout through.

The declared kind is still the right call, because a director genuinely knows which document this is and
genuinely does not know what a layout inference will do. But the residual risk is a **confirmation-surface**
risk, which is why §4.2's cards are held to `DESIGN_STANDARD.md` and why Trap 4's requirement 2 (campers
opt-in, not opt-out) is the control that matters most.

## 6. A camper named on a preference row who is not in the system

**Decision: never created as a side effect.** A camper name appearing only on a preference row emits
an ordinary `campers` proposal that the director confirms on its own card. Until they do, that
camper's bindings are held back and listed by name.

This is not a preference for ceremony; it is forced by the trap in §9. Confirming a card **is** the
write. If a preference row could conjure a camper, then importing a family-filled form would create
children in the camp's roster with no one having agreed to any of them — and `campers` is the one
table the schema singles out as PII-bearing and admin-only
(`electron/db/schema.sql:1290-1300`: *"ADMIN-ONLY (ADR D9) … a future column here is an ADR-level
change"*). Identity creation stays a named act.

Three sub-cases, all already half-solved in the existing reader:

- **External id present.** `deriveCamperId(campId, { externalId, displayName })` keys on it; two
  children sharing a name are correctly two campers. Retained.
- **No external id, one row.** Ordinary fuzzy match against live + proposed `campers`.
- **No external id, two rows same name.** A **blocking** decision, not a notice — retained from
  `parsePreferenceSheet`'s `sameNameCampers`, whose header documents why: the two rows collapse onto
  one derived id, producing one camper with contradictory rank-1s.

## 7. What this does **not** solve

- **Stage 5, "asking to reconfirm after."** Not built, not designed here. It attaches at
  `docs/adr/2026-09-26-per-cell-elective-preferences.md` Decision 2 **step 3** — the per-(activity,
  period) director decision surface — as one of the options a director may choose for a failed
  offering. It is *not* an ingest concern, and per the owner's ruling it is emphatically not
  re-asking the child: *"the answer is not asking the kid again, it's asking the user how they want
  to handle each activity in each period."* If reconfirmation ever does go back to families, it
  generates a **new** import of this same shape, which this design already supports.
- **Persisted layouts.** §5. The only part needing a table; §9 Trap 6 is what not having one costs a
  director who closes the window mid-confirm.
- **The third-party portal's actual export.** D14's refusal stands: the artifact in hand is a blank
  form. This ADR designs a reader for three *structures*; it does not claim to know the file.
- **Camper data beyond the D8 footprint.** No contact details, no medical, no household. Unchanged.
- **A camper-deletion or camper-CRUD surface.** §9 Trap 4 establishes there is none and rules that
  prevention is the whole answer. Building one is a separate ticket with its own D9 posture question,
  and §12 Q4 is the owner acceptance that it stays unbuilt.
- **Fairness across cells** (ruling R4), the **tier-1/tier-2 linked-choice split** (T247), and
  **making occurrence ids run-independent** — all untouched.
- **Roster sync with the camp's own system.** Import only, one direction.

## 8. Schema version: none required

**No schema version is needed for this design, and that is a design constraint honoured rather than
a lucky accident.**

- `campers` exists (v66) with every column needed.
- `elective_preferences` gained `occurrence_id` at v78 on this branch and needs nothing further —
  §3 establishes that ingest produces a cell *coordinate*, which `commitElectiveRun` resolves to an
  `occurrence_id` against `deriveOccurrences`'s output. No new column.
- Bindings are in-session until `commitElectiveRun` writes them, so they need no table.
- The confirmed layout is not persisted (§5).

**The one thing that would need a version is persisting the layout**, and it is deliberately
deferred. Should a future slice take it up, the owner allocates the number after coordinating with
the peer sessions holding 75–77.

**No schema version — but "no schema change" is not "no stored-shape consequence".** Making `campers`
U2-deletable (below) changes the referential model of a table that holds PII and is pointed at by a
finalized elective run. That is reviewed here, in §8 and §9, not deferred to Maker.

### 8.1 `campers` is the eighth member — and that touches FIVE arrays across three files, not two

An earlier draft named two arrays. The real set, verified on this branch:

| # | Site | Change |
|---|---|---|
| 1 | `src/ingest/extractEntities.js:35` — `INGESTIBLE_ENTITIES` (renderer) | append `'campers'` **last**, after `'activities'` |
| 2 | `electron/ops/ingest.js:52` — `INGESTIBLE_ENTITIES` (writer) | append `'campers'` last, identically |
| 3 | `electron/ops/ingest.js:43` — `U2_DELETE_ORDER` | insert `'campers'` **immediately after `'anchor_activities'`** |
| 4 | `electron/ops/undoReferences.js:136-138` — `U2_DELETABLE_ENTITIES` | add `'campers'` to the Set |
| 5 | `electron/ops/ingest.js:64` — `REPLACEABLE_ENTITIES` | **ruled in §9 Trap 7** — decide, do not drift |

Plus three test sites: `src/ingest/extractEntities.test.js:22` (sorted-set equality **and** a
hardcoded seven-name literal), `electron/ops/ingest.test.js:43` (sorted-set equality), and
`electron/ops/undoReferences.schemaParity.test.js:295-298`, which asserts `U2_DELETABLE_ENTITIES` is
exactly `INGESTIBLE_ENTITIES` plus `anchor_activities` — **it goes red the moment array 1 or 2 changes
without array 4**, which is the one tripwire in this set that already works.

**The U2 position was stated wrongly in an earlier draft and the correction is not cosmetic.** That
draft said `campers` goes *first* in `U2_DELETE_ORDER`. It does not: the array's first element is
`anchor_activities`, and the rest is the reverse of the seven. `campers` appended last to
`INGESTIBLE_ENTITIES` therefore lands **second** in `U2_DELETE_ORDER`, immediately after
`anchor_activities`. Getting this wrong is a runtime failure, not a style question — `PRAGMA
foreign_keys` is ON and a wrong order throws.

**Why last in the create order — and the stated reason in the earlier draft was false.** That draft
said "`campers.group_id` references `groups`". It does not. `electron/db/schema.sql:1304` is
`group_id TEXT` with **no `REFERENCES` clause**. The conclusion survives — `commitPlan`'s create loop
resolves a group *name* to an id, so the group must already exist — but **the falseness matters in its
own right**: with no FK, a Replace that drops `groups` does not throw, it **silently orphans every
camper's `group_id`**. An orphaned `group_id` means no group, which means no tier, which means
`deriveOccurrences` can resolve no cell for that camper (§12 Q3's shape, arrived at by a different
road). §9 Trap 7 is where that lands.

### 8.2 The order tripwire this design needs does not exist yet, so S1 builds it

`extractEntities.js:32-34` says *"Order is normative here, not just set membership — ingest.test.js's
set-equality check pairs with this array's own order"* — a comment that names a nonexistent file and,
by its own wording, concedes that the test checks a **set**. Both real assertions sort before
comparing. **A Maker who puts `campers` in the wrong position of any of the five arrays gets a green
gate.** Two of the five are order-critical (create order, delete order) and one runtime-throws when
wrong.

**S1 therefore ships an order assertion as work, not as a discovered safety net:** `INGESTIBLE_ENTITIES`
compared to `RENDERER_WHITELIST` by **sequence**, and `U2_DELETE_ORDER` asserted to equal
`['anchor_activities', ...[...INGESTIBLE_ENTITIES].reverse()]`. The second one is the higher-value of
the two, because it derives the order rather than restating it, and it is the assertion that would have
caught the earlier draft's own error.

### 8.3 Ruling — making `campers` U2-deletable invalidates three documented exemptions

This is the consequence with the longest reach, and it is a design decision, not an implementation
detail. `electron/ops/undoReferences.js:121-124` exempts `elective_run_outer_snapshots.run_id` and
`.camper_id` from `UNDO_REFERENCE_CHECKS` on the stated ground that they *"point at
elective_assignment_runs/campers, neither U2-deletable."* Three `ACCEPTED_NON_REFERENCES` entries say
the same verbatim:

- `undoReferences.schemaParity.test.js:150` — `elective_preferences.camper_id`
- `:156` — `elective_assignments.camper_id`
- `:163` — `elective_run_outer_snapshots.camper_id`

**Each of those three reasons becomes false on the day `campers` joins array 4**, and the naming-
convention scanner in that same file exists to catch exactly this. Worse than a red test: Undo Import
after a **finalized** elective run would tombstone camper rows with **no referential blocker**,
leaving a published run pointing at children who no longer exist.

**Ruling.** S1 registers all three as real `UNDO_REFERENCE_CHECKS` entries toward `campers`
(`kind: 'scalar', enforced: false` — matching the existing soft posture, since none of the three has a
DB-level `REFERENCES`), and removes the three `ACCEPTED_NON_REFERENCES` rows. The effect is the one
this design wants: **a camper referenced by any preference, assignment or outer snapshot cannot be
U2-deleted at all**, so Undo Import after a run refuses rather than orphaning it. S1 also adds a
**fourth** entry, `campers.group_id → groups`, which has no row today and needs one because `groups`
*is* U2-deletable and §8.1's missing FK means nothing else will catch it.

The gate that proves this: an integration case that imports a roster, finalizes a run, and asserts
Undo Import **refuses** — not that it succeeds quietly.

### 8.4 Two non-schema gates this opens, which are not free

1. **`campers` is absent from `electron/auth/permissions.js` ENTITIES by design**
   (`schema.sql:1290-1292`, following the `camp_maps` precedent — confirmed: `grep -n campers
   electron/auth/permissions.js` returns nothing). Making it ingestible means the ingest commit path
   writes it. Whether that requires a `permissions.js` entry or is already covered by the ingest
   handler's own admin gate in `authorize()` is an implementation question Maker must settle by reading
   both, **not** assume. If it needs an entry, that is an ADR D9 revisit, not a field addition.

   **This is also a READ question, which an earlier draft framed as write-only.** Three sites loop
   `INGESTIBLE_ENTITIES` calling `list(entity)` and will start reading the PII roster into the
   renderer: `src/ingest/existingSnapshot.js:30,46`, the recognition-map build at
   `electron/ops/ingest.js:264`, and `src/utils/downloadWorksheet.js:11-14`. §9 Traps 5 and 8 are what
   those two reads do when the read is *denied*.

2. **`INGESTIBLE_ENTITIES` order is normative** — §8.1 and §8.2 above, which replace this gate's
   earlier one-paragraph form.

### 8.5 Governance deliverables that must land with the work

`node scripts/check-governance.js` reported three findings against this file's first draft, and all
three are deterministic reds in `npm run verify`'s second step:

- **`task_class: data-ingestion` was an enum violation.** The permitted values are
  `architecture` · `ui-ux-design` · `security-auth` · `scheduling-engine` · `database-sync` ·
  `copy-terminology` · `documentation-governance` · `concurrency` · `test-infrastructure`
  (`docs/governance/standards/WORK_RECORD_STANDARD.md:204-206`), and `:213-217` forbids inventing a
  class for a span — a spanning task takes the **stricter** gate list from both, it does not get a new
  hyphenated name. **Corrected to `database-sync`**, which is the right class on the merits and not
  merely the nearest legal one: the consequential parts of this design are the projection's
  referential model (§8.3), a stored-shape claim (§8), and Undo/Replace behaviour. `ui-ux-design` is
  the genuine second class this work spans — §4.2 specifies a director confirmation surface — so
  `DESIGN_STANDARD.md` is in `governing_docs` and its gates apply to S2's confirmation UI on top of
  `database-sync`'s.
- **`index-stale`** — `docs/work/INDEX.md` must be regenerated (`npm run index:work`) in the commit
  that lands this ADR.
- **`platform-state-stale`** — `docs/current/PLATFORM_STATE.md` is behind the last structural change
  and must be brought current (`/update-state`) **in the same commit**. Per CLAUDE.md, `check:governance`
  also fails on a descriptive doc naming a repo path that does not exist, so the PLATFORM_STATE edit
  must not restate this ADR's now-corrected phantom path `src/ingest/ingest.test.js`.

One more descriptive-doc correction belongs to S1 rather than to this commit:
`electron/db/schema.sql:300` documents `open_reconciliation_decisions.entity_type` as *"one of the 6
ingestible entity types"* — **already stale at seven**, worse at eight, and it annotates a host-local
**persisted** column whose values a future reader will interpret against that comment.

## 9. The traps, named rather than designed around

**Trap 1 — confirming a card is what performs the write.** `src/screens/ImportScreen.jsx:1253`:

```js
for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(effectiveProposal?.entities[entity] ?? [])]
```

Every proposed name is copied into `approved` **unfiltered**.
`src/screens/reconciliationResolutions.js:110-125` removes a name only when
`!isDecisionResolved(...)` — so the default for anything the director never looked at is **written**,
and the hold-back is the exception. Its own comment calls this *"the silent-write risk this module
exists to guard."*

**A `campers` card inherits this exactly.** The moment `campers` joins the seven, a camper name the
reader hallucinated out of a stray header cell and the director never noticed becomes a row in the
camp's PII-bearing roster. That is not a hypothetical: it is the T224 defect — 33 fake groups and 33
fake tiers from `'#1'`, `'#2'`, `'Division'` — with `campers` substituted for `groups`. The design's
answer is §1's: the reader only runs when the director has declared the document a preference sheet,
so there is no path on which a preference sheet's headers reach the camper extractor unasked.

**Trap 2 — bindings must not ride `approved`.** `electron/ops/ingest.js:688-689` throws on any key
outside the whitelist. A stray `approved.preference_bindings` is a hard commit failure, not a
skipped write — the `anchor_activities` bug shape (`reconciliationResolutions.js:118-127`). §4.1's
"beside, not inside" is that hazard, avoided.

**Trap 3 — the shape gate admits a Shape A grid and declines Shapes B and C.** §1, corrected:
`hasDayColumns` keys on day-name headers, which a Shape A grid has and Shapes B/C do not. The
declared-kind entry point is not ceremony, it is the fix for both directions.

**Trap 4 — a false-positive camper row is irreversible, un-listable, invisible, and Trap 1's
mitigation is prevention-only. This is the most serious consequence in this document.**

Trap 1 establishes that a card the director never looked at is **written**. Trap 4 is what that costs
when the entity is `campers`, and the answer is worse than for any of the existing seven:

- **It never appears in Trash.** `electron/ops/restore.js:80-100` puts `campers` in a block headed
  *"THESE SEVEN ENTRIES ARE A SECURITY BOUNDARY, NOT ONLY A PRODUCT DECISION"*, with the value
  `'refused: PII (ADR D8/D9) — a restore re-materializes a child record from the op-log outside the
  D10 purge path…'`. `RESTORABLE_ENTITIES` (`:111-113`) filters for the literal string `'restorable'`,
  and `trash.js:40` filters `listDeleted()` to that Set. A camper row is therefore **not listable in
  Trash by design** — and that design is load-bearing authorization, not tidiness: the comment records
  that `trash.read` is a blanket staff grant with no entity argument, so this filter is the only thing
  stopping a child's name being enumerated by a non-admin.
- **It cannot be restored.** `restoreEntity` returns `{ error: 'not-restorable' }` before reading any
  op history.
- **Undo Import will not remove it today**, because `campers` is absent from `U2_DELETABLE_ENTITIES`.
  §8.3 changes that — and then §8.3's own ruling makes the deletion **refuse** whenever a run
  references the camper, which is correct but means undo is not the remediation either in exactly the
  case where a bad row has already been used.
- **There is no camper CRUD screen to delete it from.** `src/screens/ElectivesScreen.jsx:12-15`:
  *"No campers roster, no solver (ADR §2)."*
- **There is no UNIQUE on `campers.display_name`** (`schema.sql:1301-1308`), so nothing stops a second
  row for the same child either.

A director confirming the roster stack at 8:30pm without reading it therefore writes a **permanent PII
row with no list, no trash, no restore and no undo**, remediable only through the D10 purge path or
raw SQL.

**Ruling: prevention is the whole answer, and this ADR states that explicitly rather than implying
it.** The reason is not that remediation is hard to build but that every remediation route is a
deliberate closed door: listing camper rows in Trash is the authorization change `restore.js`'s
comment exists to forbid, and a restore path re-materializes a child record outside D10. So the design
does not propose one. What it commits to instead, as S1/S2 requirements rather than good intentions:

1. **The reader runs only behind the declared kind** (§1), so no preference sheet's headers reach the
   camper extractor unasked. This is the T224 fix and the primary control.
2. **`campers` proposals are exempt from Trap 1's unfiltered default.** `ImportScreen.jsx:1253` copies
   every proposed name into `approved`; **`campers` must be opt-in, not opt-out** — an unreviewed
   camper card is held back, not written. This inverts the path's documented over-inclusion bias for
   exactly one entity, and the justification is that the bias's stated cost model — *"a wrong row the
   director deletes costs them a moment"* — is **factually false for `campers`**, because there is no
   way for the director to delete it.
3. **The count is shown before the confirm**, so "47 new children" is on screen rather than inferable
   from a card stack.

Item 2 is the one a Maker could plausibly skip while still shipping something that looks finished.
It is not optional, and it is the reason §12 Q1 is an owner question rather than a Maker question.

**Trap 5 — a denied `campers.read` is swallowed, and campers then duplicate on every import.**
`src/ingest/existingSnapshot.js:30` is `try { return (await list(entity)) ?? [] } catch { return [] }`,
and `:46` loops `INGESTIBLE_ENTITIES` through it. **A rejected read is indistinguishable from "no
campers yet."** With no UNIQUE on `display_name`, the buildPlan diff then proposes every camper as new
and a second import writes a **second row per child** — unremovable per Trap 4. This defeats §4.3's
idempotency claim at the root, since idempotency is computed against a snapshot that silently came back
empty.

**Narrowing, because the code is more specific than the concern.** `existingSnapshot.js:47` scans
`ALWAYS_SCANNED_ENTITIES` (`['locations']`) in **replace** mode and `INGESTIBLE_ENTITIES` only in
**add** mode. So the duplication hazard is **add-mode only**. It is still the common path and still
real.

**Requirement: S1 must distinguish a denied read from an empty table on the `campers` entity** — a
`safeList` that swallows an authorization failure is acceptable for `groups` and not for a table whose
duplicate rows cannot be deleted. The narrowest correct fix is to let the refusal propagate for
`campers` and refuse the import with a readable reason, rather than to widen `safeList`'s contract for
all eight.

**Trap 6 — closing the window mid-confirm leaves the worst available partial state: PII written,
preferences lost.** Entity decisions **persist** — `open_reconciliation_decisions`
(`electron/db/schema.sql:294-314`) is a real host-local table. Bindings do not (§4.1, by design) and
neither does the layout reading (§5, by design). So the director who confirms the camper cards, then
closes the laptop, returns to a roster of children with **no preferences and no way to resume**: the
layout choice that produced the bindings is gone, and re-importing re-derives the bindings only after
they make the same layout choice again.

**The `fixedEvents[]` precedent covers the storage *location*, not the *durability*, and §4.1 overstated
the parallel.** `fixedEvents` are re-derived deterministically from the file with no director input, so
losing them costs nothing. A binding set depends on a **layout choice** that is destroyed with the
session. **Ruling: accepted for S2, with the asymmetry named in the UI rather than papered over** — the
confirmation surface states that the layout is not remembered, so closing mid-flow means re-reading the
file. Persisting the layout (§5, §12 Q2) is what actually removes this, and it is the schema-bearing
slice this ADR defers. A Maker must not "fix" it by persisting bindings; that is a schema change this
ADR does not authorize.

**Trap 7 — Replace mode: the renderer promises what the writer will not do.**
`electron/ops/ingest.js:64-66` `REPLACEABLE_ENTITIES` is a hardcoded five and does **not** include
`campers`. `src/screens/ImportScreen.jsx:317` is
`INGESTIBLE_ENTITIES.filter((e) => e !== 'cohorts')` — a **derived** list, which picks `campers` up
automatically. That count drives the confirmation copy (`:319`), so the director is told a number that
includes campers while the writer clears none of them.

**Ruling: `campers` is NOT added to `REPLACEABLE_ENTITIES`, and `ImportScreen`'s derived list is
narrowed to match by excluding it explicitly alongside `cohorts`.** The reasons run the same direction
as Trap 4: a Replace that cleared campers would delete child records wholesale on an import the
director chose for its *schedule*, and §8.1 establishes there is no FK from `campers.group_id`, so a
Replace that dropped `groups` while keeping campers **silently orphans** them rather than throwing.
Neither half of that is acceptable, so Replace leaves the roster alone and the copy stops claiming
otherwise. A test asserting the two lists' intended **difference** is S1 work — this is the one place
in this design where two lists are correctly not equal, and an unguarded inequality is indistinguishable
from drift.

**Trap 8 — every "Download worksheet" click starts fetching the PII roster.**
`src/utils/downloadWorksheet.js:11-14` loops `INGESTIBLE_ENTITIES` calling `localClient.list(entity)`,
and it is shared by **ImportScreen and RootsHomeScreen**. Adding `campers` makes both screens pull the
roster into the renderer on every click. `SHEET_LAYOUT` (`exportWorkbook.js:48`) is a separate list, so
no camper sheet is emitted today and nothing leaves the machine — but the **read happens**, and
`.catch(() => [])` hides a refusal exactly as Trap 5 does. **Requirement: `campers` is excluded from
this loop rather than relied upon to be dropped downstream by `SHEET_LAYOUT`.** A future `SHEET_LAYOUT`
entry would otherwise turn a silent read into a silent export.

## 10. Retirement path for the bespoke reader

### Consumer inventory (re-verified by grep on this branch, and an earlier draft's version was wrong)

**The earlier inventory missed the MAIN-PROCESS consumer — and it is the writer this design keeps.**

| Consumer | Site | Process |
|---|---|---|
| **`commitElectiveRun`** | `electron/ops/commitElectiveRun.js:23` imports `hasContradictoryRanks`, fired inside `describeElectiveRunRefusal` (~`:45`) | **main** |
| In-app elective panel | `src/screens/elective/assignment/AssignmentPanel.jsx:15` — renderer-side parse, commits via `commitElectiveRun` IPC | renderer |
| Headless CLI | `scripts/preferenceSheetCli.js:33` (`runPreferenceSheetCli`) | node |
| MCP tools | `scripts/mcp/tools.js:16` → `preferenceSheetPreviewTool` (:72), `preferenceSheetCommitTool` (:76); registered in `scripts/mcp/server.js:99,113` | node |
| Browser mock | `src/localClient.mock.js:24` (`hasContradictoryRanks`) | renderer |
| Tests | `src/ingest/preferenceSheet.test.js`, `scripts/preferenceSheetCli.test.js`, `scripts/mcp/tools.test.js`, `scripts/mcp/preferenceSheetE2E.test.js` | — |
| **Test, as a bare string** | `src/engine/findingsLanguage.test.js:110` holds `'src/ingest/preferenceSheet.js'` in `NON_FINDING_MESSAGE_FILES` — **no import edge, so neither `graphify affected` nor ESLint sees it** | — |

**Two consequences, and both change the staging.**

1. **S5's deletion breaks the main process**, not just a renderer and two scripts. `commitElectiveRun`
   is the one writer this whole design *keeps*.
2. **§4.3's rank re-scope is not a reader change.** `describeElectiveRunRefusal`'s docstring
   (`commitElectiveRun.js:28-33`) states that it is exported *"so a PREVIEW can say 'this would be
   refused, and why'… Preview and commit must never disagree about that, which is why this is one
   function called from both rather than a second copy of the wording."* Re-scoping
   `hasContradictoryRanks` from `(camper, rank)` to `(camper, cell, rank)` therefore **lands in the main
   process and changes the refusal wording seen by the renderer, the CLI and the MCP tools
   simultaneously** — plus `src/localClient.mock.js:24`, which must move in lockstep or the browser mock
   and the real app disagree about whether a sheet is refusable.

### The `parsed` output shape S3 changes has ~12 consumers, and none was listed

S3 repoints `AssignmentPanel` onto the binding stream, which changes the `parsed` object shape. Verified
consumers of that shape on this branch:

`src/screens/elective/assignment/ParseSummary.jsx:18` (reads `parsed.sameNameCampers`, and takes
`contradictoryRanks` as a prop) · `ParseSummary.test.jsx:6` · `MappingCorrector.test.jsx:4` ·
`buildAttendance.js:8-12` (**documents the `parsePreferenceSheet → campers[].division` contract in a
comment**) · `src/localClient.mock.js:1680,1694` · `src/localClient.mock.electiveParity.test.js:33` ·
`electron/ops/commitElectiveRun.test.js:43,86,110` · `electron/ops/setElectiveAssignment.test.js:41` ·
`electron/electiveRunOuterSchedule.integration.test.js:127` ·
`electron/electiveRunFinalize.integration.test.js:139,166,419` ·
`test/integration/scenarios/34-locked-seat-survives-regeneration.automerge.js:46`.

**The integration fixtures gate S3.** Per `TESTING_STANDARD.md`, `test:integration` is mandatory for
`database-sync` work and is a `verify` step in its own right, so the two `electron/*.integration.test.js`
files and scenario 34 are not "tests to update afterwards" — they are S3's acceptance surface. Note also
`src/localClient.mock.js:24`, which appears in both lists (the import *and* the shape), and
`findingsLanguage.test.js:110`'s bare string, which no import graph will surface.

### Stages (re-sequenced: the rank re-scope moves out of the reader stage)

- **S1 — `campers` becomes the eighth ingestible entity.** The five arrays and three test sites of
  §8.1, the order assertion of §8.2, the referential ruling of §8.3 (three exemptions converted plus
  `campers.group_id → groups`), the `permissions.js` read/write question of §8.4, and the Trap 4/5/7/8
  requirements. Nothing is retired; a camp roster becomes importable from any file. **Independently
  shippable and independently useful — and the only stage a Maker can start on today** (see §10.1).
- **S2 — the per-cell reader, on the general path, behind the per-page declared kind.** Shapes A/B/C —
  **three readers to write, since `twoRowSplit.js` is not one of them (§5)** — the binding stream, the
  per-page kind declaration of §5.1, and the confirmation surface of §4.2 under `DESIGN_STANDARD.md`.
  Both readers coexist; nothing is deleted. **Carries no rank-check change**, which is why it is now
  separable from S3.
- **S2a — re-scope `hasContradictoryRanks` to `(camper, cell, rank)` with §4.3's four rulings.** Split
  out of S2 because it lands in `electron/ops/commitElectiveRun.js` and changes refusal wording across
  the renderer, the CLI, the MCP tools and `localClient.mock.js` at once. It is a **main-process,
  cross-surface** change and is reviewed as one.
- **S3 — repoint `AssignmentPanel.jsx`** to consume bindings and bind each coordinate to an
  `occurrence_id` against `deriveOccurrences`'s output at solve time (§5's ruling — the caller binds,
  never `commitElectiveRun`). Gated by the ~12 `parsed`-shape consumers above, integration fixtures
  included. **This is the stage that actually fixes the three currently-failing test files**
  (`scripts/preferenceSheetCli.test.js` ×4, `scripts/mcp/tools.test.js` ×1,
  `scripts/mcp/preferenceSheetE2E.test.js` ×2). Until then those failures are a correct signal that the
  bespoke reader cannot express a per-cell preference, and must not be papered over — the same discipline
  `docs/adr/2026-09-26-per-cell-elective-preferences.md` applied to `migrationDomainState.test.js`'s
  deliberate red.
- **S4 — repoint the CLI and MCP tools.** **The MCP tool surface does not change.**
  `preference_sheet_preview` and `preference_sheet_commit` keep their names, arguments and result shape;
  only their implementation swaps. A machine consumer must not have to notice this refactor
  (`project_machine_access`). `runPreferenceSheetCli`'s exported name is likewise kept.
- **S5 — delete `src/ingest/preferenceSheet.js` and its test**, drop the mock's import, and **drop
  `commitElectiveRun.js:23`'s import**, which is the one an earlier draft would have left dangling in the
  main process. Only after S2a, S3 and S4 show green, and after a `graphify affected` pass plus a
  `grep -a` sweep for string references — the three-blind-spots rule in `CLAUDE.md`, which exists because
  the Stage 6c WS-layer deletion missed four dependents to hand-written greps. `findingsLanguage.test.js:110`
  is the known string reference; assume there are others.

**`scripts/preferenceSheetCli.js` is not deleted, it is re-based.** Its header's argument for being a
separate core from `runIngestCli` — *"Teaching runIngestCli to sometimes mean 'preference sheet'
would reopen exactly that hole"* — is the T224 hazard, and it stays correct. What changes is that the
separation becomes a **declared kind parameter** on one shared harness rather than two forked
harnesses, which is the smallest change that keeps the gate and removes the duplication.

### 10.1 Pre-S2 coordination requirement with the peer session holding T266/T267

**Flagged here, not resolved — resolving it is not this ADR's to do.**

T266 (merged, v75, added `activities.catalog_role`) and T267 (v77) are **not on this branch**:
`grep -rn catalog_role electron src` returns nothing here, independently confirmed by Code Reviewer.
§4.2 resolves a preference sheet's choice labels as ordinary `activities` cards — and once `activities`
carries a `catalog_role`, **an activity proposed from a preference sheet's choice column has no role to
assign.** A choice label is evidence that something is electable, which is plausibly a different role
from an activity read off a schedule grid, and this design currently says nothing about which.

**This is a hard prerequisite for S2, not a merge-conflict risk.** S1 does not touch `activities` and is
unblocked. Before S2 is briefed, someone must rebase onto the T266/T267 shape and decide what
`catalog_role` a choice-column-derived activity proposal carries — including whether the director
confirms it. A Maker who meets an unexpected `catalog_role` column mid-S2 will guess, and a wrong guess
here is a silent data-quality defect in the catalog rather than a red test.

## 11. Candidate approaches rejected

Generated under five isolated divergent frames (inversion, regulator, logistics, remove-the-load-bearing-assumption, 3am-on-call), then pruned against the code.

- **Preferences as an eighth/ninth `INGESTIBLE_ENTITIES` member.** The obvious reading of the brief.
  Rejected on §2: `elective_preferences` is run-scoped and `commitPlan` has no run. Would have needed
  a schema change and a second writer.
- **Store bindings with dangling legs and resolve later / placeholder participants.** Attractive, and
  it reuses the sync conflict machinery. Rejected as premature: it requires a persisted
  partially-resolved preference row — a schema change — to solve a problem the in-session hold-back
  already solves. Revisit only if directors actually import across sessions.
- **Confirm per cell on a rendered schedule grid.** The most faithful confirmation surface, and the
  right long-term answer. Rejected for now: it is a screen, not a data path, and the vocabulary-level
  confirmation of §4.2 reduces ~7,200 decisions to a few dozen without one.
- **An overlay document that ingest writes and the schedule reads through, with commit meaning "no
  longer provisional".** Genuinely different and genuinely better on the silent-write trap. Rejected
  as out of proportion: it re-architects `commitPlan` for every entity to fix one import.
- **Infer the document kind from shape.** Rejected as the T224/T223 defect, re-ordered. §1.
- **Skip confirmation for unambiguous bindings entirely, no review at all.** Rejected: §9 Trap 1
  means "no review" and "written" are the same state, and this is PII.

## 12. Open questions for the owner

1. **Does making `campers` ingestible require a `permissions.js` ENTITIES entry, and is that an ADR
   D9 revisit?** §8.4, gate 1. Technical to establish, product to accept. Note it is a **read** question
   as well as a write one (§8.4, Traps 5 and 8).
2. **Should the confirmed layout be persisted per camp** (a returning director skipping the mapping
   step) — the one item here needing a schema version? §5, and Trap 6 is the cost of not doing it.
   Recommended: not yet.
3. **A preference sheet naming a camper in no group at all.** `deriveOccurrences` needs a tier, and
   the tier comes from the camper's group. A grouped-later camper has no resolvable cell. Recommended:
   accept the camper, hold the bindings, surface an `UNGROUPED_CAMPER` finding — consistent with the
   existing `UNTIERED_GROUP` finding rather than a new refusal kind. Needs an owner nod. §8.1 notes a
   second road to the same state: a Replace that drops `groups` orphans `campers.group_id` silently,
   because there is no FK.
4. **NEW — is prevention-only acceptable for a false-positive camper row?** Trap 4 establishes that such
   a row is permanent, un-listable, un-restorable and has no CRUD screen, remediable only via the D10
   purge path or raw SQL. This ADR **rules prevention-only** and states why every remediation route is a
   deliberately closed door. **That ruling is an owner acceptance, not a technical one**, and it carries
   one concrete cost: Trap 4's requirement 2 makes `campers` opt-**in** at the confirmation surface,
   inverting the ingest path's documented over-inclusion bias for one entity. Confirm the inversion, or
   direct that a camper-deletion surface be built first.
5. **NEW — is a per-PAGE declared kind the right granularity?** §5.1 rules yes, on the ground that a
   per-import kind re-introduces the whole-file granularity T223's fix removed. The tradeoff is that a
   director importing a ten-tab workbook makes ten declarations. Confirm, or accept per-import with the
   mixed-workbook hazard named.
6. **NEW — who allocates the schema version if §12 Q2 is ever taken up?** §8 defers it. T266 (v75) and
   T267 (v77) are held by a peer session and are not on this branch (§10.1); v78 is taken by T265 here.
   Any future layout table needs a number the owner allocates after that coordination, not one this ADR
   reserves.

## 13. What changed in round 2, and why it is recorded

Round-2 review by Red Hat and Code Reviewer, run independently, converged on the same defects. The
core data-modelling decisions survived and are unchanged: **Decision 2.1** (`elective_preferences` is
not and cannot be ingestible) and **Decision 4.1** (bindings travel beside `approved`, not inside it)
were both independently confirmed, and the "no schema change" claim was independently verified as true.

What was **wrong** in round 1 is recorded above at each site rather than quietly corrected, because
three of the four errors were errors of *false reassurance* — a safety net cited that does not exist —
and that is the failure mode most likely to recur:

- `src/ingest/ingest.test.js` **does not exist**, and the order assertion this design leaned on was
  imaginary; both real sites compare sorted sets (§1, §8.2). The phantom filename is also written into
  two source comments.
- `campers` in `U2_DELETE_ORDER` goes **second**, after `anchor_activities`, not first (§8.1).
- `campers.group_id` has **no `REFERENCES`** clause; the conclusion held but the reason was false, and
  the falseness is itself a hazard (§8.1, Trap 7).
- `src/ingest/twoRowSplit.js` is **not** a two-row-header reader; Shape A's reader is unbuilt (§5).
- `isDayName` **cannot** detect a Shape B header, so Shapes B and C are not schedule-shaped and §1's
  hazard claim was too broad (§1, Trap 3).
- The consumer inventory **missed the main-process consumer**, which is the writer this design keeps
  (§10).
- `task_class: data-ingestion` was a **deterministic governance red**, not a stylistic choice (§8.5).
