---
ticket: T353
document_type: ticket
title: A removed admin's backdated revoke vote still counts (mutual removal and undoing in small camps)
status: open
created: 2026-10-09
archive_when: "vote rule fixed in authorityReplay.js or the behaviour is explicitly accepted by the owner"
task_class: security-auth
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_prs: []
related_tickets: []
---

# T353 - Backdated revoke votes by removed admins still count

## The bug (live on main)

In `electron/automerge/authorityReplay.js`, `stateAt` admits a revoke vote when
`isValidSignerAt(entry.signer_device_id, h)` holds, i.e. when the signer was a valid admin at the
VOTE'S OWN causal point (the `for (const h of ancestors)` loop, "signer's OWN ancestor-relative
state"). The vote is then kept permanently (comment item 3 above `stateAt`). A removed admin M can
author a new vote whose deps are the pre-removal heads; at that causal point M is still an admin,
so the vote counts toward quorum at heads even though M is removed there.

## Consequence

In a 2-admin camp (`quorumThreshold(2) = 1`) one vote removes the other admin. A votes M out; M
then authors a backdated vote against A. Both votes count and the camp ends with NO admins
(mutual removal). In a larger camp the removed device's vote is a tie-breaker that undoes a
legitimate outcome: 5 admins, A/B/D remove M, then M's backdated vote plus E remove B once the
denominator has shrunk to 4.

## Model evidence

`electron/automerge/authorityModel.test.js` (describe "T353 ...") with
`todayRule` in `authorityModel.testkit.js` (a replica of `stateAt`):

- 2 admins, mutual votes on the same heads: today's admin set is `[]` (both array orders).
- 2 admins, A acts after removing M, M backdates: `[]`.
- 4 admins, M + D backdate vs B: today `[A, D]`.
- 5 admins as above: today `[A, D, E]`; with the candidate, `[A, B, D, E]`.

## Candidate rule

`todayRule(entries, { filterVotes: true })`: grant semantics untouched. In the removal fixed point,
a vote counts only while its signer is still a granted admin (so a signer removed in the vote's own
causal past, or removed at heads, does not count), removal is sticky, and each round removes only
targets that still reach the threshold when votes by fellow round-candidates are dropped. If
candidates exist but none survive that test the round removes nobody.

Model result over 500 random histories + seed 209:

- Single pass, no iteration order consulted: unique and order independent (6 relabel/permutation
  runs per seed, 0 mismatches). Terminates because removal is sticky and monotone.
- Differential: equal to `todayRule` on all 207 seeds where no removed device authored a vote and no
  two devices voted on each other; 294 seeds differ or were skipped for those reasons.
- Appended backdated votes by removed devices: 301 attempts, 281 were mutual-vote pairs
  (structurally symmetric, see below), 20 tested, 0 moved the outcome.

## Limit the model found (needs an owner decision)

When two devices have each voted on the other, or a camp splits 2 v 2 (A,B vs M,D with threshold 2),
the DAG is symmetric: a backdated vote cannot be told from a concurrent genuine one without a
timestamp. The candidate deadlocks there (both devices stay) instead of letting the attacker win
or removing both. Safe for the admin set, but a real removal can be blocked by a colluding
counter-vote. Resolving it needs an extra input (e.g. a founder tie-break or an explicit
"seen-at" fact), not a different counting rule.

## Success predicate

A device removed at heads has no counted vote against anyone; legitimate removals in histories
without backdated or mutual votes are unchanged; replay stays order independent.

## Non-goals

No change to grant semantics; no change to ADR host-succession's effective-grant rule here.
