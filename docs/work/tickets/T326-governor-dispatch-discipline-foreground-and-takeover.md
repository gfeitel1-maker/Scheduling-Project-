---
ticket: T326
document_type: ticket
title: Governor binding — foreground Maker/Verifier/Grader dispatch + 20-minute quiet-loop takeover, as a hard rule with the reason
status: completed
created: 2026-10-01
archive_when: "a loop that goes quiet with no process and no commit for 20 minutes is taken over by the session rather than waited on, and no Governor loop parks for an hour on a backgrounded Maker/Grader again"
task_class: documentation-governance
parent: ""
related_prs: []
---

# T326 — Governor dispatch discipline: foreground gate-dispatches + quiet-loop takeover

## Context

On 2026-10-01 three dispatched loops (the primary's T321/T322 and the second worker's T323) each
parked for roughly an hour on a **backgrounded Maker or Grader dispatch** before a human-driven
takeover unstuck them. `docs/governance/agent-bindings/governor.md` already carries a strong
"Dispatch discipline (non-negotiable)" paragraph requiring foreground/synchronous dispatches, but it
did not (a) call out the three round-gating dispatches (Maker, Verifier, Grader) by name as the ones
whose backgrounding causes the park, nor (b) state the remedy when a loop goes quiet anyway.

## Success predicate (observable)

1. `docs/governance/agent-bindings/governor.md` states, as a hard rule with the reason, that
   **Maker, Verifier and Grader dispatches are foreground/synchronous, no exception**, and that a
   loop which goes quiet — **no running process and no new commit on its worktree for 20 minutes** —
   is **taken over by the session**, not waited on.
2. `.claude/agents/governor.md` is regenerated from the binding and `npm run agents:check` is
   byte-identical.
3. `npm run check:governance` is clean (no blocking) and CI is green.

## What does NOT count as done

- Editing `.claude/agents/governor.md` by hand instead of regenerating it from the binding.
- Adding the takeover rule without the reason (the reason is what stops it being re-litigated).
- Touching any other agent binding.

## Remaining

Done — see the run record.
