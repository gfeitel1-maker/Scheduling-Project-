---
title: "ADR: Ticket-number arbitration across unpushed worktrees — aggregate, don't claim closed"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-09-25
decided: null
deciders: [product-owner]
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_specs: []
related_tickets: [docs/work/tickets/T225-ticket-number-arbitration.md]
related_adrs: []
supersedes: []
affects: []
program: shoresh-governance-tooling
---

# ADR: Ticket-number arbitration across unpushed worktrees — aggregate, don't claim closed

## Context

Ticket numbers (`docs/work/tickets/TNNN-*.md`) are allocated manually: a session picks "the next free
number" by listing whatever `docs/work/tickets/` it can see. `checkTicketNumberUniqueness` in
`scripts/check-governance.js` (line 381) already detects a collision after the fact, but only within
the one working tree it runs in — it operates on the `docs` array `checkAll(root, execFn)` builds by
reading `root`'s own filesystem (`readDocs`, `scripts/build-work-index.js`). It cannot see a ticket
that exists only in another session's unmerged branch, or in another local worktree's **uncommitted**
files, because nothing ever asks those trees a question.

That gap is not hypothetical. `checkTicketNumberUniqueness`'s own doc comment (`scripts/check-governance.js:360-368`)
records that it happened twice in two days — T165, then T175 — "for a structural reason rather than a
careless one: each session picks 'the next free number' by listing this directory, and neither can see
the other's uncommitted file." This ticket (T225) is triggered by a further, independently verified
recurrence on 2026-09-23/24: the same failure mode hit both a ticket-number collision (T234–T239) and a
schema-version collision (v73), on the same machine, across concurrent sessions, and in both cases **the
authoritative "what's taken" signal lived only in an unpushed local worktree.** A remote-only check
(`origin/main`, `git ls-remote`, or the open-PR list) came back clean in both cases while the collision
was real — see project memory `feedback_authoritative_state_in_unpushed_worktrees`. A remote-only
allocator is therefore not merely incomplete; it is a check that reports green while wrong, which is
worse than no check, because it is trusted.

As of this ADR there are on the order of 28 sibling worktrees under
`/Users/gregfeitel/dev/shoresh/.claude/worktrees/`, verified via `git worktree list --porcelain`
(confirmed in this session: the command lists each worktree's absolute path, `HEAD`, `branch` or
`detached`, and a `locked` line when a Claude agent session holds it — no flag or state is needed
beyond parsing that output). Each one can hold ticket files git itself does not know about yet.

## Options considered

1. **Remote-only aggregation** (origin/main + `git ls-remote --heads origin` + open PRs). *Rejected*:
   this is exactly the shape of check that was confidently wrong twice on 2026-09-23/24. It would ship
   green while reproducing the verified bug.
2. **Full aggregator across local + remote, including uncommitted worktree files** (the direction named
   in the ticket). Reads: (a) `origin/main`'s `docs/work/tickets/` via the existing `readDocs`/checkAll
   path, (b) `git ls-remote --heads origin` to enumerate remote branch names (a ticket number embedded
   in a branch name, e.g. `T240-foo`, is a soft signal — best-effort, not authoritative, since a branch
   name is not required to carry the number), (c) `gh pr list` for open PR titles/branches (same
   best-effort caveat), and (d) every entry from `git worktree list --porcelain` **other than the one
   already covered by (a)**, reading `docs/work/tickets/*.md` directly off each worktree's disk with
   `readdirSync`/`readFileSync` — no git operation on that tree, no requirement that it be committed or
   pushed. This is the only option that actually closes the gap the incident exposed, because (d) is
   the source the incident showed was authoritative and everything else missed.
3. **Push a claim-ref marker at filing time** (e.g. `git push origin HEAD:refs/ticket-claims/TNNN`,
   which fails atomically if the ref exists) to make allocation closer to atomic. *Evaluated, deferred*
   — see "Scope decision" below.
4. **Make the ticket number non-load-bearing** (content-addressed or timestamp-based IDs instead of a
   sequential human-assigned number). *Evaluated, rejected for this ticket*: it would remove the
   collision class entirely, but the number appears in filenames, commit-message closure references,
   and ADR cross-references throughout the existing corpus. Migrating to a different identity scheme is
   a repo-wide, multi-file change, and the ticket explicitly forbids "automated renumbering that
   rewrites references outside the renumbering session's own documents" (constraint (c)). It is a
   legitimate future direction but not a surgical answer to T225's archive_when, which asks for
   observability before either session merges, not identity-scheme replacement.
5. **A running allocator service/daemon holding a lock.** *Rejected*: new infrastructure, a process to
   keep alive, and a single point of failure in a project whose whole architecture is local-first with
   no central server. Disproportionate to the problem (a doc-hygiene helper), and the kind of premature
   abstraction the project's standing guidance (karpathy-guidelines; "if 200 lines could be 50, write
   50") asks not to build.

## Decision

**Recommend option 2** (full local+remote aggregation, sources (a)-(d) above), shipped as a new
`scripts/nextTicketNumber.js` allocator helper plus injectable building blocks that
`checkTicketNumberUniqueness`'s test suite (and this new script's own tests) can drive without touching
real disk or a real git remote.

**Confidence: high (≈0.85).** Evidence: this is a direct, mechanical extension of code that already
exists and already works for the single-tree case (`checkTicketNumberUniqueness`,
`scripts/check-governance.js:381`); `git worktree list --porcelain`'s output shape was verified in this
session rather than assumed from memory; and the failure mode this closes (an unpushed worktree holding
the authoritative signal) is independently confirmed by two separate incidents in project memory, not a
single anecdote. The residual uncertainty is entirely in the size of the race window that remains (see
below), not in whether aggregation is the right mechanism.

### What ships

- `scripts/nextTicketNumber.js` exporting a pure function, shaped like the existing `checkAll(root,
  execFn)`:

  ```
  nextTicketNumber({
    root,                 // this worktree's path — feeds the existing readDocs(root) path
    execFn,               // injectable, same contract as checkAll's execFn: runs `git ls-remote`, `gh pr list`
    listWorktrees,        // injectable: () => [{ path, branch, locked }], default parses
                           // `git worktree list --porcelain`
    readWorktreeTickets,  // injectable: (worktreePath) => [{ path, number }], default does
                           // readdirSync(join(worktreePath, 'docs/work/tickets')) + regex match,
                           // wrapped in try/catch (a worktree can be mid-rebase, deleted, or
                           // permission-denied — a read failure there is a skip, never a crash)
  })
  ```

  Returns `{ next, sources }` where `sources` records exactly which of (a)-(d) it managed to read and
  which it skipped (mirroring `checkAll`'s existing "a skip is announced, never silent" discipline for
  the status-drift and run-record checks). A CLI entry point (`node scripts/nextTicketNumber.js`) prints
  the number and, importantly, prints the skip list — a director-facing "I could not see worktree X"
  line is the honest version of this tool, not a silent best-effort.

- `checkTicketNumberUniqueness` itself is **not** widened to read other worktrees at gate time — it stays
  scoped to `root`'s own docs, because `npm run verify`/CI must stay deterministic and fast, and reading
  27 sibling worktrees on every gate run in every worktree is the wrong place to pay that cost. The
  aggregation belongs in the allocator, which runs once, at filing time, by choice — not in the gate,
  which runs unconditionally, on every commit. This is a real interface split: **detection** (gate,
  single-tree, fast, deterministic) versus **allocation** (helper, multi-tree, best-effort, advisory).

### Scope decision: claim-ref marker (option 3) — deferred, not included

The ticket asks explicitly whether a pushed marker "makes the claim atomic-ish" belongs in this ticket.
It would: `git push origin <sha>:refs/ticket-claims/TNNN` is a real atomic primitive (the push either
creates the ref or fails because it exists), and it's cheap to add later. It is **deferred out of this
ADR's scope** for one reason: it is the one candidate mechanism here that has a **side effect on a
shared resource** (`origin`) triggered automatically by a filing action, from a script multiple
concurrent agent sessions may invoke — that is a materially different risk profile from a read-only
aggregator (stray refs accumulating, a push failing partway and leaving the working session unsure
whether its claim landed, a push racing a concurrent `git push` of the actual branch) and deserves its
own scoped design and review rather than riding in as a rider on T225. Recommend filing it as a
follow-up ticket once the aggregator above has been in use and its remaining race window is observed to
still matter in practice.

## The residual race (documented, not closed)

Even with source (d) present, a same-second window survives: two sessions can both invoke
`nextTicketNumber` before either one **writes its ticket file to disk** (in its own worktree) — let
alone commits or pushes it. The aggregator reads whatever exists on disk *at the moment it runs*; it does
not lock, reserve, or announce. If session A calls it, gets `T260`, and has not yet created
`T260-foo.md` on disk when session B calls it a second later, B also gets `T260`. Sources (b) and (c)
(branch names, PR titles) are soft signals for exactly this reason — they only exist once something has
been pushed or opened, which is later still.

This is the same race `checkTicketNumberUniqueness` already lives with today, just narrowed from "can
persist across a merge, undetected, for days" (the T165/T175/T234-239 shape) down to "a same-second
window between two sessions' allocator calls." **`checkTicketNumberUniqueness` remains the backstop that
catches whatever this window lets through** — it does not become redundant, and this ADR does not claim
it can be retired. Per constraint (a), this document does not claim the race is closed: it is narrowed,
and the narrower race is still real and still needs the existing post-hoc gate.

## Test seam (non-vacuity)

`scripts/check-governance.test.js` already builds `checkAll` fixtures around an injectable `execFn`
(see the `execFn = () => ...` fixtures around line 297). The new allocator follows the same shape so it
is testable without touching real disk or a real remote:

- **Fixture shape**: a fake `readDocs`-equivalent for `root` (an array of `{ path, data }`, same as
  `checkAll` already consumes) representing `origin/main`'s committed tickets; a fake `listWorktrees`
  returning `[{ path: '/fake/sibling-worktree', branch: 'worktree-x', locked: true }]`; a fake
  `readWorktreeTickets` that, given `/fake/sibling-worktree`, returns `[{ path:
  'docs/work/tickets/T240-uncommitted.md', number: '240' }]` **without that file existing anywhere on
  real disk** — this is the crux of the fixture, because it is standing in for exactly the case that
  broke: a ticket number that exists only as an uncommitted file in another worktree.
- **Positive test** (proves non-vacuity): `root`'s own docs show the highest committed number as `T239`.
  `nextTicketNumber({ root, execFn: fakeExecFn, listWorktrees: fakeListWorktrees,
  readWorktreeTickets: fakeReadWorktreeTickets })` must return `241` (not `240`), because it saw the
  sibling worktree's uncommitted `T240`. A version of this function with the sibling-worktree read
  stubbed out (i.e. simulating the *old*, T225-motivating behavior) must return `240` on the identical
  fixture — that second assertion is the plant: it proves the test fails under the single-tree logic
  and only passes because the new source is being read, not because the fixture happens to agree with
  either answer.
- **Skip-is-announced test**: `listWorktrees` throwing (e.g. `git worktree list` unavailable) must not
  throw out of `nextTicketNumber` — it must fall back to `root`-only allocation and report
  `sources.worktrees = 'skipped'`, mirroring `checkAll`'s existing pattern for the status-drift and
  run-record checks (`console.warn` + a `null` sentinel rather than a thrown error).
- **`readWorktreeTickets` failure isolation test**: one sibling worktree entry whose read throws (locked,
  deleted, permission-denied) must not prevent the other sibling worktrees from being read — each
  worktree read is wrapped individually, not the whole loop.

This keeps the check-governance test suite's existing discipline (injectable `execFn`, fixtures over
real disk, `checkAll(root, execFn)`'s shape) and extends it with two more injectable seams
(`listWorktrees`, `readWorktreeTickets`) rather than introducing a new testing pattern.

## Consequence

- New file: `scripts/nextTicketNumber.js` (allocator helper + CLI), with unit tests in
  `scripts/nextTicketNumber.test.js` following the fixture shape above.
- No change to `checkTicketNumberUniqueness`'s scope or the gate's runtime cost.
- The allocator is advisory tooling a session chooses to run before filing a ticket; it is not wired
  into `npm run verify` and does not become a new gate.
- A follow-up ticket (not filed by this ADR) may later evaluate the claim-ref marker (option 3) once the
  narrowed race is observed in practice.
