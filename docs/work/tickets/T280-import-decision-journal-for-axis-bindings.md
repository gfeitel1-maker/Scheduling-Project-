---
title: "Stage 2 — the decision journal records axis-binding questions and their outcomes"
document_type: ticket
status: completed
created: 2026-09-27
task_class: database-sync
archive_when: "every axis-binding, declared-kind AND RESOLVER-MISS question the importer presents is written to import_decisions as PRESENTED with its lane, what was proposed and what the director chose, including the accepted-without-comment case; a question skipped on every import is visible as data rather than lost as silence; and the journal's device-local scope is stated wherever its counts are surfaced so a per-device subset is never reported as a fleet measurement"
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

**ROUND 5 (ADR §12.9).** Widened from axis-binding questions to **every resolver miss and its
outcome** (ADR §12.0's five resolvers), so §8's two acceptance numbers are computable from the journal
rather than from a bespoke harness. Device-local scope caveat unchanged (§6.3).

**COMPLETED 2026-10-11 (batched with T282).** The import panel journals the column binding (`axis_binding`, ACCEPTED/CHANGED against what the corrector proposed, `learned_from_id` when it came from the camp's remembered layout) and every label question it presented, answered or not (it previously read them off the final parse, where a settled label is gone, so answers were never journalled). Label answers are also remembered in the camp's synced answer memory as qkind `pref_label`, so a re-import of the same sheet asks nothing already answered, and both appear in "What Shoresh has learned". Declared kind is not asked as a question in the panel, and division / identity / rank misses are findings rather than questions, so they have nothing to journal as an answer. The journal stays device-local (`import_decisions`); the acceptance numbers are computed by T282's corpus test, labelled device-local, rather than from the journal. ADR amendment: docs/adr/2026-10-11-import-answer-memory.md §7.
