---
title: "A new high npm advisory against @libp2p/peer-store fails the security gate on every branch, and the only offered fix is a semver-major libp2p bump"
document_type: ticket
status: completed
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, SECURITY.md]
depends_on: "Resolved by T215 (#472). Blocked every open PR while it stood — #467 (T206), #470, #471 — none of which caused it or touched a dependency file. Not caused by any commit in this repo."
archive_when: "`npm run security` reports 0 findings on a clean checkout of main, the trusted-LAN/peer-identity implication of the advisory has been assessed against SECURITY.md rather than only silenced, and whatever was decided (upgrade, pin, or documented accepted tradeoff with a human gate) is recorded"
---

# T214 — the libp2p peer-store advisory that redded the gate repo-wide

**RESOLVED the same night, by T215 (#472): `libp2p` 2.10.0 → ^3.3.11 on `main` at `8825015`.**
`npm run security` returns `0 findings` on the resulting tree, confirmed independently on more than
one worktree. Every blocked PR went green on a rebase.

**Read the rest of this ticket in the past tense.** It is kept as the record of *why the tree went
red on a night nobody changed a dependency* — the thing that is incomprehensible six months later —
and of two conclusions that outlive the incident: the narrow pin is impossible (below), and the
security gate has no exception mechanism for dependency advisories (below). Everything written as
"is failing" describes 2026-09-17 between roughly 19:28 and the T215 merge.

**One thing the resolution was larger than the title suggests.** T215 was not a single-package bump.
Six packages moved, five of them majors — the whole transport stack:

| package | from | to |
|---|---|---|
| `libp2p` | 2.10.0 | ^3.3.11 |
| `@chainsafe/libp2p-noise` | ^16.1.5 | ^17.0.0 |
| `@chainsafe/libp2p-yamux` | ^7.0.4 | ^8.0.1 |
| `@libp2p/identify` | ^3.0.39 | ^4.1.14 |
| `@libp2p/mdns` | ^11.0.47 | ^12.0.32 |
| `@libp2p/tcp` | ^10.1.19 | ^11.0.28 |

**What is still open after this ticket closes**, and should not be lost with it: the **two-device
cross-version question** in "Verification the upgrade needs" below was deliberately deferred until
after the merge rather than answered before it. Encryption, muxing, discovery and TCP all changed
majors at once. Whether a device on the new stack can discover, authenticate against and replicate
with one still on the old stack is **unverified**. A camp's devices do not upgrade together, and that
failure would land on a director's second device days later. If a sync defect appears, start here.

## What is failing

`npm run security` (`scripts/security-gate.js`), step 4 of `npm run verify`:

```
❌ security-gate: 2 finding(s)
  [dependency] @libp2p/peer-store: high advisory (npm audit) — run `npm audit` for the chain
  [dependency] libp2p: high advisory (npm audit) — run `npm audit` for the chain
❌ VERIFY FAILED at step: security
```

The advisory:

> libp2p: PeerStore accepts attacker-signed PeerRecords for a victim peer ID and stores certified
> attacker addresses

## This is a published-advisory change, not a code regression

Nothing in this repository changed to cause it. The same gate reported **0 findings** locally earlier
the same day, on the same lockfile.

Note what `main`'s last runs claim: **success** — at `f87368d` and `08e971b`. Both ran *before* the
advisory was published. `main` is not green, it is **stale-green**, and the next push to `main` will
fail for this reason whoever makes it. A passing CI run is evidence about the moment it ran, not
about the tree. This is the third distinct shape of that same trap seen in one day, alongside a gate
verdict that exits 0 while INCONCLUSIVE and CI's shallow clone silently skipping the status-drift
check.

## What we actually have installed

- Direct dependency: `libp2p@2.10.0`.
- Vulnerable package: `@libp2p/peer-store@11.2.7`, **transitive** — pulled in by `libp2p`, never
  imported by this repo. `grep` for `peer-store` / `peerStore` / `PeerRecord` across `electron/`,
  `src/` and `scripts/` returns nothing.
- Advisory range for `@libp2p/peer-store`: `>=8.0.0 <12.0.24` — we are inside it.
- npm's only offered fix: `libp2p@3.3.11`, flagged **`isSemVerMajor: true`** (2.x → 3.x).

## Why this is not a drive-by bump

`libp2p` is the entire peer-to-peer sync transport (`electron/sync/automerge/transport.js`,
`discovery.js`). A major bump lands directly on the boundary `SECURITY.md` treats as an accepted
tradeoff requiring a **human gate**, and the advisory is specifically about **peer-identity
spoofing**, which is that boundary's subject.

Relevant, and the reason this needs assessing rather than only patching: `transport.js` configures
the `identify` service, and `identify` is the mechanism by which signed peer records are exchanged
and land in the peer store. So the vulnerable component is not inert here — it is on the live path.

## The questions this ticket must answer, in order

1. **Is the attack reachable given our trust model?** Connections are Noise-encrypted and mutually
   authenticated, and joining a camp requires the camp code read off an existing device. The
   advisory describes address hijack / eclipse via certified attacker addresses. Whether that is
   exploitable *before* mutual auth, by a hostile device already on the camp LAN, is the load-bearing
   question and is **not yet answered** — do not assume either way from this ticket.
2. **Does `libp2p@3` change the wire protocol or peer-identity handling** in a way that breaks
   replication against a device still on 2.x? A camp runs several devices that are not upgraded
   simultaneously.
3. Only then: upgrade, or accept the risk with the human gate `SECURITY.md` requires.

## Resolved while this ticket was open: the narrow pin does NOT work

The obvious cheaper route — an `overrides` entry pinning `@libp2p/peer-store` to `>=12.0.24` without
the `libp2p` major — is **dead on declared metadata**, so nobody should spend time testing it:

```
@libp2p/peer-store@11.2.7  (ours)          -> "@libp2p/interface": "^2.11.0"
@libp2p/peer-store@12.0.24 (first fixed)   -> "@libp2p/interface": "^3.2.5"
libp2p@2.10.0              (ours)          -> "@libp2p/interface": "^2.11.0"
libp2p@3.3.11              (npm's fix)     -> "@libp2p/interface": "^3.3.0"
                                              "@libp2p/peer-store": "^12.0.28"
```

The first non-vulnerable peer-store requires `@libp2p/interface@^3.2.5`; our libp2p requires
`^2.11.0`. An override forces two incompatible majors of `@libp2p/interface` into one tree. **The
peer-store major IS the libp2p major** — npm's `fixAvailable: libp2p@3.3.11` is the only fix, not
merely the simplest one it happened to report.

Worth recording *why this was settled from the registry rather than by experiment*, because the
experiment would have been actively misleading: an override would most likely have installed
cleanly, and the integration suite might well have passed, since the mismatch is at a type/contract
seam that only bites on specific code paths. A green run against a tree npm's own metadata calls
incoherent is weak evidence dressed as strong evidence. Three sessions converged on this
independently — via the registry, via the installed tree, and via the observation that the gate's
only dependency lever is a blanket severity constant.

## Do not silence the gate — and do not justify an exception with an unverified reachability claim

One plausible-sounding argument in circulation is that the practical impact here is misrouting rather
than data disclosure, because connections are Noise-authenticated and devices are trust-gated. That
is **a guess nobody has verified**, offered as such by the session that raised it. It must not be
used as the justification for an exception unless the security agent confirms it. This is exactly the
shape of reasoning that turns a real finding into an accepted tradeoff on the strength of a story.

The gate is behaving correctly; suppressing the finding to get green is the one outcome this ticket
exists to prevent. If the conclusion is "not reachable for us", that is a documented accepted
tradeoff with a named approver, not a filter rule.

For the record on mechanism: `scripts/security-gate.js` has **no exception mechanism for dependency
advisories at all**. `auditFindings` has no allowlist, no per-advisory key and no expiry; the
`security-gate:allow` marker applies only to the dangerous-code-pattern scan. The sole
dependency-level lever is the blanket `FAILING_SEVERITIES` constant. So "add a time-boxed exception"
is not a thing that can be done — it is a mechanism that would have to be *built*, on the security
gate, under merge-queue pressure.

## Verification the upgrade needs — a green unit suite is not enough

Whoever takes the upgrade should have a **two-device check**, not only a green `npm run test`. This
is precisely the seam where a green suite and a broken transport coexist comfortably: the unit tests
construct libp2p nodes in-process, and the question that actually matters is whether a device on
libp2p@3 can discover, authenticate against and replicate with a device still on 2.x — a camp's
devices do not upgrade simultaneously. `npm run test:integration` is mandatory for this task class
and is closer, but it is still one process.

Note also that `test:integration` runs **after** the security step in `scripts/verify.js`, which
short-circuits. So for as long as this advisory is unresolved, every branch's gate stops before
reaching the integration suite — meaning work that depends on migration/projection/merge evidence is
not merely blocked, it is running without the evidence it most needs. Run those steps individually
and state which ones did not execute; a report listing the green steps while silently omitting the
ones that never ran is indistinguishable from a pass.

### What to do about that in the meantime

The integration evidence is not gone, it is only off the path anything takes by default — which is
the worst place for evidence to be, because its absence is silent. `npm run test:integration` is a
standalone `node test/integration/run.automerge.js` with no dependency on the gate, so **invoke it
directly** while this stands, and name it in the run record as separately executed. Same for `test`,
`lint` and `build` if you need them past the short-circuit.

This also reframes the advisory's cost, and the reframing should drive the sequencing. The red is not
"we cannot merge tonight", an inconvenience. It is "the repository has silently lost its integration
evidence, repo-wide, until this is resolved" — which argues for resolving the advisory situation
**before** the sync-transport upgrade rather than as part of it. Nobody would deliberately choose to
run the change most likely to cause a sync regression during the window when the suite that catches
one is off every branch's path.

## Suggested handling

Security review, then Red Hat on the multi-device upgrade path, before Maker touches the lockfile.
`npm run test:integration` is mandatory for this task class and is the gate that would actually catch
a replication break.
