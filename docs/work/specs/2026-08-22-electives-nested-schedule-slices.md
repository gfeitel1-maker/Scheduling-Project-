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
  **location**, **eligibility (who can go)**, and **capacity**. Reuse
  `setupCrudRepository` / `useCrudScreen` and the frozen tokens; Operate-restrained.
  Location/eligibility surface via each offering activity's existing links (do not
  duplicate those models).
  - **Staff DEFERRED (ratified 2026-08-22):** no staffing model exists on
    `activities`; the offering row omits staff rather than fabricate one. Staff-per-
    offering is its own future initiative (a real staffing model). See the parent ADR.
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

## Slice 3a — Detect + nudge + create-empty-set (SHIPPABLE CORE)

**Scoped by the 2026-08-22 Slice 3 architecture pass (ADR §4 addendum).** Honors the
"electives are authored, never reconstructed" invariant by pre-filling the authored
create-path, not bypassing it. Catalog offering-recognition + rule-parsing (former
Slice 3 stretch) **folds into T114** (owner, 2026-08-22).

- **Two detectors** (both log a traceable `{detector, band, sourceExcerpt, row, column}`
  fact; neither writes silently):
  - *Header-label*: a new `ELECTIVE_HEADER_TERMS` controlled vocabulary in
    `extractEntities.js` (chugim/bechirot/electives/indoor elective/elective,
    case-insensitive) — mirrored from `NON_GROUP_HEADERS`'s matching but with the
    OPPOSITE semantics (flag the column, don't drop it). `confirmed` band.
  - *Content-shape*: a cell token that survives `isActivityLike` but matches NO
    existing `activities` row via `recognitionKey`, in a non-header-flagged column →
    `inferred` band. Record as ONE opaque unresolved finding with raw text; do NOT
    delimiter-split into fake offerings.
  - *False-positive guard*: a token resolving 1:1 to an existing activity is exempt by
    construction (no name blocklist).
- **The nudge = a new `elective_candidate` decision kind**, added to
  `reportToLanes.js`'s closed `laneFor()` switch, routed to **hold** (never
  auto-accepts). Create-shaped (no field diff — no elective_set exists yet). Dedup the
  decision id by column-signature so a prior decline doesn't re-surface (verify whether
  a generic dismissed-decision mechanism exists before adding a table).
- **Confirm → create ONE empty `elective_set`** via the EXISTING
  `campScopedEntities.js` authored-write path (not a new INSERT), named the **header
  text verbatim** (editable). Ingest never writes `elective_set_activities`.
- **Success (Tester, real files):** uploading a schedule with a "Chugim"/"Electives"
  period surfaces a hold-lane nudge; confirming it creates an empty "Chugim" elective
  set the director then fills on the Slice 1 screen; declining writes nothing and
  doesn't re-surface on re-import. Verified against the owner's real Camp Aaron/JCC
  files, not a synthetic fixture.
- **Smallest first step (Architect):** implement the header-label detector alone as a
  plan-item annotation and eyeball it against the real files BEFORE touching `laneFor`
  or the write path.

## Slice 3b — catalog offering-recognition + narrow rule-parsing (FOLDED INTO T114)

Not built here. Catalog activity-name matching (`recognitionKey`/`normalizeName`) +
narrow verbatim-quotable phrase parsing (DOUBLE PERIOD→span; sign-up-for-both→linked)
with per-field `import_evidence` provenance (needs a new `entity_type` value). Freeform
eligibility prose stays a manual field — no NLP promise. Tracked in
`docs/work/tickets/T114-infer-outdoor-coschedule-alt-activity-rules.md`.

## Slice 3 — Ingest + nudge (superseded by 3a/3b above)
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
