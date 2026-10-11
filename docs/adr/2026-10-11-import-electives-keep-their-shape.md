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

**Success predicate.** Import a file with an elective period, then open the schedule: (a) the elective sits in exactly the day, block and groups the file printed it in, on the Manual route and as an input Generate honours; (b) a camp-wide "Electives" is an elective, not a fixed event; (c) a list cell becomes N choices of one set, not one activity named with slashes; (d) the review screen asks at most one question per subject, and an unanswered question never mints a wrong record.

**Non-goals.** No linked bundles inferred from a file (a bundle is a director-authored all-or-nothing claim; imports have no evidence for one). No camper assignment (preference sheets are a separate flow). No new tables. No change to how Generate solves electives.

## Context: the three defects

1. **Camp-wide elective words become fixed events and raise no question.** `buildElectiveCandidates` (`src/ingest/buildPlan.js:299-417`) drops any header finding whose cell text is a known name, and `isKnownName` (`:334-338`) counts a name in `source.fixedEvents` as known; separately a name claimed by the fixed-event pass is skipped as a shape candidate via `claimedEventKeys` (`:340-342`, `:352`). The header terms (`ELECTIVE_HEADER_TERMS`, `src/ingest/extractEntities.js:316`) are exactly the words a camp-wide row prints, so the fixed-event pass wins and the elective detector never sees them. Scorecard: 0 sets on s02, s09, s11, s15, and the Chugim on s06 and s13.
2. **A group-limited elective asks, but confirming keeps only the name.** The card is `elective_candidate` (`src/ingest/reconciliationReport.js:605-636`). Its commit, `commitElectiveCandidates` (`electron/ops/ingest.js:658-690`), appends two ops: `name` and `camp_id`. The candidate record (`buildPlan.js:411`) carries only `detector`, `band`, `sourceExcerpt`, `row`, `column`. Day, block and groups are never even collected. The same header word also still mints a catalogue activity ("Electives" on s04), which Generate fills with ordinary activities.
3. **A list cell becomes one activity named with slashes.** `LIST_SHAPED` (`buildPlan.js:296`) recognises the shape only to ask "is this an elective period", and the one opaque finding is recorded "never split into fake offerings" (`buildPlan.js:290-291`). If the director declines, or the heuristic skips it, the entity pass still mints `Hiking / Fishing / Kayaking / Orienteering / Bocce` as an activity (s04, s06, s08, s13).

## What an elective actually is in the data (verified by reading code)

- Occurrences are derived from `template_slots` cells carrying `elective_set_id`, **not** from `elective_sets.day_id` / `time_block_id` (`src/screens/elective/assignment/deriveOccurrences.js:1-8`; those columns, `electron/db/schema.sql:1141-1151`, are storage-only). A cell is `(template, group, day, time_block)`; the occurrence is `(day, time_block, tier)`, and `group_ids` is derived from which groups' cells carry it.
- Therefore **eligibility ("which groups or divisions") is the set of groups whose cells carry `elective_set_id`**. A division is a tier/group expansion: the groups of that division get the cell. `elective_bundle_tiers` is NOT eligibility; it scopes one activity's linked bundle across tiers (`schema.sql:1357` onward).
- The set's choices are `elective_set_activities` (`UNIQUE(elective_set_id, activity_id)`, `schema.sql:1232-1247`).
- `buildSchedule` treats a cell with `elective_set_id` as authored content, never engine output (`src/engine/buildSchedule.js:351`).

So **no schema change is needed**. The gap is that import creates the `elective_sets` row but never writes the cells or choices.

## Precedence (one bucket per name)

Under the strict amendment of 2026-09-26 (OQ3, answered 2026-10-11) no name sits in two buckets. For a name that could be elective, fixed event, or activity, the order of evidence is:

1. **Exact elective header word** (the `ELECTIVE_HEADER_TERMS` list, whole-cell match) printed in a cell or as a row/column label: **elective period**. It outranks fixed event and activity, because the word's only meaning in a camp schedule is "choose something here", and a fixed event named "Electives" cannot be filled by Generate in any useful way. The fixed-event pass must not claim it and the activity pass must not mint it.
2. **List-shaped cell** (see D3): elective period with N choices.
3. **Fixed event** (existing rules) for everything else.
4. **Activity** is the default for the remainder.

A camp that really has a single non-elective event called "Electives" is the false positive; it is reversible by the one escape answer in the question flow (D1).

## Decision per defect, with options

### D1. Camp-wide and group-limited electives (defects 1 and 2)

- **A. Keep today's design, add data capture only.** Questions stay; the confirm payload gains day/block/groups. Cheap, but defect 1 stays (camp-wide words never reach the detector) and every elective needs an answer. Fails the one-bucket rule (the header word keeps a catalogue activity).
- **B. Classify silently on exact header word; capture shape from the cells; ask only the escape question.** The detector reads the cell positions the parser already has (`row`, `column` on every finding; day, block and group resolve from the grid like any other placement), writes the set plus cells, and shows the result as a classified item with a flag "Read as electives: Tuesday 2:00, Hawks and Owls", with one action "Not electives" (makes it a fixed event, remembered per the answer-memory ADR). Unanswered = stays elective. Matches the owner's "keep their shape" and the fixed-event ADR's "unambiguous evidence is classified silently".
- **C. Always ask, one question per elective, with a pre-filled shape the director edits.** Safest for correctness; but 11 of 15 camps print electives and one question per period (s04 asked 9) is the noise the one-question-per-subject rule exists to stop.

**Chosen: B.** Camp-wide vs limited is not a separate path: eligibility is simply the groups whose cells printed the word (all groups = camp-wide; `elective_sets.is_all_groups` may be written for display only). Odd shapes fall out: one block a week is one cell-set; some days only is cells on those days; "Electives" printed by two of four groups in one block is two groups' cells.

### D2. Mapping a printed period to sets, choices and cells

One elective **period group** = all cells in the file with the same normalized elective name and the same ordered offering list.

| Imported fact | Lands in | Notes |
|---|---|---|
| Elective name ("Electives", "Chugim") | `elective_sets.name` (one row per name; case-insensitive dedupe already in `commitElectiveCandidates`) | Two cell groups with the same name but different offering lists get the name suffixed with day and time ("Chugim (Tue 2:00)") only when the lists differ; otherwise one set. |
| Day + block of each cell | `template_slots` row per cell with `elective_set_id` set (activity ignored, `schema.sql:608-615`), on the same template(s) the import already writes placements to | Not `elective_sets.day_id`/`time_block_id` (unused by placement). Writing the binding columns for display is deferred. |
| Eligible groups / divisions | the `group_id`s of those cells; a division label expands to its groups using the group links the plan already holds (`links.groups`, `divisionSupport`) | No `elective_bundle_tiers` rows. |
| Choices (list cell, or choices printed under the header) | `elective_set_activities` rows (existing activities matched by `recognitionKey`, else created as ordinary activities through the normal entity path) | Uneven counts: each set carries its own N; no padding. |
| A bare word with no list ("Electives") | a set with zero choices | The director fills choices later; Generate leaves the cell unfilled and the existing empty-elective flag says so. It must never be silently dropped to a fixed event. |
| Linked multi-period offering | not imported | `elective_bundles` / `elective_bundle_periods` stay director-authored (T301). |

If the Maker finds the import placement writer (`electron/ops/ingest.js`) cannot emit a `template_slots` elective cell with an `elective_set_id`, that is a code gap, not a schema gap; report it to Governor before improvising. I did not verify this writer (see confidence).

### D3. List-form cells (defect 3)

- **A. Always split on `/`, `,`, `;`.** Fixes s04/s06/s08/s13 but breaks real single names ("Arts/Crafts", "Lunch/Rest Hour") and risks silent catalogue damage.
- **B. Never split; keep one opaque finding, as today.** Safe, but defect 3 stays by design.
- **C. Split silently when the list is unambiguous (a comma or semicolon list, or three or more slash parts), and ask ONE question when ambiguous (exactly two slash parts, "Arts/Crafts"), default one activity.** Unambiguous lists become the choices of an elective set (D2); the original text is never minted as an activity name.

**Chosen: C.** For the ambiguous two-part case the existing catalogue already says whether the name is real (`isKnownName` guard, `buildPlan.js:334`); only an unknown two-part name asks.

## Question flow on the review screen

At most one question **per subject**, where the subject is the elective name (normalized). Id: `elective_period:<normalized name>`, replacing `elective_candidate:<detector>:<column>:<excerpt>` (`reconciliationReport.js:610`), so one name gives one id regardless of detector, matching the `name_kind` precedent. It is keyed so the answer-memory ADR can remember it.

| Situation | Asks? | Wording | Unanswered default |
|---|---|---|---|
| Exact header word (D1) | No; classified-item flag | "Read as electives: Tuesday, 2:00 PM, Hawks and Owls." Action: "Not electives" | Elective set with cells; no activity, no fixed event |
| Unambiguous list cell | No; flag | "Read as a choice of 5: Hiking, Fishing, Kayaking, Orienteering, Bocce." Action: "One activity" | Elective set with N choices |
| Two-part slash, name unknown | Yes, one question | "Is 'Arts/Crafts' one activity or a choice of Arts or Crafts?" | One activity (the name stays as written; nothing is split) |
| "Not electives" or "One activity" | n/a | Remembered through the answer-memory store as a `name_kind`-style decision | n/a |

No banners (flags only, per house rule). Reduced motion: the flag needs no animation; the status text is the feedback (DESIGN_STANDARD sections 5 and 8). Nothing new is animated.

## Reused vs new

Reused: `elective_sets`, `elective_set_activities`, `template_slots.elective_set_id`, `deriveOccurrences`, the `name_kind` question shape, `recognitionKey`, the answer-memory store. New: a shape-capturing candidate record (day, block, groups, choices), precedence changes in the fixed-event and entity passes, an import writer for elective cells and choices. Nothing in `elective_bundles*` is touched.

## Recommendation, confidence, evidence

**Recommend D1-B + D2 + D3-C.** Confidence: **medium (about 70%)**. Evidence for: occurrence derivation reads cells only (`deriveOccurrences.js:1-8`), so capturing cells is sufficient and needs no schema; the scorecard names the exact failing code; the silent-plus-escape pattern already shipped for `name_kind`. Evidence against and risk: I read code only and ran no test or import, so I did not confirm the placement writer accepts elective cells; and "Electives" with no choice list creates empty sets whose usefulness depends on the director's flow. The Maker proves both first with failing tests. Divergence note: the options above were generated in one context, not as isolated parallel branches, to honour the brief's cost limit.

## Open questions for the owner

1. A header word with no list (just "Electives") creates a set with zero choices and an "add choices" flag. Acceptable, or should the import ask what the choices are? (Recommended: acceptable.)
2. Confirm the false-positive stance: a camp whose real event is literally named "Electives" clicks "Not electives" once, then it is remembered. (Recommended: yes.)

## Test plan

- **Repro grids** (the scorecard repro folder, including `repro/r7-electives-for-some-groups.txt`, plus new ones): camp-wide "Electives" in every group; two of four groups; one block a week; only Mon/Wed; a division-labelled column; list cells of 2, 3 and 5 choices; a two-part slash name; a real activity named "Electives" already in the catalogue.
- **Invariants:** after commit no elective-term name is a fixed event or activity (zero exemptions, as in the OQ3 invariant); every written elective cell has an `elective_set_id` whose set exists; the groups of the written cells equal the groups printed; no activity name contains a split list delimiter; at most one decision per normalized elective name; re-import is idempotent (same sets, same cells, no second question).
- **Harness columns:** elective sets created, elective cells written, groups matched / printed, choices per set, activities minted with delimiter characters (must be 0), questions asked per subject (must be at most 1). Re-run the 15-camp scorecard; F6 closes when sets and elective slots are non-zero on s02, s04, s06-s09, s11-s15 and Generate reports elective slots.
- **Test first:** each repro grid as a failing test at the `buildPlan` and `commitIngest` seam before any change.
