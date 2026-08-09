---
task: "Agent-quality track, Project B — cut wasted agent work (evidence-first, measured to set up a future learning loop)"
document_type: handoff
status: active
created: 2026-08-09
archive_when: "superseded by the delivered ADR + measurement spec + baseline evidence this brief calls for, once the sharpened agent definitions land and waste is re-measured"
---

# Handoff — Agent-quality track, Project B: cut wasted agent work

**Date:** 2026-08-09
**Type:** Design + evidence + governed change brief. Some prose/prompt edits, **no product code**. Drop this whole file into a fresh session as the opening context.
**Owner:** product owner (non-engineer; defines outcomes and operates the workflow, cannot validate low-level architecture — see `~/.claude/CLAUDE.md` engineering-workflow defaults).
**Who does the thinking:** the agents, routed through the Governor loop. This brief sets the goal, the yardstick, and the acceptance bar. It deliberately does **not** pre-decide how "waste" is defined or measured — that is the first design task, and it must be reached divergently, not imported from intuition.

---

## 0. How to run this (read first)

- Launch in a session whose cwd is a Shoresh worktree so the agent team registers (Governor, Architect, Red Hat, Verifier, etc. live in `.claude/agents/`). If `Agent(subagent_type: 'governor')` errors with "not found," you launched from the wrong directory.
- Route this through the **Governor loop**, per `~/.claude/WORKFLOW_CONSTITUTION.md` and the project constitution (`docs/governance/constitution/CONSTITUTION.md`). This is architecturally/process significant, so it wants **Architect** (design + ADR) and adversarial review (**Red Hat**), not a Maker-first path.
- **Divergent then convergent**: the definition of "wasted agent work" and the measurement method both have genuinely different shapes. Produce at least three materially different definitions/measurement approaches, score them, then converge. Do not collapse to the first plausible metric.
- **Evidence before proposing.** The owner has an established preference (memory `feedback_reference_research_before_divergence`, and the graph-track precedent where evidence-first paid off): measure the real baseline from actual run history before recommending any change.
- Consult skills as peers, not answers: `self-improvement-loops` (this is the on-ramp to a learning loop — heed its acceptance-gate/measurement discipline), `evaluation` and `advanced-evaluation` (metric design, gaming resistance, judge calibration), `harness-engineering` (what is a locked vs. editable surface), `multi-agent-patterns` (the team topology being tuned).

---

## 1. Context the new window will not have

**The product.** Shoresh — a local-first Electron scheduling app for camp directors (SQLite, LAN sync, no cloud). Repo `~/dev/shoresh`. This brief is **not** about the product; it is about the **agent workflow that builds the product.**

**The agent workflow.** Work is routed by a **Governor** orchestrator that holds the goal, clarifies spec, plans, and dispatches a team on a per-task basis: **doer/orchestrator agents** — Governor (routing), Architect (design/ADR), Designer (UI spec), Maker (implements test-first) — and a **gate stack** — Verifier (deterministic tests/lint/build), Security, Red Hat (adversarial), Tester (director's-eye UX), Code Reviewer, Grader (consolidated score). Agent definitions live in `.claude/agents/*.md`; those files are the "source code" of agent behaviour. Humans own named decision points (spec approval, ADRs, promotion). Durable run history lives in `docs/work/runs/` (typed run records: gates, verdicts, scores, decisions) and in session transcripts.

**Where this sits in a larger arc.** The owner is upgrading agent ability in steps.
- **Step 1 (done):** nightly memory consolidation — mining each day's sessions into memory deltas (memory `project_nightly_memory_consolidation`).
- **Step 2 (done, 2026-08-09):** graph-engineering exploration + the GateReport schema/reducer spec (T79) — legibility/plumbing for the gate fan-in. Merged to main.
- **Step 3 (this brief):** the **agent-quality track**. After scoping with the owner, the track was split: making the *review gates* sharper is **explicitly deprioritized** ("the gates are working well right now"). The target is the **doer + orchestrator** side.

**The owner's decisions that scope this brief (made 2026-08-09, these are inputs, not open questions):**
1. **Aim at the doer/orchestrator agents** (Maker, Architect, Governor; Designer if evidence warrants), **not** the gate stack.
2. **Approach: improve directly, hand-tuned from evidence (Option B), aimed to set up a future learning loop (Option A).** A closed learning loop is explicitly **out of scope now** — but B must be built so that its measurement instrument is exactly what a future A would need. The reasoning the owner accepted: you cannot build a trustworthy learning loop until you can measure agent quality honestly, and the run corpus today is too small/biased (~11 records, ~two weeks, self-authored — established in the step-2 evidence review) to train or even measure a loop against safely. B produces that measurement.
3. **Primary yardstick: "less wasted agent work."**
4. **Non-negotiable guard on the yardstick:** waste is only "cut" if it is cut **at equal-or-better outcome quality.** Raw "fewer agent runs" is rejected as the target because, optimized naively, it degrades into "do less review" — under-dispatching gates, shortening rigor — which would erode the gates the owner says are working. The metric MUST carry a quality floor (gate verdicts and human accept-rate hold or improve) so it cannot be gamed by doing less.

---

## 2. The task

Through the Governor loop, produce a **design + evidence deliverable** that (a) defines "wasted agent work" for this workflow rigorously and gaming-resistantly, (b) measures the real baseline from actual run history, (c) audits the doer/orchestrator agent definitions against that baseline, (d) sharpens them with concrete reversible edits each tied to a named waste pattern, (e) re-measures to show waste dropped without quality loss, and (f) leaves the measurement instrument in place as the on-ramp to a future learning loop.

The design/ADR, the measurement, the baseline evidence, and the sharpened agent-definition edits are the deliverables. The only "code-like" changes permitted are edits to `.claude/agents/*.md` and any measurement/analysis tooling the design justifies; **no changes to Shoresh product code** (`src/`, `electron/`).

---

## 3. Success predicate (what must be true at return)

An ADR-backed deliverable exists that satisfies **all** of the following:

1. **Defines "wasted agent work"** for this specific workflow, operationally and gaming-resistantly — reached divergently (≥3 materially different candidate definitions scored before converging). The definition names concrete waste categories in this team's terms (e.g. redundant re-dispatch, an agent run whose output changed nothing downstream, gates dispatched that could never fire, retry rounds caused by *avoidable* upstream misses, work an agent re-derives by hand each run).
2. **Carries the quality floor as part of the metric, not a footnote.** The definition of "waste cut" is inseparable from "outcome quality held or improved" (gate verdicts, human accept-rate, or a defensible proxy). It must be impossible to score a win by reducing rigor. State exactly what the floor is and how it is checked.
3. **Measures the real baseline** from `docs/work/runs/` + session transcripts (and any other durable history): where is waste actually occurring today, how much, and in which agents' behaviour. Honest about corpus size and bias. If the evidence is too thin to quantify a category, say so — an underdetermined category is a finding, not a gap to paper over.
4. **Attributes waste to agent-definition causes.** For each material waste pattern, identifies what in the current `.claude/agents/*.md` instructions (or the Governor's routing policy) *causes* it — the seam a hand-edit would target.
5. **Proposes concrete, reversible edits** to the doer/orchestrator agent definitions, each tied to a named waste pattern and its evidence, governed and ADR'd. No edit is justified by intuition alone; each cites the baseline.
6. **Re-measures after the edits** (or specifies exactly how re-measurement will be run and on what tasks) and shows waste dropped **without** tripping the quality floor. If re-measurement cannot be run on real tasks within this cycle, the deliverable must define the before/after protocol precisely enough that the next cycle can execute it deterministically.
7. **Leaves the measurement instrument in place and names the A on-ramp** — states plainly what a future learning loop could optimize against this yardstick, and what would still have to be true (corpus size, acceptance gate, guardrails per `self-improvement-loops`) before A is safe to build. B is the prerequisite; say what B does and does not unlock.
8. **Gives one recommendation** per convergent decision with a stated confidence level and the evidence behind it (constitution rules 2/6/7).
9. **Survives adversarial audit** against §5.

---

## 4. Does NOT count (return these and the task is not done)

- A definition of waste that is just "unnecessary work" without operational categories tied to this team and measurable against the run corpus.
- A metric without the quality floor, or with a floor that is stated but not actually enforceable/checkable — i.e. any metric a Governor could satisfy by dispatching fewer gates or shortening review.
- Proposing agent-definition edits with no baseline evidence that the targeted waste actually occurs ("this prompt could be tighter" is not evidence).
- Building, or starting to build, a closed learning loop / self-modifying agent now. B sets A up; it does not implement A.
- Any change to Shoresh product code (`src/`, `electron/`), or to the **gate-stack** agent definitions beyond what is strictly needed to measure them (the gates are deprioritized by owner decision; do not "improve" them here).
- A recommendation with no confidence level or no evidence.
- A pure efficiency win that reduces agent runs while quietly lowering rigor — this is the explicit failure mode the quality floor exists to catch.

---

## 5. Auditor checklist (Red Hat / independent review must hunt for)

- **Proxy-gaming:** can the proposed metric be satisfied by doing *less* — fewer gates, shorter review, skipped adversarial passes — while the "waste" number improves? If the quality floor doesn't provably block that, the metric is unsafe.
- **Quality-floor teeth:** is the floor actually measurable and enforced, or decorative? What exactly is checked, on what data, and what happens when waste-down collides with quality-down?
- **Evidence vs. assertion:** is every claimed waste pattern and every proposed edit tied to something observable in the real run history, or is some of it the reviewer's aesthetic preference for "tighter" prompts?
- **Corpus honesty:** is the baseline honest about ~11 self-authored records over two weeks? Does any conclusion over-reach what that corpus can support? (Same trap the step-2 evidence review named.)
- **Attribution soundness:** does "this agent definition causes this waste" actually follow, or is the waste caused by task variance / the Governor's per-task judgment / the human, mislabeled as an agent-definition defect?
- **Reversibility & blast radius:** are the edits genuinely reversible text, and could any of them degrade output quality or erode a human gate as a side effect of chasing efficiency?
- **A-onramp overreach:** does the deliverable quietly assume the learning loop, or keep it firmly parked with the guardrails `self-improvement-loops` requires?
- **Scope creep into the gates:** did the work "improve" the gate stack despite the owner deprioritizing it?

---

## 6. Constraints & guardrails

- **No Shoresh product-code changes.** Editable surfaces are `.claude/agents/*.md` and any justified measurement/analysis tooling under a docs/scripts path the design names. Product `src/`/`electron/` is off-limits.
- **The quality floor is non-negotiable** (owner decision, §1.4). Any recommendation that cannot demonstrate waste-cut-at-held-quality is not acceptable, however large the efficiency gain.
- **Do not build A.** The learning loop is explicitly out of scope; B only sets it up. Note A-relevant constraints (locked surfaces, what agents may not self-modify, acceptance gates) for `harness-engineering`/`self-improvement-loops`, do not implement them.
- **Governance:** any doc created must pass `npm run check:governance` (frontmatter/cross-reference integrity) and keep `docs/work/INDEX.md` current (`npm run index:work`). Use the next free ticket id (main is at T78; T79 is taken by the GateReport spec — check the tickets dir for the next free number).
- Keep the recommendation honest about uncertainty and stop for human judgment where the call is genuinely the owner's (constitution rules 6, 10).

---

## 7. Return condition

Return only when: the ADR + measurement spec + baseline-evidence deliverable exists; the waste definition carries an enforceable quality floor; the proposed agent-definition edits are each tied to baseline evidence; re-measurement is either done or specified deterministically; the A on-ramp is named with its guardrails; and the deliverable has passed an independent adversarial review against §5 with all findings resolved in place (per "fix all findings, no triage" — memory `feedback_fix_all_findings_no_triage`). Do not return a partial draft, a metric without a floor, or a set of prompt edits unbacked by evidence.

---

## 8. Pointers

- Workflow constitution: `~/.claude/WORKFLOW_CONSTITUTION.md`; project constitution: `docs/governance/constitution/CONSTITUTION.md`; governance index: `docs/governance/GOVERNANCE_INDEX.md`
- Agent definitions (the surfaces being tuned): `~/dev/shoresh/.claude/agents/*.md`
- Run history (the baseline evidence source): `docs/work/runs/`
- Step-2 precedents (evidence-first, adversarial-audit shape): `docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md`, `docs/work/2026-08-09-graph-engineering-exploration.md`, `docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md`
- Owner defaults: `~/.claude/CLAUDE.md`
- Skills to consult (as peers, not answers): `self-improvement-loops`, `evaluation`, `advanced-evaluation`, `harness-engineering`, `multi-agent-patterns`
- Relevant memory: `project_nightly_memory_consolidation`, `feedback_reference_research_before_divergence`, `feedback_fix_all_findings_no_triage`, `feedback_governor_maker_resilience`
