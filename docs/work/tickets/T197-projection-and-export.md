---
title: T197-projection-and-export
document_type: ticket
status: completed
created: 2026-09-17
archive_when: both projections reconcile and the export contract ships
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T197 — Slice 5: projection and export

Child schedules, activity rosters, summary, exceptions, a new JSON contract, and an XLSX workbook —
all generated from **one** assignment run so they cannot disagree. **Blocked on T196.**

## Shape

- **Child schedules** — one row per camper/day/time block, combining inherited group cells with
  elective assignments; activity, location, group, assignment status.
- **Activity rosters** — one row per assignment, grouped by day, time block, activity, camper;
  include the camper's group and count/capacity. The **inverse projection** of
  `elective_assignments`; no second roster table.
- **Exceptions** — unresolved, unassigned, unranked, stale, capacity, eligibility, resource.
- **Summary** — counts by rank received, unassigned count, fill by offering, run identity, source
  hash, route/week/division.
- **JSON** — its own `format_version: 1`. The existing group-schedule contract
  (`src/utils/exportScheduleJson.js:43`) is **not** mutated.

Note the existing elective cell is already non-opaque — `src/utils/scheduleCells.js:68-70` and
`exportScheduleJson.js:38` already enumerate members. The brief assumed otherwise; nothing needs
un-opaquing.

## Distribution: the export IS the staff surface (ADR D9)

Staff have **no in-app read path** to any participant entity. The exported roster and child schedule
are what a counsellor holds, produced by an admin and handed over out of band.

Note how the existing export is gated: `src/utils/exportSchedule.js` and `exportScheduleJson.js` are
renderer-side utilities called from `src/screens/ScheduleScreen.jsx`, with **no `authorize()`
call** — they operate on data the renderer already loaded, so they are gated implicitly by entity
read permissions. For this feature that yields the right result by construction, but it must be
verified rather than assumed: **add no staff-reachable export path**, and assert in a test that a
staff session cannot produce these artifacts.

## Spans (ADR D12)

Exports are not span-aware today — `src/utils/exportSchedule.js:17-27,33-40` resolves each
(group, day, block) independently, so a three-block activity exports as three identical rows. A
child schedule that reads "Swim, Swim, Swim" is wrong output. Handle it here; do not inherit it.
Linked elective assignments have the same shape and the same requirement.

## Finalization snapshot (ADR D6)

A draft run derives non-elective cells from live `template_slots`. **Finalizing writes a
denormalized snapshot** of the outer schedule cells the run's campers occupy, and a final run reads
that snapshot. Without this, a finalized run's exported child schedule silently changes when the
template is later edited, and breaks outright if the template rows are deleted.

## Exit condition

Every child assignment appears exactly once in the matching activity roster, and roster counts
equal summary counts. A child's non-elective cells equal the selected group template. Exports
formula-sanitize user-controlled strings (`src/utils/exportSanitize.js:14,21,28`) — camper names
are user-controlled input. A finalized run exports identically before and after an unrelated
template edit. A multi-block activity and a linked elective choice each render as one span, not as
repeated cells. A staff session cannot produce any of these artifacts.

A printable per-child PDF packet is the next presentation layer over this same projection and is
not built here. Do not block the data model on it.

## Known limits at close (2026-09-26)

`status: completed` is recorded with these gaps stated rather than with `archive_when` narrowed to
match what shipped. Two of the seven exception kinds named in **Shape** above are **not computed**:

- **eligibility** and **resource**. Both are generation/finalize-time findings that are never
  persisted, so at export time there is no stored source to read and no detector exists to
  reconstruct them. They ship as explicitly-named, empty buckets carrying a machine-readable
  `not_computed` marker, so a consumer cannot read an empty bucket as "checked, none found". No
  detector was fabricated and no key was silently omitted — the two available wrong answers.
  Discharging them requires persisting those findings at generation time, which is a separate
  change to the run lifecycle and is not in this ticket's scope.

Also true at close, and not defects to chase:

- The dev mock's `deriveMockOuterRows` is a deliberate simplification: it does not span-collapse
  inherited rows and does not implement the elective-wins exclusion, so mock visuals can differ from
  Electron on exactly those two behaviours. Verify both against `npm run electron:dev`, not the mock.
- Grader never scored this ticket. Round 1's review failure was unambiguous enough that no score was
  needed to choose RETRY, and round 2 was not re-scored. Recorded in the run record as `no-predicate`.
