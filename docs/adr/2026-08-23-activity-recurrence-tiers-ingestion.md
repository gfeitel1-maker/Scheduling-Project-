---
title: "Activity recurrence tiers — truth-status × binding-vector ontology for ingestion"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-23
approved: "Owner-approved 2026-08-23 — ontology selected via divergence pass, this data-model/ingestion design approved with OQ1=two-rows-sharing-a-name, OQ2=keep-column-clarify-label, OQ3=conservative-weekly-detection"
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/camp-setup-ingestion-program.md
  - docs/work/specs/2026-08-23-slice3b-lunch-stagger-design.md
  - docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md
related_adrs:
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
  - docs/adr/2026-08-06-inferred-activity-rules-at-ingest.md
  - docs/adr/2026-08-10-ingestion-evidence-persistence.md
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
  - docs/adr/2026-08-22-events-overlay-placement.md
amends: []
archive_when: Slices 0-5 of the classifier/inference plan below all ship, or this ontology is superseded
---

# Activity recurrence tiers — truth-status × binding-vector ontology for ingestion

## 0. What this ADR is and is not

The owner ran a structured divergence pass and **selected an ontology**: classification moves off
the named activity and onto the *occurrence-pattern* (one activity can carry several patterns).
That choice is **not re-derived or second-guessed here.** This ADR's job is narrower and harder:
design the data model and ingestion pipeline around it, and pressure-test its edges against real
data. Section 1 states the ontology precisely with testable predicates. Section 2 audits current
code against it line by line. Section 3 gives the data model. Section 4 gives the ingestion
design. Section 5 places four real artifacts on the ontology's map and reports where it strains.
Section 6 sequences the work. Section 7 lists open decisions with recommendations.

---

## 1. The ontology, stated precisely

### 1.1 Axis 1 — TRUTH-STATUS

Three values, each a predicate over one **occurrence-pattern** (not over an activity, not over a
single grid cell — a repeated shape the classifier has grouped together):

| Value | Predicate | Canonical examples |
|---|---|---|
| **Asserted** | The pattern's time AND place are *authored and pinned* by the director — the grid cell(s) are the source of truth for exactly when/where this happens, not a placement the engine or a rule may move. | Lunch, Carpool, All-Camp Tuesday, Mifkad |
| **Obligation** | The pattern has a *frequency requirement* (N times per week) but **no pinned time or place** — where/when it lands is open, decided later by an engine round or a director drag. | Rec Swim (2x/week, any period), Sports rotation |
| **Permission** | The pattern is *eligible to be placed*, camper-chosen, and **refusable** — nothing requires it to happen at all for any given camper/day. | Electives, optional advanced lane |

A occurrence-pattern that fails all three (no pinned time, no frequency requirement, not
camper-chosen — i.e. genuinely undetermined) is **not yet classifiable** and must not be forced
into one of the three; see §4.1's refusal gate.

These three are mutually exclusive **per occurrence-pattern**, not per activity — Swim can carry
one Asserted pattern (a fixed instructional block) and a separate Obligation pattern (rotating rec
swim) simultaneously, because they are different occurrence-patterns of the same genotype. This is
the ontology's central move and the reason the current schema's per-activity `priority`/rule
columns are read as *per-pattern*, not per-activity, going forward (see §2.3).

### 1.2 Axis 2 — PER-AXIS BINDING VECTOR

Four independent axes, each **bound** or **free** for a given occurrence-pattern:

| Axis | Bound means | Free means |
|---|---|---|
| **time** | A specific time_block (or period) is fixed for this pattern. | Any available block satisfies it. |
| **group/audience** | A specific, named set of groups/cohorts is fixed. | Camper-chosen or any-eligible-group. |
| **location** | A specific location is fixed. | Any suitable location satisfies it. |
| **day-of-week** | A specific day or day-set is fixed, **and** a granularity value applies: `daily` (recurs every operating day) or `weekly` (recurs once per week on a fixed day-set) — this is not itself a fifth axis, it is the day axis's own bound-value shape. `dateless`/free means no day constraint at all (an Obligation with day free). | No day constraint. |

The **binding vector is the classification**, not a derived label. A staggered per-division Lunch
is `time: bound-per-(group,day)` (a *map*, not a scalar — see §3.3), `group: bound`, `location:
free or bound`, `day: bound, daily`. Rec Swim is `time: free`, `group: often bound (a unit)`,
`location: free`, `day: free`, with the requirement carried instead on a **fifth, orthogonal
field** — frequency (`min_per_week`) — that exists only for Obligation-tier patterns. This
replaces the prior "minor variance" language entirely; a pattern's variance IS its binding vector,
read off directly, not fuzzed into a confidence score.

### 1.3 Genotype → phenotype (storage rule, not a new axis)

Store the pattern once (rule-DNA: name, eligibility, frequency, binding shape) and express
occurrences per (day, cohort) only where the binding vector requires it. This is not new — it is
the existing split: `activities` = genotype, `template_slots` = phenotype (one row per placed
occurrence). Asserted patterns fan out to one `anchor_activities` row per bound day (already true,
`electron/db/schema.sql:470-484`); Obligation patterns store the rule once on `activities`
(`min_per_week` etc., `electron/db/schema.sql:280-286`) and phenotype-express only when the engine
or a director places them into `template_slots`.

### 1.4 Provenance-origin (a facet, not an axis)

Every stored occurrence-pattern and every field on it carries where it came from: `observed-in-grid`
| `parsed-from-prose` | `engine-emitted` | `human-override`. This re-import-safety facet already
exists in two forms in this codebase — `_humanFields` (protects hand-edited fields from being
silently overwritten on re-import, verified live in `electron/ops/ingest.js`, `src/ingest/buildPlan.js`,
`src/localClient.mock.js`) and `import_evidence` (`observed`/`inferred` tag + confidence + support,
`electron/db/schema.sql:120-140`, ADR `2026-08-10-ingestion-evidence-persistence.md`). Both are
reused, not replaced — see §3.4.

### 1.5 Coexist-vs-override (the existing orthogonal axis)

`docs/adr/2026-08-23-unified-schedule-overlay-model.md` (D2) already establishes a second axis
independent of truth-status: **contend-and-coexist** (electives + Asserted recurring events +
Obligation-placed activities compete for capacity and can mark locations full) vs.
**override-and-replace** (special events/special days wholesale replace what a slot would
otherwise hold). One-offs — Color War, trips, special days — sit in the override class and are
**outside the truth-status vocabulary entirely**: they are not Asserted, Obligation, or Permission
in the recurrence sense, because they do not recur. Truth-status classifies *recurring*
occurrence-patterns; override-class items are dated, one-shot, and classified only by
compositing behavior.

### 1.6 The 2D composition map

| | contend-and-coexist | override-and-replace |
|---|---|---|
| **Asserted** | Lunch, Carpool, All-Camp Tuesday (recurring, pinned, still contends for the location/time slot with anything else scheduled there) | *(empty — an Asserted pattern that overrides would just be a special day, i.e. not recurring; see §5 strain note)* |
| **Obligation** | Rec Swim, Sports rotation (frequency rule, engine places it, contends for capacity) | *(empty — same reasoning)* |
| **Permission** | Electives (camper-chosen, contends for capacity/location) | *(empty)* |
| **n/a (one-off)** | *(n/a — one-offs aren't recurring)* | Color War, field trips, Friday special-event days, special days generally |

The bottom-right cell being the *only* populated override cell, and the top-right column being
structurally empty, is not a gap — it is the predicted shape once you accept that
"recurs" and "one-off" are how a pattern enters the truth-status vocabulary at all. This is stated
explicitly so a reviewer does not go looking for an Asserted-override case that the ontology
correctly forbids.

---

## 2. Current-state audit — reuse vs. gap, file:line

### 2.1 Ingest pipeline, read top to bottom

- **`src/ingest/sheetGrid.js`** (`workbookToPages`, 173 lines) — turns a workbook into
  `{ title, columns, rows }` pages. No classification; pure grid normalization. Unaffected.
- **`src/ingest/extractEntities.js`** (652 lines) — builds `proposal.entities.{groups, days_of_operation,
  time_blocks, locations, activities, tiers, cohorts}`. Already carries per-activity scope and
  period signal (`activityNamesFromCell`, `activityPages` keyed by normalized name → group names,
  consumed directly by `activityRules.js`). This is genotype-adjacent data collection; it does not
  itself assign truth-status. **No gap** — it is already the right shape to feed a classifier.
- **`src/ingest/fixedEvents.js`** (`inferFixedEvents`, 377 lines) — **this is the current
  Asserted-pattern detector**, though the ontology did not exist when it was written. Read closely
  (lines 111–338): it collects `(group, day, block, activity, period)` tuples, majority-filters
  per group (`occ * 2 <= operating` drop, line 201), then **collapses across groups by
  `(activity, block, days)`** (line 214, 260) — i.e. it already computes something close to a
  per-(day-set) binding vector, and it already emits `scope.groups` + `days` + `confidence` per
  proposed event (lines 300-312). What it does **not** do: emit a day→binding-vector *map* (defect
  3 below) or recognize weekly (once-per-week, all-camp) recurrence as a distinct day-granularity
  (defect 4 below) — both are binding-vector gaps in a file whose logic is otherwise exactly the
  Asserted-tier grouping the ontology calls for.
- **`src/ingest/activityRules.js`** (`inferActivityRules`, 99 lines) — **the heart of the
  Obligation tier; this is the critical finding.** Read in full (above): for every proposed
  activity it computes `eligible_group_names`/`eligibility_known` from per-group appearance
  counts (lines 67-78), and separately computes `perWeek = round(appearances / eligibleGroupCount /
  days)`, clamped to a floor of 1 (lines 80-88), written as **both** `min_per_week` and
  `max_per_week = perWeek + 1` (line 88). This *is* the Obligation frequency-rule inference the
  ontology needs — **but it treats every activity as Obligation-shaped, unconditionally**. There is
  no branch that asks "is this pattern already Asserted (an already-detected fixed event) or
  Permission (already an elective) before assigning it a frequency rule?" Concretely:
  `inferActivityRules` and `inferFixedEvents` run over the **same raw appearance data**
  independently (both consume `extractEntities`'s output; see `electron/ops/ingest.js:532`'s
  comment on how their proposals are merged) with **no cross-check that an activity name already
  classified Asserted by `fixedEvents.js` does not also get an Obligation `min_per_week` from
  `activityRules.js`.** A daily-pinned Lunch that appears 5/5 days per group will get
  `perWeek = round(5/1/5) = 1` written into `min_per_week`/`max_per_week`, i.e. **it is silently
  double-classified as an Obligation-tier rule on top of its correct Asserted classification**,
  with no signal in the data to tell a director (or a re-import) which one is load-bearing. This is
  a real gap, not a naming problem: it needs the classifier (§4.1) to run *before* frequency
  inference and gate `activityRules.js`'s output to occurrence-patterns not already claimed
  Asserted or Permission.
- **`src/ingest/electiveSetPopulate.js`** (64 lines) — populates `elective_sets` from a proposal.
  Already Permission-tier by construction (a named, camper-facing set of choices). No truth-status
  ambiguity here because electives are only ever created explicitly, never inferred from bare
  grid repetition the way Obligation is. **No gap.**
- **`src/ingest/eventGridPopulate.js`** (106 lines) — populates the `events`/`event_slots` family,
  i.e. override-class one-offs. Outside the truth-status vocabulary by design (§1.5). **No gap
  relative to this ontology**, though see Slice 5 in §6 for its own known deferred work.
- **`electron/ops/ingest.js`** (`commitIngest`, 2109 lines) — the transactional write path. It
  already threads `_humanFields` provenance (searched live, confirmed present) and
  `import_evidence` rows (lines ~887-908, 1149-1190) keyed by field name including
  `eligible_group_names`/`min_per_week`. This is exactly the provenance facet §1.4 calls for,
  already built for the Obligation-relevant fields. **No new provenance mechanism needed** — the
  classifier's job is to decide *which* patterns get which fields, not to invent a new
  provenance system.
- **`src/ingest/preview.js`** (31 lines) — thin re-export/normalize surface for the director
  preview. No classification logic; unaffected.

### 2.2 Schema / engine

- **`activities`** (`electron/db/schema.sql:263-292`) genotype table already carries every
  Obligation-tier field the ontology needs: `min_per_week`, `max_per_week`, `same_tier_only`,
  `eligible_tier_ids`, `eligible_group_ids`, `prefer_before_day`, `prefer_before_day_min`,
  `location_id`. **This confirms the KEY CLAIM for the Obligation tier**: no new table, no new
  column — `activities` ≈ genotype ≈ Obligation-rule storage already, verified at the column
  level, not just by name.
- **`anchor_activities`** (`electron/db/schema.sql:470-484`) — one row per (day, cohort) fan-out,
  `is_all_groups`/`group_ids` scope, plus **`recurrence_level TEXT NOT NULL DEFAULT 'daily'`**
  (line 483, added v42 per the schema comment at line 460, referencing
  `2026-08-23-unified-schedule-overlay-slices.md`). This column is **already exactly the
  day-axis-granularity concept §1.2 needs** (`daily` vs `weekly`) — it shipped in the prior ADR's
  Slice 3a work, before this ontology was named, and needs zero new migration to serve as the
  day-binding-granularity field. **Confirms the KEY CLAIM for the Asserted tier's day axis.**
- **`elective_sets`** (`electron/db/localDb.js`, `ELECTIVE_SETS_DDL`) carries `day_id`,
  `time_block_id`, `is_all_groups`/`group_ids`, `schedule_week_id`, and the **same**
  `recurrence_level TEXT NOT NULL DEFAULT 'daily'` column (v43, per the file's own comment: "added
  v43 (unified-schedule-overlay Slice 3a)"). **Permission-tier binding vector already has its
  day-axis field too** — shipped, not proposed.
- **`template_slots`** (`electron/db/schema.sql:322-329` base + drifted/ALTER-added columns per
  the file's own note at line 321 "Use PRAGMA table_info(template_slots) against a migrated db to
  see all 13" and line 748 "template_slots is a DRIFTED TABLE") — phenotype table, one row per
  placed occurrence, `activity_id`/`elective_set_id`/`event_id` mutually exclusive
  (`MUTUALLY_EXCLUSIVE_FIELDS`, `electron/ops/projections.js:842`). This is the shared phenotype
  surface across all three truth-status tiers once something is actually placed — **no gap**, it
  already treats Asserted/Obligation/Permission/override placements uniformly at the slot level.
- **`src/engine/buildSchedule.js`** — `anchorLookup`/`electiveLookup`/`eventLookup` exclusion sets
  keep the engine from double-placing what Asserted/override tiers already claimed; `placeUsage`
  capacity map is where Obligation-tier and Permission-tier activities actually compete for
  location capacity. The engine-contention gap (elective/anchor/event locations never entering
  `placeUsage`) is **Slice 4, explicitly out of scope for this ADR** — flagged, not re-litigated.

### 2.3 Verdict on the KEY CLAIM

**Mostly confirmed, with one real gap and one real renaming-not-rewriting note:**

- Genotype/phenotype split: **exists**, unchanged.
- Obligation-rule storage (`activities.min_per_week` etc.): **exists**, unchanged — confirmed at
  column level.
- Asserted day-binding granularity (`recurrence_level` on `anchor_activities`): **exists**,
  shipped v42, unchanged.
- Permission day-binding granularity (`recurrence_level` on `elective_sets`): **exists**, shipped
  v43, unchanged.
- Provenance facet (`_humanFields`, `import_evidence`): **exists**, unchanged.
- **The gap is not schema — it's classifier sequencing.** `activityRules.js` (Obligation
  inference) and `fixedEvents.js` (Asserted inference) run as two independent, uncoordinated
  passes over the same raw data with no shared notion of "this occurrence-pattern already has a
  truth-status." That is a **pipeline-ordering gap**, addressed in §4.1, not a schema gap.
- **One thing does need a genuinely new, small field**: the per-day binding-*map* for a
  day-varying pattern (defect 3, §4.2) has no home today — `anchor_activities` fans out to one row
  per day already, so a day-varying binding vector (Wednesday's Alufim having a different
  group-scope than Monday's) is representable as *distinct rows*, but the ingestion code
  (`fixedEvents.js`'s day-set collapse key, line 260) currently collapses across days that don't
  match into being dropped rather than kept as distinct rows. This is a **detector fix, not a
  schema change** — see §4.2 defect 3.

The claim "minimal migration, not a rewrite" holds. The single schema-adjacent addition proposed
in §3 is a director-facing classification field that names which truth-status tier the director
confirmed, on the genotype record — everything else is ingestion-logic sequencing.

---

## 3. Data model

### 3.1 Principle

Reuse first. The only genuinely new persisted concept is **"which truth-status tier did the
director confirm for this occurrence-pattern"** — everything else (binding vector, frequency,
scope, day granularity, provenance) already has a column. Nothing in this section proposes a new
table.

### 3.2 New column: `activities.recurrence_truth_status`

```
ALTER TABLE activities ADD COLUMN recurrence_truth_status TEXT;
-- values: 'asserted' | 'obligation' | 'permission' | NULL (not yet classified / genuinely mixed)
```

Why on `activities` (genotype) and not on `anchor_activities`/`elective_sets`/`template_slots`:
an occurrence-**pattern**'s truth-status is a property of that pattern, and an activity can carry
more than one pattern (Swim: Asserted + Obligation). Storing a single enum on `activities` would
therefore be **wrong for the multi-pattern case** — flagged explicitly as the one place this ADR's
storage choice needs a director-facing decision, not a technical one; see Open Decision OQ1 (§7).
The recommended default (OQ1) is: store `recurrence_truth_status` on `activities` for the common
single-pattern case (the large majority of real activities — see §5's map, only Swim among the
four real artifacts is genuinely multi-pattern), and represent the rare multi-pattern case as **two
separate `activities` rows sharing a name** (e.g. "Swim" and "Swim (rec)"), the same mechanism
`fixedEvents.js`'s `dualUseNames` heuristic (line 340-363) already half-detects today — a
dual-use name is exactly a name whose occurrences split across two truth-status tiers. This reuses
an existing signal instead of inventing multi-valued storage.

This is the **only new column** this ADR proposes. It is purely descriptive/UI-facing — no engine
code reads it; `buildSchedule.js` continues to key off `anchorLookup`/`electiveLookup`/
`min_per_week` presence exactly as it does today. Its only consumers are the ingestion classifier
(writes it) and any future UI surfacing "why is this an Obligation vs Asserted" to a director
(reads it, out of scope here).

### 3.3 Day-varying binding as a map, not a scalar (no schema change)

`anchor_activities` already fans out to one row per (day, cohort) — the day-varying binding-vector
IS that fan-out, not a new representation. The fix for defect 3 (§4.2) is entirely in
`fixedEvents.js`'s collapse logic: stop requiring every day sharing an (activity, block) to share
the *same* group-scope before being kept (today's collapse key at line 260 is
`(activity, block, days-joined)`, which silently drops a day whose group-scope differs enough to
fragment the days-set below majority). The fix is to collapse by `(activity, block)` **and then
emit one `anchor_activities` row per distinct (days-subset, scope) pairing** rather than one row
requiring full day/scope agreement — i.e. treat the day axis as genuinely a map from day → scope,
which the *table* already supports (multiple `anchor_activities` rows, same activity name,
different `day_id`/`group_ids`) even though the *detector* today collapses to a single scalar
before emitting.

### 3.4 Provenance facet — reuse `_humanFields` + `import_evidence` as-is

No new provenance mechanism. `recurrence_truth_status` gets one more `import_evidence.field`
value (`'recurrence_truth_status'`) alongside the existing `'eligible_group_names'`/
`'min_per_week'`/`'days'`/`'scope'` set (schema.sql:130-140), tagged `observed` when the
classifier read it directly off repeated grid structure or `inferred` when it required frequency
extrapolation, with `confidence`/`support` populated the same way `activityRules.js`
already does (line 94: `support: { matched_groups, appearances, eligible_group_count }`). A
director hand-correcting a truth-status assignment sets `_humanFields.recurrence_truth_status =
true` on the entity, the same mechanism that already protects `min_per_week` and
`eligible_group_names` from being clobbered by a later re-import.

### 3.5 Migration-discipline checklist for `recurrence_truth_status`

This is the full checklist the constitution's migration discipline requires, applied to the one
new column. **Standing hazard, cite verbatim**: the 3a gate for `recurrence_level` (v43) *just
failed* on a missed sibling test/mirror-constant (per the electives migration test comments at
`electron/ops/electivesRegistries.test.js:28-32` and `electron/ops/projections.js:410-416`, both
of which had to be updated in lockstep when `recurrence_level` was added) — treat every item below
as load-bearing, not boilerplate:

1. **Append last.** `recurrence_truth_status` must be the last column in `activities`'s CREATE
   block in `schema.sql`, after `location_id` (currently last, per the comment at
   `electron/db/schema.sql:288-291` explaining exactly this ordering discipline for a
   migrated-vs-fresh-install byte match). Add via `localDb.js` `ALTER TABLE activities ADD COLUMN
   recurrence_truth_status TEXT` at the next migration version.
2. **Fresh-vs-migrated equivalence test.** Extend whatever test currently asserts a fresh
   `CREATE TABLE activities` and a fully-migrated `activities` produce identical `PRAGMA
   table_info` column lists/order — this table has no single `ACTIVITIES_DDL`-style mirror
   constant today (unlike `elective_sets`/`events`/`day_overrides`), so confirm during
   implementation whether `activities`'s migration parity is asserted structurally elsewhere
   (`electron/db/localDb.migrations.test.js` is the likely home) and add the new column to that
   assertion. **Do not add a new `ACTIVITIES_DDL` mirror constant unless one doesn't already
   exist for another reason** — matching existing convention, not inventing a new one, per
   karpathy "surgical changes."
3. **Version canary bump.** `CURRENT_SCHEMA_VERSION` in `electron/db/localDb.js` increments by
   one; the schema-too-new guard (`openLocalDb`, confirmed live above) depends on this being
   exact.
4. **`undoReferences.schemaParity`** (`electron/ops/undoReferences.js`) — `recurrence_truth_status`
   is not a `*_id`/`*_ids` foreign-key-shaped column, so it likely does **not** need registration
   there (that registry is for undo/redo reference-repointing on ID columns). Confirm this
   negative during implementation rather than assuming it — the standing hazard above is exactly
   "assumed it didn't apply, it did."
5. **Projections / `DOMAIN_TABLE_COLUMNS` / `MOCK_WRITE_ALLOWLIST` / `projectionsCoverage`
   parity.** `electron/ops/projections.js`'s `PROJECTIONS.activities.fields` list must include
   `recurrence_truth_status` (mirrors how `recurrence_level` was added to
   `PROJECTIONS.elective_sets.fields` at `electron/ops/projections.js:275,416` for exactly this
   reason). `src/localClient.mock.js`'s activities mock-write allowlist needs the same field
   added — this is the sibling-test class that broke on the 3a gate; the sibling here is whatever
   test asserts `activities`' PROJECTIONS field list matches its real columns
   (`electron/ops/campScopedEntities.test.js` or an activities-specific projections test is the
   likely home; confirm exact filename during implementation, do not guess).
6. **No IPC surface change.** `recurrence_truth_status` is written the same way `min_per_week` is
   — via the existing `write`/`bulkReplace` IPC on the `activities` entity — so
   `electron/ipcSurfaceParity.test.js` needs no new handler, only the field-list update in (5).

---

## 4. Ingestion design

### 4.1 The classifier

**Sequencing fix, not a new module.** Insert a classification pass between entity extraction and
the two existing inference passes:

```
extractEntities()  →  classifyOccurrencePatterns()  →  { fixedEvents pass restricted to 'asserted' candidates,
                                                           activityRules pass restricted to NOT-'asserted' candidates,
                                                           electiveSetPopulate pass restricted to explicit elective sheets }
```

`classifyOccurrencePatterns` does not replace `fixedEvents.js`'s grouping logic (which is already
the right binding-vector computation, per §2.1) — it runs `inferFixedEvents` first (unchanged),
and passes its output as a **denylist of activity names already claimed Asserted** into
`inferActivityRules`, which gains one new parameter (`excludeNames: Set<string>`) and skips any
activity name already in it. This is the entire fix for the double-classification gap in §2.1 — a
sequencing and parameter change to two existing pure functions, not new inference logic. Testable
predicate for the classifier's core decision: **an occurrence-pattern is Asserted iff
`inferFixedEvents` already grouped it with `confidence` present (high or low — a low-confidence
Asserted guess is still an Asserted-shaped hypothesis, not a demotion to Obligation)**; everything
else that repeats ≥2 times gets Obligation-tier frequency inference; everything sourced from an
explicit elective-sheet parse is Permission-tier by construction and never enters either
inference pass.

**Regulator-frame requirements** (from the divergence pool, adopted): the classifier must (a)
refuse to write a truth-status for any occurrence whose provenance-origin cannot be traced to a
specific source page/row (no best-guess default — matches the existing "ambiguous → null/fallback"
philosophy `activityRules.js` line 74-78 already follows for eligibility, extended to truth-status
itself); (b) never let a single ambiguous grid cell escalate a pattern from Permission to
Obligation without at least the existing 2-appearance corroboration threshold
(`AMBIGUOUS_APPEARANCE_THRESHOLD = 2`, already present, reused unchanged); (c) quarantine
header-artifact-shaped detections (defect 5) rather than default them into `activities` — see 4.2.

### 4.2 The five detector defects — current → required

1. **One Lunch → N rows by time-block.** *Current:* `fixedEvents.js` groups tuples first, then
   collapses by `(activity, block, days)` at line 214 — a shared name across two blocks (e.g. a
   camp that labels Lunch differently per period) produces two collapse keys, two proposed
   events. *Required:* before the block-keyed collapse, run a name-normalized pre-merge pass that
   treats two blocks as the *same* Asserted pattern's staggered occurrences when their group-sets
   are disjoint or near-disjoint (the staggered-lunch shape) — this is exactly what the already-
   shipped `docs/work/specs/2026-08-23-slice3b-lunch-stagger-design.md` designed and is Slice 3b
   in §6, not new work invented here.
2. **Fragmentation by incidental day-set diffs.** *Current:* the collapse key includes the exact
   `days.join(',')` (line 260), so a group present Mon/Tue/Wed/Thu and another present
   Mon/Tue/Wed/Thu/Fri (because one cohort has Friday programming the other doesn't) produce two
   events instead of one Asserted pattern with a day-varying group scope. *Required:* the §3.3 fix
   — collapse by `(activity, block)` only, emit **multiple** `anchor_activities` rows (one per
   distinct day-subset/scope pairing) rather than requiring day-set equality to merge at all.
3. **Day-varying block dropped (Wednesday Alufim vanishes).** *Current:* same root cause as (2) —
   if Wednesday's occurrence has a different group-scope than the Mon/Tue/Thu/Fri majority, the
   majority-filter (line 201, `occ * 2 <= operating`) can drop Wednesday's tuple entirely before
   it ever reaches the collapse step, because it's evaluated per-group in isolation rather than as
   a legitimate day-varying member of the same pattern. *Required:* the day-varying-map fix in
   §3.3 makes Wednesday's occurrence a *first-class row*, not a minority to be filtered — the
   majority threshold should apply to "does this (group, block, activity) happen often enough to
   be Asserted at all," not "does it happen on the same days as everyone else."
4. **Weekly single-day events land in `activities`, not surfaced as recurring.** *Current:*
   `fixedEvents.js`'s day-set collapse has no day-*count* granularity concept — a pattern that
   occurs once, on the same day, every week (All-Camp Tuesday) looks structurally identical, from
   one week of import data, to a genuinely one-off Tuesday activity, so it never reaches the
   fixed-event proposal path at all and is silently absorbed into the bare `activities` list.
   *Required:* this is **the exact gap the prior ADR named and deferred as Slice 2b** ("weekly
   Asserted detection") — a single week of import data cannot, by itself, prove weekly recurrence
   (that requires either explicit prose ("every Tuesday") or a second imported week to compare
   against). The classifier's honest answer for a single-file import is: **propose it as a
   low-confidence Asserted-weekly candidate when the source is a per-group grid with only one
   occurrence of that (activity, day) pair across the whole file AND the activity name matches an
   All-Camp/whole-unit scope pattern**, with confidence forced to `low` and provenance
   `observed-in-grid` — never silently promoted to `high`. A second corroborating import (or
   explicit prose, per artifact 2 in §5) can raise it later. This is Slice 2b's scope, sequenced
   in §6, not solved definitively by this ADR.
5. **False positives from header artifacts ("CIT Block 1/2/3").** *Current:* `isBlockLabel` (line
   50-55) treats any row label matching a time-shaped regex or an already-known block name as a
   period row; a header row that happens to read "CIT Block 1" satisfies neither test directly but
   downstream activity-name extraction can still misread a repeated header structure as an
   activity. *Required:* per the regulator-frame requirement (c) above — quarantine rather than
   guess. A detected name that (i) appears only in header/title positions across pages (never in a
   body cell under a real time-shaped row) and (ii) matches a `Block \d+`-shaped pattern should be
   written to a **holding set surfaced in the preview as "possible headers, not activities"**
   rather than defaulting into the `activities` proposal list — reusing the existing preview
   confirm/reject UI (the director already unticks wrong `fixedEvents` proposals; this is the same
   interaction pattern applied to a new quarantine bucket, not new UI).

### 4.3 What the director sees

Every classifier output — Asserted, Obligation, or quarantined-unclassified — surfaces through the
**existing** preview/confirm flow (`src/ingest/preview.js` + whatever screen consumes it), with:
confidence (`high`/`low`, reusing `src/ingest/confidence.js`'s `CONFIDENCE`/`classifyConfidence`
already used by both `fixedEvents.js` and available to the classifier), and the `support` object
shape `activityRules.js`/`fixedEvents.js` already populate (matched groups, appearances,
occupied/operating days, weakest contributor) extended with one more field: `truth_status_basis`
— a one-line string like `"grouped as a pinned event by fixedEvents (confidence: low, 4/6 days)"`
or `"appeared 6x across 5 groups → frequency rule 2x/week"` — so a director asking "why is this an
Obligation and not Asserted?" gets the same evidence-persistence answer `import_evidence` already
gives for other inferred fields (ADR `2026-08-10`), not a new explainability system.

---

## 5. Real-artifact pressure test

| Case (source) | Truth-status | Binding vector | Compositing | Strain |
|---|---|---|---|---|
| Staggered per-division Lunch (owner's 2 xlsx) | Asserted | time: bound-per-(division,day) map; group: bound; day: bound, daily | coexist | None — this is the worked Slice 3b case, the ontology fits exactly. |
| All-Camp Tue/Thu (owner's 2 xlsx) | Asserted | time: bound; group: bound (all); day: bound, **weekly** (twice-weekly, not once) | coexist | **Moderate strain**: the day axis's binary daily/weekly granularity (§1.2, `recurrence_level`) does not natively express "twice a week, specific days" — it expresses "recurs every week on this day-set," which the existing `days: string[]` field on the proposal already carries (Tue+Thu as a set), so `weekly` + a day-set of size >1 is representable, but the *name* `recurrence_level='weekly'` reads misleadingly singular. Recommend documenting `weekly` as "recurs on this fixed day-set every week" rather than renaming — no schema change, a docs/label clarification only (folded into Open Decision OQ2). |
| Nested double-block Swim w/ internal micro-schedule (ALL 2025 Bunk Schedules pdf) | Asserted (outer block) **+** a second, structurally separate Obligation or Asserted pattern for the internal micro-schedule | outer: time bound (two contiguous blocks), group bound; inner: time bound *within* the outer span, own sub-audience | coexist (outer contends for the double-block; inner is invisible to the outer engine) | **Real strain, honestly reported**: the ontology's binding vector is defined per occurrence-pattern at the `template_slots`/`anchor_activities` granularity, and this case has a pattern *nested inside* another pattern's time span. Nothing in this ADR's data model represents that nesting — it is out of scope (matches the engine-contention Slice 4 boundary already drawn in the prior ADR) and should not be forced into the binding-vector model here. Flag as a genuinely separate, future data-model question (own future ADR if it recurs enough to matter), not solved by pretending the two-axis model already covers it. |
| Prose rules — "2x/week", "TAVOR only", "period 3 only" (Camp_Aaron activity-list pdf) | Obligation ("2x/week"), with location/group binding language ("TAVOR only") and time binding ("period 3 only") layered on top of an otherwise-free Obligation | time: bound if "period 3 only" stated, else free; group: bound if named; location: bound if named; frequency: explicit | coexist | **None** — this is the cleanest case for the ontology: prose gives the binding vector directly per axis, no inference needed, `provenance-origin = parsed-from-prose`. Confirms the two-axis model reads naturally off explicit rule text, not just grid repetition. |
| Friday "Special Event and Mitzvah Project" (ALL 2025 Bunk Schedules pdf) | n/a (override class) | n/a | override-and-replace | None — correctly falls outside truth-status per §1.5; this is exactly the bottom-right cell of the composition map. |
| Header artifact "CIT Block 1/2/3" (ALL 2025 Bunk Schedules pdf) | n/a (quarantined, not classified) | n/a | n/a | None once defect 5's quarantine fix (§4.2.5) lands — currently strains the *detector*, not the ontology; the ontology correctly has no slot for "not actually an occurrence-pattern at all," which is the right answer, not a gap. |

Overall: the two-axis model holds for 5 of 6 real cases with no strain, holds for the twice-weekly
All-Camp case with a labeling clarification only, and correctly identifies one case (nested
double-block Swim) as genuinely outside its current scope rather than silently mis-modeling it.

---

## 6. Slice plan

Small, reversible, test-first, each independently gated — sequencing what is already designed or
partially shipped as **cases of this ontology**, not reinventing any of it:

1. **Slice 0 (in progress per memory, unchanged by this ADR):** `fixedEvents.js` collapse-key and
   non-time-label bugs — this is where defects 1-3 (§4.2) actually get fixed. No new scope added
   by this ADR; this ADR names *why* the fix is correct (it's the Asserted-tier binding-vector map,
   §3.3), it does not change Slice 0's plan.
2. **Slice 3b (already designed, `docs/work/specs/2026-08-23-slice3b-lunch-stagger-design.md`):**
   the staggered-Lunch worked example — ships as the concrete implementation of defect 1's fix.
3. **New, small: classifier sequencing (§4.1).** Add `excludeNames` param to
   `inferActivityRules`, call `inferFixedEvents` first in `electron/ops/ingest.js`'s orchestration,
   pass its confirmed names through. Test-first: a fixture activity appearing 5/5 days for one
   group must NOT receive a `min_per_week` proposal once it's also proposed as a fixed event.
   Gate: existing `ingest.activityRuleProvenance.test.js` and `ingest.test.js` extended, not
   replaced.
4. **New, small: `recurrence_truth_status` column (§3.2, §3.5 checklist).** Additive migration
   only; classifier writes it; no engine consumer. Gate: migration parity test + projections
   parity test per the checklist.
5. **Slice 2b (deferred by the prior ADR, sequenced here as defect 4's fix):** weekly Asserted
   detection — low-confidence single-occurrence-per-week proposal, per §4.2.4. Depends on Slice 0
   and the classifier sequencing (step 3) being in place first, since it reuses the same collapse
   machinery.
6. **Slice 4 (prior ADR, unchanged, out of scope here):** engine Obligation/location contention —
   `placeUsage` capacity map gaining anchor/elective/event locations. Named, not re-scoped.
7. **Slice 5 (prior ADR, unchanged, out of scope here):** override-class special-day ingest.
   Named, not re-scoped.
8. **Defect 5 quarantine (§4.2.5):** small, independent of the above — a holding-bucket addition
   to the preview flow. Can ship any time after Slice 0.

---

## 7. Open decisions for the owner

> **RESOLVED 2026-08-23 (owner):** OQ1 → **two rows sharing a display name** (reuse `dualUseNames` to *suggest* the split; validate the heuristic against real re-import data before it ships). OQ2 → **keep the column, clarify the label only**. OQ3 → **conservative weekly detection** (all-camp/whole-unit names only, forced low-confidence, never auto-confirmed). The original decision text is retained below for rationale.


**OQ1 — multi-pattern activities: one row with an enum, or two rows sharing a name?**
Recommendation: **two rows sharing a display name** (e.g. "Swim" / "Swim (rec)"), reusing the
`dualUseNames` signal `fixedEvents.js` already computes (line 340-363) to *suggest* the split to
the director rather than silently auto-splitting. Confidence: **high** that this is the smaller,
safer change (no multi-valued column, no new UI concept — a director already understands "two
activities with related names"); confidence **medium** that `dualUseNames`'s existing heuristic is
precise enough to drive the split suggestion without producing false splits on real data — this
should be checked against actual re-import data before Slice 3/4 ships it, not assumed correct
from the code alone. Operational tradeoff: a wrong auto-split costs a director an extra untick/
merge action; a forced single-enum column costs future rework the moment the first real
double-pattern activity is encountered (already true today — Swim, per this ADR's own example).

**OQ2 — is `recurrence_level='weekly'` the right label for a twice-weekly day-set, or does it need
a rename/clarification?** Recommendation: **keep the column, clarify the label only** ("recurs on
a fixed day-set every week," not "recurs once a week") in whatever UI copy surfaces it.
Confidence: **high** — this is a documentation fix, not a data model change; the underlying
`days: string[]` already carries the day-set correctly, per §5's All-Camp Tue/Thu row. Operational
tradeoff: negligible either way; flagging only so a future reader doesn't assume "weekly" implies
"once."

**OQ3 — how aggressively should the weekly-Asserted detector (Slice 2b, defect 4) propose from a
single week of data?** Recommendation: **conservative — only propose when the activity name
matches an all-camp/whole-unit scope AND appears exactly once in the file**, forced to
`confidence: low`, never auto-confirmed. Confidence: **medium** — this is a genuine judgment call
about false-positive tolerance with only one real data point (the owner's All-Camp Tue/Thu, which
is *not* single-occurrence and so doesn't validate the single-occurrence heuristic directly).
Operational tradeoff: too conservative means a director manually adds weekly events the tool could
have caught; too aggressive means false "Asserted weekly" proposals cluttering every review with
noise from genuinely one-off Tuesday activities. Recommend starting conservative (fewer false
positives) since `fixedEvents.js`'s own stated design bias elsewhere in the file is "over-inclusion
is deliberate... a wrong one costs an untick" — but weekly-from-one-week-of-data is a weaker signal
than the daily-majority case that bias was written for, so the same bias should not be applied at
the same strength without owner sign-off.

---

## Recommended path

Treat this ontology as confirmed by the schema audit in §2: `activities`, `anchor_activities`,
and `elective_sets` already carry essentially every column the truth-status × binding-vector model
needs (`min_per_week`/`eligible_group_ids` for Obligation, `recurrence_level` for both Asserted and
Permission day-binding, shipped in v42/v43 before this ontology had a name), so the real work is
not a migration — it is teaching `activityRules.js` and `fixedEvents.js` to stop running as two
uncoordinated passes over the same raw appearances, and teaching `fixedEvents.js`'s collapse step
to keep day-varying and near-day-varying patterns as first-class rows instead of dropping or
fragmenting them. Land the one new `recurrence_truth_status` column (additive, no engine
dependency, full migration-discipline checklist in §3.5) alongside the classifier-sequencing fix in
step 3 of §6, before touching Slice 2b's weekly detection — the weekly case is materially harder
(inferring recurrence from a single week of data) and should not block the mechanical fixes that
are already fully specified.

**Report back — the three truth-status predicates, the biggest gap, strain, and the highest-stakes
open decision:**

- **Asserted**: time AND place authored/pinned by the director, not a placement the engine may
  move. **Obligation**: a frequency requirement (N×/week) exists but placement (time/location) is
  open. **Permission**: eligible-to-place, camper-chosen, refusable — nothing requires it to
  happen.
- **Biggest current-state gap**: `activityRules.js` (`src/ingest/activityRules.js:50-99`)
  unconditionally computes an Obligation-tier frequency rule for every proposed activity,
  including ones `fixedEvents.js` has already correctly classified Asserted — a daily-pinned
  Lunch appearing 5/5 days gets silently double-classified with a spurious `min_per_week=1`
  alongside its correct fixed-event proposal, with nothing in the data distinguishing which
  classification is load-bearing. This is a pipeline-sequencing gap (the two inference passes
  never talk to each other), not a schema gap — fixed by an `excludeNames` denylist, no new
  inference logic.
- **Real-case strain**: low overall. Five of six real cases (from four artifacts across three
  camps) fit the two-axis model with zero strain; the twice-weekly All-Camp case needs a labeling
  clarification only; the nested double-block Swim micro-schedule is the one genuine gap, honestly
  scoped out as a future data-model question rather than forced into the current model.
- **Highest-stakes open decision**: OQ1 (multi-pattern activities — enum column vs. two rows
  sharing a name). Recommendation: two rows sharing a display name, reusing the already-computed
  `dualUseNames` signal, confidence high on the storage choice, medium on whether that existing
  heuristic is precise enough to drive it without owner validation against real re-import data
  first.
