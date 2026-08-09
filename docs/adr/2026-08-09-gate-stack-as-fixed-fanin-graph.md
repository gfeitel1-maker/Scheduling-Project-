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
   `{task_id, diff_ref, design_spec_ref, files_changed[], test_files_added[], spec_summary}`,
   never each other's output and never the full conversation transcript. `design_spec_ref`
   (added per Round 2 review, HIGH-2) is a pointer to the actual spec/design artifact,
   not a paraphrase — added because a spec-fidelity gate (Code Reviewer) checking only
   `spec_summary` (a paraphrase, possibly Maker's own self-summary) can be fooled by
   drift from what was actually specified; `design_spec_ref` stays a pointer, not
   inlined content, to preserve the minimal-state discipline. This is the state
   contract; it is a locked surface (see Consequences).
3. A declared reducer assembles the five gate outputs into one `GateReport`. If any
   gate's report is missing, `incomplete` is set true and the reason is recorded in the
   durable `GateReport`. **Owner decision, 2026-08-09 (resolves open question 1 /
   Round 2 FINDING-6): a missing/`incomplete` gate report does NOT hard-halt the
   pipeline. Governor retains discretion to proceed past it, provided the gap is
   documented in the persisted `GateReport` record.** This reverses the earlier
   hard-halt default this ADR had assumed pending confirmation; it is now a closed
   decision, not a default. The discretion is deliberately bounded so it does not erode
   the constitution's "deterministic evidence over agent opinion" rule:
   - It applies only to a *missing or incomplete* opinion-gate report (Security, Red Hat,
     Tester, Code Reviewer). A gate that actually ran and returned **FAIL** is not a
     "gap" and this discretion does not touch it.
   - `verifier_pass = false` remains a hard block regardless (point 4) — Governor's
     discretion never extends to the deterministic gate.
   - Proceeding is never silent: `incomplete = true` and the named missing gate(s) are
     written to the durable `GateReport`, and (per point 6 below) that record is surfaced
     to the human at the promotion gate. The gap is a documented, auditable judgment, not
     an absence no one can see.
   This keeps deterministic evidence supreme (the Verifier hard block is untouched) while
   letting a *missing opinion report* be a recorded Governor judgment rather than an
   automatic halt — which is the risk posture the product owner chose. See the
   §5-auditor note in Consequences ("Human-gate / evidence-erosion tension, flagged").
4. `GateReport.verifier_pass = false` is a hard block: the Governor decision node may
   not reach PASS while it is false, regardless of `overall_score` — this
   operationalizes the constitution's existing rule that a reviewer score is never
   proof when a required gate fails.
5. `GateReport` is persisted as a durable, queryable record per task/round (a bounded
   borrow of the "record the trace" idea from the rejected all-dynamic model, scoped
   only to this one stage).
6. **Owner decision, 2026-08-09 (resolves open question 3): the persisted `GateReport`
   record is surfaced to the human at the promotion PAUSE node** — it is part of what the
   human reviews when approving promotion/merge, not an internal audit-only artifact. The
   promotion pause node's payload therefore carries a `gate_report_ref` alongside
   `{task_id, artifact_ref, score_context}`, so the human sees the same five-gate
   verdicts, any `blocking_findings`, and the `incomplete` flag (with any documented gap
   from point 3) that Grader and Governor saw. This makes "the human owns promotion" mean
   the human owns it *with the gate evidence in hand*, and it is what makes the point-3
   discretion honest: a documented gap is not merely logged, it is placed in front of the
   human who owns the final gate.

Nothing about Governor's dispatch of Architect, Designer, or Maker changes. Nothing
about the round-1-retry/round-2-escalate cap changes. No new agent role is introduced.

**Accepted cost (Round 2 review HIGH-1):** input-isolation among the five gates means a
cross-cutting risk one gate surfaces (e.g. Security flagging a change under
`electron/db/**` that implies a `better-sqlite3` ABI rebuild per CLAUDE.md) is not
visible to another gate (e.g. Verifier, whose independent pass may already have run
against a stale native binary) during review — only the reducer/Grader sees both
findings side by side, after the fact, and cannot make any gate revise its verdict.
This design accepts that cost in exchange for keeping the five gates parallel,
independent, and cheap; see the exploration doc §3 ("Isolatability, defended, with the
cost conceded") for the full argument and a candidate (not adopted) follow-up.

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
  automation introduced here may auto-resume them. The promotion pause node now also
  carries `gate_report_ref` (Decision point 6) so the human reviews the gate evidence at
  that gate.
- **Human-gate / evidence-erosion tension, flagged (re-opened §5 auditor concern —
  "missing evidence is never converted to a passing result"):** the owner's decision that
  a missing/`incomplete` opinion-gate report grants Governor discretion-to-proceed (rather
  than a hard halt) does mildly widen Governor's authority relative to the original
  hard-halt default, and it touches the §5 auditor line the hard-halt was written to hold.
  This is a deliberate, owner-owned risk call (constitution rules 6/10), and it is bounded
  so the erosion is contained rather than open-ended: (a) `verifier_pass = false` stays an
  absolute hard block — deterministic evidence is never subject to this discretion; (b) the
  discretion covers only a *missing* opinion report, never a gate that returned FAIL; (c)
  the gap is recorded in the durable `GateReport` and surfaced to the human at promotion
  (Decision points 3 and 6), so a proceed-with-gap is auditable and human-reviewed, not
  silent. The residual risk that remains (and is accepted): Governor could, in principle,
  repeatedly proceed past a flaky opinion gate and the pattern would only be caught by
  someone querying the persisted `incomplete` records — mitigated by, not eliminated by,
  those records existing.
- **Confidence:** medium — qualitative, per the exploration doc §12 (Round 2 review
  MEDIUM-5: the earlier numeric "~60%" is dropped as false precision; no session-history
  review was actually performed). The two present failures this targets (undeclared
  gate-merge logic, no durable record of which gate blocked a task) are architectural
  inference, not a confirmed incident from this project's session history. The concrete
  evidence step that would raise or lower this confidence: review recent session logs
  for actual gate-merge disagreement or RETRY-cause opacity before implementation
  begins. **That review has now been performed (owner decision b, 2026-08-09) — see the
  exploration doc §14.** Outcome: confidence stays **medium/qualitative**, but its
  character is corrected. The review found no observed mis-merge and no observed
  in-the-moment RETRY opacity (so this is not "fixing a live failure"), yet the run-record
  corpus shows the gate-merge/`incomplete` reducer discipline is real, recurring, and
  currently performed by hand each run (so it is not "not yet" either). The honest framing
  is: Model A **formalizes a merge-and-record discipline the team already practices
  manually and reinvents per run**, reducing drift risk and making it queryable — cheaper
  insurance than "fixes a bug," stronger than "hypothetical." See §14 for the evidence.
- **Completion evidence:** per this project's house pattern (see the reference ADR at
  `docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md`), a "Completion evidence"
  section listing falsifiable checks is expected to be added to this ADR when
  `implementation_state` moves from `not started` to `implemented` (Round 2 review
  Code Reviewer LOW finding).
- **Frontmatter/body agreement (not a change — Round 2 review, argued down):** Code
  Reviewer flagged a MEDIUM on `status: proposed` in frontmatter vs. "PROPOSED" in the
  body. This ADR's frontmatter and body already agree (`proposed` / "PROPOSED"), unlike
  the reference ADR (`status: accepted` vs. body "PROPOSED"), which is the actual
  inconsistency Code Reviewer's pattern-match was tuned to catch. No change made; noted
  here so the agreement is explicit rather than accidental-looking.
