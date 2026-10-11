---
title: T365-events-only-for-camps-imported-before-v95
document_type: ticket
status: open
created: 2026-10-11
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
archive_when: a camp imported before v95 gets events_only on its short event blocks on the next import, or via a one-time backfill, without overwriting any director toggle, with a red-first test
---

# T365: camps imported before v95 never get events_only

**Problem.** `events_only` is written only when a block is created. Camps imported before v95 already have their short Flag Raising / Reveille blocks with `events_only = 0`. A re-import never sets the flag, so Generate can still place activities in those blocks.

**Direction.** Either a one-time backfill in the v95+ path (a short block that holds only fixed events gets the flag), or set it on re-import when the block holds a fixed event and the director has never touched the flag.

Source: Red Hat review of PR #906 (F2: short event rows and events-only time blocks), 2026-10-11. Filed as a follow-up by the keeper's ruling; not a blocker for #906.
