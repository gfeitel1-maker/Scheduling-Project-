---
title: T364-events-only-flag-goes-stale
document_type: ticket
status: completed
created: 2026-10-11
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
archive_when: a re-import that removes a block's only fixed event clears that block's events_only flag (or asks), unless the director set the flag by hand, with a red-first test
---

# T364: events_only flag stays set after its event is removed

**Problem.** `time_blocks.events_only` is set on create only: a block of 10 minutes or less that holds a fixed event from the plan. A later import that removes that event leaves the flag set, so Generate keeps the block empty for every group. The only way out is the toggle on Time Blocks.

**Direction.** On re-import, if an events-only block no longer holds any fixed event and the flag was set by import (not the director), clear it or raise one question. That means recording who set the flag, or comparing against the import evidence.

Source: Red Hat review of PR #906 (F2: short event rows and events-only time blocks), 2026-10-11. Filed as a follow-up by the keeper's ruling; not a blocker for #906.

## Resolution (2026-10-11)

Who set the flag comes from data that already exists: the op-log `source` of the flag's last write, read in
`buildExistingSnapshot` (`electron/ops/ingest.js`) as `events_only_source` and consumed by the recognized-block
arm of `src/ingest/buildPlan.js`. A re-import clears an import-set flag on a short block that no longer holds
a fixed event; a flag the director wrote (any non-import source) is never touched and raises no conflict. No
schema change, no new column. `electron/main.js` no longer defaults an absent `fixedEvents` to `[]` for
`ingestCommit`/`ingestReconcile`, so a caller that carries no event information (not a schedule import) cannot
clear flags. Mirrored in `src/localClient.mock.js`. Tests: `electron/ops/ingest.eventsOnly.test.js`,
`src/localClient.mock.eventsOnly.test.js`. Not covered: the Time Blocks edit form saves `events_only` along
with the other fields, so a block saved by hand without toggling reads as director-set from then on (the safe
direction: it is then never cleared or set by import).
