---
title: T106-special-day-author-ui
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md]
related_adrs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md]
archive_when: shipped and merged
---

# T106 — Special Day author UI (the single construction surface)

Build the author UI on the shipped v34 `special_days` substrate. A list screen + a grid editor that
**seeds** its time blocks from the camp's `time_blocks` (convenience, not a storage branch), then lets
the director type activities per group×block — creating one-off activities inline via the generalized
in-context-create interaction. Wire the waiting `deleteSpecialDay` cascade to IPC.

## Scope

- `special_days` list + grid editor screen; `SCREENS`/sidebar entry; IPC (create/edit special day + time
  blocks + slots; delete → wire `deleteSpecialDay`); `localClient` wrappers.
- **Record/print notes** (ADR D2): a free-text notes region on `special_days` for the non-schedulable
  data (teams, points, staffing, trip times). Record & print only — never solved. Add structure only if
  a downstream behavior must parse a field.
- Inline activity create reuses `createActivityFromCell`.

## Out of scope

Roots Context wiring (T107); ingest of a special-day file; multi-block spanning; per-cell person column.

## Review loop

**Designer → Maker (test-first) → Red Hat (cascade under live use; seed-not-branch time blocks) →
Security (IPC permissions) → Code Reviewer → Tester → Verifier → Grader.**

## Terminology dependency (2026-08-21)

The `camp-setup-ingestion` peer is landing a terminology-unification (ubiquitous-language) ADR — canonical
labels for unit vs age-division, "programs", "resources"=locations. This author UI labels groups/
locations/tiers, so **inherit the ratified glossary terms** rather than hard-coding drifting labels. If the
glossary ADR hasn't landed when T106 starts, keep user-facing strings centralized/easy to swap. Peer will
ping when the ADR is ready.
