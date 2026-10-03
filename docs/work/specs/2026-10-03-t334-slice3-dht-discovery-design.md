---
title: "T334 Slice 3 — DHT discovery (primary WAN path) design"
document_type: spec
authority: proposed
status: draft
task_class: security-auth
created: 2026-10-03
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, docs/adr/2026-10-02-signed-revocation-witness.md, SECURITY.md]
related_docs: [docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md, docs/work/security/2026-09-15-wan-dht-boundary-assessment.md, docs/adr/2026-10-02-distributed-revocation-authority.md]
archive_when: Slice 3 is implemented, security+battle-test gate recorded, kadDht/bootstrap signoff entries added
---

# T334 Slice 3 — DHT discovery design

**Status: blocked on a prerequisite gap found during this design pass — see §0.** Everything past
§0 is the design Maker would execute once that gap is resolved; none of it should start before
Governor routes §0 to the owner.

## §0 — Prerequisite check: Slice 2 is NOT done (this blocks Slice 3 as the ADR itself defines it)

The ADR's own build plan (`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`, "Reordered build
plan") makes Slice 3 depend on Slice 2: *"Prerequisite for the DHT being safe to open."* Slice 2 is
the rotating, scrypt-derived discovery tag firing automatically on revocation — the mechanism the
ADR's whole safety argument for a public DHT rests on ("How the already-built keys make a public DHT
safe").

**Slice 2 is not shipped.** It was attempted on branch `claude/t329-ephemeral-join-secret-rotation`
(commit `9f120797`), and a security-assessment review failed it and froze the branch (commit
`41e7f142`, `docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md`). The three
disqualifying findings:

- **F1 (CRITICAL):** the merge-layer `campEpoch` field is an unsigned, peer-writable LWW scalar
  (`campEpoch.js:27-41`, gate at `syncNode.js:250-261`) — any paired device, including a revoked one,
  can write an arbitrarily high epoch and pass the gate.
- **F2 (CRITICAL):** the gate is receive-side only; a still-connected revoked device reaches epoch
  parity through ordinary bidirectional sync and then merges freely — "even an entirely honest
  revoked device defeats the gate simply by staying connected."
- **F3 (HIGH):** the committed battle-test exercises only an honest, stale, forked-from-genesis
  adversary; the forged-epoch and resync-to-parity cases the ADR's own acceptance criteria demand
  (ADR §4: "forged-peer writes... replay... a red-before-green proof that rotation-on-revocation
  actually cuts a removed device off") were never tested, and under the current design both would
  stay green.

The assessment's explicit conclusion: *"Slice 3 (DHT) must not be signed off on the premise that
Slice 2 closed it."*

**What this means concretely for today's codebase (post-T328/T331/T332, verified by grep):**

- `electron/sync/automerge/rendezvousNamespace.js` — `mintRendezvousNamespace` / `rotateRendezvousNamespace`
  — has **zero production callers**. Nothing mints a namespace when rendezvous is enabled; nothing
  rotates it on device revocation. It is a tested, correct primitive sitting unwired (confirmed by
  `grep -rn "rotateRendezvousNamespace\|mintRendezvousNamespace" electron src`, matches only the
  module's own file and its test).
- T331/T332 (the merged distributed-revocation + client-admin-minting work) implemented the
  **merge-layer authorization half** (`camp_authority_log`, the signed revocation witness ADR) —
  a different, and per the signed-witness ADR (`2026-10-02-signed-revocation-witness.md:264-276`)
  independently-sound, mechanism. That ADR explicitly treats namespace/epoch rotation as a separate
  *liveness/discoverability* layer that "stays, unchanged" — it does not claim to have wired it, and
  says authorization must not rest on it alone. So T331/T332 did not silently absorb Slice 2; Slice 2
  remains a distinct, unshipped, previously-failed piece of work.
- `electron/sync/automerge/syncStarter.js` still derives its mDNS tag from the static, campId-hashed
  `campDiscoveryTag` (`discovery.js:49-51`) and its rendezvous namespace from whatever
  `readRendezvousNamespace` finds — which today is **nothing**, because nothing mints it. The
  Cloudflare rendezvous path (`SHORESH_RENDEZVOUS_URL`-gated) is therefore currently a no-op in
  practice for any camp that hasn't had some other code path mint a namespace — a separate finding
  worth flagging to Governor but outside this ticket's scope.

**Consequence for this design.** The ADR's tier-2 safety argument is: *"the rotating secret means the
public DHT only ever holds opaque, short-lived, un-impersonable provider records."* That argument
requires (a) a namespace that actually exists and is actually minted when rendezvous/DHT discovery is
enabled, and (b) that namespace actually rotating, in a way an adversary cannot forge, when a device
is revoked. Neither holds today. Wiring `provide`/`findProviders` under `readRendezvousNamespace`'s
output right now would key the DHT off a value that is either `null` (DHT discovery silently never
activates — the safe failure) or, once something mints it, a namespace that **never rotates on
revocation** (F1/F2's root cause: no production trigger exists at all, forged or not) — i.e. exactly
the deterministic, non-rotating key the 2026-09-15 assessment identified as the original hazard this
whole ladder exists to close.

**Recommendation to Governor: this is a stop, not a design problem to route around.** Two honest
paths, both product/security decisions above this document's authority:

1. **Treat "Slice 2, redesigned to close F1-F3" as a hard prerequisite sub-slice of T334**, done
   test-first with Security + Red Hat before any DHT package is installed. The redesign direction the
   failed assessment already points at: bind the rotation witness to `host_signing_key` (or reuse the
   T331/T332 signed revocation-witness primitive directly, since it is the mechanism that already
   passed its own gate) instead of inventing a second, unsigned epoch field — rotate the discovery
   *namespace* as a side effect of the already-signed revocation witness landing, not as an
   independent unsigned counter.
2. **Ship Slice 3's wiring code now, test-first, but keep `kadDht`/`bootstrap` signoff at `null` and
   gate activation on a namespace that is provably rotating** — i.e. build everything below, prove it
   against the mDNS-parity and tag-rotation-invalidation test seams using a **test-only** namespace
   rotation trigger, and treat "wire the real, signed rotation trigger into production" as the actual
   gating item the security+battle-test pass (§5) must close before `signoff` is ever set. This is
   defensible because `transportCapabilities.js`'s registry already enforces that no package/wiring
   alone opens the capability — only a `signoff` entry does, and that entry is explicitly withheld
   until the gate passes (§4). Under this path Slice 3's code can be built in parallel with the
   redesigned rotation trigger, which de-risks the schedule without ever exposing a live camp.

Both paths converge on the same technical design below for the DHT wiring itself; they differ only in
whether the rotation-trigger redesign is a blocking predecessor ticket or a parallel one that must
land before `signoff` (not before code). **This document assumes path 2** (build now, gate
activation), because it lets Maker start without reopening Slice 2's failed design, and flags the
choice as the one open question Governor must take to the owner (§6).

## Candidate approaches considered

Closed case for the wiring shape itself — the ADR already fixed it (`provide`/`findProviders` under
`@libp2p/kad-dht`, slotted into `syncStarter.js`'s existing `peerDiscovery` array, bootstrap nodes
from the public network by default). The one place a genuine option existed (bootstrap node source)
was already decided by the ADR with recorded rationale ("option 1 as the default, option-3
configurability", confidence medium) and is carried forward unchanged in §2 below rather than
re-litigated. Divergence was spent instead on **§0** — the real open question this pass surfaced is
not "how should the DHT be wired" (settled) but "is it safe to wire it at all yet" (not settled),
which is a prerequisite-sequencing question, not a design-shape one.

## §1 — Reused vs. new

**Reused, unchanged:**
- `electron/sync/automerge/syncStarter.js`'s `peerDiscovery` array (`:295-345`) — DHT discovery is a
  third entry alongside the existing mDNS (`createMdnsDiscovery`) and rendezvous
  (`createRendezvousDiscovery`) entries, same array, same shape.
- `electron/sync/automerge/rendezvousNamespace.js` — `readRendezvousNamespace` is the read path the
  DHT keys off; no new namespace-storage primitive is needed, only (per §0) a real production writer.
- `electron/sync/automerge/transportCapabilities.js` — the capability-gate mechanism is exactly
  right for this; no change to its shape, only two new rows already present (`kadDht`, `bootstrap`,
  both currently `signoff: null`).
- The `{id, multiaddrs}` discovered-peer shape and everything downstream of it
  (`mutualAuth.js`, admission, `authorize()`) — a DHT-discovered peer must produce byte-identical
  objects to mDNS/rendezvous discovery, so nothing downstream changes at all.

**New:**
- `electron/sync/automerge/dhtDiscovery.js` — thin wrapper around `@libp2p/kad-dht`'s
  `provide`/`findProviders`, parallel in shape to `discovery.js` (mDNS) and `rendezvousClient.js`
  (HTTP rendezvous): given a namespace (not campId — see §0), periodically `provide` this node's own
  record and `findProviders` for the camp's current tag, emitting discovered peers in the same
  `{id, multiaddrs}` shape the other two discovery sources use.
- A bootstrap-node list constant (public libp2p/IPFS bootstrap multiaddrs), with a `SHORESH_DHT_BOOTSTRAP`
  env/config override for a camp that wants to pin its own, mirroring the `SHORESH_RENDEZVOUS_URL`
  override pattern already established for the Cloudflare path.
- Two `TRANSPORT_CAPABILITIES` rows gain real `packages`/`sourceMarkers` entries (they already exist
  as placeholders — `kadDht` and `bootstrap`, `transportCapabilities.js:70-81`); no new row is added.

## §2 — The DHT wiring design

**Module: `electron/sync/automerge/dhtDiscovery.js`.**

```
createDhtDiscovery({ campId, doc, libp2pNode, bootstrapList, intervalMs }) -> peerDiscovery service
```

- Keyed on **the rotating discovery tag**, read the same way `rendezvousClient.js`'s tick loop reads
  it today (`rendezvousClient.js:142`, `readRendezvousNamespace(doc(), campId)`), never on `campId`
  directly. If `readRendezvousNamespace` returns `null` (rendezvous/DHT never enabled for this camp,
  or — per §0 path 2 — the rotation trigger isn't wired yet in a given build), the service is a
  documented no-op: it issues no `provide`, no `findProviders`, and emits no discovery events. This
  is the deliberate safe-closed state, not an error path — exactly how a camp with
  `SHORESH_RENDEZVOUS_URL` unset degrades today.
- The DHT key used for `provide`/`findProviders` is `sha256(namespace || ':' || epoch)` (not the raw
  namespace) — hashed, not published in the clear, so a passive public-DHT observer sees only an
  opaque CID-like key, consistent with the "opaque, un-impersonable provider records" property the
  ADR's safety argument requires. `findProviders` on the current epoch's key only; an old epoch's key
  is never looked up, so a device that missed a rotation (was revoked, or offline) cannot find current
  peers by replaying a stale key — it must resync via mDNS/LAN or Cloudflare fallback first.
- `provide` and `findProviders` run on the same tick interval already established for rendezvous
  (`rendezvousClient.js`'s tick loop pattern) — reuse that interval constant rather than inventing a
  second one.
- **Parity requirement (hard):** every discovered peer this module surfaces is shaped
  `{ id: PeerId, multiaddrs: Multiaddr[] }`, identical to what `@libp2p/mdns` and
  `createRendezvousDiscovery` already emit into `peerDiscovery`. No camp-membership, trust, or
  authorization data rides on the DHT event — that is `mutualAuth.js`'s job, unchanged. This is the
  org-interface-contracts requirement for this seam: the DHT widens *who gets a dial attempt*, it
  changes nothing about who is *admitted*.
- `syncStarter.js` change (`:295`, additive): `peerDiscovery = [mdns, ...(rendezvous.enabled ? [rendezvousDiscovery] : []), ...(dhtEnabled ? [dhtDiscovery] : [])]`. `dhtEnabled` is a new local gate — see §4 — never the bare presence of the `@libp2p/kad-dht` package.
- Ladder ordering (ADR's "never races tiers"): this slice does **not** implement the ladder's
  sequencing logic (that's Slice 5, demoting Cloudflare to fallback). For Slice 3, DHT and rendezvous
  both run as additive `peerDiscovery` sources, same as mDNS+rendezvous do today — libp2p's own
  discovery/dial machinery already dedupes a peer discovered twice. Explicit non-goal, stated so
  Maker doesn't accidentally build Slice 5's ordering logic here.

**Bootstrap nodes (`bootstrap` capability).** Per the ADR's own recommendation (confidence: medium,
carried forward unchanged — not re-decided here): the public libp2p/IPFS bootstrap network is the
default bootstrap list, hard-coded as a constant (the standard public bootstrap multiaddrs), with a
`SHORESH_DHT_BOOTSTRAP` comma-separated multiaddr override for camps wanting independence (mirrors
`SHORESH_RENDEZVOUS_URL`'s override pattern). **Clean degradation:** if no bootstrap node is
reachable, `@libp2p/kad-dht` fails to join the ring and this module's `provide`/`findProviders` calls
simply never find anything — the node falls back to LAN mDNS (and Cloudflare, if enabled), with no
crash and no retry storm. This must be an explicit test case (§5).

**OWNER SPEND/INFRA FLAG:** nothing in this design stands up any Shoresh-run infrastructure. The
public bootstrap network costs nothing to depend on; it is not something Shoresh deploys, pays for,
or operates. If a future camp wants option-3 independence (its own pinned bootstrap nodes), *standing
those up* is an owner spend/infra decision exactly as the ADR already flags for Cloudflare/relay — out
of scope for Maker to decide or build toward speculatively.

## §3 — Schema

**No schema change.** Confirmed: the DHT key is derived in-memory from the existing
`rendezvousDiscovery` document field (`camps` entity, `rendezvousNamespace.js`) and `campId`; no new
table, column, or document field. This *does* trip the Tier-4 capability guard (new npm packages:
`@libp2p/kad-dht`, `@libp2p/bootstrap`) — that is expected and correct; it is exactly the mechanism
the gate exists to catch, not a defect to design around.

## §4 — Capability-gate ordering (strict sequence Maker must follow)

1. **Packages + wiring land, build-blocked.** Maker adds `@libp2p/kad-dht` and `@libp2p/bootstrap` to
   `package.json`, writes `dhtDiscovery.js` and the `syncStarter.js` wiring, with full test coverage
   (§5). `TRANSPORT_CAPABILITIES.kadDht.packages`/`.sourceMarkers` and `.bootstrap`'s are filled in
   (they're placeholders today) but **`signoff` stays `null` on both.** `transportBoundary.guard.test.js`
   will fail red the moment the package/marker appears with no signoff — that red is the intended,
   correct state at the end of this step, proving the gate actually catches it. The PR that lands this
   step does not flip either `signoff` and does not merge past a red guard test — the guard test itself
   must be the thing Maker proves fails, then the capability stays inert at runtime (the `dhtEnabled`
   local flag from §2 defaults to false regardless of package presence) so the branch can exist without
   the guard blocking unrelated work — confirm with Verifier exactly how this repo's guard test is
   meant to be exercised red-before-green versus how CI's gate actually runs it (this is an
   org-interface-contracts question for Verifier/Governor, not resolved here).
2. **Security re-assessment + Security + Red Hat run against that landed-but-inert code** (§5's
   checklist) plus, per §0, against whatever the Slice-2 rotation-trigger redesign produced.
3. **Only after that gate passes**, a follow-up PR adds the two `signoff` entries
   (`{date, owner, doc}`, `doc` pointing at the recorded security+battle-test evidence under
   `docs/work/security/`) and flips `dhtEnabled` to the real runtime condition. This is the PR that
   actually activates the capability for a running camp; everything before it is dormant code.

## §5 — Security re-assessment checklist (security-assessment + Security + Red Hat, before signoff)

Per the ADR's table and the two things this design pass additionally surfaced:

1. **Join-secret brute-force against the public DHT** — re-benchmark the scrypt cost from
   `joinCode.js:58-68` against whatever's actually true at pickup time (org-source-verification: the
   112.7ms/guess figure is dated 2026-09-27 on a specific dev machine/Node version; re-measure, don't
   assume), confirm the ~3.5M CPU-year margin still holds for a public-DHT-wide offline attacker, not
   just the LAN threat model it was first sized against.
2. **The Slice-2 gap this pass found (§0) must be closed first or explicitly accepted as a deferred
   residual** — the security-assessment run for this capability must re-read
   `2026-10-02-t329-slice2-camp-epoch-assessment.md`'s F1-F3 and state plainly whether the redesigned
   rotation trigger (whatever form it takes) closes them, rather than silently re-using the frozen,
   failed design.
3. **DHT poisoning / eclipse / Sybil** — can an attacker who doesn't know the current tag still
   disrupt a camp's `findProviders` by flooding the DHT region near the hashed key, or by running
   enough Sybil nodes near that key to intercept/withhold legitimate provider records? Public-DHT
   eclipse attacks are a known class; the assessment must state the camp's actual exposure, not assert
   it away by analogy to the join-secret argument (which protects confidentiality of the key, not
   availability/integrity of lookups against it).
4. **Record replay** — can a captured provider record (multiaddrs + peerId) be replayed into the DHT
   after the camp has rotated past that epoch, to redirect a joiner toward a stale/malicious address?
   Confirm provider records expire (standard kad-dht TTL) within a window shorter than the rotation
   cadence, or that the self-certifying PeerId signature (already relied on elsewhere, per the ADR)
   makes a replayed record harmless because the attacker still can't impersonate the PeerId's keys.
5. **Metadata exposure of publishing to a public DHT** — the provider record reveals that *some* peer
   under this opaque key exists at these IPs, to any DHT participant that happens to be near that
   key-space region, even without knowing the camp. Confirm this is the same class of exposure already
   accepted for Cloudflare rendezvous (2026-09-27 Section 2) and not a materially larger one (DHT
   participants are globally distributed and uncontrolled, vs. Cloudflare being one operator — state
   which is actually worse and why).
6. **Slice-1 carry-forward (persisted-peer cached address + DHT)** — a revoked device must not become
   redialable over the DHT path using a `peer_last_addresses`-cached WAN address
   (the T328/Slice-1 assessment's own named residual). This is distinct from §0's rotation-trigger gap:
   even with a working rotation trigger, confirm the DHT-discovery code path in `dhtDiscovery.js`
   itself never short-circuits through a cached address instead of a fresh `findProviders` lookup —
   i.e. the cached-address reconnect logic (Slice 1) and DHT discovery (Slice 3) must be two
   independent paths, both subject to the revocation-eviction check at the admission layer
   (`authenticatedPeers`/`authorize()`), never one feeding the other a shortcut.

## §6 — Red-before-green test seams

1. **mDNS/DHT discovery-event parity** — same fixture peer, discovered once via mocked mDNS and once
   via mocked `findProviders`; assert the two events are structurally identical going into
   `mutualAuth.js`. Red state: a test that currently has no DHT path to compare against (write it
   failing first against a stub, then wire the real module).
2. **Tag-rotation invalidation** — a peer that minted a provider record under namespace/epoch N is not
   discoverable once the camp has rotated to N+1 (mock the DHT's findProviders to only return records
   keyed by the current hashed tag). Red: assert discoverability fails under the old tag before the
   rotation-aware lookup exists.
3. **Revoked-device-not-redialable-via-DHT** — combine with §5.6: a revoked device's provider record
   (minted before revocation) must not yield a connection that survives `authorize()`/admission, even
   if the record is still technically fetchable from the DHT's eventual-consistency window. Red:
   write the test assuming the naive "any discovered peer dials" path, show it would otherwise let a
   revoked device back in, then assert the admission gate (not discovery) is what blocks it.
4. **Clean degradation when bootstrap is unreachable** — no bootstrap node answers; assert no crash,
   no unbounded retry, and that mDNS/Cloudflare discovery continue to function normally in the same
   process.

## §7 — ADR required

**No.** This design does not introduce a new persistent data shape (§3: no schema change) and does
not change an existing contract other modules call (the `{id, multiaddrs}` peerDiscovery shape is
preserved exactly). It operates entirely within the ADR already accepted
(`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`) and the capability-gate mechanism already
established (T288). The one tradeoff decision inside this document — build Slice 3's wiring now with
signoff withheld, rather than blocking on a redesigned Slice 2 first (§0, "this document assumes path
2") — is a sequencing call for Governor/owner, not an irreversible architectural commitment; it does
not need its own ADR, but **must be recorded in the ticket and confirmed by the owner before Maker
starts**, per §6 below.

## §8 — Open questions for Governor (product/owner decisions, not technical ones)

1. **§0's core question: is "build Slice 3 code now, gate activation" (path 2) acceptable, or does the
   owner want the Slice-2 rotation-trigger redesign done and passed first (path 1)?** The owner's own
   acceptance language on the parent ADR ("battle test it... if it passes, then they can continue on")
   reads as capability-by-capability gating, which supports path 2, but the ADR's build-plan explicitly
   lists Slice 2 as Slice 3's prerequisite — this needs the owner's explicit confirmation, not an
   inference either way.
2. **Who redesigns the failed Slice 2 rotation trigger, and when relative to this ticket?** Candidate
   direction (bind rotation to the already-signed revocation witness from T331/T332 rather than a new
   unsigned field) is named in §0 but is itself a design decision for a future Architect pass, not
   decided here.
3. **Confirm the bootstrap-node default (public libp2p/IPFS network) against current, not
   2026-10-02-dated, operational reality** — is the public bootstrap network still healthy/available
   enough to depend on as the default, or has anything changed since the ADR's writing that the owner
   should know before this becomes the primary path for every camp's cross-network sync?
