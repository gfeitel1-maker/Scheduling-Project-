---
title: T366-sparse-short-row-with-events-dropped-silently
document_type: ticket
status: open
created: 2026-10-11
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
archive_when: a short row whose fixed events cover fewer than 2/3 of cells is either kept or reported in the import preview by name and time, with a red-first test
---

# T366: a short row with events for a few groups drops without warning

**Problem.** A row of 10 minutes or less is kept only when at least 2/3 of its cells agree on non-transition text (`rowCarriesContent` in `src/ingest/periodSpan.js`). A real short row where only 2 of 5 groups print Flag Raising (the others off-site) is dropped as a change-over. Its fixed events then have no block to land in, and nothing tells the director.

**Direction.** When a dropped short row carries text that matches a fixed event elsewhere in the file, keep it as an events-only block, or report it in the preview ("Flag Raising at 8:50 for Badger 1 and 2 was skipped as a 10-minute change-over"). Agreement keys are exact lowercased text today, so "Flag Raising (all)" and "Flag raising!" count as different.

Source: Red Hat review of PR #906 (F2: short event rows and events-only time blocks), 2026-10-11. Filed as a follow-up by the keeper's ruling; not a blocker for #906.
