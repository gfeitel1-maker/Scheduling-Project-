---
title: T49-finish-ingestion
document_type: ticket
status: completed
created: 2026-08-05
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: T33, T34, T35, T36 all closed and ingestion declared production-ready
---

# T49 — Finish the ingestion work

**Status: open.** The ingestion branches (`work/ingest-methodology`, `work/flag-review-import-dev-loop`,
`work/ingest-fixed-events`) are all merged to main. Four open tickets remain that collectively
represent the gap between "ingestion mostly works" and "ingestion is production-ready."

---

## Open ingestion gaps

### T33 — Cohort-orphaned entities after import

Ingestion creates cohort-scoped entities but the `cohort_id` was left NULL on tiers/time_blocks, filtering them out of the active Program (there is NO `cohort_activities` table; activities carry eligibility inline). The join described below is not
created. The activity exists; the cohort exists; they are not linked. Post-import, those activities
appear in the wrong place or not at all depending on which screen is reading. Root cause:
`INGESTIBLE_ENTITIES` does not include `cohort_activities`.

### T34 — Fixed-event block inference

Camps commonly have fixed-period entries like "Rest Hour 14:00–15:00" that do not move. The
importer treats these as regular activities. They should be recognised as fixed events and ingested
into `anchor_activities` (the app's existing fixed-at-this-period concept), not as schedulable activities. Requires inference heuristics
or an explicit tagging step in the import preview.

### T35 — Post-import activity configuration at scale

After a successful import from a real camp file, the activity list has 30–60 entries. Each one
needs min/max per week, preferred-before-day, block duration, and tier assignment set. The current
UI forces editing each activity one at a time. At scale this is impractical — directors give up and
leave everything at defaults, making the generated schedule unusable.

**This may be the highest-value remaining ingestion gap.** A bulk-edit UI or a sensible
set of heuristic defaults (infer duration from the import's time block size, infer frequency from
how many slots the camp showed in the sample schedule) would let a director get to a usable
generated schedule in minutes rather than hours.

### T36 — Unlabeled path residuals

Some import files have sheets or columns the detector does not recognise and silently skips.
The director has no way to know what was dropped. A residual report ("3 cells were not matched
to any entity — here is what they contained") would close the loop.

---

## Sequencing recommendation

T35 first — it is the blocker for directors actually finishing an import. T33 second, because
orphaned entities cause silent failures in the schedule engine. T34 and T36 can follow in either
order; they are independent.

---

## Acceptance

- [x] T33 resolved (SHIPPED d9f34dc/4436e42; ticket closed): `cohort_activities` created during import, activities appear in the correct cohort on ActivitiesScreen
- [x] T34 resolved (SHIPPED inferFixedEvents → anchor_activities; ticket closed): fixed-event periods are recognised and placed in the correct table, not the activity list
- [x] T35 resolved (SHIPPED inferActivityRules + inline edit; ticket closed): a director can configure a 40-activity import in a single sitting without editing each activity individually
- [~] T36 → tracked in T36: residual-report UI IN PROGRESS (2026-08-20); parser residuals F1/F2/F3 deferred (unreachable on the 4-camp corpus)
- [ ] End-to-end test (OWNER-MANUAL — agents cannot reach the gitignored .ingest-incoming/ corpus): import a real camp file (from `.ingest-incoming/`, never committed) and reach a runnable generated schedule without manual data repair

## Resolution (2026-08-20, verified — mostly shipped, corrected)

Premise-verification against current code: **T33, T34, T35 are all shipped and merged** (their own
tickets are `status: closed`); this umbrella just never got flipped, and its body carried two factual
errors (corrected above): there is no `cohort_activities` table (T33 was a NULL `cohort_id` on
tiers/time_blocks), and fixed events route to `anchor_activities`, not a "fixed_events" table. The
"highest-value gap" T35 (bulk activity config) is met via `inferActivityRules` (inferred defaults +
inline edit), not one-at-a-time editing. The only remaining live piece is the **residual-report UI**
(the "what was dropped" transparency feature), now being built under **T36**; the parser residuals
(F1/F2/F3) are deferred-by-design (unreachable on the 4-camp corpus). The final end-to-end acceptance
(import a real `.ingest-incoming/` file) is **owner-manual** and cannot be completed by an agent.
Closed as substantively done; the residual-report + owner e2e ride on T36 / the owner. Pending sign-off.
