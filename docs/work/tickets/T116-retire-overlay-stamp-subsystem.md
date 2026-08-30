---
title: T116-retire-overlay-stamp-subsystem
document_type: ticket
status: completed
created: 2026-08-30
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-30-retire-overlay-stamp-subsystem.md]
archive_when: DONE — shipped. The overlay/stamp subsystem (template_overlays) is fully retired via migration v53: the table and schedule_snapshots.overlays column are dropped, the subsystem is removed from sync/projections/campScopedEntities/restore/duplicateWeek/deleteWeek, and the render layer (FieldTripDrawer, useOverlayFillStamp, OverlayCell, the kind==='overlay' branch) is deleted. Snapshot matching is slots-only. npm run verify green; code-review + Red Hat clean.
---

# T116 — Retire the schedule overlay/stamp subsystem (template_overlays)

Executes `docs/adr/2026-08-30-retire-overlay-stamp-subsystem.md`. Owner-approved
full retirement (2026-08-30). The field-trip stamp/overlay authoring path was
already dead (the Field Trips toolbar control was removed in #222); this ticket
removes the dormant data layer and render code in full.

Hard cutover per the standing pre-production bias — no back-compat shim, the
`schedule_snapshots.overlays` column is dropped outright.

## Outcome

Shipped on branch `feat/retire-overlay-stamp-subsystem`. Recovered from a stalled
Maker (work complete-but-uncommitted); the full gate then caught and fixed real
fallout (a migration test copying the dropped column, a delete-preview counting
retired overlays, an integration scenario planting a template_overlays row, and
stale `affects` references to deleted files). `npm run verify` passes end to end;
code-review and Red Hat both returned clean (Red Hat Resilience 5/5).

Explicitly NOT touched, per ADR §1: the two schedule routes, `day_overrides` /
`applyDayOverrides`, `schedule_weeks`, and `registerOverlayOccupancy` in
`buildSchedule.js` (an unrelated same-named engine concept).
