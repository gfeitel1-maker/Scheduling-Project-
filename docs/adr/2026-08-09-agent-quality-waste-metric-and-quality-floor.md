---
title: "Wasted-agent-work metric with an inseparable quality floor (agent-quality track, Project B)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-09
supersedes: []
implementation_state: edits-applied-remeasurement-deferred
affects:
  - .claude/agents/maker.md
  - .claude/agents/governor.md
  - docs/work/specs/2026-08-09-wasted-agent-work-measurement-spec.md
---

# Wasted-agent-work metric with an inseparable quality floor

**Status: PROPOSED.** This ADR records the agent-quality-track (Project B) decision from
`docs/work/handoffs/2026-08-09-agent-quality-cut-wasted-work-brief.md`: how "wasted agent work" is
defined and measured for this workflow, why the quality floor is a hard veto rather than a
footnote, and the three concrete agent-definition edits the baseline evidence supports. The
baseline measurement itself, its corpus-honesty caveats, and the per-record coding live in
`docs/work/2026-08-09-agent-quality-waste-baseline.md`; the full operational taxonomy and
re-measurement protocol live in `docs/work/specs/2026-08-09-wasted-agent-work-measurement-spec.md`.
This ADR holds the decision.

---

## Context

Shoresh's agent workflow is routed by a Governor orchestrator dispatching a fixed team —
doer/orchestrator agents (Governor, Architect, Designer, Maker) and a gate stack (Verifier,
Security, Red Hat, Tester, Code Reviewer, Grader) — per `.claude/agents/*.md`. The product owner
is upgrading agent ability in steps: Step 1 (nightly memory consolidation, done), Step 2 (the
graph-engineering exploration + GateReport schema/reducer spec, T79, done, merged to main), and
Step 3 — this track — the **agent-quality track**, scoped by the owner to the doer/orchestrator
side. The gate stack is explicitly deprioritized ("the gates are working well right now") and is
out of scope here, structurally: this ADR touches zero gate-stack agent-definition files.

**Corpus correction.** An earlier framing of this track referred to "~11 records." Re-verification
against `docs/work/runs/` finds **10 typed run records plus `TEMPLATE.md`** (`ls docs/work/runs/`
returns 11 entries; `TEMPLATE.md` is a blank form excluded from the corpus by the same rule
`check-governance.js` applies to it). The corpus is **n=10**, not 11. This correction is carried
through to the baseline-evidence document and is itself an instance of the corpus-honesty
discipline this track is supposed to encode: a headline number gets re-checked against the
filesystem, not carried forward from memory.

**A second correction, on attribution.** An early read of T32 attributed its round-1 interruption
(an external session usage-limit crash mid-verification) to the full four-agent gate-stack panel
having to re-run. The run record (`docs/work/runs/2026-08-01-t32-schedule-slot-mutations-run.md`)
shows round 2 was **Maker (test-only) + Verifier + Grader only** — Red Hat and Code Reviewer's
round-1 findings were addressed by a test-only diff that left production code byte-identical, so
neither needed to re-run. Treating round 2 as "the full gate stack re-ran" would have overstated
the waste at T32 and, worse, would have misattributed it to the gate stack's dispatch policy
rather than to Maker's missing interruption-disclosure shape — which is the seam this ADR actually
edits (W1, below). Getting this right matters because the fix has to point at the true cause, not
at deprioritized territory.

**The owner's decisions that scope this ADR** (quoting §1 of the handoff brief, verbatim):

> 1. **Aim at the doer/orchestrator agents** (Maker, Architect, Governor; Designer if evidence
>    warrants), **not** the gate stack.
> 2. **Approach: improve directly, hand-tuned from evidence (Option B), aimed to set up a future
>    learning loop (Option A).** A closed learning loop is explicitly **out of scope now** — but B
>    must be built so that its measurement instrument is exactly what a future A would need.
> 3. **Primary yardstick: "less wasted agent work."**
> 4. **Non-negotiable guard on the yardstick:** waste is only "cut" if it is cut **at
>    equal-or-better outcome quality.** Raw "fewer agent runs" is rejected as the target because,
>    optimized naively, it degrades into "do less review" ... The metric MUST carry a quality
>    floor (gate verdicts and human accept-rate hold or improve) so it cannot be gamed by doing
>    less.

**Relationship to the Step-2 gate-stack ADR.** This ADR is the agent-quality track's analog to
`docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md`: same evidence-first method (measure the
real corpus before proposing), same divergent-then-convergent shape (≥3 candidates scored before
converging, on two separate axes here), same adversarial-audit gate before acceptance. It
explicitly does **not** touch what that ADR touched — the GateReport schema, the reducer rule, or
any gate-stack dispatch logic. The two ADRs are siblings under the same larger arc, not a
sequence where one depends on the other's implementation.

---

## Considered Options

### A. What counts as "wasted agent work" — three candidates, scored

| # | Candidate | Description |
|---|---|---|
| A1 | **Categorical waste taxonomy** | Name concrete, team-specific waste patterns (redundant re-dispatch, no-op agent runs, gates dispatched that could never fire, avoidable retry rounds, hand-re-derivation of facts an agent could have been told) and count instances of each from run history. |
| A2 | **Round-count / dispatch-count proxy** | Treat "waste" as a function of raw round count or number of agents dispatched per task — fewer rounds/dispatches = less waste. |
| A3 | **Token/time-cost proxy** | Treat waste as excess wall-clock time or token spend relative to some baseline task-complexity estimate. |

**Scoring** (1–5, higher is better):

| Criterion | A1 | A2 | A3 |
|---|---|---|---|
| Gaming-resistant (can't be satisfied by doing less review) | 5 | 1 — directly rewards under-dispatch, the exact failure mode §1.4 forbids | 2 — rewards skipping gates that cost time |
| Measurable from existing run corpus | 4 — every category maps to something a run record already states or implies | 5 — round/verdict fields already exist | 2 — no token/time field is recorded in run history today |
| Attributable to a specific agent-definition seam | 5 — each category names *why*, not just *that* | 2 — a low round count says nothing about which agent's instructions caused it | 2 — same problem |
| Team-specific (not generic "less work is better") | 5 | 2 | 3 |
| **Total** | **19** | **10** | **9** |

**Decision: A1, with A2 folded in as a diagnostic signal, not the metric.** Round count is kept as
a secondary observation (it is cheap, already in every run record's frontmatter, and a useful
cross-check), but it is never the yardstick itself — §1.4 forbids exactly that. A3 is rejected as
primary: this repository's run records do not carry token/time data today, so a cost-proxy metric
would have to be built before it could be measured, inverting the evidence-first order this track
requires. A3 remains available as a future refinement once/if cost data is captured, but is out of
scope for this cycle.

### B. How to measure it — three approaches, scored

| # | Approach | Description |
|---|---|---|
| B1 | **Corpus mining only** | Code every existing run record + available session transcript against the A1 taxonomy; report the baseline; stop. |
| B2 | **Corpus mining anchored by B1, plus a before/after re-measurement protocol** | Same as B1, plus: apply the sharpened agent-def edits, then re-measure on the *next N dispatched tasks* under an identical coding taxonomy, comparing rate (not raw count) to the B1 baseline, with a quality-floor check that runs first and can void the comparison. |
| B3 | **Synthetic replay** | Re-run a sample of past tasks against the edited agent definitions in a sandboxed session, to isolate the edit's effect from natural task variance. |

**Scoring:**

| Criterion | B1 | B2 | B3 |
|---|---|---|---|
| Deliverable within this cycle (no closed loop, no live re-run infra) | 5 | 5 | 2 — needs a replay harness that does not exist; would itself be new infrastructure, arguably violating "do not build A" |
| Produces a real re-measurement, not just a baseline | 1 | 5 | 4 |
| Gaming-resistant (re-measurer can't cherry-pick favorable tasks) | 3 | 5 — protocol fixes "next N dispatched tasks," forecloses cherry-picking by construction | 2 — which past tasks to replay is itself a choice that can be gamed |
| Sets up the A on-ramp (a repeatable instrument, not a one-off) | 2 | 5 | 3 |
| **Total** | **11** | **20** | **11** |

**Decision: B2 — Approach 2 (protocolized re-measurement), anchored by Approach 1 (the corpus
baseline).** B1's baseline is a necessary first half of B2, not a separate option — it is what
grounds the edits in evidence per §1.2/§4 of the brief. B2 is the only approach that satisfies
brief §3.6 (re-measure and show waste dropped without tripping the floor, *or* specify the
protocol precisely enough for the next cycle to execute it deterministically) without requiring
new harness infrastructure this cycle, which the brief (§4, §6) forbids. B3 is rejected: building
a replay sandbox is infrastructure-building that edges toward Option A (the learning loop), which
is explicitly out of scope now.

---

## Decision

### The W1–W5 waste taxonomy

Each category names what the waste is, how it is attributed to an agent-definition seam, and (for
categories with baseline evidence this cycle) the citation. Full operational definitions —
exactly how each is counted, on what data — live in the measurement spec.

| # | Name | What it is | Attribution target |
|---|---|---|---|
| W1 | **State-disclosure gap** | An agent's turn ends without an accurate account of what happened (partial completion misreported as done, or silently dropped), forcing Governor to reconstruct state from the working tree by hand. | Maker's Done Signal shape |
| W2 | **Un-preflighted environment drift** | A round's evidence is computed against stale/wrong environment state (wrong branch, wrong ABI target, contaminated concurrent process) discovered only after the fact, costing a re-run to re-establish trustworthy evidence. | Governor's pre-Verifier dispatch discipline |
| W3 | **Avoidable retry round** | A second round exists to fix something the first round's own gate output already flagged and that a pre-dispatch check would have caught before Verifier ran at all. | Governor's pre-flight / dispatch judgment |
| W4 | **Hand-re-derived fact** | An agent re-derives, by reading code or re-reasoning, something that was already decided and recorded elsewhere in the corpus (a prior ADR, a prior ticket's scope call), because nothing routes that decision to it. | Declined this cycle — see Consequences, evidence-vs-assertion |
| W5 | **Near-miss / tracked-not-counted** | A pattern with a credible failure mode observed once, addressed by opening a tracking ticket rather than by treating it as confirmed waste. | Declined this cycle — watch only |

### The quality floor — a hard veto, not a soft warning

The floor is **structurally identical in force to the precedent ADR's `verifier_pass=false` hard
block** (`docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md`): it does not lower a score, add
a caveat, or get averaged away — it **voids the waste-cut claim outright** if tripped. A
waste-down number computed while any of the four conditions below is unmet is not "waste cut with
caveats"; it is not a waste-cut claim at all, and must be reported as such.

The floor is four conditions, **all** of which must hold for a waste-reduction claim to be valid:

1. **Gate-dispatch parity.** The set of gates dispatched per task class, per `GOVERNANCE_INDEX.md`
   §3–8 routing, is unchanged before vs. after the edits. A task that used to route Red Hat still
   routes Red Hat under the same task class. This condition is checked against an
   **independently re-derived** task class and required gate set — not against the after-set
   record's own self-reported `task_class`/`selected_agents`/`omitted_agents` frontmatter taken at
   face value, because a Governor could game gate-dispatch parity by mis-classifying the task
   class itself rather than by crudely omitting a gate. Any task-class assignment in the after-set
   that reduces the required gate set relative to the re-measurer's independent derivation is
   itself a red flag requiring escalation, not a silent pass.
2. **Verifier-pass parity-or-improvement.** The rate of Verifier PASS (vs. FAIL/UNVERIFIED) across
   the compared task sets does not regress.
3. **Grader dimension floor unchanged.** No scored dimension in the after-set falls below the
   before-set's per-dimension floor (nothing below 3, matching the existing Grader PASS bar).
4. **No self-inconsistent record introduced.** The after-set introduces no run record whose
   frontmatter and prose contradict each other (the exact defect the corpus already has one
   unfixed instance of, per `docs/work/runs/2026-07-30-typed-run-records-and-work-index.md`,
   documenting `2026-07-26-manual-grid-editing-run.md`'s `grader`-in-`selected_agents`-vs-prose
   contradiction — coded W1, a state-disclosure gap, not W4, per the baseline document's recode)
   — a waste-down number produced by a record that cannot be trusted to describe its own round is
   void by construction.

**Ordering:** the floor check runs *before* any waste-rate comparison is computed or reported. If
any condition fails, the comparison is voided — not published with an asterisk. This ordering is
itself the enforcement mechanism, not merely descriptive: a metric that computes the headline
number first and checks the floor after has already given the floor no teeth.

### The three agent-definition edits

**Edit 1 — `.claude/agents/maker.md`, Done Signal section.** Adds an `INTERRUPTED` signal shape,
used only when verification is cut short by external interruption (usage limit, crash, timeout —
not a test failure), so Maker discloses accurate partial state instead of Governor reconstructing
it from the working tree by hand.

Added text (in full):

> **If verification cannot be completed** (external interruption — usage limit, crash, timeout —
> not a test failure): do not signal DONE. Signal the actual state instead, using this shape:
> ```
> INTERRUPTED — verification did not complete: [what stopped it]
> Files changed: [list, as of interruption]
> Verified so far: [which success criteria were actually checked and passed]
> Not yet verified: [which success criteria were not reached]
> ```
> This is not a failure signal — it is accurate state disclosure so Governor does not have to
> reconstruct what happened from the working tree by hand.

**Waste-incident citation (W1):** `docs/work/runs/2026-08-01-t32-schedule-slot-mutations-run.md`,
round 1 — "The Maker process hit an external session usage limit mid-verification... Governor
inspected the working tree directly... Ran the gates the Maker didn't reach." Governor's manual
reconstruction is exactly the cost this edit removes: the fact pattern (interruption, not
failure) already existed in the run record; the agent definition gave Maker no shape for saying
so on its own turn.

**Scoping caveat on this citation.** T32's round 1 was a **hard usage-limit kill** — the record
shows Governor discovering the incomplete state by inspecting the working tree, with no
Maker-authored recovery text anywhere in the round. The citation establishes the *pattern*
(interruption-not-failure exists in this corpus and costs Governor a manual reconstruction); it
does **not** establish that Maker had a live turn in that specific incident to use the new
`INTERRUPTED` signal — a hard kill of the kind T32 exhibits may itself be unreachable by this
fix, because there is no guarantee the process survives long enough to emit any output at all.
This edit's benefit is scoped to interruptions where the Maker process is still able to emit a
turn-ending signal (a soft timeout, a self-detected stall, an approaching-limit warning) — it is
**prophylactic for that subset**, not a fix for T32's exact failure mode. T32 motivates why the
shape is worth having; it is not proof the shape would have fired in T32 itself.

**Edit 2 — `.claude/agents/governor.md`, Phase 6.5 (Verify), new first line.** Adds an
environment-state pre-flight check before Verifier is dispatched.

Added text (in full, as the new first line of Phase 6.5, before "Dispatch Verifier"):

> **Before dispatching Verifier, confirm environment state:** run `git branch --show-current` and
> confirm it matches the task's working branch (not a branch that changed underneath the session
> via a background rebase — see the 2026-07-30 typed-run-records incident); confirm no concurrent
> `vitest`/build process is running on the machine (a contaminated full-suite run costs more to
> explain away than to avoid — see T69's round-2 contamination). This is a Governor pre-flight
> check, not a Verifier instruction — it does not change Verifier's own behavior or gate-stack
> scope.

**Waste-incident citations (W2 × 2 + W3):**
- Wrong branch: `docs/work/runs/2026-07-30-typed-run-records-and-work-index.md` — "HEAD was
  switched back to `feat/delete-used-records`... Work proceeded there unnoticed... every
  `check:governance` result before the switch back was computed against the wrong tree." That
  record's own closing line — "`git branch --show-current` belongs at the top of a run, not at
  the end" — is transcribed directly into the edit.
- ABI/native-module mismatch, same record: `npm run test` first failed 395 tests, traced to the
  documented `better-sqlite3` Node/Electron ABI mismatch, requiring a rebuild cycle before
  trustworthy evidence existed. (This second W2 instance is captured by the "confirm environment
  state" framing generally; the ABI-rebuild step is already documented procedure in `CLAUDE.md`
  and is not independently re-added here to avoid duplicating an existing instruction.)
- Concurrent-process contamination: `docs/work/runs/2026-08-08-t69-engine-id-list-purity.md` —
  "Round 2's suite runs showed failures... contaminated by a concurrent vitest in another worktree
  at load average >400... took 414s against 1299s for a contaminated one." Grader's own words are
  quoted in that record: "a round that has to explain away its own red suite is a round where the
  evidence gate is doing less work than it appears to" — precisely the W3 avoidable-retry cost
  this edit is aimed at.

**This edit touches zero gate-stack files.** It changes Governor's own pre-dispatch discipline
only; Verifier's definition (`.claude/agents/verifier.md`) is unedited, and the note in the added
text says so explicitly to prevent the edit's intent from drifting toward gate-stack scope in a
future revision.

**Edit 3 — `.claude/agents/governor.md`, Phase 5 (Maker, round N), new block after "Wait for
Maker to signal 'done'."** Adds an instruction that an `INTERRUPTED` disclosure from Maker (Edit
1) is used only to route the retry — Governor independently re-runs the cited checks before
treating any of Maker's "Verified so far" claims as established, rather than accepting the
self-report at face value.

Added text (in full):

> **If Maker signals `INTERRUPTED` instead of `DONE`:** use the signal only to route the retry —
> its "Verified so far" claims are not accepted at face value. Independently re-run the cited
> checks yourself before treating any success criterion as established, exactly as you would
> manually reconstruct state from the working tree if no signal had been given at all (see T32's
> round 1). An unverified self-report is not evidence a criterion is met, regardless of which
> agent produced it.

**Why this edit exists.** Edit 1 gives Maker a shape for disclosing interruption instead of
silence. Left there, that shape is itself an unaudited self-report: nothing instructed Governor to
confirm an `INTERRUPTED` disclosure is genuine, or to re-verify Maker's "Verified so far" claims
before trusting them — an escape hatch by which a future Maker could under-verify and cry
"interrupted" rather than actually finishing the check. Edit 3 closes that gap by requiring
Governor to do exactly what it did manually in T32 (re-run the gates Maker didn't reach) as a
standing instruction, not a one-off improvisation. This directly answers the brief's §5 auditor
checklist line — "could the Maker `INTERRUPTED` signal give Maker an escape hatch to under-verify
and cry 'interrupted'?" — which Edit 1 and Edit 2 alone left unaddressed.

**Waste-incident citation (same W1 incident as Edit 1, plus the §5 escape-hatch concern):**
`docs/work/runs/2026-08-01-t32-schedule-slot-mutations-run.md`, round 1 — Governor's manual
re-verification of the gates Maker didn't reach is the exact behavior this edit turns into a
standing rule rather than leaving to be reinvented each time an interruption occurs.

**This edit touches zero gate-stack files.** It changes only Governor's own handling of Maker's
turn-ending signal; no gate-stack agent definition is edited.

---

## Consequences

Answering every line of the brief's §5 auditor checklist:

**Proxy-gaming — can the metric be satisfied by doing less?** No. The floor's condition 1
(gate-dispatch parity) makes under-dispatching a hard-veto trigger, not a side effect to notice
later. A Governor that "cuts waste" by skipping Red Hat on a task class that requires it fails
condition 1 before any waste number is even computed.

**Quality-floor teeth — measurable and enforced, or decorative?** Enforced by ordering: the spec
requires the floor check to run *before* the waste-rate comparison, and a failed floor voids the
comparison outright rather than annotating it. What is checked and on what data is stated
explicitly per condition in this ADR and operationalized in the measurement spec. What happens on
collision (waste-down + quality-down) is unambiguous: the claim is void, full stop — not "waste
cut with a caveat."

**Evidence vs. assertion.** W1, W2, W3 each cite a specific run record and quote it. W4 has **no
clean instance in the examined corpus** — the one candidate originally coded W4
(manual-grid-editing's frontmatter/prose contradiction over `grader`'s `selected_agents`
inclusion vs. its prose routing table marking Grader skipped) is better read as a
record-consistency, W1-adjacent gap and is recoded as W1 in the baseline document; it does not
support a W4 edit either way. W5 is supported by exactly **one** observed instance in the n=10
corpus (T69's DEV-only-shape-assertion near-miss, carried to T78 rather than fixed inline). One
instance is evidence that the pattern exists, not evidence of a rate or trend worth an
agent-definition edit — the bar this track holds edits to (brief §4: "this prompt could be
tighter" is not evidence, and by the same logic neither is a single instance dressed up as a
pattern). Both W4 and W5 are named and left un-edited rather than forced into an edit the evidence
doesn't support — W4 now on firmer ground than before (zero instances, not one thin one), and this
does not change the decision to decline a W4 edit. This is a deliberate under-reach, not an
oversight.

**Corpus honesty.** n=10, not 11 (corrected above) — `TEMPLATE.md` is a form, not a record, same
exclusion rule `check-governance.js` already applies. ~2 weeks, single author, self-authored by
the same agent stack being evaluated: every claim in this ADR inherits that bias. **No escalated
or abandoned run record exists anywhere in the corpus** — every examined record's `status` is
`pass` or `in-progress` heading toward pass. That is a survivorship gap, not a clean result: a
corpus with zero visible failure cannot support any claim about how this workflow behaves when a
task actually goes badly wrong, and this ADR makes no such claim. The baseline-evidence document
carries this forward explicitly rather than silently narrowing scope to "the records that exist."

**Attribution soundness.** Each of W1/W2/W3's citations names the specific text in the run record
that shows the *agent-definition* was the cause (Maker had no interruption-disclosure shape;
Governor's phase list had no pre-flight step) rather than task variance or the human's call. The
T32 round-2 correction in Context above is itself an attribution-soundness check that was applied
and changed the read: the original framing risked attributing waste to the gate stack's dispatch
count, which this ADR is not allowed to touch; the corrected reading attributes it to Maker's
missing signal shape, which it is. **This attribution is scoped, not absolute:** T32 establishes
that the interruption-not-failure pattern exists and costs Governor a manual reconstruction; it
does not establish that Maker had a live turn to use the new signal in that specific incident
(T32's kill was external and hard, with no Maker-authored recovery text in the record). Edit 1 is
therefore attributed to the pattern T32 evidences, not to a claim that it would have changed
T32's own outcome — see the scoping caveat under Edit 1 above.

**Reversibility & blast radius.** All three edits are additive single blocks with a clear boundary
(a new Done Signal subsection; one new sentence at the top of Phase 6.5; one new block after Phase
5's "wait for done" line), each independently deletable without touching surrounding text. **Zero
gate-stack agent-definition files are touched** — `verifier.md`, `security.md`, `red-hat.md`,
`tester.md`, `code-reviewer.md`, `grader.md` are all unedited by this ADR, satisfying the owner's
explicit deprioritization. None of the three edits changes what Verifier checks, what Grader
scores, or what any gate dispatches on — they change only what Maker discloses, when Governor
looks at its own environment, and how Governor treats Maker's own self-report.

**A-onramp overreach.** This ADR does not build, and does not simulate building, a closed learning
loop. It leaves a measurement instrument (the taxonomy + protocol) in place, per brief §3.7, and
the measurement spec states explicitly what would still have to be true (corpus size well past
n=10, an acceptance gate, `self-improvement-loops`-style guardrails on any self-modifying surface)
before Option A becomes safe to build. Nothing here assumes that bar is already met.

**Scope creep into the gates.** The gate stack is not "improved" anywhere in this ADR. The
measurement spec and baseline evidence *measure* gate-related signals (Verifier pass rate, Grader
dimension floor) because the quality floor requires it — but measuring an existing signal to gate
a claim about the doer/orchestrator side is not the same as editing gate-stack behavior, and no
gate-stack file's content changes.

---

## Confidence

**Medium-high**, qualitatively — this is a hand-tuned, evidence-first design over a small corpus,
not a validated model.

- Edits 1 and 2 (W1, W2/W3) each rest on **≥2 verified corpus instances** (T32 round 1 for W1; the
  2026-07-30 branch-drift + ABI incidents and T69's contamination incident for W2/W3, combining to
  more than two citations across the edit). This is the strongest-evidence part of the
  deliverable. Edit 3 rests on the same T32 incident as Edit 1 plus the brief's own §5
  escape-hatch concern — it is a closing of a gap Edit 1 itself opens, not an independently
  evidenced pattern, and its confidence should be read accordingly: lower than Edits 1/2's
  corpus-backed confidence, justified instead by direct traceability to an explicit,
  previously-unanswered checklist item.
- Edit 1's citation is itself scoped: T32 establishes the interruption-not-failure pattern, not
  that Maker had a live turn to use the new signal in that exact incident (see the scoping caveat
  under Edit 1 and in Consequences above). The edit is prophylactic for interruptions where the
  Maker process can still emit output, not a fix validated against T32's own hard-kill mode.
- The metric/floor **design** itself is higher confidence than the specific taxonomy contents: it
  is a direct structural application of the precedent ADR's hard-veto pattern
  (`verifier_pass=false` blocks a PASS regardless of Grader score; here, any of the four floor
  conditions blocks a waste-cut claim regardless of the headline number). That pattern is already
  accepted and load-bearing elsewhere in this repository's governance.
- The **weakest link is corpus size**: n=10, ~2 weeks, one author, and — as stated above — zero
  escalated or abandoned records to check the workflow's failure-mode behavior against. W4 and W5
  are declined as edit targets specifically because the corpus cannot support them past a single
  instance each; that restraint is itself part of the confidence claim, not a gap in it.

---

## Completion evidence

When `implementation_state` moves to `implemented`, the following are the falsifiable checks that
confirm it:

1. `.claude/agents/maker.md` contains the `INTERRUPTED —` signal-shape block, in the Done Signal
   section, before the `DONE —` template.
2. `.claude/agents/governor.md` Phase 6.5 begins with the "Before dispatching Verifier, confirm
   environment state" line, before "Dispatch Verifier".
3. `.claude/agents/governor.md` Phase 5 contains the "If Maker signals `INTERRUPTED`" block,
   after "Wait for Maker to signal 'done'."
4. `git diff` against this ADR's baseline commit touches no file under `src/`, `electron/`, or
   any gate-stack agent definition (`.claude/agents/{verifier,security,red-hat,tester,
   code-reviewer,grader}.md`).
5. `npm run check:governance` passes with no findings attributable to this ADR, its spec, its
   baseline-evidence doc, or T80.
6. `npm run index:work` has been run and `docs/work/INDEX.md` reflects this ADR, the measurement
   spec, and T80. The baseline-evidence doc (`docs/work/2026-08-09-agent-quality-waste-baseline.md`)
   is **intentionally absent** from that index — it carries `document_type: exploration`, which
   `build-work-index.js` does not index, the same precedent as
   `docs/work/2026-08-09-graph-engineering-exploration.md` from step 2. Its absence from
   `docs/work/INDEX.md` is not an omission and should not be misread as one by a future auditor.
