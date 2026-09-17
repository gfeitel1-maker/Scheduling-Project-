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

## A machine-coordination fact worth knowing

`npm run verify`'s lock is keyed **per repository**, so a gate running in a worktree and a gate
running in the main checkout do **not** exclude each other. Two concurrent gates on this 4-core
machine drove load to 64 and produced two `VERIFY INCONCLUSIVE` verdicts — which exit **0** while
explicitly not being a pass. Check `pgrep -fl verify.js` before gating, and read the verdict line
rather than the exit code.

## Suggested next step

The owner decision on the `4405` director-facing message, then replacing `lanTopologyTrust` with a
real `devices.libp2p_peer_id` check now that T162 makes peer ids stable. After that, T210 (record +
namespace) before T209 (the Worker), since the Worker's API depends on the record contract.
