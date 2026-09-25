---
title: "Ticket numbers are allocated from a tree that cannot see unmerged branches"
document_type: ticket
status: open
created: 2026-09-18
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T216-gate-semantics-write-up.md]
archive_when: "a ticket number is allocated against a source both concurrent sessions can observe before either merges, and the residual race is documented rather than claimed closed"
---

# T225 — Ticket numbers are allocated from a tree that cannot see unmerged branches

## The defect

`check:governance`'s duplicate-ticket-number scan reads the **working tree**. A session filing a
ticket derives the next free number from the tree it has. Neither of those can observe a ticket
that exists only on another session's unmerged branch. So two sessions can both derive the same
next-free number, both pass `check:governance` **correctly on the evidence each has**, and collide
only when the second one merges.

This is not a diligence failure and cannot be fixed by applying more care inside the check. It is
the same shape as the grep-sweep lesson already recorded in this repo's guidance: **a check's blind
spot tracks the method used to build its input list, not the care applied within it.**

## Evidence — two data points, one of each outcome

Both occurred on 2026-09-18, on the same machine, between two concurrent sessions:

- **T222 collided.** `docs/work/tickets/T222-update-on-open.md` merged in #483 while
  `docs/work/tickets/T222-cli-ingest-shape-gate.md` sat on an unmerged branch. Both sessions had
  re-derived the number from a freshly fetched `origin/main` at filing time. Both were right. The
  second session renumbered to T224 after the fact.
- **T220 survived — on luck, not method.** Filed in the same window by the same process, it simply
  happened not to be claimed elsewhere. The method that produced the collision also produced this
  pass; the difference was chance.

Two earlier collisions are recorded in
`docs/work/handoffs/2026-09-18-post-ship-cleanup-audit-handoff.md` §6: a duplicate T202 turned
`main` red for roughly an hour and aborted an unrelated session's gate run, and a block of
T192–T198 collided wholesale.

## Why "rebase immediately before merge" is a weaker answer than it sounds

That discipline is currently the recorded mitigation, and it is worth keeping — it is the first
moment a tree contains both sets of tickets, so it catches most of these. But it **shrinks the
window; it does not close it.** Two sessions can both rebase onto the same `origin/main`, both run
`check:governance` green, and both merge. Nothing in the sequence makes one of them observe the
other.

## Proposed direction (not a fix — read the caveat)

Allocate the number against something **both sessions can observe before either merges**, rather
than against a local tree. The cheapest version is `git ls-remote --heads origin` at filing time,
reading ticket numbers from remote branch state rather than from `origin/main` alone. That has the
property that matters: arbitration on shared, pushed state.

**It narrows the race from minutes to milliseconds. It does not eliminate it.** Two sessions can
query `ls-remote` within the same second and still both see the number free. Any implementation of
this must say so in its own documentation rather than presenting itself as a fix — an honest
"shrinks a race" ages well; a claimed fix gets trusted and then quietly fails. If the residual race
ever actually bites, that is the moment to consider a real reservation scheme (push a marker branch
at filing time, so the claim is atomic against the remote).

A second, cheaper mitigation worth considering independently: make the number **not load-bearing**.
Much of the pain is that the number appears in filenames, cross-references, and commit messages, so
renumbering is a multi-file sweep with its own hazard — a blind `sed T222 -> T224` would rewrite
another session's citations. That hazard was avoided by hand on 2026-09-18 and will not always be.

## Does NOT count as done

- Any change that claims to close the race rather than narrow it.
- A mitigation that replaces one unobservable source (the working tree) with another.
- Automated renumbering that rewrites references outside the renumbering session's own documents.

## Status note (2026-09-25 — PR #539, kept open)

The mechanism is built and its two `archive_when` clauses are satisfied in code: numbers are now
allocated against a source both concurrent sessions can observe before either merges (root + **every
sibling worktree's tickets, uncommitted files included** + `git ls-remote` + open PRs, via
`scripts/nextTicketNumber.js`), and the residual race is **documented, not claimed closed** — the
interval between allocating a number and writing the ticket file to disk (unbounded; seconds-to-minutes),
with `checkTicketNumberUniqueness` retained unchanged as the post-hoc backstop.

Status is left **open** deliberately: the arbitration approach is captured in
`docs/adr/2026-09-25-ticket-number-arbitration.md` at status **`proposed`**, and per the Constitution
the product owner accepts ADRs. This ticket closes when that ADR is accepted. A cheaper follow-up
(a pushed claim-ref marker to shrink the residual window further) is recorded for the owner to weigh,
not self-dispatched.
