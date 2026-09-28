---
title: "Scope and pin down the fixed / recurring / activity vocabulary across the product"
document_type: ticket
status: open
task_class: copy-terminology
date: 2026-09-28
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
archive_when: "A single authoritative definition of 'fixed', 'recurring', and 'activity' exists (behavior in the engine, on the grid, and in eligibility for each), an audit has flagged every drift/overlap/ambiguity across data model, engine, UI copy, and docs as concrete findings, and both are recorded in a Governor-produced vocabulary/scoping spec (an ADR if any behavior would change) ready for owner review"
---

# T293 — pin down "fixed" / "recurring" / "activity" across the product

## Problem

The three core scheduling concepts — **fixed**, **recurring**, and **activity** — are not fully
pinned down. The owner's concern is that they may drift or overlap: the same word may mean different
things in the data model, the engine, the UI, and the docs, and the boundaries between the concepts
are not written down anywhere authoritative. Suspected specific symptoms to verify (not trust):

- "Recurring Events" reads as **optional** somewhere in the UI when it may not be.
- "events vs special-days" may in fact be **one** override concept wearing two names.
- Fixed-event eligibility behavior (see prior work referenced as T141) may not match the copy.

Relevant existing surfaces to read and verify against code, not assume:

- The events/program layer — `events` table, slot `event_id`, and the engine's skip behavior in
  `src/engine/buildSchedule.js`.
- The in-flight branch `claude/T267-fixed-recurring-event-model` — overlapping territory; the
  Governor must reconcile scope with it before proposing anything.
- Screens under `src/screens/` where these terms appear in copy and controls.

## Success predicate (observable)

1. A **single authoritative definition** of what "fixed", "recurring", and "activity" each mean —
   for each concept: how it behaves in the **engine**, how it appears/behaves on the **grid**, and
   how it participates in **eligibility**.
2. An **audit of every place** the three terms are used in code and UI copy, with every instance of
   **drift, overlap, or ambiguity flagged as a concrete finding** (file:line + what is wrong).
3. Both captured in a Governor-produced vocabulary/scoping spec — promoted to an **ADR if it would
   change any behavior** — ready for owner review.

## Non-goals

- **Do not redesign the scheduling model in this ticket.** Scope and define first; any behavioral
  change is a separate, owner-gated follow-up.
- No engine, schema, or UI code changes land under this ticket — it produces a spec and findings,
  not an implementation.

## Notes

- `task_class: copy-terminology` per `GOVERNANCE_INDEX.md` §3–8 (governed by `CONSTITUTION.md`
  Art. V); the audit necessarily reads engine and schema surfaces, but this ticket's deliverable is
  terminology/scoping, not code.
