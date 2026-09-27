---
title: "A main-side gate that flags a merged ticket whose status never flipped"
document_type: ticket
status: open
created: 2026-09-27
task_class: test-infrastructure
governing_docs: [docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
archive_when: "a going-forward gate flags a merge to main whose T<n>: commit names a ticket that is not `completed`/`closed`/`wont-fix`, proven non-vacuously against the REAL commit log (not a synthetic subject), with the pre-existing backlog it surfaces on first run either cleared or explicitly accepted — or the owner records that discipline alone (WORK_RECORD_STANDARD §3.3) is sufficient and no gate is wanted"
---

# T283 — Board-truth is ungated; a main-side audit gate would close that

## Problem (measured, not asserted)

`docs/governance/standards/WORK_RECORD_STANDARD.md` §3.3 records the finding: `checkStatusDrift`
(`scripts/check-governance.js`) is a **keyword-consistency check**, not a board-truth guarantee. It
fires only when a branch commit writes `closes T##` / `Merge S##`, and it runs pre-merge over
`git log origin/main..HEAD`. This repository's merges are overwhelmingly `T<n>: title (#pr)` — no
keyword — so **of the last 40 merges to `main`, 2 would fire it** (measured 2026-09-26,
`git log origin/main --format='%s' | grep -icE '(closes|merge)[[:space:]]+[TS][0-9]+'`). The result:
~10 shipped tickets were reconciled by hand in #573, and that was the first sweep of a surface that
had been drifting for ~40 merges.

Nothing structurally keeps `docs/work/INDEX.md` truthful. §3.3 makes that a discipline; this ticket
asks whether it should also be a gate.

## Scope (a NEW gate — do NOT widen checkStatusDrift)

- A **going-forward, main-side** check: for each commit reachable on `main` since some watermark
  whose subject is `T<n>:`/`S<n>:` (topic-prefix form, the actual merge convention), assert the
  referenced ticket's `status` is terminal (`completed`/`closed`/`wont-fix` for tickets; the §3.2
  closed-state predicate for ADRs/specs).
- Do **NOT** widen `checkStatusDrift`'s regex to treat `T<n>:` as a closure. §3.2 line 142 warns
  against it, and it would over-fire on work-in-progress branch commits that carry the same prefix.
  The distinguishing signal here is *reached main via a merge*, not *named in a branch commit* —
  which is why this is a separate, main-side gate, not a change to the pre-merge one.

## Hard constraints (learned at cost — cite them to the Maker)

- **Prove the matcher non-vacuously against the REAL log** (`git log origin/main --format='%s'`),
  never a synthetic subject the author imagines — that imagined-format assumption is how the
  original narrowness went unnoticed. Same failure class as a fixture built from the shape a
  document *describes* rather than what the code emits.
- **First run surfaces the ~38-merge backlog. That is the gate working, not broken** — state it in
  the gate's own output so the first red is not misread and the gate disabled in its first week.
- Handle the environment-skip honestly the way `checkStatusDrift` does (no `origin/main` to diff →
  skip with a stderr line, never a silent pass — see §3.2 "Scope").
- Whatever failure message it prints, walk the prescribed remedy forward: a gate that fires
  correctly but prescribes the wrong fix arrives with the gate's authority behind it.

## Non-goals

- Not a re-audit of all history — going-forward from a watermark, like `checkStatusDrift`.
- Not a change to the pre-merge `checkStatusDrift` regex or its deliberate narrowness.
- Not a substitute for the §3.3 discipline (flip as part of the work); a belt for it.

## Owner decision embedded

Whether to build this at all is the owner's call: §3.3 discipline + periodic reconciliation sweeps
may be judged sufficient. This ticket exists so the choice is tracked rather than implicit; it is
authorized to be *designed and built* only on the owner's yes.
