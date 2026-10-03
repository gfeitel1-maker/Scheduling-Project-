---
title: "T334 Slice 3 — DHT discovery (primary WAN path) design"
document_type: spec
authority: approved
status: superseded
task_class: security-auth
created: 2026-10-03
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, docs/adr/2026-10-02-signed-revocation-witness.md, SECURITY.md]
related_docs: [docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md, docs/work/security/2026-09-15-wan-dht-boundary-assessment.md, docs/adr/2026-10-02-distributed-revocation-authority.md, docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md, docs/work/security/2026-10-03-t334-dht-capability-assessment.md, docs/work/specs/2026-10-03-cross-network-discovery-options-menu.md]
archive_when: superseded — see status
---

# T334 Slice 3 — DHT discovery design

**SUPERSEDED/REJECTED (2026-10-03, owner decision — historical, not current).** The owner rejected
the public-DHT cross-network path this design wires, verbatim: *"no. i do not accept this."* The
"Amendment 2026-10-03" section of
`docs/adr/2026-10-02-wan-discovery-transport-ladder.md` is the current authority: the public DHT is
dropped from the ladder entirely, replaced by remembered-address reconnect + NAT hole-punch as the
primary cross-network path, with Cloudflare rendezvous kept as the rare fallback. The dormant,
gated code this design produced (`electron/sync/automerge/dhtDiscovery.js`, `dhtEnabled: false`,
`kadDht`/`bootstrap` rows still `signoff: null` in `transportCapabilities.js`) is not activated and no
further work proceeds against this document. It is kept, not deleted, as the historical record of the
design that was built dormant and then rejected before activation — do not pick this up as a current
spec.

---

_Everything below this line is the original, now-superseded design, preserved for historical
reference._

**Status: prerequisite closed (2026-10-03) — organizer-approved.** T335 (merged `4a9c4020`) shipped
the signed, rotating discovery tag §0 originally found missing. Everything below is the design Maker
executes directly; §4's strict capability-gate sequence (signoff withheld until the security+battle-test
gate passes, including the HARD live-rotation acceptance criterion at the bottom of this doc) is
unchanged and still governs when the DHT actually activates for a running camp.

## §0 — Prerequisite check: the signed rotating discovery tag is now SHIPPED (T335, merged 4a9c4020)

The ADR's own build plan (`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`, "Reordered build
plan") made Slice 3 depend on a rotating discovery tag firing automatically on revocation —
*"Prerequisite for the DHT being safe to open."* This design doc originally found that prerequisite
unshipped (the frozen `claude/t329-ephemeral-join-secret-rotation` attempt, failed by
`docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md` for F1-F3: an unsigned,
peer-writable `campEpoch` LWW scalar that any paired device — including a revoked one — could forge,
checked receive-side only, with no forged-epoch/resync-to-parity test coverage).

**T335 closed this gap with a different, signed mechanism — verified in code 2026-10-03:**

- `electron/automerge/authorityRevocationDigest.js` (`revocationDigest`) computes a deterministic,
  sorted, JSON-encoded SHA-256 digest of `currentRevokedDeviceIds` (`electron/automerge/authorityReplay.js:383`),
  which is gated by the same `createVerifiedEntryTrust` (`authorityReplay.js:361`) signature
  verification the T331/T332 merge-layer projector already uses to accept `camp_authority_log`
  entries. The revoked-device set this digest covers is therefore **signed**, not a peer-writable
  scalar — F1's root cause (an unsigned field anyone could write) does not exist in this design.
- `electron/sync/automerge/rotatingDiscoveryTag.js` (`rotatingDiscoveryDigest`) derives
  `HMAC-SHA256(campDhtSecret, revocationDigest)` — a pure, total function of already-present document
  state (no document write, no network call, no wall-clock dependency). Because the tag is a pure
  function of the *signed* revocation set, F2's root cause (a receive-side-only gate a still-connected
  revoked device can out-wait) does not apply here either: the tag itself changes the instant the
  signed revocation set changes, for every device computing it.
- `electron/sync/automerge/discovery.js` (`rotatingServiceTag`) and
  `electron/sync/automerge/syncStarter.js` (`computeRotatingServiceTag`) wire this into production
  mDNS discovery today: `syncStarter.js:318` calls `mintRendezvousNamespace` once at startup (idempotent
  — a camp that already minted a `campDhtSecret` in a prior run is a no-op) to guarantee the secret
  exists, and `syncStarter.js:324` keys `createMdnsDiscovery`'s `serviceTag` off
  `computeRotatingServiceTag(doc, campId)` rather than the old static, campId-hashed
  `campDiscoveryTag` (`discovery.js`'s `campDiscoveryTag` function still exists but is no longer what
  `syncStarter.js` uses for the live mDNS tag).
- Note the precise mechanism T335 used, since it differs from what this doc originally expected:
  `mintRendezvousNamespace` now has a real production caller (`syncStarter.js:318`, minting the
  `campDhtSecret` HMAC key) — but `rotateRendezvousNamespace` still has zero production callers, and
  that is correct, not a gap. T335 does not rotate the stored namespace value itself; it derives a
  tag that is already a pure function of the signed revocation set, so the tag "rotates" automatically
  as that set changes, with no separate rotation-trigger write needed.

**Documented residual (carried forward, not reopened by this closure):** T335 accepted a
restart-bounded limitation on the LAN/mDNS path specifically — a running device keeps the mDNS
`serviceTag` it computed at startup until it restarts, because `@libp2p/mdns` captures `serviceTag` by
value at construction. **That acceptance does not extend to the DHT** — see the HARD acceptance
criterion carried from T335 at the bottom of this document, which requires this slice to implement
*live* re-keying (no restart needed) precisely because the DHT's safety argument depends on it.

**Consequence for this design.** The ADR's tier-2 safety argument — *"the rotating secret means the
public DHT only ever holds opaque, short-lived, un-impersonable provider records"* — now rests on a
real, signed, rotating primitive rather than an unwired placeholder. The "build now vs. block on a
redesign" dilemma this doc originally posed to Governor (§8.1/§8.2 below) is resolved: the prerequisite
is done, so Maker builds the DHT wiring in §1-§6 directly against `rotatingDiscoveryDigest`. The strict
gate sequence in §4 — packages and wiring land with `signoff: null`, security+battle-test gate runs,
only then does a follow-up PR flip `signoff` and activate the capability — is unchanged and still the
correct discipline; closing the prerequisite does not shortcut that sequence.

## Candidate approaches considered

Closed case for the wiring shape itself — the ADR already fixed it (`provide`/`findProviders` under
`@libp2p/kad-dht`, slotted into `syncStarter.js`'s existing `peerDiscovery` array, bootstrap nodes
from the public network by default). The one place a genuine option existed (bootstrap node source)
was already decided by the ADR with recorded rationale ("option 1 as the default, option-3
configurability", confidence medium) and is carried forward unchanged in §2 below rather than
re-litigated. Divergence was originally spent on **§0** — at the time of writing, the real open
question was not "how should the DHT be wired" (settled) but "is it safe to wire it at all yet". T335
has since closed that question (§0, updated 2026-10-03): the prerequisite is shipped, so this doc's
remaining content is the settled wiring design with no open sequencing question left to diverge on.

## §1 — Reused vs. new

**Reused, unchanged:**
- `electron/sync/automerge/syncStarter.js`'s `peerDiscovery` array (`:295-345`) — DHT discovery is a
  third entry alongside the existing mDNS (`createMdnsDiscovery`) and rendezvous
  (`createRendezvousDiscovery`) entries, same array, same shape.
- `electron/sync/automerge/rotatingDiscoveryTag.js` — `rotatingDiscoveryDigest` is the read path the
  DHT keys off (per §0, now shipped by T335); no new namespace-storage or rotation-trigger primitive
  is needed.
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

- Keyed on **the rotating discovery tag**, `rotatingDiscoveryDigest(automerge, doc, campId, opts)`
  (`electron/sync/automerge/rotatingDiscoveryTag.js`, shipped by T335) — never on `campId` directly,
  and never on a raw namespace. That function throws if no `campDhtSecret` has been minted yet for
  the camp, mirroring the no-silent-fallback contract `syncStarter.js` already relies on for mDNS; the
  caller mints via `mintRendezvousNamespace` first (same idempotent call `syncStarter.js:318` already
  makes), exactly as the mDNS wiring does today. This is the deliberate safe-closed state, not an
  error path.
- The DHT key used for `provide`/`findProviders` is the rotating digest itself (already
  `HMAC(campDhtSecret, revocationDigest)`, truncated hex) — opaque, un-impersonable, and a pure
  function of the signed revoked-device set, consistent with the "opaque, un-impersonable provider
  records" property the ADR's safety argument requires. `findProviders` on the current digest only;
  the previous digest is never looked up, so a device that missed a revocation-set change (was
  revoked, or offline) cannot find current peers by replaying a stale key — it must resync via
  mDNS/LAN or Cloudflare fallback first.
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
   checklist) plus, per the bottom "HARD acceptance criterion carried from T335" section, confirming
   live (not restart-bounded) re-keying against T335's shipped rotation mechanism.
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
established (T288). The sequencing tradeoff this document originally flagged (build Slice 3's wiring
with signoff withheld, vs. blocking on a prerequisite redesign first) is resolved by T335's merge —
see §0 — and needs no ADR of its own: the still-open capability-gate sequence in §4 (signoff withheld
until the security+battle-test gate passes) remains the governing discipline Maker follows.

## §8 — Open questions for Governor (product/owner decisions, not technical ones)

1. **RESOLVED by T335 (merged 4a9c4020).** §0's "path 1 vs. path 2" question — block on a Slice-2
   redesign first, or build Slice 3 now with activation gated — is moot: T335 shipped the signed
   rotating-tag prerequisite directly, so Maker builds against it with no owner choice between paths
   required. Kept here, struck rather than deleted, so the history of why this mattered is not lost.
2. **RESOLVED by T335 (merged 4a9c4020).** "Who redesigns the failed rotation trigger, and when" is
   moot — T335 is that redesign, already reviewed and landed (bound to the signed T331/T332 revocation
   witness via `authorityRevocationDigest.js`/`currentRevokedDeviceIds`, per §0 above), not a future
   Architect pass.
3. **Confirm the bootstrap-node default (public libp2p/IPFS network) against current operational
   reality — a verify-at-pickup technical check, not an owner question by default.** Per the
   organizer's 2026-10-03 ruling, Maker/Verifier records this as a pickup-time check in the gate
   evidence under `docs/work/security/`: is the public bootstrap network still healthy/available
   enough to depend on as the default. **Only an unhealthy result escalates** — if the public network
   is not dependable, the public-bootstrap default itself comes into question and a Shoresh-run
   bootstrap node is a real spend/infra decision (per §2's "OWNER SPEND/INFRA FLAG"), which does need
   organizer→owner routing. A healthy result requires no escalation and is simply recorded as
   evidence.

## HARD acceptance criterion carried from T335 (organizer ruling 2026-10-03) — LIVE rotation on the DHT

T335 accepts a restart-bounded discovery-tag rotation on the LAN/mDNS layer (an obscurity gap bounded by T331 auth; see T335 design + SECURITY.md). **That acceptance does NOT extend to the DHT.** This slice (T334) MUST implement LIVE discovery-tag rotation: when a device is revoked while the node is running, its DHT discoverability under the camp's tag must be cut off without a process restart (the public-DHT safety premise — brute-force-safe + cut-off-on-revocation — depends on the key actually turning live). This is a non-negotiable acceptance criterion:

- The DHT provide/findProviders must re-key on the current rotating tag when the revocation set changes (DHT state travels over a persistent connection / re-provide cycle, unlike the one-time mDNS UDP service-tag constant — so live re-keying is achievable and testable here).
- Red Hat + Security MUST re-confirm, as part of this slice's capability + battle-test gate, that a revoke-while-running actually cuts the revoked device off over the DHT (not restart-bounded). A red-before-green test is required.
- This requirement cannot be quietly dropped or deferred; it is why the LAN restart-bounded limitation was acceptable (the real cut-off happens here).

### Implementation cost note (carried from T335 Red Hat re-gate)

The T335 signature-gated tag derivation (`createVerifiedEntryTrust` → full `camp_authority_log` replay + one ed25519 verify per entry) runs exactly ONCE at process start, so cost is a non-issue on the LAN/mDNS path. T334's live rotation recomputes the tag whenever the revocation set changes — if that reuses the full-replay-plus-per-entry-verify pattern on EVERY DHT re-key tick, it could become costly at a large authority-log size. The T334 implementation should recompute incrementally / memoize the verified revocation set per converged document state (re-verify only new entries), not re-replay the whole log on every tick. Red Hat + Security to confirm the live-rotation cost is bounded as part of this slice's gate.
