---
title: "Wasted-agent-work measurement — specification"
document_type: spec
status: draft
created: 2026-08-09
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T80-agent-quality-wasted-work-metric.md]
related_adrs: [docs/adr/2026-08-09-agent-quality-waste-metric-and-quality-floor.md]
archive_when: superseded by an executed re-measurement cycle that validates or revises this protocol
---

# Wasted-agent-work measurement — specification

This document operationalizes the W1–W5 taxonomy and the quality floor decided in
`docs/adr/2026-08-09-agent-quality-waste-metric-and-quality-floor.md`, and specifies the
re-measurement protocol the ADR commits to. It is the instrument; the ADR is the decision to build
it this way; the baseline-evidence document (`docs/work/2026-08-09-agent-quality-waste-baseline.md`)
is its first run.

`status: draft` — this has not yet been exercised by an executed re-measurement cycle. Per the
governance checker's `spec` status enum (`draft`, `active`, `approved`, `implemented`,
`superseded`), `draft` is the nearest valid value for a not-yet-approved protocol; it moves to
`approved` only after a human gate, per `CONSTITUTION.md` Article IV, and to `implemented` only
after a re-measurement cycle has actually run against it.

---

## 1. The W1–W5 taxonomy, operationalized

Each category below states: the definition, how an instance is attributed to a specific record,
and how instances are counted (as a rate, never a raw headline number in isolation).

### W1 — State-disclosure gap

**Definition:** An agent's turn ends without an accurate account of what happened — a partial
completion is misreported as full completion, or dropped from the record entirely — forcing
Governor (or a human) to reconstruct actual state from the working tree rather than from the
agent's own signal.

**How it is coded:** Read the run record's round narrative. A W1 instance exists when the record
states or implies that Governor (or the human) had to inspect the working tree, diff output, or
file timestamps to determine what an agent actually did, where the agent's own turn-ending signal
did not already say so.

**Attribution:** Maker's Done Signal shape (pre-edit: only a `DONE —` template existed, with no
shape for "I was interrupted before I could verify").

**Counting:** Count of W1 instances per N run records examined, reported as `W1 count / N
records`, never a bare integer without the denominator.

### W2 — Un-preflighted environment drift

**Definition:** A round's evidence (test/lint/build/governance output) was computed against a
stale or wrong environment state — wrong git branch, a native-module ABI target mismatch, or a
machine carrying a concurrent contaminating process — discovered only after the fact, requiring a
re-run to produce trustworthy evidence.

**How it is coded:** A W2 instance exists when the record explicitly names an environment-state
problem (branch mismatch, ABI mismatch, concurrent load) as the reason a gate result had to be
disregarded or re-run.

**Attribution:** Governor's Phase 6.5 pre-Verifier dispatch step (pre-edit: no environment-state
check existed before "Dispatch Verifier").

**Counting:** `W2 count / N records`. Multiple distinct environment-drift causes within the same
record are counted separately (e.g. a record with both a branch-drift incident and an ABI
mismatch counts as W2 × 2 for that record), because each is an independent seam worth counting for
corpus completeness and collapsing them would understate the pattern. This is a counting-breadth
rule, not a claim that this edit closes every counted cause: not every separately-counted W2
instance is necessarily addressed by this cycle's edit. The ABI-mismatch sub-instance, in
particular, is closed by pre-existing `CLAUDE.md` procedure (the documented Node/Electron
`better-sqlite3` rebuild step), not by Governor's new Phase 6.5 pre-flight line — it is counted
here for corpus completeness, not as evidence that this edit is what addresses it.

### W3 — Avoidable retry round

**Definition:** A second round exists to address something a pre-dispatch check (branch state,
concurrent process) would have caught before Verifier ran at all, distinct from a retry caused by
a genuine finding in the work itself (a real bug, a real design gap — that is normal review
working as intended, not waste).

**How it is coded:** A W3 instance exists when a round's own text attributes the need for the
round to environmental contamination rather than to a substantive finding about the work — most
directly, a record that has to "explain away" a red suite result as caused by machine state, not
by the diff under review.

**Attribution:** Governor's Phase 6.5 pre-Verifier dispatch step (same seam as W2 — both point at
the same missing pre-flight check; W2 codes the drift itself, W3 codes the retry round it caused).

**Counting:** `W3 count / N records`.

### W4 — Hand-re-derived fact

**Definition:** An agent re-derives, by reading code or re-reasoning from scratch, a fact that was
already decided and recorded elsewhere in the corpus (a prior ADR's decision, a prior ticket's
scope boundary), because no mechanism routes that decision to the agent doing the new work.

**How it is coded:** A W4 instance exists when a record shows an agent working out something a
prior, still-valid document already settled, with no citation back to that document.

**Attribution:** Declined this cycle for an edit — see the ADR's Consequences, evidence-vs-assertion.
No clean instance is observed in the examined slice of the n=10 corpus (see baseline doc) — the
one original candidate is better read as a W1 record-consistency gap, not a W4 hand-re-derivation.

**Counting:** `W4 count / N records`, reported and left un-actioned pending more evidence.

### W5 — Near-miss / tracked-not-counted

**Definition:** A credible failure mode is identified during a round but addressed by opening a
tracking ticket rather than by confirming it as an actual, occurred instance of waste. It is
recorded as a **signal to watch**, not counted toward any waste total, because it did not actually
happen — treating a near-miss as an occurrence would inflate the metric with hypotheticals, which
is its own form of evidence-vs-assertion failure.

**How it is coded:** A W5 instance exists when a record explicitly defers a risk to a new ticket
rather than treating it as a defect in the round just completed.

**Attribution:** Declined for an edit this cycle — watch only, same evidence bar as W4.

**Counting:** Reported separately from W1–W4, labeled `tracked, not counted`, and never summed
into the headline waste rate.

---

## 2. The quality floor, operationalized

Four conditions, all required. **The floor check runs first, before any waste-rate number is
computed or published.** If any condition fails, the entire comparison is void — reported as
"floor tripped, comparison void," not published with a caveat.

| # | Condition | What is checked | On what data |
|---|---|---|---|
| 1 | Gate-dispatch parity | For each task class present in both the before-set and after-set, the set of agents required is unchanged, per the routing table in `GOVERNANCE_INDEX.md` §3–8. The re-measurer **independently re-derives** the correct task class and its required gate set from `GOVERNANCE_INDEX.md` §3–8 for each after-set record — this condition is not satisfied by diffing the record's self-reported `task_class`/`selected_agents`/`omitted_agents` against itself, because a task could be mis-classified into a lighter class rather than crudely gate-omitted. Any after-set task-class assignment that reduces the required gate set relative to the re-measurer's independent derivation is flagged as its own red flag requiring escalation, not a silent pass. | `selected_agents` / `omitted_agents` frontmatter of each run record in both sets, cross-checked against the re-measurer's own independent classification — not read from the frontmatter alone. |
| 2 | Verifier-pass parity-or-improvement | `count(verdict starts with PASS) / count(all Verifier dispatches)` in the after-set is `>=` the same ratio in the before-set. | Verifier verdict as recorded in each run record's Gates table or `verdict` field. |
| 3 | Grader dimension floor unchanged | `min(all scored dimensions across the after-set)` is `>=` `min(all scored dimensions across the before-set)`. N/A-scored dimensions (correctly omitted agents) are excluded from both mins, not treated as 0 or 5. | Grader score sections of each run record. |
| 4 | No new self-inconsistent record | Zero records in the after-set have frontmatter and prose that disagree about what happened (the same defect already unfixed once in the corpus — `docs/work/runs/2026-07-30-typed-run-records-and-work-index.md`'s note on `2026-07-26-manual-grid-editing-run.md`, coded W1 in the baseline document, not W4). | Manual read of each after-set record's frontmatter against its own prose. |

**Collision rule.** If waste-rate goes down (a real improvement by W1–W3 counts) while any floor
condition fails, the result is reported as: *"Waste rate improved from X to Y, but condition N of
the quality floor failed [specifics] — this result is void and must not be read as a validated
waste-cut."* The improvement number itself is still disclosed (per the corpus-honesty discipline —
suppressing the number would be its own dishonesty), but it carries no claim.

---

## 3. Re-measurement protocol

**Task set.** The **next 5 tasks dispatched through the Governor loop after the three edits land**,
in dispatch order, with no exclusions and no substitutions. This is stated explicitly to foreclose
the obvious gaming vector: a re-measurer choosing which 5 tasks to examine after seeing how they
turned out. If fewer than 5 tasks have been dispatched by the time re-measurement is requested,
re-measurement has not yet occurred — report "not yet measurable," not a partial number dressed up
as a result.

**Coding taxonomy.** Identical W1–W5 definitions and counting rules as §1 above, applied by the
re-measurer to the after-set exactly as they were applied to the before-set in the baseline
document. No definition may be loosened or tightened between the two measurements — if a
definition turns out to need revision, that is itself a finding to record, and the comparison
waits for a third, consistently-coded measurement rather than comparing across two different
rulers.

**Comparison basis.** Compare **rate**, not raw count — `Wn count / N records` in the after-set
against the same ratio in the before-set (baseline document, n=10... examined records — see that
document for which are UNEXAMINED). A raw-count comparison across different N is not a valid
comparison and must not be reported as one.

**Ordering.** The §2 quality-floor check runs first. Only if all four conditions hold does the
rate comparison get reported as a validated result.

**Non-gaming rule — independent re-measurer.** The person or session that applied the
agent-definition edits must **not** be the one who re-measures. The re-measurer reads this
taxonomy fresh (from this document, not from memory of how the before-set was coded) and is not
the same session that made the edits. This mirrors the corpus's own existing practice of
independent review (Red Hat, Code Reviewer) rather than self-grading, and exists specifically
because a self-graded "waste went down" claim from the same session that engineered the edit is
exactly the kind of unverifiable assertion this whole track was built to stop producing.

**Known residual gaming vector — measurement timing.** The rules above cover WHO codes (an
independent re-measurer) and WHICH tasks (the next 5 dispatched, no cherry-picking). They do not
cover WHEN the re-measurement window opens relative to task difficulty — a re-measurer (or whoever
requests re-measurement) could choose a favorable moment to start counting the "next 5" if task
difficulty is predictable in advance. This is a known residual, left un-closed in this cycle
rather than silently ignored; a future revision should tighten it, e.g. by pre-committing the
window's start boundary (a fixed date/dispatch-count trigger) before the composition of the next 5
tasks is known, so the choice of when to start counting cannot be made with foreknowledge of what
is about to be dispatched.

---

## 4. What this spec does not do

It does not implement a closed learning loop. It does not automate the coding step (still a human
or agent reading records against a taxonomy, by design — automating judgment calls this early
would itself be building toward Option A, which is out of scope per the brief). It does not touch
any gate-stack agent definition; §2's checks read gate-stack *output* (Verifier verdicts, Grader
scores) but change no gate-stack *behavior*.
