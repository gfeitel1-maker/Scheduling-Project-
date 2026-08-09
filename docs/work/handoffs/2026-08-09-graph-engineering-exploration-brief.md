---
task: "Design exploration — from dynamic looping to graph engineering"
document_type: handoff
status: superseded
created: 2026-08-09
archive_when: "superseded by the delivered ADR (docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md) and exploration doc — kept as the originating brief for provenance"
---

# Handoff — Design exploration: from dynamic looping to graph engineering

**Date:** 2026-08-09
**Type:** Design/decision exploration brief. **No code.** Drop this whole file into a fresh session as the opening context.
**Owner:** product owner (non-engineer; can define outcomes and operate the workflow, cannot validate low-level architecture — see `~/.claude/CLAUDE.md` engineering-workflow defaults).
**Who does the thinking:** the agents. This brief sets up the question and the acceptance bar. It deliberately does **not** answer it. Whoever picks this up must not collapse the exploration into their first intuition.

---

## 0. How to run this (read first)

- Launch in a session whose cwd is `~/dev/shoresh` so the agent team registers (Governor, Architect, Red Hat, Verifier, etc. live in `.claude/agents/`). If `Agent(subagent_type: 'governor')` errors with "not found," you launched from the wrong directory — fix that before anything else.
- Route this through the **Governor loop**, per the workflow constitution at `~/.claude/WORKFLOW_CONSTITUTION.md`. This is architecturally significant, so it wants **Architect** (design + ADR) and adversarial review (**Red Hat**), not a Maker.
- **Divergent then convergent** (constitution + `/adhd` if useful): genuinely different structural proposals first, scored, then converge on one recommendation. Do not converge before at least three materially different models exist.
- Consult before proposing: skills `multi-agent-patterns` (topology/coordination), `harness-engineering` (control surfaces, locked/editable boundaries, rollback), `self-improvement-loops` (if any node self-modifies), and `long-horizon-prompting` (this brief's own lineage). Reference research on real agent-graph systems is a **peer phase**, not an afterthought (see memory `feedback_reference_research_before_divergence`).

---

## 1. Context the new window will not have

**The product.** Shoresh — a local-first Electron scheduling app for camp directors (SQLite, LAN sync, no cloud). Repo `~/dev/shoresh`, branch `main`, concurrent work in git worktrees under `.claude/worktrees/`.

**The current agent workflow — what "dynamic looping" means here.** Work is routed by a **Governor** orchestrator that holds the goal, clarifies spec, plans, and dispatches a team on a per-task, one-round-at-a-time basis: Architect (design/ADR), Designer (UI spec), Maker (implements test-first), then a gate stack — Verifier (deterministic tests/lint/build), Security, Red Hat (adversarial), Tester (director's-eye UX), Code Reviewer, Grader (consolidated score). The Governor reads the results, decides pass/retry/re-dispatch, and loops. Humans sit at named decision points (spec approval, ADRs, promotion). The control flow is **decided turn-by-turn by the Governor's judgment** — which agent runs next, and whether to loop, is a model decision each round.

**What just changed (step 1, done 2026-08-09).** The agents' **memory** was upgraded: a nightly consolidation pass mines each day's sessions into itemized memory deltas (see `project_nightly_memory_consolidation` in the project memory). The owner considers this the first step in a larger upgrade of agent abilities. **This brief is step 2.**

**The owner's stated framing (verbatim intent, not a solution):** "the agent workflow should be something close to a dynamic loop… the next step is to define what it would look like to move from dynamic looping to graph engineering." The owner has **not** defined "graph engineering." Defining it precisely, for this workflow, is the first task below — not an assumption to import from any particular framework or vendor.

---

## 2. The task

Produce a **design decision document** (an ADR plus supporting exploration, under `docs/adr/` and `docs/work/`) that defines what moving this agent workflow from dynamic looping to graph engineering would look like — rigorously enough that a future session could implement it — **without writing any implementation code now.**

The document is the deliverable. Diagrams, state/transition tables, and worked traces are expected. Code is not.

---

## 3. Success predicate (what must be true of the document at return)

A single ADR-backed design doc exists that satisfies **all** of the following:

1. **Defines the terms.** States precisely what "dynamic loop" is *in this workflow today* and what "graph engineering" would mean *for this workflow* — including the degenerate case: articulate why the current Governor loop is or is not *already* a graph, so the distinction is real and not cosmetic.
2. **Names the unit of the graph.** Specifies concretely what the nodes are, what the edges/transitions are, what state flows along them, and how branching, parallelism, looping-back, and termination are expressed — in terms of *this* team (Governor/Architect/Maker/gates/human) and *this* domain, not a generic diagram.
3. **Locates human decision points and quality gates** as first-class elements of the graph, consistent with the workflow constitution (deterministic evidence vs. agent opinion; humans own spec/ADR/promotion).
4. **States what problem the move solves** — the observable failure(s) of the current dynamic loop that a graph model fixes (e.g. non-reproducibility of routing, invisible state, no rollback to a prior node, wasted re-runs, weak parallelism). If it cannot name a concrete present failure, that is a finding in itself and must be stated plainly.
5. **Enumerates tradeoffs** of graph engineering vs. keeping the dynamic loop: flexibility lost, determinism/reproducibility gained, authoring/maintenance cost, debuggability, and where a rigid graph would be *worse* than model-decided routing.
6. **Gives one recommendation** with a stated confidence level and the evidence behind it (constitution rule 2/6/7), including whether the answer is "adopt fully," "adopt for a bounded sub-part," or "not yet — the loop is sufficient."
7. **Sketches a migration path** in small reversible steps, with the first ticket-sized move identified — but writes no code.
8. **Survives adversarial audit** against §5 below.

---

## 4. Does NOT count (return these and the task is not done)

- A restatement of the ambiguity ("graph engineering means using a graph") without an operational definition tied to this team and domain.
- Picking a framework (LangGraph, state machines, DAG runners, etc.) as the answer. Tool selection is downstream of the model; a framework named before the node/edge/state model is justified does not count.
- A diagram with no state semantics, no transition rules, and no worked trace of a real Shoresh task flowing through it.
- A design that merely renames the current Governor loop's steps as "nodes" without changing what is decided-at-runtime vs. fixed-in-structure.
- A pure vision/benefits essay with no tradeoffs and no place where graph engineering is the wrong choice.
- Any implementation code, scaffolding, or config.
- A recommendation with no confidence level or no evidence.

---

## 5. Auditor checklist (Red Hat / independent review must hunt for)

- **Cosmetic reframing:** does the proposal actually change control flow, or just relabel the loop? Test: is anything decided-at-runtime today now fixed-in-structure, or vice versa? If nothing moves, it is cosmetic.
- **Determinism vs. adaptivity trap:** a graph buys reproducibility by fixing transitions; the current loop's value is the Governor adapting routing to what it finds. Does the proposal say *which* decisions should become fixed edges and *which* must stay model-decided — and defend the line?
- **State smuggling:** what state travels the edges? If "everything / the whole context," the graph adds nothing over the loop. Look for an explicit, minimal state contract per node.
- **Missing degenerate cases:** empty graph, single-node, a task that needs an unplanned agent, a cycle that never terminates, a human gate that rejects — does the model handle these or ignore them?
- **Human-gate erosion:** does making the graph "flow" quietly automate a decision the constitution reserves for a human?
- **Rollback and failure:** can the graph return to a prior node on gate failure, and is prior state restorable, or is failure just "loop again"?
- **Circular justification:** "we need a graph because graphs are better" — is every claimed benefit tied to a named present failure in §3.4?
- **Unverified benefit claims:** each asserted gain (reproducibility, parallelism, debuggability) must be checkable against a concrete Shoresh scenario, not asserted in the abstract.

---

## 6. Constraints & guardrails

- **No code.** The return artifact is documents only.
- **Do not** treat any vendor's or framework's default as the definition of graph engineering; if external research is used, cite it and keep it as input, not answer (reference-research-as-peer-phase, per memory).
- Constraints that would need to survive later (budgets, human-gate boundaries, what agents may not self-modify) are **harness** concerns — note them for `harness-engineering`, do not bury them in prose that a future implementer can optimize away.
- Keep the recommendation honest about uncertainty and stop for human judgment where the call is genuinely the owner's (constitution rules 6, 10).

---

## 7. Return condition

Return only when the ADR + exploration doc exists, a worked trace of one real Shoresh task through the proposed graph is included, and the doc has passed an independent adversarial review against §5 with findings resolved (per "fix all findings, no triage" — memory `feedback_fix_all_findings_no_triage`). Do not return a partial draft, a framework pick, or an explanation of why it is hard.

---

## 8. Pointers

- Workflow constitution: `~/.claude/WORKFLOW_CONSTITUTION.md`
- Agent definitions: `~/dev/shoresh/.claude/agents/*.md`
- Owner defaults: `~/.claude/CLAUDE.md`
- Project memory (relevant): `project_nightly_memory_consolidation`, `feedback_reference_research_before_divergence`, `feedback_fix_all_findings_no_triage`, `feedback_governor_maker_resilience`, `project_shoresh_local_first_architecture`
- Skills to consult: `multi-agent-patterns`, `harness-engineering`, `self-improvement-loops`, `long-horizon-prompting`
