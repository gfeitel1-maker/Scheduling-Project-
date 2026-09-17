---
title: T196-assignment-engine
document_type: ticket
status: open
created: 2026-09-17
archive_when: the engine ships with its determinism and findings suite green
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T196 — Slice 4: the assignment engine

`src/engine/buildElectiveAssignments.js` — a pure deterministic module. Plain objects in,
assignments plus findings out. No database access, no file parsing, no UI, no writes. Same
discipline as `buildSchedule.js`, a different level of the nested schedule. **Blocked on T194.**

## Hard constraints

Each active camper in scope gets at most one activity per occurrence. A **linked choice places
atomically** — every member occurrence or none; a camper is never placed in one half of a
two-period choice (ADR D12). The activity is a member of
the occurrence's elective set. Eligibility admits the camper's tier/group. Assigned count never
exceeds a finite valid `camper_headcount`. A locked manual assignment is retained and consumes
capacity *before* generated placement. A camper is never assigned to overlapping occurrences.
Generation cannot finalize while the route has unresolved location conflicts (T193's validator).

## Allocation

Deterministic min-cost max-flow (ADR D11). Source→camper capacity 1; camper→choice edges only for
eligible ranked choices; choice→sink capacity is the **minimum** remaining capacity across the
choice's member offerings after locks — a linked choice is only placeable if every member has room;
an explicit unassigned edge costing more than any possible rank combination, with lower ranks
penalized monotonically.

Occurrences are independent **only when no linked choice spans them**. Solve each connected
component of the occurrence graph — occurrences joined by a shared linked choice — as one flow
problem. A single-period choice is the degenerate one-member case, so unlinked camps produce exactly
the per-occurrence decomposition and there is one code path, not two. Sort campers and offerings by stable id before building
the graph so input order cannot change the result. Return the achieved rank for every generated
assignment and a reason for every unassigned camper.

Cost constants live in **one exported policy object**, pinned by tests, not editable through MCP.
Unranked fallback is disabled by default; enabling it is an explicit run option and the export
labels those assignments.

## Capacity (ADR D3)

Capacity is a two-part value: an explicit **"no limit"** mode, or a number. `0` is a real closed
offering — no camper is placed there and it is not an error. Negative or non-integer →
`INVALID_CAPACITY`, blocking. Nothing is ever silently treated as unlimited. `schema.sql:1020` has
no CHECK and no DEFAULT, so this is an enforcement point alongside write-time validation on the
authoring screen.

## Generation coherence (ADR D5)

Assignments carry the run's `solver_generation`. Rows whose generation does not match the run's
current marker are inert and raise `SUPERSEDED_GENERATION`. A run projects exactly one coherent
generation; losing a concurrent-generation race costs a regenerate, never a silently wrong roster.

## Findings

`INVALID_CAPACITY` · `NO_ELIGIBLE_CHOICES` · `CAPACITY_SHORTFALL` · `LOCK_CONFLICT` ·
`STALE_OUTER_SCHEDULE` · `OUTER_RESOURCE_CONFLICT` · `UNSUPPORTED_LINKED_CHOICE` ·
`SUPERSEDED_GENERATION` · `NO_OFFERINGS` · `NO_CAMPERS`.

The last two exist because an empty occurrence must be distinguishable from a solved one —
"0 assignments, 0 findings" reads to a director as success.

## Exit condition

Determinism under shuffled input; rank cost; finite, unlimited and invalid capacity; eligibility;
locks; all-full; no-ranked-choice; overlapping occurrence; empty occurrence; closed (`0`) offering;
"no limit" offering; **linked-choice atomicity, including the case where one member has room and
another does not** (the choice must be refused whole); stable finding order.
Manual moves and locks recompute capacity and eligibility immediately — manual override is not an
escape hatch, and over-capacity placement is not permitted in this release.
