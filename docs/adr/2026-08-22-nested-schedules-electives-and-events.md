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
  (`elective_set_activities`), each carrying **location**, **staff**,
  **eligibility (who can go)**, and **capacity**, edited on a **dedicated elective
  screen**.
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
nudges the elective space open**, recognizing offerings from activity catalogs and
parsing embedded rules (eligibility, double-period, capacity) with the **Slice D
inferred-rule machinery** (`import_evidence`, `CONFIDENCE_COPY`,
`plainEvidenceSentence`). Populating an elective set is a set of reconciliation
**decisions the director confirms** — never silent.

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
