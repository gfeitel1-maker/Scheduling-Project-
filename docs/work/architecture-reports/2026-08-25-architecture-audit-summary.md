---
title: Architecture audit 2026-08-25
document_type: architecture-report
authority: descriptive
status: active
date: 2026-08-25
---

- **Extract a SlotOccupant seam from `src/screens/schedule/useSlotMutations.js`** (1833 lines) — the `{ activity_id, elective_set_id, event_id }` occupant triple appears 31 times across three near-identical placement handlers with no lockstep guard; a small pure occupant module collapses them to one. HIGH leverage.
- **Deduplicate the ingest-commit logic in `src/screens/ImportScreen.jsx`** (1764 lines, now the largest screen) — its reuse branch re-inlines the `recurrence_truth_status` ratchet already owned by `src/ingest/twoRowSplit.js:87`, risking divergence on a synced column; push it behind an `applySplitDecision` seam. MED leverage, LOW effort.
- **Give the four special-things delete cascades (`deleteEvent`/`deleteElectiveSet`/`deleteSpecialDay`/`deleteWeek`) one shared slot-scrub helper** — the cascades genuinely differ (keep them), but each re-implements the "null this id out of every referencing `template_slots` and record the op" obligation by hand. MED leverage.
- **Registry/parity family is healthy — no drift found; affirm it.** All new v39→v47 entities (events + 3 sub-tables) are consistently registered across PROJECTIONS, DOMAIN_SNAPSHOT_ORDER, MOCK_WRITE_ALLOWLIST, permissions, with import-time assertions and parity tests; `declined_two_row_splits` is correctly host-local. Optional low-cost add: one event-family-completeness test.
- **Watch (defer): the overloaded `activities.recurrence_truth_status` column** — no longer "writer without reader" (it now gates twoRowSplit and drives elective permission tiers); the real issue is one column holding truths the model says coexist per occurrence-pattern. A data-model/ADR decision for the owner, not a Maker refactor.
