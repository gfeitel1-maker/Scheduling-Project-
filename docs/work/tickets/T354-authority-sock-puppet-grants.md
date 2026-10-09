---
ticket: T354
document_type: ticket
title: One admin can grant sock-puppet admins to outvote slower honest admins
status: open
created: 2026-10-09
archive_when: "sock-puppet rule decided and implemented in authorityReplay.js, or the behaviour is explicitly accepted by the owner"
task_class: security-auth
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_prs: []
related_tickets: [docs/work/tickets/T353-backdated-revoke-votes.md]
---

# T354 - Sock-puppet grants inflate quorum

## Problem (pre-existing; board q-authority-sock-puppet-grants)

`quorumThreshold` counts every granted admin and every granted admin may vote. A compromised or
rogue admin M can grant extra devices (S) and have them vote with it, outvoting honest admins who
are slower to react.

Probe: A (founder), B, M, S (4 admins, threshold 2). A votes against M; M then grants S; M and S
vote against B. Today B is removed (`[A, M, S]`).

## Candidate (modelled, not implemented)

`todayRule(entries, { sockFilter: true })`: a grant made by an admin AFTER (causally descending from)
a revoke vote against that admin is "tainted"; so is a grant by a signer who holds only tainted
grants. A device whose every grant is tainted stays an admin but its votes do not count and it is
excluded from n. Grant semantics otherwise unchanged. Tests: `authorityModel.test.js`
("T354 sock-puppet candidate"), run on the plain rule and on the T353 seniority variant.

## Model evidence (500 seeds + 209)

- Probe (post-vote sock): without filter `[A, M, S]`; with filter `[A, B, M, S]` (honest B survives), both variants.
- Unique + order independent: 0 failures over 3006 runs per variant.
- Never zero admins: seniority variant 0 failures. Plain rule has 15 zero-admin seeds, identical to the same rule without the filter (that is the T353 mutual-removal bug, not new).
- Differential: 143 histories with no grant after a vote against its signer, 0 differ from the unfiltered rule (legit grants unaffected); 358 tainted histories skipped (4 seeds actually change).

## Residual (not fixed by the candidate)

A sock granted BEFORE any vote against M is untouched: probe with `grant(M->S)` preceding A's vote,
filtered result still `[A, M, S]` (B removed). The rule only helps when honest admins vote first.
Closing it needs a different input (grant cooling-off, cap on grants per admin, or a quorum on
grants) and an owner decision.

## Verdict

Candidate is safe (deterministic, no zero-admin regressions, no effect on uncontested histories) but
partial: it blocks reactive socks only. Recommend adopting it with T353 seniority as defence in
depth and treating pre-emptive socks as an accepted or separately-ruled residual.

## Non-goals

No change to authorityReplay.js in this ticket; no new grant types.
