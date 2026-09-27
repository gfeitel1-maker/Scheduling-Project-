---
title: "Stage 2 — the decision journal records axis-binding questions and their outcomes"
document_type: ticket
status: open
created: 2026-09-27
task_class: database-sync
archive_when: "every axis-binding and declared-kind question the importer presents is written to import_decisions as PRESENTED with its lane, what was proposed and what the director chose, including the accepted-without-comment case; a question skipped on every import is visible as data rather than lost as silence; and the journal's device-local scope is stated wherever its counts are surfaced so a per-device subset is never reported as a fleet measurement"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T278-import-agnostic-elective-preferences.md]
---

# T280 — Stage 2: journal the axis-binding questions

Umbrella: **T278**. Design: ADR §6.

**Ships BEFORE any learning**, on `src/ingest/decisionJournal.js`'s own argument: *"You cannot learn
from decisions you never recorded as decisions."* Stage 3 is designed against what this shows, not
against a guess.

`import_decisions` is host-local and never synced (`electron/db/schema.sql:226-232`) — see ADR §6.3
for the asymmetry that creates once stage 3's profile replicates.
