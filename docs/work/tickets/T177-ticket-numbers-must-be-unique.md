---
title: "Two tickets must never share a number"
document_type: ticket
status: completed
created: 2026-09-15
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: the governance gate fails when two ticket files share a number, and the historical duplicates are grandfathered only while every ticket sharing their number stays closed
---

# T177 — Two tickets must never share a number

Agreed cross-session after the second collision in two days.

## Why it is a gate, not tidiness

`resolveIds` resolves `closes T175` by matching the number against the **path**,
so a duplicated number resolves to every file carrying it, and
`checkStatusDrift` reports drift for each match that is not closed.

That behaviour is strict and correct as far as it goes: **a duplicate can never
make the gate falsely pass.** I had told the other session it could, which was
wrong — checked against the code and measured with a two-doc fixture before
writing this.

The real hazard runs the other way, and is worse because it is *actionable*:
closing **your** ticket demands closure of **someone else's** unrelated, still-open
one, and the obvious way to turn a red gate green is to flip the status it names.
The gate that exists to stop a ticket silently looking closed can, through a
number collision, push someone into closing one.

## Why it kept happening

Structural, not careless. Each concurrent session picks "the next free number" by
listing `docs/work/tickets/`, and neither can see the other's uncommitted file.
T165 collided, we announced numbers to each other, and T175 collided anyway.
Announcing worked and is not a mechanism.

## What it found on its first run

Three pre-existing collisions nobody had noticed: **T82, T107, T110** — each two
unrelated tickets sharing a number, all six closed.

They are **grandfathered conditionally, not exempted.** The hazard is dormant for
them only because every ticket sharing the number is closed — nothing can demand
the closure of something already closed. If one is ever reopened the hazard
returns, so the pass is re-earned on every run rather than granted once, and a
test drives exactly that reopen case.

Renumbering them was rejected: it would break references in commit messages and
ADRs that cannot be rewritten, for no live benefit.

## Scope

Tickets only. ADRs and specs are addressed by filename, not by number.

A new duplicate is reported **even when both tickets are closed** — closed-and-
closed is dormant rather than safe, the ambiguity is still in the history, and a
reopen brings it back.
