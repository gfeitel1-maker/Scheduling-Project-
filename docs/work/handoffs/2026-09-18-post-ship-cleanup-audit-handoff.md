---
title: "Handoff — to the post-ship cleanup audit: ticket states, what shipped, and what only looks shipped"
document_type: handoff
authority: descriptive
status: active
date: 2026-09-18
created: 2026-09-18
task: docs/work/tickets/T215-libp2p-3x-upgrade.md
archive_when: the post-ship cleanup audit has flipped the statuses this document adjudicates and the rendezvous branch has merged or been abandoned
---

# Handoff — to the post-ship cleanup audit

Written for the cleanup audit session, which is flipping ticket statuses for shipped-but-unclosed
work. It answers the questions that session asked, and pre-answers the ones it is about to hit.

The governing distinction throughout: **merged to `main` is not the same as done, and a branch
existing is not the same as shipped.** Several tickets here look closeable and are not.

## 1. What actually merged

Two things, both verified from the run's own `conclusion` rather than a PR status field:

| PR | merge commit | what it is |
|---|---|---|
| #472 | `8825015` | T215: libp2p 2.10.0 → 3.3.11, closing GHSA-vrf4-mx87-p53w |
| #470 | `8e66547` | Remove the orphaned pairing-push channels, fix the dead gate underneath |

At time of writing `origin/main` is `8e66547` and still moving — #467, #471 and T194 were queued
behind these and may have landed by the time you read this. Re-derive rather than trusting this line.

**Nothing has been released.** No packaged build was produced. Nothing here has reached a camp.

## 2. T215 — leave OPEN

Its `archive_when` has three conditions. Two are met, one is untouched.

1. **`npm audit` clear of high/critical against `@libp2p/peer-store` — MET.** `npm audit --omit=dev`
   returned 0 vulnerabilities, and the security review verified the fix is present in the installed
   `@libp2p/peer-store@12.0.28` source (`consumePeerRecord` derives the peer id from the envelope's
   own signer and rejects a mismatch) rather than trusting the audit tool.
2. **Tier-4 guard package list re-checked against 3.x names — MET.** All nine forbidden names
   survived the major unchanged, so nothing needed renaming. The re-check surfaced two internet
   transports missing from the list entirely — `@chainsafe/libp2p-quic` and `@libp2p/webrtc-direct`
   — both added in #472. Worth knowing *why* QUIC was absent: it was uninstallable under
   `@libp2p/interface@^2.11.0`, so the dependency graph was doing the guarding accidentally, and
   the 3.x bump removed that accidental protection.
3. **Mixed-version 2.10 ↔ 3.x replication demonstrated, or its failure surfaced to the director —
   NOT MET.** Neither half has happened.

### Do not move condition 3 onto T217

T217 is scoped to three residual findings: the `authenticateWith` close-race where the security and
adversarial reviews reached **opposite** conclusions, the dead `it-pipe` dependency, and the
enumerated list of what same-version tests structurally cannot see. It *names* the cross-version run
as the thing that would settle several of its items; it does not own the condition. Reassigning
condition 3 there would make both tickets closeable while the demonstration never happens.

### Why condition 3 is not a formality

The interop expectation rests on the protocol IDs being byte-identical across the major — Noise
`/noise`, Yamux `/yamux/1.0.0`, multistream-select `/multistream/1.0.0`, identify `/ipfs/id/1.0.0`,
read out of the published 3.x packages rather than inferred from the changelog. That argument is
sound as far as it goes, and it has a structural reason to hold (those IDs are shared with
go-libp2p and rust-libp2p, so a JS-only major cannot move them without breaking cross-implementation
interop).

But **Yamux's initial window size is negotiated in-band, after protocol selection**, so it sits
underneath the protocol-ID equality argument entirely. The IDs can match byte-for-byte and the
connection can still misbehave once data moves. "Connects, then misbehaves" is precisely the failure
a green single-version suite cannot see.

This matters to the product, not just to the ticket: the owner's stated requirement is that laptops
keep talking to each other regardless of what upgrades are in flight, because a camp's devices do
not upgrade together. Right now that requirement is supported by good reasoning and no evidence.

### The run is queued, and it is not impossible after the merge

Owned by the rendezvous session, queued as the first thing after the merge train clears, using
`test/integration/harnessAutomerge.js`'s injectable `startSyncNode` seam — two checkouts at
different versions, two node processes, one machine over loopback.

Correct a claim you may encounter: the merge did **not** make 2↔3 untestable.
`git worktree add <dir> 08e971b && npm ci` reproduces a libp2p 2.10.0 tree from the lockfile at that
sha. It became less convenient, not impossible. That distinction matters because "it's now
untestable" invites either skipping the test or rushing a merge to preserve an option that was never
being lost.

## 3. Ticket states on the unmerged rendezvous branch

Branch `claude/shoresh-rendezvous-wan-handoff-5f211b`, 8 commits, **unmerged**. Do not close any of
these on the strength of the work existing.

| Ticket | State | Note |
|---|---|---|
| T207 | in-progress | Tier-4 guard extended behaviourally; guard is a tripwire with stated blind spots |
| T208 | in-progress | `isPeerTrusted` predicate now required at the wire seam; `lanTopologyTrust` still permissive |
| T162 | in-progress | Persistent per-device libp2p identity, token-to-peer binding, schema v66 |
| T209–T212 | open | Rendezvous phases A–E; none built |
| T213 | in-progress | Dead pairing-push listeners; the deletion half landed via #470, the guard half has not |
| T216 | filed, deliberately unexpanded | Gate-semantics write-up; see §5 |

T213 is the one most likely to be mis-flipped. #470 deleted the channels, but this branch owns
clearing the three `KNOWN_GAPS` entries in `electron/ipcChannelParity.guard.test.js` so the guard
enforces with an empty allowlist. Until that lands, the guard still documents exemptions for code
that no longer exists.

## 4. Collision surface for other branches

The rendezvous branch's `electron/` footprint: `sync/automerge/**` (mutualAuth, peerIdentity,
syncNode, transport, two guards), `db/schema.sql`, `ops/undoReferences.schemaParity.test.js`, the new
`ipcChannelParity*` files, and `electron/main.js`.

`electron/main.js` is the only realistic contact point with unrelated work, and the change is small
and localised: one import (`codeForAuthRejectedReason` from `./authRejectedSender.js`) near the other
imports, and a 9-line block inside the `isElectronEntryPoint()` branch sending `shoresh:auth-rejected`
to the renderer. Nothing touching window construction, `BrowserWindow` options, `webPreferences`, the
menu, or app lifecycle. A conflict, if any, will be the import line — keep both.

`electron/preload.js` is being changed on `main` by the merge train (#470 removed three
`ipcRenderer.on` channels). Any branch with a preload diff should rebase before assuming it is clean.

### Schema version

This branch holds schema **v66**, as does the T194 participant-data branch. Agreed resolution:
**numbers follow merge order, verified at rebase** — whoever merges first keeps v66, the second
re-derives from a freshly fetched `origin/main` and moves to v67 with guard `>= 66 && < 67`. The
rendezvous branch is later in the train and expects to be the one that moves.

This is not merely a numbering nicety. Two migrations at the same version means whichever lands
second is **never applied** on a database that already ran the first, because the guard compares the
stored version against the literal — and the app then reports itself fully migrated. Silent
data-shape divergence across a camp's devices. `check:governance`'s duplicate scan cannot catch it:
it scans the working tree, and neither branch contains the other's migration, so both pass correctly
on the evidence they have. **Only the rebase reveals it.**

## 5. Gate semantics you will need while auditing

T216 records these; the short version, because an audit is exactly the activity they mislead.

A green or absent verdict can fail to mean what it looks like in several distinct ways:

- **The check didn't run.** CI's shallow clone has no `origin/main`, so `check-governance.js`'s
  status-drift (`:902`) and run-record (`:900`) checks skip. They `console.warn`, so the evidence is
  in the log — but a green run is not evidence they passed.
- **The check ran and abstained.** `VERIFY INCONCLUSIVE` exits **0** while its own text says it is
  not a pass. `graphify affected "<sym>"` returning "No unique node match" means the symbol is
  *unindexed* — the graph declined to answer, which reads as agreement.
- **The check ran against different external truth.** `npm audit` queries a live advisory database,
  so the security gate's verdict is a function of wall-clock time. This is the only kind that flips
  with nobody touching the repo, and it is why every branch went red on the night of 2026-09-17.
- **The check ran against a tree you no longer have.** After a major dependency change, `node_modules`
  can still hold the old version while the lockfile holds the new. Run `npm ci` before trusting any
  local result.
- **The check ran and stopped checking.** A guard that asserts via a throw does not go red when
  disarmed — it goes quiet. Green before, green after, guard gone. **Compare test and assertion
  counts against a baseline sha, not just pass/fail.** Counts match and colours match → real
  comparison. Colours match and counts moved → something stopped running and nobody was told.

Two specific traps for a session reading CI:

- `gh pr checks <n>` can report "no checks reported on the branch" while `gh run list` shows a
  **completed failure** from minutes earlier. Read the run (`gh run view <id>`) and its `conclusion`,
  never the PR-level status.
- `gh pr checks` reports `IN_PROGRESS` rather than `PENDING`, which exits naive wait-loops early.

And one that cost a real defect on 2026-09-17: the `VERIFY INCONCLUSIVE` banner **advises** that a
failure under load is "very likely a load artifact, not a defect." On that run it was a genuine
defect — a fuzz test in `test/fuzz/` still building its send-path fake as a pull-stream callable
sink, missed because the migration sweep was scoped to `electron/sync/automerge/**`. **Read the
counts before believing the explanation.** The banner is a heuristic; the counts are the measurement.

The generalisable half: **a sweep scoped by directory misses every consumer outside it, and test
directories are where they hide** — hand-rolled fakes of production interfaces live in `test/`. Two
sessions made this identical method error on 2026-09-17; one happened to come back clean, the other
hit a real failure.

## 6. Ticket numbering

`main` moves faster than a session can hold a number. Two collisions occurred on 2026-09-17: a
duplicate T202 turned `main` red for about an hour and aborted an unrelated session's gate run at
2m28s, and this branch's original T192–T198 block collided wholesale with tickets filed concurrently.

Re-deriving from a freshly fetched `origin/main` is **necessary and not sufficient** — the window
between checking and merging stays open. The number is only really yours once it is pushed. What
closes it: rebase onto fresh `origin/main` immediately before merge and re-run `check:governance`
locally, which is the first moment the tree contains both sets of tickets and the duplicate scan can
see a collision.

## 7. Open questions this handoff does not answer

- **Whether 2.10 ↔ 3.x actually replicates.** Queued, owned, not done.
- **`INTERNET_TRANSPORT_SIGNOFF`** remains `false` in
  `electron/sync/automerge/transportBoundary.guard.test.js`. It is a deliberate human checkpoint and
  no agent may flip it. Rendezvous Phase C cannot ship without a recorded re-assessment.
- **The `4405` refusal wording** says "contact your director," which is circular when the reader is
  the director. Left deliberately: every improvement either names a cause or offers a remedy, and the
  same screen reaches whoever holds a copied credential. Recorded as accepted friction, not an
  oversight.
- **Symmetric-CGNAT-both-ends has no WAN path in scope** — not via QUIC, not via coordination-only
  relay. Accepted limitation, recorded in the seam ADR.
