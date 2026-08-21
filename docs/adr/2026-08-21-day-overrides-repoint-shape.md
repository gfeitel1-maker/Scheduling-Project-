---
title: "Day-Overrides re-point — the day_overrides table shape (T108)"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-21
approved: 2026-08-21 (owner: "ratify T108 and build it")
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: [docs/work/specs/2026-08-21-day-overrides-repoint-design.md]
related_adrs:
  - docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
related_tickets: [docs/work/tickets/T108-day-overrides-repoint.md]
archive_when: T108 ships and merges; folded into PLATFORM_STATE
---

# Day-Overrides re-point — the `day_overrides` table shape

Supersedes the *shape* portion of the 2026-08-20 ADR's **D5**, which ratified only the *direction*
(re-point, don't remove) and explicitly deferred the shape to an Architect pass. That pass is
[docs/work/specs/2026-08-21-day-overrides-repoint-design.md](../work/specs/2026-08-21-day-overrides-repoint-design.md);
this ADR ratifies its decisions. It does not re-open the re-point-vs-remove decision (owner-ratified).

## Context

Today's `day_override_templates`/`day_override_template_slots` are a reusable, cohort-scoped, detached
*template* with **no group axis** that **nothing renders** (confirmed: no read under
`ScheduleScreen`/`src/components/schedule/`/`buildSchedule.js`/`weekCatalog.js`). The high-frequency real
job — "this specific day is mostly normal except a few swaps / a group pulled for a trip" — is unserved.

## Decision

### D1 — A new `day_overrides` table, keyed `(schedule_week_id, day_id, group_id, time_block_id)`

A **diff-intent** per cell: `kind` = `swap` (a new `activity_id`) or `pull` (`activity_id NULL`, cell
renders explicitly *pulled*, not "not yet filled"). `kind` is **explicit, not inferred from NULL**
(same reasoning as `schedule_templates.kind` being load-bearing). An optional `note` carries a
director-facing reason ("Trip to lake"), record-and-print. `UNIQUE(schedule_week_id, day_id, group_id,
time_block_id)`. Bound to `schedule_weeks` (FK, non-recurring, camp/season-scoped) — **not** a recurring
`day_of_week` integer, which would ambient-resurrect for future cohorts. Migration **v38** (additive).

### D2 — Route-agnostic by construction: NO `template_id` column

The override never points at a `schedule_templates` row. It is composed as a **render-time diff over
whichever route's already-resolved slots are on screen**, reusing the `template_overlays`/`decideCell`
precedent. This satisfies the plural-candidates ADR (no schedule is canonical) **by construction** — one
authored override applies identically to Manual and Generated without either being designated, and
without a per-route opt-in flag.

### D3 — Engine-blind; regeneration needs no reconciliation

`buildSchedule.js` never reads `day_overrides` and is not modified. Because the override is a *diff over
whatever is there* (not a replacement row), regenerating the Generated route replaces the underlying
`template_slots` row and the override reapplies automatically — no staleness check, no snapshot hash, no
engine change. A now-redundant swap (engine happened to place the same activity) still applies correctly
and is visibly marked, self-correcting on next inspection.

### D4 — Composition ORDER is the one load-bearing constraint

`applyDayOverrides(rawSlots, overridesForWeekDay)` (a new pure function beside `computeWeekClosures.js`)
runs in the `ScheduleScreen.jsx:163-176` `slots` pipe **BEFORE** `withWeekClosureFlags`/`withOverlapFlags`
— so OVERLAP/WEEK_CLOSED evaluate the *post-override* content (a swapped-in activity's contention fires
OVERLAP for free). Getting this order backwards is the one thing Maker must not do. Overridden rows carry
a persisted-through-the-pipe provenance marker `is_overridden` (+ `day_override_id`) so the marker
travels to render AND print, not just a paint-time lookup. `SlotCell` gains a `data-overridden` visual
treatment via the `scheduleGrid.css` exception (new ephemeral cell state = data-attribute + CSS rule, no
new React state, no new token), distinct from OVERLAP styling.

### D5 — Authoring: retire the CRUD screen; explicit "Override this day" mode (owner decision)

`DayOverridesScreen.jsx` (its template/cohort/`frequency_mode` model + sidebar entry) is **removed** — an
unused parallel authoring surface is the exact failure this ticket fixes. Authoring is **in place on the
rendered day** via the T112 `CellInlineEditor` path. **Governor decision (open question 1): an EXPLICIT
"Override this day" mode** — a per-day/route toggle that scopes subsequent cell edits to write
`day_overrides` instead of `template_slots`. Conflating ordinary Manual edits (first-class
`template_slots` writes) with overrides is a category error. The exact gesture/visual is a **Designer**
call before Maker.

### D6 — Owner decisions on the remaining open questions

- **Q2 — `pull` render/print: SHOWN as pulled, not omitted.** A pulled cell renders and prints as an
  explicit "Off"/"Pulled" state carrying the optional `note` ("Trip to lake") — a printed day must show
  *why* a group is out of normal programming, never silently drop the column.
- **Q3 — old-table drop trigger: retire now (v38 additive, no DROP), drop in the NEXT schema-touching
  ticket after T108 ships once Grader confirms the new path is live and no data depends on the old one.**
  Concrete trigger, Article IV-safe (no destructive op in v38; rollback leaves the empty table in place).
- **Q4 — sync-conflict handling DEFERRED, confirmed.** Concurrent same-cell overrides across devices rely
  on the existing per-cell write-queue serialization + op-log last-write-wins, exactly as `template_slots`
  writes behave today. Full conflict UX is a follow-up trigger (real multi-device override usage), not v1.

## Registration surface (the T88 class)

`day_overrides` registered in `electron/ops/projections.js` (fields), `campScopedEntities.js` (parent =
`camp_id`, like `week_activity_exclusions`), `electron/sync` `DOMAIN_TABLE_COLUMNS`, `permissions.js`
(schedule-adjacent camp-scoped), and `src/localClient.mock.js` parity. `recordLabels.js`'s
`day_override_template` entries updated to `day_overrides`.

## Consequences

- **Positive:** the high-frequency override job finally renders, on both routes, without a third canonical
  schedule; the engine is untouched; the leaf grid layer + T112 authoring are reused.
- **Risk / cost:** the composition-order constraint (D4) is subtle — pinned by an explicit test. The
  explicit-mode authoring (D5) is the one piece without an existing precedent — Designer-gated. Removing
  `DayOverridesScreen` discards a shipped (if unrendered) screen — acceptable, pre-production, and its
  model is strictly weaker than the new shape.
- **Reversible?** v38 is additive-only (no DROP); the route-agnostic binding is the one non-obvious
  choice, defended in the design §4 and recorded here.

## Review loop

**Red Hat (challenge this ADR + the design: composition order, route-agnostic binding, migration/
registration completeness, engine-blindness, the write-routing mode) → Designer (the "Override this day"
gesture + overridden-cell + pulled-cell visual/print) → Maker (test-first) → Red Hat verify → Security →
Code Reviewer → Tester (live) → Verifier → Grader.**
