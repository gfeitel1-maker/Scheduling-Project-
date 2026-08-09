---
title: "Graph engineering for the Governor dynamic loop — exploration"
document_type: exploration
authority: informative
date: 2026-08-09
status: complete
related_adr: docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md
---

# Graph engineering for the Governor dynamic loop

## 0. What this document is

A structural analysis of what "graph engineering" would concretely mean for Shoresh's
multi-agent workflow (the "dynamic loop": Governor → Architect/Designer → Maker → gate
stack → Grader → Governor decision), written to a stated success predicate, ending in
one recommendation with confidence and evidence. Reference research (LangGraph, Temporal,
Step Functions, XState, Swarm/Agents SDK, CrewAI, Airflow/Dagster/Prefect, BPMN/Saga) is
cited as evidence, not adopted as an answer — no framework is selected here.

---

## 1. Defining the terms

### 1.1 "Dynamic loop" — what it is today

The dynamic loop is: **a fixed roster of agent roles, an implicit and unenumerated set of
legal transitions between them, and a routing function that is re-evaluated by Governor's
model judgment on every turn** — not read from any stored table, not persisted between runs,
not the same twice by construction (it's a fresh inference each time, not a replay of a
prior inference).

Concretely, today:
- The **roster** is fixed and documented: Governor, Architect, Designer, Maker, five gates
  (Verifier, Security, Red Hat, Tester, Code Reviewer), Grader, human.
- The **legal transitions** are fixed in *prose* (this file, the constitution) but not in
  any machine-checkable structure. Governor "decides turn-by-turn by model judgment."
- The **state** that moves between agents is whatever Governor chooses to put in each
  dispatch prompt — unbounded, freeform, decided fresh each call.
- The **loop-back and termination rule** (round 1 retry, round 2 escalate to human) is
  documented as policy, enforced by Governor remembering to apply it, not by any counter
  that exists outside the conversation.

### 1.2 "Graph engineering" — an operational definition for THIS workflow

Graph engineering, for this workflow, means exactly this and nothing more abstract:

> **Declare a fixed set of possible destinations (nodes) and a fixed set of possible
> transitions (edges) between them, ahead of runtime, in a form that persists outside any
> single conversation. Which edge fires is still decided at runtime — by a guard
> function, by an agent, or by a human — but the *set of options* is no longer
> reinvented per run.** Each edge carries a declared, typed, minimal payload (not the
> whole context). Every edge traversal is written to a durable, queryable log.

This is deliberately narrow. It is not "give Governor a diagram." It is not "add
retries." It is: fix the destination set, type the payloads, persist the traversal.
This lines up with reference-research finding 1 (the fixed/dynamic line is drawn at the
destination set everywhere it's been productized) and finding 2 (typed minimal state,
not whole-context, is what makes the edge meaningful rather than decorative).

### 1.3 Is the current loop already a graph?

**Yes, in topology; no, in the two properties that make "graph" a useful engineering
word rather than a compliment.**

- It has nodes (the roster) and it has a bounded set of transitions Governor actually
  uses in practice (dispatch Architect, dispatch Designer, dispatch Maker, dispatch gate
  stack, dispatch Grader, decide PASS/RETRY/ESCALATE). In that sense it is already an
  **implicit graph** — Governor is *already* choosing from a small enumerable option set,
  it just isn't declared as data.
- What it lacks, and what "graph" adds nothing over a loop without: (a) the transition
  set is **never persisted** — it exists only as an inference Governor re-derives each
  run, so two runs of the "same" task shape can legally take different paths with no
  record of why; (b) **no typed state contract** — every dispatch carries whatever
  Governor decided to include, so a review gate two turns later cannot be mechanically
  checked against what an earlier node promised it; (c) **no execution trace** —
  there is no queryable answer to "what path did this task actually take" independent
  of reading the conversation transcript.

So the honest position, matching the research hint: **the current workflow is an
implicit graph whose topology is re-derived by model judgment each run and never
persisted.** Calling it "already a graph" and stopping there would be cosmetic — it
dodges the actual question, which is whether persisting and typing that topology is
worth its cost. The rest of this document answers that.

**Note added per Round 2 review (MEDIUM-3):** because the gate destination set was
*already* non-improvised in practice (bullet above), the recommended change in this
document (§12) is NOT a routing change — it is a payload-schema-and-reducer change at
one seam. Under this document's own §1.2 definition ("type the payloads, persist the
traversal"), that IS the minimal true instance of graph engineering here, not a
watered-down one. See §7 and §12 for the corrected framing — do not read this document
as promising routing-level benefits (reproducible paths, novel-task containment) that
this recommendation does not deliver.

---

## 2. Divergence — three materially different structural models

Ran under the `adhd` divergence discipline (regulator / inversion / 3am-on-call /
speedrunner / remove-the-load-bearing-assumption frames), scored, and pruned to the
three survivors that differ on the axis the success predicate requires: **what actually
moves from runtime-decided to fixed-in-structure.** Each is a real, distinct, buildable
answer to "what would graph engineering mean here," not a rephrasing of the others.

### Model A — Fix only the gate stack (bounded structural graph)

**One-line frame:** the five review gates already run in a fixed, isolatable, unordered
parallel batch that fans into one Grader — formalize *only* that fan-out/fan-in as a
typed graph node; leave all of Governor's role-to-role routing exactly as dynamic as it
is today.

**Key assumption:** the review-gate stage is the one place in the loop where the
transition set is *already* effectively fixed in practice (Governor doesn't improvise
which gates run) and where the merge step is *already* silently doing reducer work
(Grader reading five reports into one score) without a declared contract. Fixing what's
already fixed in practice costs little and closes a real gap; fixing what's genuinely
still adaptive (Governor's role selection) would remove value the loop currently has.

### Model B — Fix the whole pipeline as one static graph with conditional edges

**One-line frame:** declare the entire Governor→Architect→Designer→Maker→Gates→Grader→
Governor→human sequence as one graph, with every routing decision Governor makes today
(dispatch this role next / skip Designer / retry Maker / escalate to human) rewritten
as a guarded conditional edge over declared graph state, the way LangGraph conditional
edges or Step Functions Choice states work.

**Key assumption:** essentially all of Governor's real-world routing decisions already
fall into a small enumerable set (skip Designer if not UI-significant, retry Maker on
gate failure round 1, escalate on round 2, stop on PASS) — so formalizing the whole
pipeline captures real structure rather than inventing it, and the residual freedom
Governor needs (which agent to loop back to, how to phrase a retry brief) still lives
inside node bodies, not in the edge set.

### Model C — Keep routing fully dynamic; persist it as a recorded execution graph

**One-line frame:** change nothing about how Governor decides what runs next — it stays
100% model judgment, re-derived each turn — but require every dispatch decision to be
written as a structured, typed event to a durable log, so the graph exists only as the
*trace* a run actually took, reconstructed after the fact, never declared in advance.

**Key assumption:** the loop's actual value (Governor adapting routing to what it finds)
is untouched, and the concrete present failure worth fixing is auditability/
resumability, not flexibility — so the fix is a logging/checkpointing discipline
layered under the existing loop, not a change to how routing decisions get made.

### Scoring

| Criterion | A — bounded (gate stack) | B — full static pipeline | C — dynamic + recorded trace |
|---|---|---|---|
| Reproducibility | Medium — gate fan-in becomes checkable/replayable; upstream routing still opaque | High — whole path is declared and guard-evaluated, closest to true reproducibility a non-deterministic LLM graph can get | Low-medium — the *record* is reproducible to read, the *routing* is not reproducible to re-derive |
| Adaptivity preserved | High — Governor's role selection untouched | Medium — routing is enumerable today, but any *novel* task shape Governor would have improvised for is now constrained to declared edges | High — nothing about adaptivity changes |
| Authoring cost | Low — one new node type, one reducer | High — every existing informal transition has to be enumerated and kept in sync with the constitution as it evolves | Low-medium — logging discipline, a state-contract schema, no new control flow |
| Rollback (state-restore) | Medium — checkpoint before/after gate stage, resume gates from clean input | High — checkpoint per node throughout the whole pipeline | Medium — trace gives you exact state to restore to, but nothing auto-restores it; still manual |
| Degenerate-case handling | Good — "no unplanned agent" case never arises because Governor's dispatch stays open | Weakest — a task that needs an agent outside the fixed edge set has no legal transition; must fall through to a manual escape hatch | Good — same as today by construction, since routing didn't change |
| Constitution-fit (evidence outranks consensus; human owns spec/ADR/promotion; smallest responsible workflow) | Strong — smallest change, doesn't touch human gates or Governor's judgment mandate | Weak-to-medium — risks encoding "smallest responsible workflow" as a Governor call into a fixed pipeline shape, which is itself a process decision the constitution reserves to Governor/human, not to a diagram | Strong — makes evidence durable (the constitution's own rule 1) without touching any decision authority |

---

## 3. The node/edge/state model (Model A, the recommended bounded model)

### Nodes
A node is **one agent invocation with a declared input/output contract** — not an agent
role in the abstract (Maker-the-role is not a node; "Maker asked to implement ticket
T-xxx against design-spec D-yyy" is a node instance). The gate stack is a special node:
a **fixed parallel fan-out** to five sub-invocations (Verifier, Security, Red Hat,
Tester, Code Reviewer) whose outputs pass through a declared **reducer** before Grader
runs. This directly targets research finding 3 (parallel fan-in forces an explicit
merge decision or it silently corrupts) — today the "merge" is Grader freehand-reading
five prose reports; under Model A it's a typed `GateReport` object a reducer assembles,
with an explicit rule for what happens if a gate's report is missing or contradictory
(currently: undefined behavior; under Model A: a declared `INCOMPLETE` state that blocks
Grader from running, matching the constitution's "missing evidence is never converted to
a passing result").

### Edges — what's fixed vs. what stays dynamic
- **Fixed:** Maker → gate-fan-out (always all five gates, always parallel, always
  feeding one reducer). Per the correction in MEDIUM-3 below (Round 2 review), what
  actually becomes fixed here is narrower than "the edge" — it is the **payload schema
  and the reducer rule**, not a routing change, since the destination set (dispatch all
  five gates) was already non-improvised in practice (see §1.3, §7).
- **Everything else stays dynamic**, exactly as today: which of Architect/Designer runs
  before Maker, whether Governor loops back to Maker or escalates, how Governor phrases
  a retry brief. Nothing about Governor's own judgment is fixed by Model A. This is the
  deliberate answer to the determinism-vs-adaptivity trap in §5 below.

### State — the minimal typed contract (not "the whole context")

| Edge | Payload (typed, minimal) |
|---|---|
| Maker → gate-fan-out | `{task_id, diff_ref, design_spec_ref, files_changed[], test_files_added[], spec_summary}` |
| each gate (isolated, no cross-talk) → reducer | `{gate_name, verdict: PASS\|FAIL\|N/A, findings[], evidence_ref}` |
| reducer → Grader | `GateReport {verifier_pass: bool, gate_scores: {security, red_hat, tester, code_reviewer}, blocking_findings[], incomplete: bool}` |
| Grader → Governor | `{overall_score, dim_scores, verdict_recommendation}` |

**`design_spec_ref` (added per Round 2 Red Hat HIGH-2):** the original §3 table gave
gates only `spec_summary` — a paraphrase, possibly Maker's own self-summary of what it
built. A gate doing spec-fidelity work (Code Reviewer, principally) checking a paraphrase
against the diff can be fooled by drift between what Designer actually specified and what
Maker or Governor later summarized. `design_spec_ref` is a **pointer** to the actual
artifact Designer produced (or Architect's design doc, when no Designer ran) — not its
inlined content — so it stays consistent with the minimal-typed-state discipline (a
pointer, like `diff_ref` and `evidence_ref`, not a blob) while giving spec-fidelity
checks a source of truth instead of a paraphrase. `spec_summary` is retained alongside it
as a short human-readable label for gates that don't need the full artifact (e.g.
Verifier, which only needs `diff_ref`).

Deliberately excluded from every payload: full conversation transcripts, full file
contents (only `diff_ref`/`evidence_ref` pointers), prior rounds' state. This is the
direct fix for the state-smuggling failure mode named in the brief — "the whole
context" on an edge would make Model A cosmetic, since nothing would actually be
constrained.

### Branching, parallelism, loop-back, termination in Model A terms
- **Branching:** the fan-out to five gates is unconditional (all five always run) —
  this is the one place "branching" in Model A means literal parallel dispatch, not a
  choice.
- **Parallelism:** exactly the five gates, matching research finding 8a's isolatability
  test — each gate reads the same diff and produces an independent verdict with no
  need to see the others' output, which is precisely the case Anthropic's multi-agent
  post says parallelism helps and Cognition's critique doesn't apply to. **This claim
  needs defending, not just asserting (Round 2 Red Hat HIGH-1) — see below.**

**Isolatability, defended, with the cost conceded.** Red Hat's scenario: Security flags
a SQL-injection-shaped risk; Code Reviewer, doing spec-fidelity review on the same diff,
would legitimately benefit from seeing that finding — and cross-cutting risks specific
to this codebase (e.g. a change under `electron/db/**` that needs a `better-sqlite3`
ABI rebuild per CLAUDE.md, which Verifier's build/test run might surface but a
spec-fidelity-only read might not connect to the diff's intent) are exactly the kind of
thing cross-gate visibility mid-review would catch better than isolation does. That
scenario is correct, and isolatability is not costless — it should not have been stated
as if it were.

The actual architecture this design commits to is narrower than "the gates never learn
about each other's findings": **the five gates are isolated at INPUT — each produces an
independent verdict from the same `diff_ref`/`design_spec_ref`, which is what makes the
parallel fan-out itself valid under finding 8a's isolatability test — and cross-gate
SYNTHESIS is the reducer/Grader's job, performed on the merged `GateReport`, not
something any individual gate does mid-review.** That is the boundary: input-isolation
during the parallel stage, synthesis after merge.

**The accepted cost, named plainly:** some cross-cutting risks that cross-gate
visibility *during* review might catch are, under this design, caught only at the merge
step if at all — because by the time Grader synthesizes the five reports, each gate has
already finished its independent pass and cannot revise its verdict in light of what
another gate found. The concrete Shoresh example: if Security's report on an
`electron/db/**` diff surfaces a finding that implies a `better-sqlite3` ABI rebuild is
needed, and Verifier's independent pass already ran (and possibly passed, against a
stale native binary) before that finding existed, nothing in this design routes
Security's finding back to Verifier for a second look — the reducer can only surface
both findings side by side in `GateReport`, and it is Grader (or a human, at the
promotion gate) who has to notice the connection. This is a real gap, not a solved
problem, and it is the direct tradeoff for keeping the five gates parallel and cheap
rather than serialized or cross-informed. If this gap proves costly in practice, the
fix is not to abandon input-isolation (that reintroduces the ordering/latency cost
parallelism exists to avoid) but to give the reducer a declared rule for flagging
findings that reference the same file/module across gates for mandatory human attention
at the promotion gate — noted here as a candidate follow-up, not adopted in this ADR.
- **Loop-back:** unchanged from today — Governor decides RETRY/ESCALATE from
  `GateReport` + round number, and that decision itself is *not* fixed by Model A (see
  §5, determinism line).
- **Termination:** unchanged — the existing round-1/round-2 cap, which is already a
  hard step-cap in the constitution, not a trust-based limit (research finding 7 is
  already satisfied here; Model A doesn't need to add one).

---

## 4. Human decision points and quality gates as first-class graph elements

Per the constitution, three points are reserved to the human: spec approval, ADR
acceptance, promotion/merge. Under Model A these are represented as **durable PAUSE
nodes** (research finding 4 — HITL is a pause primitive, not a code branch):
persist `{task_id, artifact_ref (spec/ADR/diff), score_context}`, suspend indefinitely,
resume only on an explicit external human event carrying `{decision: APPROVE|REJECT,
comments}`. A human REJECT is a **first-class edge back to Governor/spec-clarify**, not
a silent fallthrough — it carries the same typed shape as a gate FAIL, so "human said no"
and "Verifier said no" are both representable, auditable transitions, not one written
into prose and the other invisible.

The gate stack's `GateReport.verifier_pass = false` is a **hard block edge**: Governor's
decision node cannot legally reach PASS while `verifier_pass` is false, regardless of
`overall_score` — this mechanically encodes the constitution's rule that a reviewer
score is never proof when a required gate fails (rule 8), rather than relying on
Governor remembering to apply it.

---

## 5. Determinism-vs-adaptivity line — defended

**Fixed:** the five-gate fan-out and its reducer contract. That's the entire list.

**Stays model-decided:** whether Architect/Designer run at all; which agent Governor
loops back to on RETRY; how a retry brief is phrased; whether a task is classified as
needing escalation before round 2 exhausts; anything touching novel task shape.

**Why the line sits here:** the gate stack is the one stage where, in the research's own
framing (finding 8a), the sub-tasks are mutually isolatable — each gate needs the diff
and nothing else, doesn't need to negotiate with the other gates, and the "coordination"
required is exactly a merge, which is a mechanical operation, not a judgment call. Every
other stage in the loop is the opposite: Governor's routing depends on *what it finds*
at each step in a way that isn't enumerable without either (a) accepting Model B's risk
of a task needing an edge that doesn't exist, or (b) padding the edge set with a
catch-all "Governor does something clever" edge, which is not a graph, it's a graph-
shaped decoration around the same loop. Fixing only the isolatable stage captures real
structure without paying Model B's degenerate-case cost.

---

## 6. Degenerate cases, handled explicitly

- **Empty graph:** a trivial task skips Architect and Designer (existing classify logic,
  untouched) and goes straight Governor → Maker → gate-fan-out. Model A doesn't require
  Architect/Designer to exist as nodes in every run; they're optional dispatches
  Governor still decides on, same as today.
- **Single node:** a Maker-only fix (no Architect, no Designer) still passes through the
  one fixed edge (gate-fan-out) — the fixed edge doesn't require anything upstream to
  also be fixed.
- **Task needing an unplanned agent:** genuinely unsolved by any graph, fixed or bounded
  — a static edge set cannot invent a reviewer. Model A's bet is that this failure mode
  is *contained* to Governor's still-dynamic routing (where it already exists today,
  unchanged), rather than *introduced* into the one part of the workflow that's fixed.
  Model B would move this risk into the gate/pipeline layer too; Model A deliberately
  doesn't. **Correction per Round 2 review (MEDIUM-4):** an earlier draft of §11 locked
  the five-gate set in a way that read as stricter than "unchanged" — that was an
  internal contradiction with this bullet, now resolved as follows. **The five gates
  are a FLOOR, not a ceiling.** Governor may still dispatch an *additional* ad-hoc
  reviewer at runtime alongside the fixed five — that stays exactly as dynamic and
  unconstrained as today, and is how the "needs an unplanned agent" case is actually
  handled under Model A. What §11 locks is narrower: Governor (or any node) may not
  *remove* one of the five gates, and may not weaken the hard-block/reducer rule, at
  runtime — changing that floor is a decision that goes through the human-ADR path,
  same as this document itself.
- **A cycle that never terminates:** already bounded by the existing round-1/round-2
  human-escalation cap in the constitution; Model A adds no new cycle, so no new cap is
  needed.
- **A human gate that rejects:** handled in §4 as a first-class typed backward edge, not
  a silent branch.

---

## 7. Tradeoff table — graph vs. loop

| Dimension | Loop (today) | Model A (bounded graph) |
|---|---|---|
| Flexibility | Maximal — Governor can improvise any transition | Slightly reduced at exactly one stage (gate fan-in is no longer improvised, but it wasn't meaningfully improvised in practice anyway) |
| Determinism/reproducibility | None at the gate-merge step — same gate reports could be read into different scores at different times with no record of why | Reducer logic for gate merge is declared and checkable independent of Grader's prose judgment |
| Authoring/maintenance cost | Zero marginal cost — nothing to keep in sync | One schema (`GateReport`) and one reducer to maintain; low, bounded |
| Debuggability | Reconstructing "why did this task fail" requires re-reading the transcript | `GateReport` is a queryable artifact independent of the transcript |
| Where a rigid graph is WORSE | — | Model B specifically, not Model A: fixing the *whole* pipeline as a static graph would be worse than model-decided routing precisely where Governor needs to invent a transition a designer of the graph didn't anticipate (a task needing an agent outside the roster, or a routing sequence no one wrote a guard for). Model A avoids this because it fixes nothing upstream of the gate stack. |

---

## 8. Concrete present failure this solves — and what it does NOT solve

**Named present failures (my inference from the architecture, not an observed incident
log — flagged per the brief's honesty requirement):**

1. **Gate-fan-in merge logic is undeclared.** Today, if Verifier PASSes but Security
   flags a critical issue, or two gates disagree, the resolution lives entirely in
   Grader's freeform reading of four prose reports — there is no rule to point to, and
   two different sessions could plausibly read the same four reports into different
   scores with no record of why. This is the concrete Shoresh instance of research
   finding 3.
2. **No durable record of which gate blocked a task.** If a RETRY happens, the reason
   lives in that round's transcript, not in any structured, queryable place — a month
   later there's no way to ask "how often does Security block vs. Red Hat" without
   re-reading conversations.

**What Model A does NOT solve (say so plainly, per the brief):**
- It does not make Governor's own role-routing reproducible or auditable — that's
  Model C's concern, deliberately out of scope here to keep the change bounded.
- It does not solve side-effect rollback. If Maker already wrote files or ran a
  migration before the gate stack blocks it, the graph gives you the *state* to
  restore to (prior `diff_ref`) but not an automatic undo of anything Maker already
  committed to disk or the op-log — that remains a git-level/manual compensation,
  exactly as research finding 5 says no framework solves this automatically.
- If no such failure has actually occurred in a real Shoresh session, that is a
  legitimate reason to treat this as a preventive/observability investment rather than
  a bug fix — see the recommendation's confidence level below.

---

## 9. Worked trace

**Task:** "Add a per-slot 'locked' indicator to the schedule grid" (UI-significant →
Designer fires; matches the codebase's existing per-cell data-attribute pattern in
`scheduleGrid.css`).

1. **Governor** classifies: UI-significant, no new persisted data shape (locked state
   already exists per `ScheduleScreen.jsx`'s activity-locking feature — this is a
   display-only addition) → no ADR needed, Designer required, Architect not required.
   *(This routing decision is NOT fixed by Model A — Governor decides it exactly as
   today.)*
2. **Governor → Designer** edge (not fixed by Model A, still freeform dispatch):
   `{task_id: T-lock-indicator, spec_summary: "...", ui_significant: true}`.
3. **Designer → Maker** edge (not fixed): `{task_id, design_spec_ref: docs/work/.../lock-indicator-spec.md}`.
4. **Maker** implements: adds `data-locked` attribute + `scheduleGrid.css` rule
   (per CLAUDE.md's documented pattern for new ephemeral cell state), writes/updates
   tests in `ScheduleScreen`-adjacent test files, produces `diff_ref: <commit-sha>`.
5. **Maker → gate-fan-out** — **the one fixed edge**:
   `{task_id, diff_ref: <sha>, files_changed: ["src/components/schedule/scheduleGrid.css", "src/screens/ScheduleScreen.jsx", "...test.js"], test_files_added: ["...test.js"], spec_summary}`.
6. **Parallel fan-out** (fixed, unconditional, isolated): Verifier runs lint/test/build
   against `diff_ref` → `{gate_name: verifier, verdict: FAIL, findings: ["1 test failing: lock indicator not rendered when slot.locked=false and overlay=true"], evidence_ref: <test output>}`. Security, Red Hat, Tester, Code Reviewer each independently
   return their own typed reports off the same `diff_ref`.
7. **Reducer** (fixed): assembles `GateReport {verifier_pass: false, gate_scores: {...}, blocking_findings: ["verifier: 1 failing test"], incomplete: false}`. Per the hard-block
   rule in §4, this `GateReport` cannot reach a PASS regardless of the other four
   scores.
8. **Grader** still runs (constitution: Grader consolidates opinion reviews regardless,
   for record-keeping) → `{overall_score: 3.8, dim_scores: {...}, verdict_recommendation: "block — verifier fail"}`.
9. **Governor decision node** (not fixed by Model A): reads `GateReport.verifier_pass =
   false` → **RETRY, round 1**. This is a **gate-failure-with-rollback**:
   - **State-restore** (what Model A actually gives you): the retry edge back to Maker
     carries `{task_id, prior_diff_ref: <sha>, blocking_findings: ["verifier: 1 failing test"], design_spec_ref: <unchanged>}` — Maker is re-dispatched with the *original*
     design spec plus the specific failure, not asked to re-derive context from
     scratch, and not handed the whole prior transcript.
   - **Side-effect note (explicitly NOT auto-solved):** if Maker's failed attempt had
     already run a DB migration or written non-source-controlled state, Model A's
     state-restore does nothing about that — it restores the *graph's* state
     (`diff_ref` pointer), not the filesystem or op-log. That remains manual/git-level
     compensation, exactly as flagged in §8.
10. **Maker retry**: fixes the failing test, produces `diff_ref: <sha2>` → same fixed
    gate-fan-out edge fires again.
11. **Gate-fan-out round 2**: `GateReport {verifier_pass: true, gate_scores: avg 4.3, blocking_findings: [], incomplete: false}`.
12. **Grader → Governor**: `overall_score: 4.3, no dim < 3` → **PASS**.
13. **Human gate (promotion)** — first-class pause node: `{task_id, diff_ref: <sha2>, artifact_ref: none (no ADR)}` → suspend → human reviews and either `{decision: APPROVE}` (merge proceeds) or `{decision: REJECT, comments}` (first-class backward edge to
    Governor/spec-clarify, per §4 — not modeled in this trace since the task is small,
    but structurally identical to the RETRY edge in step 9).

---

## 10. Migration path (reversible, small steps, no code)

1. **First ticket-sized move:** define the `GateReport` typed schema and the reducer
   rule (including the `INCOMPLETE`/hard-block behavior from §4) as a specification
   document — no code changes to Governor's dispatch logic, no change to how gates are
   invoked today. This is purely "declare the contract that already exists implicitly."
2. Instrument the existing gate-dispatch step to *write* a `GateReport`-shaped record
   (even if nothing downstream reads it yet) — an additive, reversible logging change.
3. Have Grader *read from* the persisted `GateReport` instead of freeform report text,
   as its sole input for the four opinion scores plus the Verifier hard-block check.
   This is the first behavior change, and it's reversible by reverting Grader's input
   source.
4. Only after step 3 has run on real tasks and the `INCOMPLETE`/hard-block rule has been
   observed to fire correctly (or not) — decide whether to extend fixed structure
   upstream (toward Model B) or to invest instead in Model C's persisted-trace layer for
   Governor's own routing. Do not decide this now; it depends on evidence step 3
   produces.

Each step is independently reversible: none of them touches Governor's role-routing
judgment, none of them requires a new agent role, and step 1 alone can be entirely
undone by discarding the schema doc.

---

## 11. Harness concerns (for harness-engineering)

Constraints that must survive if this is later implemented:

- **Budgets/step-caps:** the existing round-1/round-2 human-escalation cap must remain
  the sole termination bound for the Governor decision loop; Model A introduces no new
  cycle and must not introduce a new cap either.
- **Human-gate boundaries:** the three constitution-reserved human decisions (spec
  approval, ADR acceptance, promotion/merge) must remain pause-and-resume nodes that
  only a human event can resume — no gate-stack automation may be extended to auto-
  resume these, ever, regardless of `overall_score`.
- **Nodes that may NOT self-modify:** the gate-fan-out node set (the five gates) and the
  reducer rule are the one part of this proposal meant to be *stable* — no node in the
  graph (including Governor) should be able to add/remove a gate from the fan-out or
  alter the hard-block rule at runtime. Any change to that set is itself a decision that
  should go through the same human-ADR path as this document, not a runtime edit.
- **State-contract as a locked surface:** the `GateReport` schema (§3) is the one
  interface this proposal fixes. Widening it back toward "whole context" at any future
  point is the specific anti-pattern this document exists to prevent (research finding
  2) — any future change to that schema should be treated as a contract change, not a
  free edit.

---

## 12. Recommendation

**Adopt for a bounded sub-part: Model A (fix only the gate-stack fan-out/fan-in as a
typed graph node), plus persist the resulting `GateReport` as a durable record (a light
borrow from Model C, without adopting Model C's full scope).**

**Confidence: medium (roughly 60%).** 

**Evidence for:**
- Research finding 3 (parallel fan-in forces an explicit merge decision or silently
  corrupts) maps directly and concretely onto Grader's current freeform four-report
  read — this is the clearest, most specific correspondence between the cited research
  and an actual Shoresh mechanism.
- Research finding 8a's isolatability test (parallelism works when subtasks don't need
  to stay mutually consistent) cleanly classifies the gate stack as the right place for
  structure and Governor's routing as the wrong place — this gives a principled, not
  arbitrary, boundary for what to fix, directly answering the determinism-vs-adaptivity
  trap.
- Migration cost is genuinely small and every step is reversible (§10), consistent with
  "smallest responsible workflow" and with the constitution's preference for small
  reversible changes at important seams.

**Evidence against / reasons confidence isn't higher:**
- The two named present failures (§8) are my own architectural inference, not observed
  incidents from this project's actual session history — I have not verified that
  Grader has ever actually mis-merged conflicting gate reports. If Governor's team
  reviews recent sessions and finds this has simply never been a problem in practice,
  the case for Model A weakens to "cheap insurance" rather than "fixes a live failure,"
  which would lower confidence further toward "not yet."
- Model B and Model C remain live options if step 4 of the migration path (§10)
  surfaces evidence that routing-level opacity, not gate-merge opacity, is the actual
  pain point — this recommendation should not be read as closing that door.

This is explicitly **not** "adopt fully" (Model B's degenerate-case cost — an unplanned
agent need with no legal edge — is real and unresolved by any cited framework) and
explicitly **not** "not yet" (the gate-merge gap is concrete enough, and the fix cheap
and reversible enough, to be worth doing now rather than waiting for an incident).

---

## 13. Open questions for Governor (product decisions, not technical ones)

1. Should the `INCOMPLETE` hard-block state (a gate's report is missing) actually halt
   the pipeline, or should Governor retain discretion to proceed with a documented gap?
   This is a risk-tolerance call, not an architecture call.
2. Is there appetite to spend the migration-path step-4 evidence-gathering window (§10)
   before deciding on Model B/C, or does the product owner want a firmer timeline for
   extending structure upstream regardless of what step 3 shows?
3. Should the persisted `GateReport` records be visible to the human at the promotion
   gate as part of what they review, or kept as an internal audit artifact only? Affects
   what "the human owns promotion" means in practice.
