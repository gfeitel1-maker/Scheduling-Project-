---
title: T80-agent-quality-wasted-work-metric
document_type: ticket
status: completed
created: 2026-08-09
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_adrs: [docs/adr/2026-08-09-agent-quality-waste-metric-and-quality-floor.md]
related_specs: [docs/work/specs/2026-08-09-wasted-agent-work-measurement-spec.md]
archive_when: "the three agent-definition edits (maker.md Done Signal, governor.md Phase 6.5, governor.md Phase 5) have landed with owner sign-off (done 2026-08-09), the four owner questions below are resolved (done 2026-08-09), and the deferred re-measurement follow-up has run in a later cycle"
---

# T80 — Agent-quality track (Project B): wasted-agent-work metric + quality floor

**Risk:** Low-medium. No product code touched (`src/`, `electron/` off-limits per brief §2). Two
`.claude/agents/*.md` prose edits, each additive and independently reversible. The risk is in the
metric's own gaming-resistance and attribution soundness, not in runtime behavior.
**Task class:** documentation-governance.

---

## Summary

Per `docs/work/handoffs/2026-08-09-agent-quality-cut-wasted-work-brief.md` (Step 3 of the agent-
quality arc, following Step 2's gate-stack graph-engineering work, T79): defines "wasted agent
work" for this workflow (W1–W5 taxonomy), carries an inseparable, hard-veto quality floor so the
metric cannot be gamed by doing less review, measures the real baseline from the `docs/work/runs/`
corpus (n=10, not the previously-assumed ~11), attributes waste to specific `.claude/agents/*.md`
seams, and applies two evidence-backed, reversible edits — to `maker.md`'s Done Signal and
`governor.md`'s Phase 6.5 — while leaving the gate stack (Verifier, Security, Red Hat, Tester,
Code Reviewer, Grader) untouched, per the owner's explicit deprioritization.

**Deliverables:**
- ADR: `docs/adr/2026-08-09-agent-quality-waste-metric-and-quality-floor.md` — the taxonomy, the
  floor, the three edits with their citations.
- Spec: `docs/work/specs/2026-08-09-wasted-agent-work-measurement-spec.md` — the operational
  taxonomy, the floor's exact checks, and the re-measurement protocol.
- Baseline evidence: `docs/work/2026-08-09-agent-quality-waste-baseline.md` — the corpus
  verification, per-record coding, totals over the examined slice, and corpus-honesty caveats.
- Edits: `.claude/agents/maker.md` (Done Signal — new `INTERRUPTED —` shape), `.claude/agents/
  governor.md` (Phase 6.5 — new environment-state pre-flight line).

---

## Owner decisions (resolved 2026-08-09)

All four STOP points were put to the owner and answered. None was a technical call — each is
judgment the brief (§0) and `CONSTITUTION.md` reserve to the human.

1. **Apply the three edits now, or hold for owner read first? → RESOLVED: apply now.** The owner
   approved committing all three agent-definition edits (`maker.md` Done Signal `INTERRUPTED`
   shape; `governor.md` Phase 6.5 environment pre-flight; `governor.md` Phase 5 re-verify on
   `INTERRUPTED`) to the branch, with the branch still reviewable before it merges to main. (Note:
   an earlier draft of this ticket said "two edits" — Edit 3, `governor.md` Phase 5, was added
   during Red Hat finding-3 resolution; all three are now applied.)
2. **Is the 1-instance evidence bar right? → RESOLVED: keep the conservative bar.** The owner kept
   the "≥2 verified corpus instances per edited seam" threshold. No edit is made on a single
   observed instance; the W5 Tester near-miss (T69/T78) stays *tracked, not acted on*. Matches the
   evidence-first discipline and avoids the aesthetic-preference trap the brief §5 warns against.
3. **The missing escalated/abandoned records → RESOLVED as underdetermined; owner unsure whether
   they never happen or just aren't recorded.** Accepted as a known corpus limitation for now, per
   the baseline doc's honest framing — no waste conclusion speaks to genuine-failure behavior.
   **Recommended follow-up (not done here):** close the blind spot cheaply by having any future
   escalation/abandonment produce a run record, so the corpus stops being all-`pass` (survivorship
   bias). This touches `WORK_RECORD_STANDARD.md`, so it is left as a named follow-up rather than
   done in this doc-only ticket — see Follow-ups below.
4. **Quality-floor tolerance on Grader-dimension drift → RESOLVED: keep zero-tolerance for now.**
   The floor's condition 3 (`min(after) >= min(before)`) stays strict, no noise slack. Rationale:
   the floor's entire purpose is anti-gaming, and a tolerance band on a tiny task sample (n≈10)
   would be the first place a proxy-gaming win could hide. Revisit a tolerance band only once the
   sample is large enough to estimate measurement noise — recorded as a future-cycle question, not
   an open one now.

## Follow-ups (tracked, not part of this ticket's done-state)

- **Re-measurement** (brief predicate #6): the before/after protocol is *specified*, not run — no
  new real tasks existed this cycle. Run it on the next 5 dispatched tasks per spec §(re-measurement),
  floor-check first. Until then the three edits are adopted on their per-incident evidence, not on a
  demonstrated aggregate waste drop.
- **Escalation/abandonment recording** (owner decision 3): consider a `WORK_RECORD_STANDARD.md`
  change so genuine-failure outcomes become run records — the corpus blind spot the metric most
  wants closed, and a direct input to the future Option-A learning loop.

---

## Non-goals (does NOT count as done, per brief §4)

- Any change to `src/` or `electron/`.
- Any change to a gate-stack agent definition (`verifier.md`, `security.md`, `red-hat.md`,
  `tester.md`, `code-reviewer.md`, `grader.md`).
- Building, or starting to build, a closed self-modifying learning loop.
- A metric without the floor, or a floor stated but not actually enforceable/checkable.
- Committing the three agent-definition edits without owner sign-off (resolved: owner approved 2026-08-09).

---

## Evidence

See the ADR's Completion evidence section for the falsifiable checks that confirm implementation.
`npm run check:governance` and `npm run index:work` results are reported in the handoff/session
record for this task, not duplicated here.
