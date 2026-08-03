---
title: T35-post-import-activity-configuration-at-scale
document_type: ticket
status: open
created: 2026-08-02
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: superseded by an approved design for reducing post-import activity setup
---

# T35 — After an import, configuring activities to be schedulable is too much manual work

**Raised:** 2026-08-02, product owner — imported a schedule, then had to edit **every** activity by
hand to match what the engine needs to generate a schedule. "If you have 50 activities, this isn't an
easy thing. We want easy for a user."

## The gap (by design, and now biting)

Ingest deliberately proposes **entities only** — the activity *names* — and explicitly does **not**
infer a camp's **rules** (ADR §10 non-goals: min/max per week, eligibility by unit/group, priority,
anchoring). Those are director judgements a spreadsheet does not record. Correct call for ingest — but
the consequence is that the moment the import finishes, the director faces 50 freshly-created
activities that are all un-configured, and must open each one to set eligibility, frequency, and
priority before `buildSchedule` will do anything useful. The retyping the feature removed at the
*entity* level reappears at the *rules* level.

## What "done" should feel like (observable)

A director who imports a schedule can get from "activities exist" to "engine can generate" **without
opening 50 activities one at a time** — bulk, defaulted, or assisted, but not one-by-one.

## Option space to explore in the design loop (divergent — decide by comparison, not up front)

The product owner floated two; here is the fuller set to weigh:

1. **Bulk-edit grid.** One table of all activities with their rule columns, multi-select + fill-down
   ("set these 12 to twice/week, eligible for Yeladim"), so a rule is set across many rows at once.
2. **Excel round-trip.** Export the imported activities as a pre-filled template (the app already has
   Download-Template + Import-from-Excel on Activities); the director edits rules in Excel and
   re-imports. Reuses an existing surface; familiar tool; but a second file to manage.
3. **Smart defaults + exceptions.** Create activities with sensible defaults so *most* are immediately
   schedulable, and the director only tweaks the exceptions. Least work in the common case.
4. **Infer eligibility from the grid the import already read.** The source grid shows *which groups do
   which activity* — so eligibility (which units/groups an activity is for) is partially derivable
   from what was parsed, and could be pre-populated as a proposal (still edited, never silent). NB:
   this leans toward the placements boundary and overlaps [[T34]]; scope carefully.

These are not exclusive — e.g. (3)+(1), or (4) feeding (1)'s defaults.

## Process

**UI/UX-significant → Designer leads**, then Architect if any of the options touch a data contract
(e.g. an Excel round-trip format, or storing inferred eligibility). Run the **full agent loop** with
divergent ideation (brainstorming / adhd) on the option space before converging. Sequenced **after
T33** (units must tie correctly first) and independent of the parser-robustness work. Product owner
wants this explored, not a single answer assumed.
