---
title: Electives as a nested sub-schedule — implementation slices
document_type: spec
status: draft
created: 2026-08-22
archive_when: all electives slices ship (merged/deferred) or the parent ADR is superseded
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-nested-schedules-electives-and-events.md]
---

# Electives as a nested sub-schedule — implementation slices

Implements the electives scope of `docs/adr/2026-08-22-nested-schedules-electives-and-events.md`.
The campwide cell stays opaque ("Electives"); the detail lives on a dedicated,
editable elective screen; ingest detects electives in an upload and nudges the
space open. No `campers` roster, no solver.

## Ground-truth first (do before Slice 1)
Verify what the T41 data-shape actually shipped and what any prior peer work
(T105/T110/T111) already built for elective cells/authoring, since ownership just
consolidated here — the campwide-cell render may already exist. Confirm:
`elective_sets`, `elective_set_activities`, `template_slots.elective_set_id`, and
whether any elective authoring/render code is present. Adjust slice scope to the
real delta (don't rebuild what exists).

## Slice 1 — Capacity model + the dedicated elective screen (authoring)
**The "somewhere else that holds the data and is editable."**
- **Schema:** add a **per-offering capacity** column to `elective_set_activities`
  (the deferred `camper_headcount`; nullable = "no cap"). Migration + fresh-vs-
  migrated equivalence; append-last column-order discipline (per the T41/schema
  precedent comments). `database-sync` gate (integration mandatory).
- **Screen:** a dedicated elective screen where a director builds an **elective set**
  = a named period's worth of **offerings**, each carrying: the activity, its
  **location**, **staff**, **eligibility (who can go)**, and **capacity**. Reuse
  `setupCrudRepository` / `useCrudScreen` and the frozen tokens; Operate-restrained.
  Location/staff/eligibility surface via each offering activity's existing links
  (do not duplicate those models).
- **Success:** a director can create "Afternoon Chugim" with N offerings, each with
  location/staff/capacity/eligibility, and edit them; persists + replicates like any
  setup entity; gate green.

## Slice 2 — Campwide integration (opaque cell → drill-in)
- On the campwide schedule, a group's cell referencing an `elective_set` renders the
  opaque **"Electives"** (or the set's name) — NOT the offering detail. Confirm/
  finish whatever T110/T111 shipped here.
- A clear affordance from that cell (or the elective screen in the sidebar) opens the
  Slice 1 sub-schedule screen for that set — the "schedule within a schedule" drill-in.
- **Success:** campwide view stays uncluttered (one "Electives" label); the detail is
  one click away; both schedule routes (Manual/Generated) render the opaque cell
  consistently (engine never assigns into it — T41 posture).

## Slice 3 — Ingest + nudge (discovery-first)
- **Detect:** when an uploaded schedule shows electives in any form — a
  Chugim/Bechirot/"Electives" period label, or a flattened opaque activity cell —
  reconciliation raises a **nudge** ("this looks like an elective period — open the
  elective space?"), never a silent auto-create.
- **Recognize offerings:** pull candidate offerings from an activity catalog
  (Camp Aaron/JCC-style lists) and parse embedded rules (eligibility by
  division/grade, double-period → multi-block span, "limited availability"/counts →
  capacity) using the Slice D inferred-rule machinery (`import_evidence`,
  `CONFIDENCE_COPY`, `plainEvidenceSentence`) — surfaced as reconciliation decisions
  with provenance the director confirms.
- **Populate:** confirmed decisions create/extend `elective_sets` + offerings (+
  capacity where the source gives it).
- **Success (Tester, against a real artifact):** uploading a catalog + a schedule
  that names an elective period yields a nudge and correctly-scoped elective-set
  candidates the director confirms; nothing silently written; verified against one
  of the owner's real files, not a synthetic fixture.

## Non-goals / guardrails
- No `campers` entity, no per-camper rosters/choices (owner: counts only).
- No engine/solver assignment into electives.
- Do not parse event *planning prose* here — that is the event/program layer (its
  own ADR).
- No palette/token changes; Operate restraint on the new screen.
- Colors, motion: reuse the Roots-as-hub tokens/patterns already established.
