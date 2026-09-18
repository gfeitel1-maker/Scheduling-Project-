---
title: "Upgrade libp2p 2.10.0 to 3.3.11 to close GHSA-vrf4-mx87-p53w, and answer whether a mixed-version camp can still sync"
document_type: ticket
status: closed
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-14-internet-transport-security-gate.md, docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md]
archive_when: "npm audit reports no high/critical advisory against @libp2p/peer-store, the Tier-4 guard's package list has been re-checked against 3.x names, and mixed-version (2.10 <-> 3.x) replication has been demonstrated or its failure surfaced to the director"
---

# T215 — libp2p 2.10.0 → 3.3.11

**Closed 2026-09-18 — all three `archive_when` conditions are now met.** Conditions 1 and 2 were
met as of the 2026-09-18 audit below. **Condition 3 is met by a recorded product decision, not by a
demonstration**: `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` records the
owner's decision that Shoresh does not promise mixed-version replication — a camp's devices all run
the same build, enforced (once built) by update-on-open. This satisfies the condition's "or its
failure surfaced to the director" branch by removing the promise at the product level. **A future
reader must not read this as "cross-version replication was tested and works."** It was not — see
the ADR for the one interop attempt made (branch `worktree-agent-a05ea47d10e1c405e`, discarded,
verdict inconclusive) and for the load-bearing gap this decision leaves open (update-on-open does
not exist yet; tracked as `docs/work/tickets/T222-update-on-open.md`).

1. **Advisory clear — MET.** `npm audit --omit=dev` returns 0 vulnerabilities, and the fix was
   verified in the installed `@libp2p/peer-store@12.0.28` source rather than taken on the audit
   tool's word: `consumePeerRecord` now derives the peer id from the envelope's own signer and
   rejects a mismatch.
2. **Tier-4 guard package list re-checked against 3.x names — MET.** All nine forbidden names
   survived the major unchanged, so no renames were needed. The re-check also surfaced two internet
   transports missing from the list entirely — `@chainsafe/libp2p-quic` and
   `@libp2p/webrtc-direct` — both added in #472. Worth knowing why QUIC was absent: it was
   uninstallable under `@libp2p/interface@^2.11.0`, so **the dependency graph had been doing that
   guarding accidentally**, and the 3.x bump removed that protection.
3. **Mixed-version (2.10 ↔ 3.x) replication — MET by decision.** See
   `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`. It has not been demonstrated to
   work; the product no longer promises it, so the condition's "or" branch closes it.

**Why condition 3 must not be reassigned to [[T217]].** T217 is scoped to the three residual
findings (the `authenticateWith` close-race where `security` and `red-hat` reached opposite
conclusions, the dead `it-pipe` dependency, and the enumerated list of what same-version tests
structurally cannot see). T217 *names* the cross-version run as the thing that would settle several
of its items, but it does not own the condition. Moving it would make both tickets closeable while
the demonstration never happens.

**The substance, so a later reader isn't guessing.** The protocol IDs are byte-identical across the
major — Noise `/noise`, Yamux `/yamux/1.0.0`, multistream `/multistream/1.0.0`, identify
`/ipfs/id/1.0.0` — which is the basis for expecting interop. But **Yamux's initial window size is
negotiated in-band *after* protocol selection**, so it sits underneath that equality argument
entirely: the IDs can match and the connection still misbehave once data moves. "Connects, then
misbehaves" is exactly what a green single-version suite cannot see. T194's scenario 31 (two
devices, real partition, concurrent writes, heal) passes under libp2p 3 — but at 3.3.11 on *both*
nodes.

**Ownership: claimed**, by the session on `claude/shoresh-rendezvous-wan-handoff-5f211b`, queued
behind the current merge train. The run uses `test/integration/harnessAutomerge.js`'s injectable
`startSyncNode` seam — two checkouts at different versions, two node processes, one machine over
loopback.

**Correction worth recording:** the merge did **not** make this run impossible. A 2.10 tree is
reproducible from the lockfile at that sha with `git worktree add <dir> 08e971b && npm ci`. It got
less convenient, not impossible.

Numbering: T214 was claimed by another session (`claude/t214-libp2p-advisory`, PR #471) between one
check and the next. See the handoff — a number is only really yours once pushed.

## Why, and why there is no narrower fix

GHSA-vrf4-mx87-p53w (HIGH, published 2026-09-17): PeerStore accepts attacker-signed PeerRecords for
a victim peer id and stores certified attacker addresses. `npm audit` reports
`fixAvailable: libp2p@3.3.11, isSemVerMajor: true`.

**An override pinning peer-store alone does not work, and this was checked rather than assumed.** Two
independent checks answered *different* questions and both were needed:

- *Registry* (proves the incompatibility exists): `libp2p@2.10.0` requires `@libp2p/peer-store
  ^11.2.7` and `@libp2p/interface ^2.11.0`; the first non-vulnerable peer-store, `@libp2p/peer-store@12.0.24`,
  requires `@libp2p/interface ^3.2.5`.
- *Installed tree* (proves it applies to us): the same majors are what this repo actually resolves.

An override would install two incompatible major lines of `@libp2p/interface` into one tree — and an
interface-major mismatch bites at a **contract seam**, not on every path, so a smoke test would
plausibly come back **green over an incoherent tree**. The peer-store major *is* the libp2p major.

## 1. FIRST QUESTION — can a mixed-version fleet still replicate? **Answered: yes.**

A camp does not upgrade every device at once. A director updates her laptop Tuesday and the office
machine Friday, so **a mixed-version fleet is the normal state during any rollout**, not an edge
case — and two test machines on the same version cannot detect a break.

**Finding: libp2p 2→3 is an API-level major, not a wire-level one.** Verified rather than inferred:

| Protocol | ours (2.x line) | 3.x line | |
|---|---|---|---|
| Noise | `/noise` (noise@16) | `/noise` (noise@17) | identical |
| Yamux | `/yamux/1.0.0` (yamux@7) | `/yamux/1.0.0` (yamux@8) | identical |
| multistream-select | `/multistream/1.0.0` | `/multistream/1.0.0` | identical |
| identify | `/ipfs/id/1.0.0` (identify@3) | `/ipfs/id/1.0.0` (identify@4) | identical |

Read out of the published 3.x packages themselves (via unpkg, without installing), not from the
changelog. The official v2.0.0→v3.0.0 migration guide lists only JavaScript API changes — streams
become EventTargets, handler signature `(stream, connection)`, deprecated removals, multiaddr v13.
This is consistent with libp2p's cross-implementation contract: these IDs are shared with go-libp2p
and rust-libp2p, so a JS-only major cannot change them without breaking that interop.

Shoresh's own application protocols (`/shoresh/automerge/1.0.0`, `/shoresh/auth/1.0.0`,
`/shoresh/automerge-sync/1.0.0`, `electron/sync/automerge/wireProtocol.js`) are our constants and are
untouched by the bump. Automerge sync framing rides our own protocol, not a libp2p-versioned one.

**Confidence: high that negotiation matches. What this does NOT prove:** that every framing detail
behaves identically. Residual risk sits in the Yamux 7→8 major (flow-control window defaults) and
multiaddr 12→13 (address parsing, mDNS announcement shape). Those are settled by running it, not by
reading it.

**The mixed-version test is cheaper than it sounds and must not be skipped:** it does not need two
laptops. Two checkouts at different versions, two node processes, one machine, over loopback or the
LAN is sufficient and is the only test that actually exercises the deployment scenario.

## 2. If they could NOT interoperate (contingency, currently not expected)

The app must say so plainly — "this device needs updating before it can sync with the others" — not
fail silently. We spent 2026-09-17 removing exactly that class of silent failure (the dead
`shoresh:auth-rejected` emitter); reintroducing it one layer down would be worse. It is a
device/sync-state concern, the same family as the auth-rejected notice. **Do not build it unless §1's
answer changes** — it is currently unnecessary.

## 3. Auto-update is NOT part of this ticket

The owner asked whether updating the package on open would keep everyone in sync. It shrinks the
mixed-version window; it cannot close it. An offline or unopened laptop cannot update (common at a
camp); download/install/restart is a real interval during which a director wants to work; and a
failed or declined update converts "behind" into "permanently unable to sync". Making replication
*depend* on auto-update is also a bad dependency: it installs code on every camp's machine, its
integrity is an open question in `docs/adr/2026-09-14-internet-transport-security-gate.md` §4, and a
failure there takes out every camp at once — a larger blast radius than the problem it solves.
Separate ticket if wanted; not a prerequisite here.

## Scope

- `libp2p@2.10.0 → 3.3.11`, and the peer packages it pins: `@libp2p/interface` 2→3,
  `@libp2p/peer-store` 11→12, `@multiformats/multiaddr` 12→13, `@libp2p/multistream-select` → 7.0.28.
  Also on the 3.x line: noise 16→17, yamux 7→8, tcp 10→11, mdns 11→12, identify 3→4. **Check each
  rather than bumping `libp2p` alone and hoping the peers resolve.**
- Call sites to migrate for the API break: every `handle()` protocol handler and every stream
  consumer in `electron/sync/automerge/` (`transport.js`, `authGate.js`, `wireProtocol.js`,
  `syncNode.js`, `joinSession.js`).
- **Re-check the Tier-4 guard's forbidden-package list against 3.x names**
  (`electron/sync/automerge/transportBoundary.guard.test.js`). If any listed package was renamed in
  the 3.x line, the guard silently stops guarding — the exact failure class T207 fixed.

## Review and evidence

Route through `security`, `red-hat` and `architect`: this is the sync transport at the trust
boundary. Full `npm run verify` with the raw verdict line; the `security` step should go green once
the advisory is closed — if it does not, report what remains rather than declaring victory.

**Hardware validation is required and must state its own limits.** Whoever runs it says explicitly
what two-device testing did and did not cover, with **mixed-version replication named as its own
risk** rather than folded into "tested on real devices". Same-version two-device testing does not
cover the rollout scenario.

## Does NOT count as done

- A green gate with an `@libp2p/interface` major mismatch in the tree (see above — it would be green
  over an incoherent tree).
- Same-version hardware testing reported as covering the upgrade.
- Adopting QUIC as a side effect. `@chainsafe/libp2p-quic` was rejected in
  the 2026-09-17 WAN rendezvous seam ADR (lands with the rendezvous branch) partly because it needs `@libp2p/interface@^3.x`
  against our `^2.11.0`. **This bump satisfies that incidentally, so the rejection's premise changes**
  — the ADR is amended to say so. QUIC becomes *possible*, not *chosen*; it stays a separate decision.
- Folding in auto-update (§3).

## Documentation defect found while scoping this

`scripts/security-gate.js`'s header documents the `security-gate:allow` marker without stating its
**scope**: it is honoured by `scanSecrets` and `scanDangerous` but **not** by `auditFindings`, which
has no allowlist at all. That omission is why "add a documented exception for this advisory" looked
viable when it never was. A header describing a mechanism without its limits invites exactly that
misreading — the same lesson as a guard that must state its own blind spots.
