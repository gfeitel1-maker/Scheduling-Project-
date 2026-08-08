---
title: "Source Families — What Each Kind of Source Can and Cannot Tell Shoresh"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Source Families

A returning camp already keeps its facts in several different kinds of file: a prior schedule,
a facility list, a staffing sheet, sometimes a single combined workbook. Each *kind* of file is a
**source family**. This document defines the five families and — the load-bearing part — each
family's **evidence boundary**: what it can and cannot tell Shoresh.

This is the input side of the machinery documented in `CURRENT_INGESTION_CAPABILITIES.md`.
Every family is realized as an **adapter that emits exactly one normalized `ReconciliationPlan`**
into the existing read→propose→non-skippable-preview→atomic-commit pipeline. An adapter never
writes SQLite; it produces a plan that the single privileged committer translates 1:1 into
`appendOp` calls (see `CURRENT_INGESTION_CAPABILITIES.md` §1.5).

---

## The governing principle: "not found ≠ parser failed"

A source is silent about a concept it does not carry. When the schedule contains no Programs,
that is **not a parse failure** — a weekly grid does not carry Programs by design, so the current
extractor treats their absence as expected, not as an error (`extractEntities.js:326`, "Programs
really are absent from both layouts"). The reconciler must generalize this: **a family emitting
nothing for a concept means "this source has no opinion here," never "the import broke."** A
concept a family cannot speak to must be left **untouched** in the Camp Model — it must not be
cleared, defaulted, or flagged as missing on the strength of a source that was never going to
mention it.

This principle is what makes each family's *evidence boundary* the central design fact: the
reconciler decides what to write, preserve, or ask about based on which family had authority to
speak, not on whether a field happened to be blank.

---

## Multiple families feed ONE Camp Model

Each family is an **independent adapter**; several can feed the **same Camp Model**, either as
separate files or combined in one workbook. The architecture must support this multiplicity:
per-field **authority belongs to a family** (schedule is authoritative for placements/frequency,
location-config for capacities/space assignment, staffing for assignments), and when two families
disagree on the same field the plan holds **both competing values as a first-class Conflict** —
never last-writer-wins. A combined workbook is not a special case; it is several families' evidence
arriving in one file, each still resolved against its own authority.

---

## The five families

### 1. Schedule source(s)
**What it CAN tell Shoresh.** Programs, units, groups, activities, days, time-blocks, and
recurring fixed events/anchors — plus *observed* frequency (how often an activity appears) and
*observed* eligibility (which groups do which activity). This is the family the current importer
already reads across its 4 real layouts.

**What it CANNOT tell Shoresh (evidence boundary).**
- **Programs/cohorts are absent by design** from weekly grids (`extractEntities.js:326`) — their
  absence is expected, not a failure.
- **No location catalog.** Location text under an activity is currently *stripped and discarded*
  (`textGrid.js:301,349-366`); even where present, a schedule names *where an activity happened*,
  not the camp's set of places, their capacities, or indoor/outdoor status.
- **No staffing.** A grid shows what happens, not who runs it or what qualification it needs.
- **Frequency/eligibility are observations, not rules.** "Swim appeared 4×" is evidence for a
  proposed `min/max_per_week`, presented as a reviewable guess (`inferActivityRules`,
  `ImportScreen.jsx:188-195`), never a durable fact the source asserted.

### 2. Facility / map source(s)
**What it CAN tell Shoresh.** The camp's named **places**: buildings, fields, pools, ranges,
rooms — the raw catalog of spaces from a site map or facility list.

**What it CANNOT tell Shoresh (evidence boundary).**
- **No relationships or usage.** A facility list names the Pool; it does not say which activities
  use it, its capacity, or when it is available.
- **A map label that matches an activity name is a FLAG for a human, never an auto-created
  location** — matching is always scoped to entity type, and a location label must never silently
  become (or outrank) an activity of the same name.
- **No GIS.** Explicit boundary: no coordinates, no walking-distances, no route/spatial
  optimization. The family yields identity (a place exists and is called X), not geometry.

### 3. Location / config source(s)
**What it CAN tell Shoresh.** The operating facts about spaces: **capacities**, **availability**,
**which-activity-uses-which-space**, **simultaneous-use** constraints, and **indoor/outdoor**.

**What it CANNOT tell Shoresh (evidence boundary).**
- **It does not define the schedule.** It constrains where/whether activities can run; it does not
  say what runs when.
- **`indoor/outdoor` is a distinct fact from location identity.** It must map onto the existing
  separate `is_outdoor` boolean and must not be absorbed into the Location entity
  (the engine already treats them separately, `buildSchedule.js`).
- **Contention ≠ availability.** Simultaneous-use (two groups can't share the Pool at once) is
  already an engine factor via string-keyed `locationKey`; a location-**availability** calendar
  ("Pool closed Fridays") is a *separate, optional* concept this family may or may not carry, and
  is not requested by default.

### 4. Staffing source(s)
**What it CAN tell Shoresh.** Staff, **roles**, **qualifications**, durable **requirements**
(an activity needs role/qualification + count, person-agnostic), seasonal **assignments**
(this year's person, replaceable), and temporary **availability** ("out week 4").

**What it CANNOT tell Shoresh (evidence boundary).**
- **These are three distinct things and must not be flattened.** A durable requirement ≠ a
  seasonal assignment ≠ a temporary availability window; collapsing "temporary" into "permanent"
  is a known error to reject (if temporal validity stays a non-goal, a temporary marker is
  *rejected with a flag* at import, not silently flattened).
- **It never blocks scheduling.** Staffing is **never a blocking readiness category** — a schedule
  always generates with zero staffing. Onboarding *captures* these durable facts; full staff
  *scheduling* is a separate future project, and engine enforcement of staffing feasibility is
  deferred to its own tested slice.
- **No PII barrier in the store** (owner decision, 2026-08-08): staffing PII is acceptable in the
  replicated op-log.

### 5. Workbook / paste source(s)
**What it CAN tell Shoresh.** A Shoresh-generated **enrichment round-trip** — the
`ReconciliationPlan` exported as a sheet, pre-populated with **what Shoresh already knows** — plus
clipboard/paste for bulk data entry. This is the volume-data-entry surface.

**What it CANNOT tell Shoresh (evidence boundary).**
- **It is not a bypass.** The workbook re-enters through the **identical non-skippable preview +
  atomic commit** as every other family; it is a *rendering* of the plan, not a shortcut around it.
- **It carries no stable ids until it is generated by Shoresh.** The source-id matching tier is
  dormant for external files (they have no Shoresh ids); it only activates for the round-tripped
  workbook.
- **A plain xlsx cannot encode the blank-vs-clear tri-state.** An empty cell is *both* "leave
  untouched" and "clear this" — so the workbook needs an **explicit clear token**, a decision that
  must be made before this family ships (S4).

---

## Why the boundaries matter

The evidence boundary is not documentation trivia — it drives three reconciler behaviours:

1. **Silence is preserved, not overwritten.** A field no present family has authority over is left
   exactly as it was in the Camp Model (this is the "blank leaves untouched, emits no op" rule).
2. **Disagreement across families becomes a reviewable Conflict**, because authority is per-field
   and per-family, and the plan holds both competing values.
3. **Absence never masquerades as a conclusion.** "The schedule had no location" and "the location
   is unknown" are different states; the second is shown as *worth checking*, not as a confident
   default (the generalization of `eligibility_known`).

For the pipeline these adapters feed — the whitelist, the grid intermediate, the atomic op-log
commit, and the two divergent import paths being unified — see
`CURRENT_INGESTION_CAPABILITIES.md`.
