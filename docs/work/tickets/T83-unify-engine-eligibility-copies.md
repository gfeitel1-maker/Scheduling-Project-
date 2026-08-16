---
title: T83-unify-engine-eligibility-copies
document_type: ticket
status: open
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T82-mutation-envelope-and-eligibility-predicate.md]
related_adrs: []
related_specs: []
related_reports: [docs/work/architecture-reports/2026-08-16-architecture-audit-summary.md]
archive_when: "the tier/group eligibility formula in src/engine/buildSchedule.js (both the placement pass and computeFindings) is expressed via the single src/engine/eligibility.js predicate introduced in T82 — OR a documented decision records why the engine's batch-Set form must stay separate — with buildSchedule.js's pinned tests still green and no change to generated schedules; and this ticket is merged with owner sign-off"
---

# T83 — Unify buildSchedule.js's eligibility copies against the shared predicate

**Sequencing: AFTER T82 merges (PR #77).** T82 unified the two *in-use UI* copies of the
tier/group eligibility formula into `src/engine/eligibility.js`. Red Hat's T82 review found the
same formula hand-copied **two more** times inside `src/engine/buildSchedule.js` (the placement
pass and `computeFindings`). Those were correctly left out of T82 — pre-existing, structurally
different, and in the purity-constrained engine — and routed here.

**Task class:** engine refactor (pure module, most heavily unit-tested in the repo, purity
constraint from T69 — zero JSON.parse, no React/IPC imports). **Risk:** medium — behavior-preserving
by intent, but any drift changes generated schedules, which are pinned by `buildSchedule.test.js`.

## The gap

Four hand-copies of "activity eligible for group iff no eligibility lists, OR tier match, OR group
match" existed. T82 unified two (typeahead + UNFILLABLE flag). The remaining two live in
`src/engine/buildSchedule.js`:
- the placement pass (~lines 90–109), where it is precomputed as a Set-per-activity for batch use, and
- `computeFindings` (~lines 462–483).

The ticket framing behind T82 was "one copy so it can never diverge." That is only two-thirds true
until the engine copies also reference the shared predicate.

## Why this is its own ticket, not part of T82

- `buildSchedule.js` is pure and purity-constrained (T69). `src/engine/eligibility.js` is in the same
  family (pure, no forbidden imports), so consuming it is in-family and cheap — but it is still an
  engine change and belongs behind the engine's own test gate, not riding a write-path PR.
- The engine copy is *structurally* different: it precomputes a Set of eligible group ids per activity
  for performance, rather than evaluating one (activity, group) pair. Unification must preserve that
  batch shape — likely by having the precompute call the shared single-pair predicate, not by
  replacing the Set strategy. This is real work, not find-replace.

## Success predicate (observable)

1. The tier/group eligibility boolean is defined once (`src/engine/eligibility.js`); `buildSchedule.js`'s
   placement pass and `computeFindings` both derive from it (e.g. the Set precompute is built by calling
   the shared predicate per candidate group).
2. `buildSchedule.js` retains its batch-Set performance shape — no per-slot re-evaluation regression.
3. `src/engine/buildSchedule.test.js` stays green **unchanged** (it pins generated schedules); add a
   focused test asserting the engine and the UI predicate agree on a matrix of eligibility-list shapes
   (empty, tier-only, group-only, both, null/undefined group).
4. Engine purity intact: no new non-engine imports into `buildSchedule.js`.
5. `npm run verify` green.

## Review routing

Maker (test-first) → Code Reviewer → Verifier → Grader. **Red Hat only if** the precompute strategy
changes shape (it should not). No ADR — behavior-preserving.

## Non-goals

- No change to placement order, PRNG seeding, or the schedule the engine produces.
- No broadening of what "eligible" means — this is deduplication, not a rule change.
