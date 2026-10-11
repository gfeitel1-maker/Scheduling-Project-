---
title: T364-events-only-flag-goes-stale
document_type: ticket
status: open
created: 2026-10-11
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
archive_when: a re-import that removes a block's only fixed event clears that block's events_only flag (or asks), unless the director set the flag by hand, with a red-first test
---

# T364: events_only flag stays set after its event is removed

**Problem.** `time_blocks.events_only` is set on create only: a block of 10 minutes or less that holds a fixed event from the plan. A later import that removes that event leaves the flag set, so Generate keeps the block empty for every group. The only way out is the toggle on Time Blocks.

**Direction.** On re-import, if an events-only block no longer holds any fixed event and the flag was set by import (not the director), clear it or raise one question. That means recording who set the flag, or comparing against the import evidence.

Source: Red Hat review of PR #906 (F2: short event rows and events-only time blocks), 2026-10-11. Filed as a follow-up by the keeper's ruling; not a blocker for #906.
