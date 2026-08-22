---
title: "Nested schedules — electives (and events) as sub-schedules within the campwide schedule"
document_type: adr
status: accepted
authority: normative
implementation_state: planned
date: 2026-08-22
approved: 2026-08-22 (owner, after a real-artifacts brainstorm over 9 owner-provided prior-year files; owner consolidated ownership to this session)
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_specs:
  - docs/work/specs/camp-setup-ingestion-program.md
  - docs/work/specs/2026-08-20-group-electives-design.md
  - docs/adr/2026-08-10-ingestion-evidence-persistence.md
  - docs/adr/2026-08-22-roots-as-hub-setup-ia.md
related_tickets:
  - docs/work/tickets/T41-elective-scheduling.md
  - docs/work/tickets/T40-one-day-special-event-schedule.md
archive_when: electives (this ADR) and the event/program layer (its own follow-on ADR) both ship, or this abstraction is superseded
---

# Nested schedules — electives (and events) as sub-schedules

## Context

Program workstreams **W4** (elective + single-day-event ingest) and **W9**
(programming/doc-storage on events) were investigated together against **nine
real prior-year artifacts** the owner provided (2026-08-22): two activity-catalog
PDFs (Camp Aaron / JCC Medford), two standalone event grids (Camp Chai xlsx,
MJCC Memphis), a team-overlay family email (Camp Achva), and freeform planning
prose (Camp Achva "Manor Awakens" programming notes, 2023 Maccabiah). A
structured brainstorm with the owner ("grill me about what these really are")
produced a single unifying abstraction and resolved several model questions that
`docs/work/specs/2026-08-20-group-electives-design.md` had left open or deferred.

The artifacts show that "elective + single-day event" is really **five shapes**,
only some of which are schedule data: elective *offerings* (catalogs with rules
in prose), standalone *event grids*, *team overlays*, freeform *planning prose*,
and *family communications*. Forcing the prose into the period grid would be
wrong — the planning document *is* the artifact for events.

## Decision

### 1. The abstraction: nested schedules
A period (or day) on the **campwide schedule** can be an opaque **container** —
its cell reads simply **"Electives"** (or, later, an event name). The container's
**detail** — a sub-schedule of offerings/stations, each with its own location,
staff, capacity, eligibility — lives on a **dedicated screen**, not on the
campwide grid. The uploaded docs are exactly these sub-schedules: "a schedule
within a schedule," which is why they do not look like the campwide view.

Electives are the **simple** instance of this pattern; the event/program layer is
the **rich** instance. Electives ship first to de-risk the pattern.

### 2. Electives (this ADR's shippable scope)
- **Elective-ness is a property of a period.** On the campwide schedule, a
  group's cell in that period references an `elective_set` and renders the opaque
  "Electives". Per-cell (owner-confirmed): different groups may reference
  different sets in the same period.
- **The sub-schedule is an editable elective set:** its **offerings**
  (`elective_set_activities`), each carrying **location**, **eligibility (who can
  go)**, and **capacity**, edited on a **dedicated elective screen**. Location and
  eligibility are read from the offering's underlying activity (not duplicated).
  - **Staff-per-offering is deferred (2026-08-22, ratified during Slice 1 review):**
    the app has **no staffing model** on `activities` today (confirmed by search —
    only `users.role`). Rather than fabricate one (which would duplicate a model
    that does not exist), the offering row omits staff. Staff-per-offering waits on
    a real staffing model as its own initiative; the Maccabiah `Activity - Person`
    cells that suggested "staff" are an ingest concern for the event layer, not a
    reason to invent a staffing field here.
  - **`camper_headcount` validation (Red Hat/Security, 2026-08-22):** the capacity
    column has client-side clamping (≥0 integer) but no server-side range check at
    op-apply — consistent with the app's existing posture for every integer field
    (`sort_order`, etc.), so it is not singled out with a one-off write guard. The
    field is inert today (nothing reads it). **When T41 wires the engine to consume
    `camper_headcount`, it MUST read defensively** (treat null / negative / non-int
    as "no cap"), validating where the value is consumed rather than at every write.
- **Model delta is small.** `elective_sets` + `elective_set_activities` (T41,
  data-shape-shipped) are the bones. The one real gap is **per-offering
  capacity** — the `camper_headcount` T41 explicitly deferred. Location / staff /
  eligibility ride on each offering's existing activity + `locations` links.
- **No `campers` roster.** Owner decision: individually-picked electives are
  tracked as **offerings + capacity/counts**, never a per-camper roster. This
  keeps the app group-based and avoids a new first-class `campers` entity.
- **No solver.** The director decides; the app holds and displays (same posture
  as T41 and the manual route). The engine never assigns groups/campers to
  electives.

### 3. Events / programs (deferred to a follow-on ADR)
An event is **primarily a structured program**, not a schedule: theme, **stations**
(each with location + materials + description + staff lead), **event-scoped
teams** (temporary groupings of existing groups; scoring per team), and an
**optional** schedule that plugs into the existing `special_days` (full-day
takeover) or `day_overrides` (partial). Schedule-mode is per event: rotate-by-team
or rotate-by-group (owner: both happen). This **fuses W4 and W9**. It is a larger
new capability and gets **its own ADR** after electives lands — the nested-schedule
pattern proven on electives carries over.

### 4. Ingest + nudge (discovery-first)
When an uploaded schedule shows electives **in any form** — a Chugim / Bechirot /
"Electives" period, or a flattened opaque cell — reconciliation **detects it and
nudges the elective space open**, and populating an elective set is a set of
reconciliation **decisions the director confirms** — never silent.

**Addendum (2026-08-22, Slice 3 architecture) — invariant resolution + split.**
The Slice 3 architecture pass established the concrete shape and split it:
- **Standing invariant honored, not broken.** `electron/ops/durableElectiveSets.js`
  states "electives are authored, never reconstructed from a file." Ingest does NOT
  gain a bypass: a confirmed nudge **pre-fills the existing authored create-path**
  (`campScopedEntities.js`) to create ONE empty `elective_set`. It is still authored
  — just seeded from a director-confirmed decision. **Ingest never writes
  `elective_set_activities` directly.**
- **New decision kind, deliberately routed.** `elective_candidate` is added to
  `reportToLanes.js`'s closed `laneFor()` switch, routed to the **hold** lane
  (never auto-accepts), regardless of confidence band — enforcing "never silent".
- **Two detectors:** a header-label detector (a controlled `ELECTIVE_HEADER_TERMS`
  vocabulary — Chugim/Bechirot/Electives/Indoor Elective, mirrored from
  `NON_GROUP_HEADERS` but with the *opposite* semantics: flag, don't drop) and a
  content-shape detector (an unresolved multi-activity blob → inferred band). A cell
  that resolves 1:1 to an existing activity is exempt by construction (no name
  blocklist), guarding the "Free Choice" false positive.
- **Created set name = the header text verbatim** (owner, 2026-08-22): e.g. "Chugim";
  editable afterward on the Electives screen. No app-invented name.
- **SPLIT — Slice 3a ships now, 3b folds into T114.** Slice 3a = detect + nudge +
  create-empty-set. Slice 3b (catalog offering name-matching via the existing
  `recognitionKey`/`normalizeName`, plus *narrow, verbatim-quotable* phrase parsing —
  "DOUBLE PERIOD"→span, "sign up for both"→linked) **folds into T114** (same
  prose→confidence-banded-rule problem). **Freeform eligibility prose** ("Available
  for ARAD CAMPERS Th 3rd/4th…") is NOT honestly parseable into structured rules and
  stays a **manual field** on the Electives screen — no NLP promise. Writing offering
  provenance requires a new `import_evidence.entity_type` value; deferred to 3b/T114.
- **`CONFIDENCE_COPY`/`plainEvidenceSentence` live in
  `src/components/reconciliation/reconciliationCards.jsx`** (not `confidence.js`) —
  correction to §4's original reference.

**Addendum (2026-08-22, panel round 2 — fixes + known limitations).**
- **Header detection is exact-term, not substring.** `isElectiveHeaderText`
  originally matched any text CONTAINING a term (`.includes()`), which fired on
  "Selective Sports" and "Elective A: Ceramics" — a real activity's own name,
  not the period's header. Matching is now exact (`ELECTIVE_HEADER_TERMS.includes(t)`),
  with "outdoor elective" added alongside "indoor elective" so both of the real
  Camp A file's qualified forms stay recognized. The false-positive exemption
  (a name that resolves 1:1 to a live activity) now also applies to the
  header detector's cell-VALUE findings, not just the shape detector — a
  `source: 'cell'` vs `source: 'label'` tag on each header finding
  (`extractEntities.js`) distinguishes the two, since a row/column LABEL never
  doubles as a proposed activity name and stays exempt from this filter by
  construction.
- **Elective-set create is non-atomic by design, and now fails soft.** The
  create runs after `commitPlan`'s own transaction (deliberately — see the
  code comment on why it doesn't need that transaction's atomicity), so a
  failure there (a UNIQUE collision, or any other write error) used to throw
  out of `commitIngest` and read back as "the whole import failed" even
  though the main reconciliation had already committed durably.
  `commitElectiveCandidates` now isolates each candidate in its own
  try/catch and returns `{ created, failed }`; `commitIngest` surfaces
  `failed` as `outcome.electiveSetsFailed`, a soft warning that never
  propagates as a whole-commit failure.
- **Known limitation — rename breaks the dedup match.** The confirmed-decision
  dedup (both `buildElectiveCandidates`'s finding dedup and
  `commitElectiveCandidates`'s existing-row check) now compares
  case/whitespace-normalized names, but the match is still purely
  **name-based**. A director who renames a created elective_set (e.g.
  "Chugim" → "Afternoon Chugim") and then re-imports the same file gets the
  header nudge again, because the live row no longer carries a name the
  normalized check recognizes. With the clearer confirm/decline copy this is
  a decline-able soft suggestion, not a silent duplicate (declining writes
  nothing; confirming again is also harmless — a re-confirm just proposes a
  differently-named set rather than duplicating the renamed one). A real fix
  is a source-signature link between the finding and the created set (e.g. a
  hidden `source_aliases`-style row), tracked as future work, not built now —
  no schema column is added for this in this pass.
- **Cross-device UNIQUE-collision handling — FIXED (2026-08-22, Governor).**
  `elective_sets` has `UNIQUE(camp_id, name)`, so two devices independently
  confirming the same header nudge (or two directors authoring the same-named
  set) before syncing would produce two rows with the same `(camp_id, name)`,
  and replaying one device's `name` op onto the other hits the constraint and
  throws ungracefully in `applyProjection`. **Resolved by registering
  `elective_sets` in `UNIQUE_FIELD_ENTITIES`** (`electron/ops/operations.js`),
  mirroring `locations` (docs/adr/2026-08-15-locations-concurrent-create-
  collision.md). This routes the collision through the same
  `detectUniqueFieldCollision` conflict-resolution path the pre-check at both
  sync write-entry points already uses — and closes the same gap for the
  pre-existing authored elective-set create, not just the Slice 3a nudge.

### 5. Ownership
The peer sessions that previously held the elective authoring UI (T105/T110/T111)
and special-day author UI (T106) are **closed**; the owner consolidated ownership
to this session (2026-08-22). This session owns electives ingest **and** authoring,
and the event/program layer, until noted otherwise. The only still-live peer work
is the arbitrary-length-span "merge" (landed as PR #145).

## Consequences

- **Schema:** one new persistent field (per-offering elective capacity) →
  migration + fresh-vs-migrated equivalence (`database-sync` gate). No `campers`
  table, no new schedule-engine contract.
- **New authoring surface:** a dedicated elective sub-schedule screen — an Operate
  screen, reusing the setup CRUD patterns (`setupCrudRepository` / `useCrudScreen`)
  and the app's frozen tokens.
- **Reuse:** `elective_sets`/`elective_set_activities` (T41), `special_days` /
  `day_overrides` (T40) for the eventual event schedule, Slice D inference, the
  reconciliation pipeline, the T16 dash-split for event grids.
- **Sequenced:** electives first (small, de-risks nested schedules), events second
  (own ADR, the W4+W9 fusion).
- **Non-goals:** campers/rosters; a solver; parsing planning prose into the period
  grid (prose belongs to the event/program document layer, not the campwide grid).
