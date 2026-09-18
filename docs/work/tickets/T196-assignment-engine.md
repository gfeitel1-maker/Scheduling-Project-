---
title: T196-assignment-engine
document_type: ticket
status: open
created: 2026-09-17
archive_when: "ADR D14's withdrawn preference premise is resolved against a confirmed real input format, AND the engine ships with its determinism and findings suite green"
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T196 — Slice 4: the assignment engine

> ## Premise rewritten 2026-09-18 — read this before comparing against older drafts
>
> This ticket previously specified "for each independent occurrence, run a deterministic min-cost
> max-flow". **That decomposition is withdrawn** (ADR D14). It is preserved in git history, not
> silently edited away: the text below replaces it rather than amending it.
>
> The reason it was withdrawn is still the reason: preferences are ranked **globally** — a camper
> ranks each elective once for the session — so placing a camper into an activity at one occurrence
> consumes that preference for every other occurrence of it. Occurrences of the same activity are
> **not independent**, and treating them as independent sub-problems would let one camper be placed
> into Water Ski three times while their #2 goes unfilled.
>
> D11's choice of min-cost max-flow is NOT in question. The network shape is.

## What is now known, and what is still not

**Known** (T226, merged): the input shape. `parsePreferenceSheet` produces campers, choices (labels)
and preferences `(camper, choice, rank)` from a sheet whose column layout is a mapping rather than a
constant. That is the solver's input, and it exists.

**Still unknown**: the transport (T218 — the third-party export nobody has seen). This does not block
the solver, because the mapping layer absorbs a new layout without a code change. Do not re-block on
it.

## Owner rulings this ticket is built against (2026-09-18)

- **R3 — never unplaced.** When a camper's top choices are full, assign their best AVAILABLE choice
  and flag it. Every camper always has a placement. A flag, not an empty slot.
- **R4 — fairness is NOT modeled in this pass.** The engine does not spread disappointment across
  campers. This is a recorded deferral, not an oversight: the owner's direction is to build the
  straightforward version, look at real output against the 100-camper fixture, and decide then.

## The coupling, stated precisely

Three constraints, and the third is what makes this harder than `buildSchedule`:

1. Each (camper, occurrence) the camper attends gets **exactly one** activity.
2. Each (activity, occurrence) holds at most its **capacity**.
3. A camper takes a given choice **at most once across the week** — the global-ranking consequence.

Constraints 1 and 2 alone are a clean bipartite min-cost flow. Constraint 3 couples the occurrences,
and is not expressible as a capacity in that same network: the natural encoding needs a per-(camper,
choice) node whose flow bound is 1, while constraint 1 needs (camper, occurrence) as the demand node.
Both at once is an integer program, not a flow.

## Approach — sequential min-cost flow with preference consumption

Solve occurrences in a **deterministic order**, each as its own min-cost max-flow over the campers'
REMAINING (unconsumed) preferences, and consume a camper's preference for a choice when they are
placed into it.

This keeps D11's solver, makes constraint 3 hold by construction, and stays deterministic and
explainable — a director can be told "Monday period 2 was filled first, and by then Water Ski was
full." It is **approximate**: a globally optimal assignment may do better than any fixed occurrence
order, and a camper unlucky in an early occurrence is not compensated later. That second property is
exactly what R4 defers, so the approximation and the deferral are the same decision, not two.

**This is the first cut, chosen for legibility over optimality, and it is reversible** — the network
lives behind a pure function, so a later exact formulation replaces it without touching callers.

## Determinism

Same discipline as `buildSchedule.js`: identical inputs produce an identical assignment, including
tie-breaks. Occurrence order and every tie-break must be a total order over stable ids, never
iteration order of a Map or object.

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

**Precondition (T194 round 3, Red Hat):** `electron/ops/deleteWeek.js` blocks deleting a week that
still has `elective_assignment_runs`, and its director-facing copy ("delete those runs first")
requires a run-DELETE path to exist. Nothing in the app can delete a run today — nor create one,
since T194 shipped no rendered surface. This ticket must ship run deletion alongside run creation,
or `deleteWeek.js`'s guard becomes a live dead end: reachable, and telling the director to do
something the app cannot do.

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
