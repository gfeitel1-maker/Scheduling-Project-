---
title: "Handoff — serverless rendezvous and WAN connectivity program"
document_type: handoff
status: active
created: 2026-09-17
task: "Serverless rendezvous and WAN connectivity — analysis, governed plan, and the Tier-4 guard extension"
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "Phases A–C have shipped or the owner has decided the program is not wanted"
---

# Handoff — rendezvous / WAN connectivity

**Branch:** `claude/shoresh-rendezvous-wan-handoff-5f211b` (worktree
`.claude/worktrees/shoresh-rendezvous-wan-handoff-5f211b`). Unmerged, uncommitted at time of
writing.

## What this turn produced

Analysis and a governed plan. One piece of code: the Tier-4 guard extension (T207).

| Artifact | Path |
|---|---|
| The external spec, reconciled | `docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md` |
| Seam design ADR (proposed) | `docs/adr/2026-09-17-wan-rendezvous-seam.md` |
| Security assessment | `docs/work/security/2026-09-17-rendezvous-wan-assessment.md` |
| Tickets | `docs/work/tickets/T207`…`T212` |
| Guard extension (built, gated) | `electron/sync/automerge/internetRendezvousScan.js` + its test, and a 4th assertion in `transportBoundary.guard.test.js` |

## The three things a new session must not rediscover the hard way

1. **The guard was blind to this entire program.** An HTTPS `fetch` to a Cloudflare Worker adds no
   libp2p package, is not imported by `transport.js`, and a rendezvous service appended *after*
   `createMdnsDiscovery(` still satisfies the old regex. Phases B and C could have shipped with a
   green gate. T207 closes this behaviourally (no internet egress from the sync path) and its
   non-vacuity is proven by a planted rendezvous client, not by inspection.
2. **`mutualAuth.js` has no local-trust check.** `tryAuthenticate` sends
   `{ type: 'authenticate', token, device_id }` to *any* peer surfaced by `onPeerDiscovery`. The
   spec's headline invariant — "a Cloudflare response never establishes trust" — is not enforced by
   any code today. T208. This is a prerequisite, not a Phase C detail.
3. **The stack is TCP-only.** Phase F (DCUtR) is built around QUIC's cheap simultaneous-open and is
   unlikely to work well here even if the gate were opened. Phase D's packages are forbidden, and
   CGNAT-both-ends is a networking invariant no amount of effort fixes. Measure (T212) before
   deciding either.

## Blocked on the owner — do not proceed past these

- `INTERNET_TRANSPORT_SIGNOFF` must not be flipped by any agent. Preconditions are enumerated in
  the 2026-09-17 security assessment.
- Nothing may be created, registered or deployed to a Cloudflare account or a public domain.

## What changed after the first draft of this handoff

Three owner rulings landed mid-session and are reflected in the spec, ADR and tickets:

1. **T208 approved and built**, and it surfaced a hard blocker: peer ids were not stable across
   restarts (`transport.js` passed no `privateKey`), so the peer-id trust filter the ticket asked for
   would have rejected every legitimate device after any restart. The seam now *requires* a trust
   decision (`wireMutualAuth` throws without `isPeerTrusted`) and a hung attempt can no longer pin the
   dedupe slot — but the LAN case needed T162.
2. **Cloudflare is a non-issue, not a blocker.** Shoresh is open source; anyone who does not want the
   project's infrastructure forks, disables, or self-hosts. The design consequence is a
   **configurability requirement**: the endpoint is configuration and rendezvous-off is a supported,
   *tested* configuration equal to today's LAN-only behaviour. The "single point of failure" framing
   is withdrawn.
3. **Relay: the earlier analysis collapsed two different things.** Relay as a sustained **data path**
   is REJECTED permanently. Relay as **brief coordination for DCUtR** is the intended route, and is
   what §16 of the source handoff actually describes. `@libp2p/circuit-relay-v2@4.2.13` enforces
   128 KiB / 2 minutes per relayed connection server-side — ample for DCUtR's ≤4 KB exchange, not
   enough to carry a document. **`@libp2p/dcutr`'s own documented usage keeps the relayed connection
   alive when the punch fails**, which is not fail-closed: Shoresh code must close it and surface
   `DIRECT_DIAL_FAILED`, with a test. On CGNAT-both-ends with symmetric mapping, no mechanism in
   scope connects the pair — stated unsoftened in the ADR.

**T162 was then approved and implemented** (schema **v66**, not the v60 the stale ADR names).
`security` scored it 5 with one LOW finding (`SECURITY.md`, now written). `red-hat` scored 3; two
findings were real and are fixed (a raw `SQLITE_CONSTRAINT` thrown out of an admission decision, and
an identity failure indistinguishable from a transport failure). Four are deliberately left, recorded
in T162 §0.1 — the most important being that **a `4405` refusal has no director-facing message**,
which is a product decision the owner still needs to make.

## A design spec was produced and DISCARDED on a corrected premise

A Designer spec for a `DeviceUnrecognizedScreen` — a dedicated `device_unrecognized` phase, and in
its revision a primary "Pair This Device Again" button with retry-detection and coaching copy — was
commissioned and then **discarded in full**. It is not approved direction and must not be revived
from the transcript. Two independent reasons:

1. **Its premise was false.** It told directors the cause was "a reinstall, a new hard drive, or a
   restore from backup." None of those produce a `4405`. `device_id` lives in the same SQLite
   database as the identity key (`localDb.js:3277`), so losing one loses both, and such a device is
   refused at `4403` — the ordinary path — and simply pairs as new.
2. **Its remedy was an attacker-assist.** The same screen is shown to a confused director and to
   whoever is holding a copied credential, and the app cannot distinguish them. A one-tap recovery
   path plus troubleshooting help is a guide to getting re-admitted, handed to the person the
   control just stopped. The polished revision was more dangerous than the first draft, not less.

What shipped instead: the refusal is surfaced neutrally with no cause and no remedy, and the
reasoning is written at the site so a future reader does not "improve" it back into a wizard.

## The merge train completed 2026-09-18 — `main` is `bab5528`

In order: **#472** (T215, libp2p 3.3.11, closing GHSA-vrf4-mx87-p53w) → **#470** (the pairing-push
deletion) → **#467** → **#471** → **#473** (T194, the participant data substrate at schema v66).

Two consequences for this branch, both now done rather than pending:

- **Schema: the conditional resolved to renumber.** T194 took v66 first, so ours moved to **v67**
  (`CURRENT_SCHEMA_VERSION`, guard `>= 66 && < 67`, `rollback/v67_down.js`, the
  `migrationDomainState.js` classification entry, and 18 literal test assertions). The rule held as
  written: numbers follow merge order, verified at rebase — not an advance allocation.
- **`KNOWN_GAPS` is now empty.** #470 deleted the three dead channels, so the guard enforces against
  every channel with no allowlist. That closes the loop this whole thread opened with.

## REBASE CHECKLIST — in order, and the first item is not optional

`main` moved a long way while this branch sat: `8825015` (T215, libp2p 3.x) then `8e66547` (#470,
the pairing-push deletion). Work through these in order.

1. **`npm ci` in the worktree, BEFORE trusting any local result.** This is first because it silently
   invalidates everything after it. Rebasing onto a libp2p major leaves `node_modules` carrying the
   **old** major while `package-lock.json` says the new one — the session that merged T215 hit
   exactly this, with 2.10 installed and 3.3.11 locked. A gate in that state measures a tree you no
   longer have and reports confidently about it. It looks like a valid run, and nothing in the output
   says otherwise. (Taxonomy member: *the check ran, against different truth than you think* — see
   `docs/work/security/2026-09-14-security-program.md`.)
2. **Re-derive the ticket numbers.** T207–T213 may have moved again; several sessions file
   concurrently. A number is only yours once pushed.
3. **Re-derive the schema version** and renumber to v67 **only if** v66 landed ahead of us — see the
   section below for the full move set and the merge-order rule.
4. **Clear `KNOWN_GAPS` in `electron/ipcChannelParity.guard.test.js`.** The three channels
   (`shoresh:pairing-approved`, `shoresh:pairing-denied`, `shoresh:token-renewed`) no longer exist in
   `electron/preload.js` on `main` after #470, so the exemption is now unnecessary — remove it so the
   guard enforces with an **empty allowlist**. This closes the loop the whole emitter thread started
   from; it must actually happen rather than remaining a documented exemption.
5. **Resolve the #470 conflicts toward the deletion** in `useDeviceMode.js`, `CLAUDE.md`,
   `PLATFORM_STATE.md`.
6. **Sweep `test/` and `scripts/`, not just `src/` and `electron/`.** Both sessions made the same
   method error tonight: the deletion's symbol sweep covered only the source directories (came back
   clean, but the method had the gap), and T215's libp2p migration sweep covered
   `electron/sync/automerge/**` and missed `test/fuzz/wireAndCrypto.fuzz.test.js` — which was a real
   failure, caught only by the full gate.
7. **Then** the full gate, on a quiet machine, reading the counts before believing any banner.

### Deleting a merged branch

`gh pr merge --delete-branch` can print `failed to run git: fatal: 'main' is already checked out at
<another worktree>`. That is the **local** branch-switch step failing — **the merge itself already
succeeded**. Harmless noise in a multi-worktree setup, but it leaves the *remote* branch undeleted.
Delete it separately and confirm with `git ls-remote`, never from the command's output. This sits
beside the existing rule about never chaining a branch delete onto a merge (a failed merge with a
chained delete closes the PR).

## MANDATORY AT REBASE — re-derive the schema version, and renumber ONLY if v66 landed ahead of us

**Do this at rebase, not before, and verify rather than assume.**

This branch is `CURRENT_SCHEMA_VERSION = 66` (`electron/db/localDb.js:25`), with T162's
`device_identity_key` migration guarded `>= 65 && < 66`. Another session's elective-scheduling work
(participant data substrate, seven synced entities) also built **v66** on top of 65. Two migrations
at one version is materially worse than a duplicate ticket number: whichever lands **second is never
applied** on any database that already ran the first, because the guard compares the stored version
against the literal — and the app then reports itself fully migrated. Silent data-shape divergence
across a camp's devices, surfacing much later as unexplained sync failures.

**Agreed resolution, and deliberately NOT an advance allocation:** both branches stay at v66 as they
are. **Whoever merges first keeps v66; the second renumbers to v67 at rebase.** Nobody does
speculative renumbering work against a version no pushed ref holds — that risks doing the work twice,
or undoing it.

Confirmed with the other session: their v66 is committed locally and simply unpushed, so the table
below was accurate on all three rows.

**If, and only if, v66 has landed ahead of us**, the work — all of which must move together:
- `CURRENT_SCHEMA_VERSION` → 67, and T162's guard re-written `>= 66 && < 67`.
- The down-migration follows, **filename included**: `rollback/v66_down.js` → `v67_down.js`.
- The classification entry added for v66 in `electron/db/migrationDomainState.js` must follow to 67,
  or `migrationDomainState.test.js`'s "covers 1..CURRENT_SCHEMA_VERSION with no gaps" fails — that is
  the exact test that reddened this branch's third gate.
- Every sibling test asserting the version literal. **Re-derive the list; do not trust a number.**
  A count of 17 was reached by grepping the literal, which over-counts files that mention 66
  incidentally and under-counts any test that *derives* the version instead of asserting it — and the
  derived cases are precisely the ones a literal sweep misses and that fail after you believe you are
  finished.

### The load-bearing part: merge order IS the rule, not an agreement about who gets which number

"We agreed who gets which number" is **not** the safety property. If v67 landed before v66, every
device that ran v67 would skip v66 permanently — the identical silent-divergence failure with the
numbers swapped. The rule is therefore **numbers follow merge order, verified at rebase**, and the
mutual check (each session verifying in the opposite direction) is the actual mechanism.

**Verified 2026-09-17, and it does not yet hold:** `origin/main` is at v65. The pushed
`claude/shoresh-elective-scheduling-b3bec8` is **also at v65** — highest guard `>= 64 && < 65`, no
`v65_down.js` or `v66_down.js` in its tree. Their v66 is not on any pushed ref; it exists only in
their working copy. So at the time of writing **no pushed ref claims v66 except this branch**, and
the premise "they merge first" cannot be confirmed from refs. Re-run this check at rebase:

```
git fetch origin && git show origin/main:electron/db/localDb.js | grep CURRENT_SCHEMA_VERSION
```

If v66 has **not** landed ahead of us, do not proceed as though v67 is safe — stop and escalate.

## MANDATORY BEFORE MERGE — re-verify the ticket numbers

**This branch's tickets are T207–T213.** That block was chosen on 2026-09-17 from a fetch done at
that moment: `origin/main`'s highest was T205 and a peer reported T206 in flight. The branch
originally used T192–T198, every one of which was claimed on `main` by other sessions *after* we
branched — seven collisions at once.

**Freshness is necessary and NOT sufficient — the sharper form, learned twice in one evening.** A
peer session re-derived from a fresh fetch, picked T204, and **still collided**, because another PR
landed between its fetch and its use. Then T214 was claimed the same way while we were mid-report.
**A number is only really yours once it is pushed.** Until then the pre-merge rebase is the only
thing that actually catches a collision.

**Choosing the block does not settle it, and this step must not be skipped:**

> Immediately before merging, rebase onto a freshly fetched `origin/main` and re-run
> `npm run check:governance` locally.

The reason is precise. `duplicate-ticket-number` (`scripts/check-governance.js:399`) scans the
**working tree**, so it validates numbers against *our* tree — not against whatever landed on `main`
after we branched. A number free when we checked can be claimed by another PR between our check and
our merge, and our branch never contains the other ticket, so the scan passes correctly on the
evidence it has. **The rebase is the first moment the tree contains both sets and the scan can
actually see a collision.** That exact sequence turned `main` red today on a duplicate T202 and
aborted an unrelated session's gate at 2m28s.

Note also, and do not over-read it: the duplicate scan **does** run in CI, including on the shallow
clone. What CI skips there are the **status-drift** (`:902`) and **run-record** (`:900`) checks,
which need `origin/main` to diff against — `gate.yml:40` uses `actions/checkout@v4` with no
`fetch-depth`. Both skips announce themselves via `console.warn`, so the evidence is in the CI log.

## Also pick up at rebase, if the peer branch has not

`electron/main.js:254` carries a stale prose comment referencing `selectJoinHost()`, which the peer
branch's deletion will orphan. **`check:governance` will not catch it** — the doc-reference gate
covers descriptive docs naming repo *paths*, not source comments naming deleted symbols. Flagged to
the deleting session; if it does not land there, fix it on the rebase.

## One lesson, not five: a result is a claim about the measurement first

These were collected separately over one evening and are the same error wearing different clothes.
Recorded together because treating them as five unrelated gotchas is how the sixth gets made. The
full gate-semantics taxonomy lives in `docs/work/security/2026-09-14-security-program.md`.

| What happened | What it looked like |
|---|---|
| `npm run verify` printed `⚠️ VERIFY INCONCLUSIVE` **and exited 0** | a pass, if you read the exit code |
| `pgrep verify.js` matched the peer's gate in the **main checkout** | "my gate is running" — it had never started |
| BSD `sed -E 's/\bT192\b/…'` matched nothing and exited 0 | a rename that "succeeded" having changed nothing |
| `graphify affected` returned *"No unique node match"* for an unindexed symbol | confirmation that nothing depends on it |
| `npm audit` consults a **live** advisory database | a red build caused by our diff — it was published overnight |

The last one has a consequence worth stating plainly: **`main` is currently stale-green, not green.**
Its last passing runs predate GHSA-vrf4-mx87-p53w. *"It passed"* and *"it would pass now"* are
different claims and nothing in the output distinguishes them.

## A machine-coordination fact worth knowing

`npm run verify`'s lock is keyed **per repository**, so a gate running in a worktree and a gate
running in the main checkout do **not** exclude each other. Two concurrent gates on this 4-core
machine drove load to 64 and produced two `VERIFY INCONCLUSIVE` verdicts — which exit **0** while
explicitly not being a pass. Check `pgrep -fl verify.js` before gating, and read the verdict line
rather than the exit code.

## The defect that mattered most, found late

`shoresh:auth-rejected` had a listener and **no sender anywhere** — the sender lived in the
WebSocket `syncClient.js` deleted in the Stage 6c cutover, while `preload.js`, the
`reasonForAuthRejectedCode` mapping, `sessionEndedReason` and the LoginScreen notice all survived.
So every authoritative Host refusal — revoked device, unknown device, expired session — has been
invisible to directors since that cutover, presenting as sync that silently never works. Reconnected,
and guarded by `electron/ipcChannelParity.js`, which immediately found three more dead listeners
(T213).

The class is worth naming: the cutover severed **directions** of a flow rather than whole flows, so a
half-live channel family reads as healthy from either end, and a listener with no sender is invisible
to lint, to the dependency graph, and to every test that mocks the channel.

**The same cut had a second half, and it was a live user-facing defect.** A peer session found that
the startup effect's client branch was gated on `joinHost`, which nothing has written since the
cutover — so a device that joined *by code* skipped `chooseMode` on every restart and never handed
its token to the libp2p node (`setAuthToken`, `main.js:716`). The T87 re-auth-on-restart guarantee
was silently not happening for every joined-by-code device. Its tests missed it because the fixture
hand-seeded the dead `shoresh-join-host` key, so four tests passed against a device shape the app can
no longer produce. Details and evidence in T213.

**Whether the gate half can be guarded: asked, and answered no** — see T213. The channel guard works
because it compares presence of a literal string at both ends. The gate half turns on *reachability*
(the writer exists; it is unreachable), which no cheap grep-shaped check can see. The actionable fix
is to make `graphify` index `useCallback`/arrow-const exports — it returned *"No unique node match"*
here and **abstained**, which read carelessly would have looked like confirmation. A negative result
is a claim about the measurement.

**Dependency:** the peer's deletion of the dead pairing path ships on its own branch off `main`. The
three `KNOWN_GAPS` entries stay here until that lands, or this branch would assert against code that
still exists on `main`. Both branches touch `useDeviceMode.js`, `CLAUDE.md` and `PLATFORM_STATE.md` —
expect conflicts, keep edits narrow.

## Suggested next step

The owner decision on the `4405` director-facing message, then replacing `lanTopologyTrust` with a
real `devices.libp2p_peer_id` check now that T162 makes peer ids stable. After that, T210 (record +
namespace) before T209 (the Worker), since the Worker's API depends on the record contract.
