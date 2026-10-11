---
title: T366-sparse-short-row-with-events-dropped-silently
document_type: ticket
status: completed
created: 2026-10-11
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
archive_when: a short row whose fixed events cover fewer than 2/3 of cells is either kept or reported in the import preview by name and time, with a red-first test
---

# T366: a short row with events for a few groups drops without warning

**Problem.** A row of 10 minutes or less is kept only when at least 2/3 of its cells agree on non-transition text (`rowCarriesContent` in `src/ingest/periodSpan.js`). A real short row where only 2 of 5 groups print Flag Raising (the others off-site) is dropped as a change-over. Its fixed events then have no block to land in, and nothing tells the director.

**Direction.** When a dropped short row carries text that matches a fixed event elsewhere in the file, keep it as an events-only block, or report it in the preview ("Flag Raising at 8:50 for Badger 1 and 2 was skipped as a 10-minute change-over"). Agreement keys are exact lowercased text today, so "Flag Raising (all)" and "Flag raising!" count as different.

Source: Red Hat review of PR #906 (F2: short event rows and events-only time blocks), 2026-10-11. Filed as a follow-up by the keeper's ruling; not a blocker for #906.

## Resolution (2026-10-11)

A short row that fails the 2/3 agreement line is now kept as a block when at least 2 of its cells (and at
least a third) match, loosely ("Flag Raising (all)" = "Flag raising!"), an event that another SHORT row of the
file agrees on (`src/ingest/periodSpan.js`, `src/ingest/extractEntities.js`). Otherwise any text in the dropped
row is reported in `proposal.skippedShortRows` as `{ label, text, groups }` and shown in the import preview's
"Not recognised" panel (`src/screens/ImportScreen.jsx`). Choice of "elsewhere": short rows only, because campA's
overflow slivers (a long period's "Lunch" bled into a few cells) must stay dropped (golden count 11); an event
that only a long row agrees on is reported, not kept. Not covered: the preview lists skipped overflow text too
(noisy on campA-style files, by design: never silent); no director action to promote a reported row.
