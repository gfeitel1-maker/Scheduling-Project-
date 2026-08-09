---
title: "Gate stack as a fixed parallel fan-in graph node (bounded graph engineering)"
document_type: adr
authority: normative
status: proposed
date: 2026-08-09
supersedes: []
implementation_state: not started
affects:
  - docs/work/2026-08-09-graph-engineering-exploration.md
  - docs/governance/constitution/CONSTITUTION.md
---

# Gate stack as a fixed parallel fan-in graph node

**Status: PROPOSED.** This ADR records the one architectural decision from the
2026-08-09 graph-engineering exploration (`docs/work/2026-08-09-graph-engineering-
exploration.md`) that meets the ADR bar: it introduces a new typed data contract
(`GateReport`) that other code (Grader, and eventually Governor's decision node) will
depend on, and it fixes a merge rule that today is implicit and undeclared. The
exploration document holds the full reasoning, the three candidate models and their
scoring, the worked trace, and the migration path; this ADR holds the decision itself.

---

## Context

Shoresh's multi-agent "dynamic loop" (Governor → Architect/Designer → Maker → gate
stack → Grader → Governor decision → human) routes every turn by Governor's model
judgment, re-derived each run and never persisted as structured data. The product owner
asked what "graph engineering" would mean for this workflow — a term this project had
not previously defined.

The gate stack (Verifier, Security, Red Hat, Tester, Code Reviewer dispatched in
parallel after Maker, consolidated by Grader) is the one stage of the loop where the
transition set is already effectively fixed in practice — Governor does not improvise
which gates run — and where a merge decision is already happening silently: Grader
reads five freeform prose reports into one score with no declared rule for how
conflicting or missing reports should resolve. This is the concrete Shoresh instance of
a documented pattern in graph-orchestration frameworks (LangGraph, Step Functions,
Temporal): parallel fan-in requires an explicit merge/reducer step or it silently
corrupts.

Three structural models were considered (full detail and scoring in the exploration
doc):
- **Fix only the gate stack** (this decision) — leaves all of Governor's role-to-role
  routing exactly as dynamic as today.
- **Fix the entire pipeline** as one static graph with conditional edges over all of
  Governor's routing decisions.
- **Keep all routing dynamic**, persist it after the fact as a recorded execution
  trace, with no fixed edge set anywhere.

## Decision

**Adopt the bounded model: declare the five-gate fan-out and its merge into Grader as a
fixed graph node with a typed state contract, and leave Governor's own role-routing
(which agent runs next, retry vs. escalate) exactly as dynamic and model-judged as it is
today.**

Concretely:

1. A new typed record, `GateReport`, is the sole contract between the gate stack and
   Grader:
   `GateReport { verifier_pass: bool, gate_scores: {security, red_hat, tester, code_reviewer}, blocking_findings: string[], incomplete: bool }`.
2. Each gate's output is captured independently as
   `{gate_name, verdict: PASS|FAIL|N/A, findings[], evidence_ref}` — gates read only
   `{task_id, diff_ref, files_changed[], test_files_added[], spec_summary}`, never each
   other's output and never the full conversation transcript. This is the state
   contract; it is a locked surface (see Consequences).
3. A declared reducer assembles the five gate outputs into one `GateReport`. If any
   gate's report is missing, `incomplete` is set true and Grader may not produce a
   PASS-eligible score — this operationalizes the constitution's existing rule that
   missing evidence is never converted into a passing result.
4. `GateReport.verifier_pass = false` is a hard block: the Governor decision node may
   not reach PASS while it is false, regardless of `overall_score` — this
   operationalizes the constitution's existing rule that a reviewer score is never
   proof when a required gate fails.
5. `GateReport` is persisted as a durable, queryable record per task/round (a bounded
   borrow of the "record the trace" idea from the rejected all-dynamic model, scoped
   only to this one stage).

Nothing about Governor's dispatch of Architect, Designer, or Maker changes. Nothing
about the round-1-retry/round-2-escalate cap changes. No new agent role is introduced.

## Considered Options

1. **Fix only the gate stack (chosen).** Smallest structural change; targets the one
   stage where sub-tasks are mutually isolatable (each gate needs only the diff, not
   the others' output) and where a merge decision is already happening implicitly.
   Rejected risk: does not make Governor's own routing reproducible or auditable — left
   for a future decision if evidence warrants it.
2. **Fix the entire pipeline as one static graph.** Rejected: the degenerate case of a
   task needing an agent outside the declared roster has no legal transition under this
   model, and no framework surveyed solves that — it would move a real risk into the
   part of the workflow (routing) where the loop's adaptivity is actually load-bearing.
3. **Keep all routing dynamic; persist the full execution trace after the fact.**
   Rejected as the sole answer (though partially borrowed in point 5 above): on its own
   it does not close the concrete gate-merge gap this ADR targets, since the underlying
   problem is an undeclared reducer, not a missing log.

## Consequences

- **New dependency other code must honor:** any future change to Grader's input
  contract, or to what the gate-fan-out node produces, is a contract change against
  `GateReport`, not a free edit — this schema is the one locked surface this decision
  introduces (see the exploration doc's "Harness concerns" section).
- **Reversible:** each migration step (declare the schema → instrument logging →
  switch Grader's input source) is independently reversible; reverting step 3 alone
  restores today's freeform Grader behavior.
- **Does not solve:** Governor's routing remains unreproducible/unaudited by this
  decision alone (deliberately deferred, see exploration doc §12); side-effect rollback
  (a Maker that already wrote files or ran a migration before a gate blocks it) is not
  automated by this decision and remains a manual/git-level compensation.
- **Human-reserved decisions unaffected:** spec approval, ADR acceptance, and
  promotion/merge remain durable pause-and-resume points outside this contract; no gate
  automation introduced here may auto-resume them.
- **Confidence:** medium (~60%), per the exploration doc §12 — the two present failures
  this targets (undeclared gate-merge logic, no durable record of which gate blocked a
  task) are architectural inference, not a confirmed incident from this project's
  session history. If review of session history shows this has not been a live problem,
  the case weakens toward treating this as preventive insurance rather than a fix to an
  observed failure — a fact worth re-checking before implementation begins.
