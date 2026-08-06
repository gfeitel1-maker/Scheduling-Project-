---
title: T49-finish-ingestion
document_type: ticket
status: open
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

Ingestion creates activities, time blocks, and cohorts, but `cohort_activities` (the join) is not
created. The activity exists; the cohort exists; they are not linked. Post-import, those activities
appear in the wrong place or not at all depending on which screen is reading. Root cause:
`INGESTIBLE_ENTITIES` does not include `cohort_activities`.

### T34 — Fixed-event block inference

Camps commonly have fixed-period entries like "Rest Hour 14:00–15:00" that do not move. The
importer treats these as regular activities. They should be recognised as fixed events and ingested
into `fixed_events` (or equivalent), not as schedulable activities. Requires inference heuristics
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

- [ ] T33 resolved: `cohort_activities` created during import, activities appear in the correct cohort on ActivitiesScreen
- [ ] T34 resolved: fixed-event periods are recognised and placed in the correct table, not the activity list
- [ ] T35 resolved: a director can configure a 40-activity import in a single sitting without editing each activity individually
- [ ] T36 resolved: unmatched cells are surfaced in a residual report visible before committing the import
- [ ] End-to-end test: import a real camp file (from `.ingest-incoming/`, never committed) and reach a runnable generated schedule without manual data repair
