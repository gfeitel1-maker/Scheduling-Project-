---
title: "Shoresh security program — the four-tier protocol"
document_type: reference
authority: normative
status: active
date: 2026-09-14
program: security-hardening
---

# Shoresh security program — the four-tier protocol

This document defines Shoresh's security *program*: not a one-time review, but a standing,
layered protocol. It exists because a prior assessment under-scoped the problem — it accepted the
"trusted-LAN" boundary as permanent and reduced security to two surfaces (ingest + supply-chain),
when the real posture had (a) no automated scanning at all, (b) a substantial peer-auth/CRDT
attack surface, and (c) a roadmap heading for the internet that would dissolve the boundary the
whole model rests on. The four tiers below are the correction.

The unifying principle: **local-first lowers risk; it does not remove the network, the untrusted
inputs, or the desktop attack surface.** Devices still discover peers and exchange data over a
network; camp files still arrive from other people; the app is still an Electron process on a
staff laptop. Each tier defends one of those realities, at a different cost/cadence.

## Tier 1 — Automated, continuous (every `npm run verify`)

`scripts/security-gate.js` (script: `npm run security`, wired into `VERIFY_STEPS`). Three
self-contained checks — no external scanner binary the gate could choke on:
## What a green gate does and does not mean (2026-09-17)

Recorded as a property, not a defect to rush a fix at. A green verdict can fail to mean what it looks
like in **four** distinct ways, three of which bit this repository in a single evening:

1. **The check did not run.** CI's shallow clone has no `origin/main`, so `checkStatusDrift`
   (`scripts/check-governance.js:902`) and the run-record check (`:900`) silently skip —
   `.github/workflows/gate.yml` uses `actions/checkout@v4` with no `fetch-depth`. They `console.warn`,
   so the evidence is in the log, but the verdict line says nothing. *(The duplicate-ticket-number
   scan DOES run in CI, shallow clone included — do not over-read this.)*
2. **The check ran and abstained.** `npm run verify` prints `⚠️ VERIFY INCONCLUSIVE` **and exits 0**,
   while its own text says it is not a pass. Same shape as `graphify affected` returning
   *"No unique node match"* for a symbol it never indexed: silence read as assent. The fix is to read
   the verdict line, never the exit code.
3. **The check ran against different external truth.** `npm audit` queries a **live** advisory
   database, so the security gate's verdict is a function of **wall-clock time, not committed state**.
   An unrelated diff goes red because someone published overnight, and no change to the repository
   can explain it. This is the same shape as the earlier licenses-set defect, where a gate input was
   derived from the working environment instead of from `package-lock.json`.
   **Consequence worth stating plainly: `main` is currently stale-green, not green.** Its last
   passing runs predate GHSA-vrf4-mx87-p53w. *"It passed"* and *"it would pass now"* are different
   claims and nothing in the output distinguishes them.
4. **The check validated our tree, and was read as validating the repository.** `check:governance`'s
   duplicate scans read the **working tree**. Two branches independently took ticket numbers
   T192–T198 — and, more seriously, both took **schema v66**. Neither branch contains the other's
   files, so both scans pass *correctly on the evidence they have*; only the rebase brings both sets
   into one tree where a collision is visible at all. Duplicate schema versions are the dangerous
   member: the second migration to land is **never applied** on a database that already ran the
   first, because the guard compares the stored version against the literal — and the app then
   reports itself fully migrated. Silent data-shape divergence, surfacing much later as unexplained
   sync failures.
5. **The check ran, passed, and was measuring an incoherent tree.** An `npm override` pinning
   `@libp2p/peer-store` alone would put two incompatible major lines of `@libp2p/interface` in one
   tree. It installs; an interface-major mismatch bites at a **contract seam** rather than on every
   path, so `test:integration` would plausibly come back green over a tree nobody should trust. Two
   sessions were about to run exactly that experiment. A green result you would then have to
   distrust is worse than a red one.

The common thread, and the reason these are one lesson rather than five: **in every instance the
gate answered a question about *this tree at this moment*, and was read as answering a question about
*the repository*.**

**The abstention family is the more dangerous half.** A stale answer is at least an answer; an
abstention read as agreement is the tool saying "I did not look" and the reader hearing "there is
nothing there." `VERIFY INCONCLUSIVE` exiting 0, and `graphify` returning *"No unique node match"*
for a symbol it never indexed, are both that shape — and both were read as reassurance here before
being caught.

Its siblings from the same evening —
`pgrep verify.js` matching another session's gate in a different checkout and being read as "my gate
is running", and BSD `sed` exiting 0 while `\b` matched nothing so a rename "succeeded" having
changed nothing — are not gate mechanics, but they are the same error.

**Do not "fix" #3 by pinning the advisory database.** The gate is *supposed* to learn about new
advisories; that is its job. What is worth having is the distinction recorded, so a red `security`
step is triaged as "which advisory, published when" before anyone goes looking for it in the diff.

- **Dependency advisories** — `npm audit --omit=dev`, fails on high/critical. This is what would
  have caught the `xlsx@0.18.5` CVE automatically instead of by luck during a manual pass.
- **Secret scan** — tracked text files against high-signal credential patterns (private keys,
  cloud keys, provider tokens). `// security-gate:allow` on the line opts out a deliberate fixture.
- **Dangerous code patterns** — `eval` and `dangerouslySetInnerHTML`, code files only.

Deliberately **not** in the gate: regex SQL-injection detection. This codebase interpolates schema
identifiers pervasively and by design; a regex flags ~100 safe cases, gets blanket-allowed, and
becomes worse than nothing. SQL review is Tier 3's data-flow-aware job (`security` agent).

## Tier 2 — Fuzzing the untrusted-input surfaces (every `npm test`)

Bounded, seeded property tests under `test/fuzz/`:
- `wireAndCrypto.fuzz.test.js` — libp2p frame decoding (`receiveFramed`) against malformed/
  oversized/truncated byte sources, and the join-code crypto surface (`verifyJoinProof` never
  returns true for a wrong/junk proof and never throws; normalization is total).
- `ingestParser.fuzz.test.js` — `parseTextGrid` is total over arbitrary text; the import resource
  caps hold at their boundaries; the formula-injection round-trip never lets a value re-arm to a
  live formula on export.

Seeded (mulberry32, fixed seed) so any failure reproduces exactly. These are property tests —
"no input crashes, invariants always hold" — not payload hunts.

## Tier 3 — Periodic deep assessment (on cadence + before milestones)

The `security-assessment` agent (`.claude/agents/security-assessment.md`): adversarial,
**boundary-questioning**, roadmap-aware. Distinct from the `security` agent, which is the
incremental per-diff reviewer that (correctly) treats documented tradeoffs as decisions. The
assessment agent is *allowed and expected* to question the boundary itself — because rubber-stamping
a stale assumption is exactly the failure this program corrects.

Cadence: run before any milestone that touches auth, sync, the wire protocol, packaging, or the
transport boundary; and at least once per significant architecture shift. Output: a dated
assessment under `docs/work/security/` with ranked findings. The first one is
`2026-09-14-auth-sync-threat-assessment.md`.

## Tier 4 — The boundary trigger (enforced, always on)

`docs/adr/2026-09-14-internet-transport-security-gate.md` + its enforcing guard
(`electron/sync/automerge/transportBoundary.guard.test.js`). Before any internet-reachable
transport ships, a full re-assessment is mandatory; the guard turns the build red if an
internet-transport dependency, import, or non-loopback default listen appears without a recorded
sign-off. This is the single most important artifact, because the boundary change is the largest
latent risk and would otherwise land incrementally and silently.

## Maintenance (how this program stays honest)

- **Tier 1** advisory severity threshold and secret patterns live in `security-gate.js`; widen
  them as the threat model changes, not the reverse.
- **Tier 4** guard's package list (`INTERNET_TRANSPORT_PACKAGES`) must be kept current — a new
  internet-transport library not on the list would slip through. Review it whenever a libp2p
  dependency is added.
- **SECURITY.md** is the deployment-boundary + hardened-areas + accepted-limitations record. It is
  descriptive of the *current* transport; when the transport changes, SECURITY.md changes with it
  (the 2026-07-26 → 2026-09-14 refresh that accompanied this program is the example).
- The `security` agent's "do not flag accepted tradeoffs" instruction is scoped to **code review**;
  Tier 3 assessment is explicitly permitted to reopen them.
