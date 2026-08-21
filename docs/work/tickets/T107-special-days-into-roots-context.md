---
title: T107-special-days-into-roots-context
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md, docs/work/specs/2026-08-19-roots-reconciliation-audit.md]
depends_on: [docs/work/tickets/T106-special-day-author-ui.md]
archive_when: shipped and merged
---

# T107 — Wire Special Days into Roots Context inventory

Extend `buildContextChildren` (`src/ingest/rootMapModel.js`) so `special_days` appears alongside Field
Trips / Special Events / Day Overrides in the read-only Context inventory (Roots audit Slice 3). Authored,
never ingested — calm at import, populated in the persistent inspector. This is where tier-(c)-durable
special days surface (ADR D3b) — **not** the census; do not add `special_days` to `INGESTIBLE_ENTITIES`.

## Coordination — UNBLOCKED (2026-08-20)

The `shoresh-v1-closure-audit` peer delivered their per-field UNKNOWN recommendation
(`docs/adr/2026-08-20-per-field-unknown-reconciliation-state.md`, proposed). It extends the
`import_evidence.tag` vocabulary for `activities.min_per_week`/`priority` only — it does **not** touch
Context, `special_days`, or `INGESTIBLE_ENTITIES`, and needs **no** `rootMapModel.js` structural change
(UNKNOWN renders as an existing `attention` decision). **No conflict with this ticket's durability→census
invariant.** Remaining coordination: both branches edit *near* `rootMapModel.js`, so do a quick diff-check
against their landed change before/at implementation to keep `buildContextChildren` consistent. No longer
a hard block.

## Review loop

**Maker (test-first, extend the Σ-invariant) → Red Hat (no census pollution; the ingestible-overlap
invariant) → Code Reviewer → Verifier → Grader.**
