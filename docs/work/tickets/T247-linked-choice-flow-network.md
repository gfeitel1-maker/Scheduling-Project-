---
title: T247-linked-choice-flow-network
document_type: ticket
status: open
created: 2026-09-23
archive_when: buildElectiveAssignments places linked-choice campers via the tier-1 choice-level bipartite pass (reusing minCostAssign unmodified) with tier-2 running against the reduced capacity, single-member choices are unaffected, UNSUPPORTED_LINKED_CHOICE fires on the two D12 malformed cases plus the new same-run occurrence-overlap case, and the 2-camper worked example from the ADR passes as a test
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T247 — linked-choice flow network (two-tier bipartite construction)

Implements ADR 2026-09-23 decision (c): `elective_choices`/`elective_choice_offerings` are read by
the engine for the first time (`is_linked` is currently never read anywhere in `src/`).

**Rewritten 2026-09-23 after Red Hat found the originally-scoped chain-edge construction actively
wrong** (worked counter-example: two campers ranking a 2-member linked choice against 15-seat
occurrences — the chain construction places one camper camp-wide and rejects the second with 14
seats sitting open). The corrected construction is two bipartite passes, both using
`src/engine/buildElectiveAssignments.js`'s existing `minCostAssign` **unmodified** — see the ADR's
decision (c) for the full derivation and the worked example this ticket's test must reproduce.

## Scope

- `src/engine/buildElectiveAssignments.js`: read `preferences` as pointing at `choice_id` (already
  the schema's shape per D4's correction).
- **Tier 1**: rows = campers with a preference on a choice `C` where `elective_choice_offerings`
  gives `C` more than one member; columns = those linked choices;
  `capacity[C] = min(capacity of every member occurrence of C)`. Call `minCostAssign` exactly as it
  exists today — no new graph, no new edge type. Expand each placement to one
  `elective_assignments` row per member occurrence, sharing `choice_id`/`preference_rank`.
- **Tier 2**: the existing per-occurrence solve, unchanged in its own logic, but consuming capacity
  already reduced by tier 1's placements and treating tier-1-placed campers as pre-placed for their
  member occurrences — reuse T246's `lockedAssignments`-style pre-placement mechanism for this
  rather than inventing a second one (this ticket depends on T246 for that shared shape — see
  Dependencies).
- **`UNSUPPORTED_LINKED_CHOICE` finding**, per the ADR's corrected scope: fires when a choice's
  members reference an occurrence outside the run, one the camper is structurally ineligible for,
  **or when two linked choices in the same run share a member occurrence** — the new case, an
  honest implementation limit (tier 1's two `minCostAssign` columns cannot jointly bound a shared
  occurrence's real capacity), stated as such in the finding's message text, not presented as a
  data-quality problem. Capacity infeasibility at solve time remains an ordinary unassigned outcome,
  not this finding.
- **Required test: reproduce the ADR's worked example verbatim** — `capacity(o1)=capacity(o2)=15`,
  two campers both ranking `C={o1,o2}`, assert both are placed and both occurrences show 13 seats
  remaining afterward. This is the proof the corrected construction is right where the original was
  wrong; it must exist as an actual test, not only as ADR prose.
- **Test the overlap-refusal case**: two linked choices sharing a member occurrence in the same run
  produce `UNSUPPORTED_LINKED_CHOICE`, not a silently wrong placement.
- **Locked-seat interaction: owned by T246, not this ticket.** Consume whatever capacity contract
  T246's header comment documents; do not re-decide it here.

## Non-goals

Populating real `is_linked`/`elective_choice_offerings` data from a real catalog — that's T219's
job (owned elsewhere; do not touch its ticket or `preferenceSheet.js`). The general graph-solver
rewrite that would handle overlapping linked choices (ADR candidate (1), explicitly deferred — not
built here, and not to be built here without a separate ADR-level decision that the overlap case is
real and common enough to justify replacing `minCostAssign`).

## Test seam

`src/engine/**` — pure, unit-testable via `npx vitest run --no-file-parallelism
src/engine/buildElectiveAssignments.test.js`. No integration harness required for the engine change
itself (no I/O in this module); if `commitElectiveRun`'s wiring needs updating to pass choice data
through, that wiring change follows T244/T246's existing mandatory-harness precedent for
`electron/ops/**`.

## Dependencies

T243 (schema — no new tables needed, `elective_choices`/`elective_choice_offerings` already exist
at v66). **T246** (tier 2's pre-placement mechanism and the locked-seat-in-linked-choice contract —
this is now a hard dependency, not advisory, since tier 2 reuses T246's mechanism rather than
duplicating it). T246 itself depends on T245 (its shared eligibility/capacity helper). **Corrected
2026-09-23 (residual finding, LOW):** this ticket is therefore not independent of T245 — it is
**transitively gated on T245 via T246**, even though T245's own work (the write-path IPC) has no
direct call-site here. Independent of T244/T248/T249 (direct parallel); transitively gated on T245
via T246.
