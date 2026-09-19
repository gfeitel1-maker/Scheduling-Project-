---
title: "Per-camp genesis identity for T202's re-pair gap — recommendation"
document_type: adr
authority: normative
status: accepted
implementation_state: not_started
date: 2026-09-19
decided: 2026-09-19
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
supersedes: []
related_adrs:
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-09-08-flat-record-shape.md
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
  - docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md
  - docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md
  - docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md
related_tickets:
  - docs/work/tickets/T202-camper-record-purge-path.md
program: security-hardening
affects:
  - electron/automerge/campDocument.js
  - electron/automerge/purgeSupportCommand.js
  - electron/sync/automerge/syncNode.js
  - electron/sync/automerge/docStore.js
  - electron/sync/automerge/joinSession.js
  - SECURITY.md
---

# ADR: Per-camp genesis identity for T202's re-pair gap — recommendation

## Status

**Accepted, 2026-09-19.** The product owner accepted the recommendation to **defer**: T202 is closed
as-is (its current SECURITY.md disclosure and known-gap test stand as the accepted state), with this
ADR filed as the answer to "why not more." No follow-up ticket is opened now; if the work is ever
revived, this ADR's recommended shape (a `campId`-scoped epoch, **not** a per-camp Automerge genesis
root) is the starting point. The discovery/reconnect-tag semantics this originally left unverified
were **verified on 2026-09-19** (see the discovery bullet under blast radius), raising confidence in
that shape to ~80%. The owner also decided that a support/CLI-level
notice — in the spirit of `mcp__shoresh__check_projection_health` — is sufficient for the
"some devices have not caught up to a purge" case; **director-facing partial-rotation UX is not a
product requirement.**

_What follows is the recommendation as written before that decision._ No code changes accompany this ADR. Spun off from T202
(`docs/work/tickets/T202-camper-record-purge-path.md`), which shipped a working purge procedure but
left one documented gap: "nothing in code prevents an already-paired peer from reintroducing the
purged record via ordinary sync — `sharesGenesis()` is the only gate and cannot distinguish a purged
record from an ordinary one. Per-camp genesis rotation (the real fix) is deferred to a separate
ticket." This ADR is that separate ticket's answer.

## Context — what genesis actually is today

`electron/automerge/campDocument.js` defines `GENESIS_B64` (line 292): a single frozen base64
constant, identical for every camp, on every device, in every build since it was last regenerated.
`genesisDoc()` (294) clones it; `genesisRootHash()` (351) caches the hash of its first change at
module load; `sharesGenesis(doc)` (361) is true iff a document's first-change hash equals that one
global hash. `electron/sync/automerge/syncNode.js:192` refuses and silently drops any incoming
document that fails `sharesGenesis`.

**The load-bearing clarification this ADR makes explicit, because the ticket's own name
("per-camp genesis") obscures it: genesis today carries no camp identity at all.** It exists purely
to prevent the root-split bug documented at length in `campDocument.js:119–245` — two devices each
calling `A.from(shape)` mint different roots, and `A.merge` of two such roots silently drops one
side's entire collection. `sharesGenesis` answers "is this a well-formed document of this app's
current shape," not "is this a document of *this* camp." Camp identity is carried entirely by a
different, already-existing primitive: **`campId`**, which selects the on-disk file
(`docStore.js:10-11`, `docPath(userDataDir, campId)` → `<campId>.automerge`) and (per
`joinSession.js:7`'s own comment) the discovery tag a joining device uses to find a host
(`campDiscoveryTag(campId)`). Every device on the planet, for every camp, shares one genesis root;
what makes device A and device B peers *of the same camp* is that they hold documents at the same
`campId`, paired through the camp-code flow — not shared genesis.

This matters because it reframes the actual gap. The problem T202 found is not "documents from
different camps can be confused with each other" (genesis was never doing that job, campId was).
It is: **within one campId, after a purge mints a new document lineage on some devices, a peer that
still holds the pre-purge lineage under the same campId is indistinguishable, at the admission
layer, from a legitimate peer of the current lineage** — because `sharesGenesis` only checks
"same app shape," which both the pre- and post-purge documents satisfy identically.

## Candidate approaches considered (divergent ideation, `adhd` skill)

Five parallel frames (regulator, hostile-attacker, inversion, remove-load-bearing-assumption,
3am-on-call) generated ~29 candidate ideas; clustering them by underlying angle:

- **Rotate a new per-camp identity primitive minted at purge time** (the ticket's literal proposal)
  — a fresh camp-scoped genesis root, transmitted and verified during pairing, checked at merge time
  instead of the global constant. `[N6 V5 F8]`. Real security surface: the attacker-frame branch
  flagged that a wire-transmitted, per-camp trust anchor is a **new** thing to forge/replay/roll
  back that the build-time-baked global constant never exposed (record-and-replay a mint handshake
  toward a different camp code; a compromised device caching the pre-rotation root and seeding a
  rogue partition of stale peers; passive fingerprinting of which camps are talking to which IPs if
  the raw root is sent in the clear). Every exploit has a countermeasure (nonce-bound signed mint,
  signed revocation broadcast, HMAC-commitment instead of the raw hash, synchronous revocation
  lookup, distrust-by-default after a disconnection window) — but each countermeasure is itself new
  code, in the security-critical admission path, that does not exist today.
- **Epoch/generation counter riding on an existing identity primitive, not a new one** — bump a
  monotonic per-camp counter on purge; peers present their last-known value; a stale or regressed
  epoch is refused. `[N7 V8 F8]` ★. This is the convergence point of the inversion and
  remove-load-bearing-assumption branches ("genesis is irrelevant, admission control is the real
  lever"; "purge becomes a property of TIME... merge logic refuses anything timestamped/epoched
  before the receiver's last-known epoch"). Critically, this project already has an identity
  primitive that is genuinely per-camp and already flows safely through pairing, discovery, and
  storage: **`campId`**. An epoch does not need to be a *new* transmitted trust anchor if it is
  encoded into (or alongside) the thing already doing camp-scoping — see Approach below.
- **Solve it at the storage-lifecycle/liveness layer instead of the identity layer** — periodic
  "prove liveness / re-fetch a purge-manifest" checks, or a TTL past which a silent device must
  re-earn trust before merging. `[N5 V4 F6]`, trap: adds an always-on freshness protocol for a
  problem that only manifests at the rare moment of a purge; ongoing operational cost for a
  point-in-time event.
- **Redefine "erasure" itself rather than changing identity** — CRDT history is provably
  append-only forever, so treat "gone" as "no projection ever shows it again" (tombstone-and-filter)
  rather than "removed from every possible copy of the document." `[N8 V6 F4]`, trap: this
  contradicts what T202/SECURITY.md have already told the owner and any external party ("per-record
  erasure from document history is not possible without a whole-document reset") — reframing erasure
  to dodge the hard problem is a compliance-facing regression, not a fix, the moment a director or
  auditor asks "is it *actually* gone."
- **Do nothing now; treat as an ops/documentation item** — a scheduled stale-replica quarantine sweep,
  or simply not building until a second incident class justifies the investment. `[N4 V9 F7]`.
  Directly actionable today at zero engineering risk; T202 already documents the gap honestly in
  SECURITY.md, which is itself most of what a regulator-frame branch asked for (a traceable,
  human-reviewable statement of the limit, not silence).

**Traps flagged and excluded:** wholesale re-definition of "erasure" (compliance regression);
an always-on liveness/freshness protocol (solves a point-in-time problem with permanent
infrastructure); minting the new identity as an over-the-wire value transmitted like a password
(new spoofing/replay/fingerprinting surface for a problem that has a same-cost alternative that
avoids it entirely, below).

## Approach — and the recommendation

**Recommendation: DEFER building any camp-scoped identity-rotation mechanism now. If/when this is
picked up, the target design is an epoch riding on the existing `campId` primitive, not a new
Automerge-genesis-per-camp primitive transmitted over the wire.**

### Why defer, not build now (primary recommendation)

1. **Pre-production, confirmed 2026-09-17: no live camps on the sync engine.** The exact condition
   every prior genesis regeneration leaned on to be "free" (`campDocument.js:161-207`) still holds.
   T202 already shipped the honest, cheaper mitigation available today: purge is real on the
   purging device, the gap is disclosed in SECURITY.md in plain language, and the "known gap" test
   in `purgeSupportCommand.test.js` proves rather than hides the limitation. That is a legitimate,
   already-shipped stopgap — not a placeholder pretending to be a fix.
2. **The 3am-on-call branch's operational objection is real and unanswered by either identity
   design.** Whichever primitive rotates, a partial rotation across a multi-device fleet (some
   devices ack, one is asleep in a drawer) creates exactly the support burden T202's own scope note
   deferred: "Preserving/re-establishing keys across a purge is explicitly out of scope here —
   tracked as a follow-up ticket, not attempted in this slice." Building the identity-rotation
   mechanism without also building the fleet-coordination/UX around it (a director-visible
   "did every device re-pair" state) ships half a feature that looks complete and is not.
3. **No second incident class currently motivates it.** T202's own exit condition is met without
   this: "the limits are written down honestly in SECURITY.md... per-record erasure from document
   history is not possible without a whole-document reset" is already true and already documented.
   Building the rotation mechanism now is investing in a real gap with a known, accepted, and
   disclosed workaround, ahead of the point where a live camp makes the workaround unacceptable.
4. **Confidence this can be revisited cheaply later.** Nothing about deferring forecloses the
   design below — `campId` already exists and already does per-camp scoping; adding an epoch to it
   later is additive, not a redesign of anything shipped today.

### If/when built: campId-scoped epoch, not a new genesis-per-camp primitive

Do **not** make Automerge's genesis (`GENESIS_B64`/`genesisRootHash`/`sharesGenesis`) per-camp. That
mechanism's entire job is "prove this document has the app's current shape," a property that is
correctly identical across every camp and every device — turning it into a camp-scoped, mintable,
wire-transmitted value repurposes a shape-validity check into an access-control primitive it was
never designed to be, and hands an attacker a new thing to forge (see the attacker-frame findings
above) for no capability the app doesn't already have through `campId`.

Instead:

1. **Add a monotonic epoch to the thing that already carries camp identity.** `campId` already
   selects the on-disk path (`docStore.js`'s `docPath`) and, per `joinSession.js`, the discovery tag
   used to find a host. A purge advances that camp's epoch (e.g. a suffix or a companion value
   persisted alongside the `camps` row) and the fresh document is stored/discovered under the new
   epoch's identity. Devices still advertising or seeking the old epoch's discovery tag simply never
   find a peer to sync with — the reintroduction is prevented by absence of a rendezvous, not by a
   document-level trust decision made after two peers have already connected.
2. **Defense in depth at the merge layer**, for the case where two devices *do* end up connected
   despite the above (e.g. a cached rendezvous record, a manual reconnect): a per-camp epoch value
   written into the document itself (a new, non-conflicting genesis-collection field, following the
   existing `field_author`/`field_provenance` pattern) that `syncNode.js`'s merge path checks
   alongside `sharesGenesis` — reject a merge from a document whose recorded epoch is behind the
   receiving device's own. This reuses `sharesGenesis`'s existing shape (a cheap comparison before
   `A.merge`, refuse-and-drop on failure) rather than inventing new admission-gate machinery.
3. **No new secret crosses the wire.** `campId` and its discovery tag already flow through the
   existing, already-reviewed camp-code pairing path (`docs/adr/2026-07-28-first-pairing-...md`,
   `docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md`,
   `docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md`). The epoch rides
   inside that already-trusted channel instead of requiring a parallel trust-establishment
   mechanism for a brand-new genesis-root value — closing the exact new attack surface the
   attacker-frame branch identified (replay toward a different camp code, passive fingerprinting of
   raw root values, a compromised device seeding a rogue stale-epoch partition).
4. **This still needs its own design pass before being built** — specifically, verifying (not
   assumed here) exactly how `authGate.js`/the discovery-tag lifecycle scope an *ongoing* sync
   session versus only the initial pairing handshake, and designing the fleet-coordination/ack UX
   the 3am-frame branch calls for. This ADR recommends the shape of the primitive, not a
   ready-to-build spec.

### Blast radius, if built (for the eventual Architect brief, not authorized here)

- `electron/automerge/campDocument.js`: `GENESIS_B64`/`genesisDoc`/`genesisRootHash`/`sharesGenesis`
  stay **unchanged** under this recommendation — they remain the one global app-shape check. A new,
  small, additive collection (e.g. `camp_epoch`) would need genesis-registering the same way
  `field_author` was (a sixth-style regeneration, subset-guard-enforced) — but that only applies if
  the epoch is carried *inside* the document; if it is carried by `campId`/discovery-tag naming
  instead, `campDocument.js` needs no change at all. This distinction is itself a design decision
  for whoever scopes the eventual work, not settled here.
- `electron/sync/automerge/syncNode.js:192`: the admission gate would gain one additional cheap
  check (epoch comparison) alongside `sharesGenesis`, same refuse-and-drop shape, same "sender is a
  legitimately admitted peer, the admission gate cannot catch this" note the existing comment
  already makes about the genesis check.
- `electron/automerge/purgeSupportCommand.js`: would gain the epoch-advance step, composed
  alongside its existing transaction (deletes + `seedAllFromSqlite` + genesis check), following the
  same "all inside one transaction, save only after commit" discipline already documented there
  (round-2 hardening, FIX1).
- `electron/sync/automerge/discovery.js`, `joinSession.js`, `docStore.js`, and the rendezvous path:
  **verified 2026-09-19 (was flagged unverified in the proposed draft).** `campDiscoveryTag(campId)`
  (`discovery.js:49`) is a *pure* function of `campId`, and the steady-state sync node scopes mDNS to
  it via `createMdnsDiscovery({ campId })` (`discovery.js:81`), re-derived each session — there is no
  persisted discovery tag and no persisted-peer direct redial in the steady-state node that bypasses
  discovery (`transport.js`/`main.js` show none). The only direct-dial-to-cached-address path is the
  join flow's optional `knownHostAddr` (`joinSession.js:148,220`), which is scoped to a single
  add-a-device attempt, not steady-state reconnect. **Consequence for the design:** folding an epoch
  into the discovery tag WOULD strand a stale peer at rediscovery on the shipped (LAN/mDNS) transport
  — mechanism (1) holds there. Two caveats, both now understood rather than open: (a) the WAN
  rendezvous transport (T209/T210) is not yet wired into `transport.js` — `internetRendezvousScan.js`
  is today only an egress *guard*, not a client — and its own design (ADR
  2026-09-18-rendezvous-record-encoding-and-namespace-rotation) already anticipates namespace
  rotation, so an epoch is compatible with it, not blocked by it; (b) discovery rotation is a
  *liveness* property, not an *authorization* one — a peer holding any cached multiaddr could still
  dial directly, so the merge-layer epoch check (point 2) is **required as defense-in-depth, layered
  with** (not chosen instead of) discovery rotation. The earlier framing of these as an either/or
  "which mechanism carries the property" question is resolved: both, layered.
- `SECURITY.md`: the "Camper-record purge" subsection (already added by T202) would need updating
  to state the epoch mechanism closes the re-pair gap, once built — until then, its current honest
  disclosure stands and needs no change from this ADR.
- **Not affected:** `electron/automerge/rebuildSupportCommand.js`, the schema (no migration; T202
  explicitly kept schema at v71), and every other `MODELED_ENTITIES`/`GENESIS_ENTITIES` entity —
  this recommendation is deliberately scoped away from touching the global genesis mechanism at all.

### `graphify` cross-check

Ran `graphify affected` for `genesisRootHash`, `sharesGenesis`, `createEmptyDoc`, and `GENESIS_B64`
against the main checkout's graph. Every dependent surfaced was already covered by direct reads of
`campDocument.js`, `syncNode.js`, and `purgeSupportCommand.js` above; no additional call site was
found via the graph that a `grep -a` pass over `electron/` for those four symbols did not already
show in the tool-search results earlier in this session. Per this project's own graphify caveats,
object-literal methods and `readFileSync`-string references are outside what the graph indexes —
the joinSession.js/authGate.js discovery-tag lifecycle flagged as unverified above is exactly the
kind of thing that would need a direct read, not a graph query, and this ADR says so rather than
asserting graph coverage it does not have.

## Reused vs. new

**Reused, if built:** `campId` (already the real per-camp identity primitive, already flows through
the existing camp-code pairing/discovery path); `sharesGenesis`'s refuse-and-drop admission shape
(a template for the epoch check, not itself changed); the `field_author`/`field_provenance`
genesis-collection pattern (if the epoch is carried inside the document); `purgeCamperRecord`'s
existing single-transaction discipline.

**Genuinely new, if built:** a per-camp epoch counter and its comparison at the admission gate; the
fleet-coordination/ack UX the 3am-frame branch calls for (nothing today tells a director which
devices have or have not caught up to a rotation). Nothing here is new *today* — this ADR
recommends deferring the whole thing.

## ADR required: yes

This decision — recommending against building a genesis-mutation mechanism now, and recommending a
specific alternative primitive (`campId`-scoped epoch) over the ticket's literal proposal
(camp-scoped Automerge genesis root) for when it is eventually built — is exactly the kind of
hard-to-reverse, non-obvious, real-tradeoff decision the constitution's ADR bar names. `campDocument.js`'s
own genesis mechanism is deliberately never regenerated casually (five prior regenerations, each
individually justified and dated in that file's comments); a reader six months from now must not
rediscover from scratch why "just make genesis per-camp" was rejected in favor of a smaller, already-
existing primitive, or re-litigate whether this was even worth building pre-production.

## Confidence and evidence

**Confidence: medium-high (~75%) on "defer now."** Evidence: T202's own shipped state already
satisfies its exit condition (documented limits, honest SECURITY.md disclosure, a "known gap" test
proving rather than hiding the gap); the owner's confirmed pre-production status
(2026-09-17) is the same condition every prior genesis regeneration relied on; no second incident
class currently exists to justify the investment.

**Confidence: high (~80%) on "campId-scoped epoch over genesis-per-camp, if/when built"
(raised from ~60% after the 2026-09-19 verification below).** Evidence: `campId` is independently
confirmed (by direct file read, not memory) to already be the per-camp identity primitive used for
storage (`docStore.js`) and discovery (`discovery.js:49,81`, `createMdnsDiscovery({ campId })`); the
attacker-frame divergence concretely named exploits specific to a *new*, wire-transmitted trust
anchor that a `campId`-riding epoch avoids by construction. The one fact previously flagged as the
capping unknown — how the discovery/reconnect layer treats tag freshness — was **verified on
2026-09-19** (see blast radius, discovery bullet): the tag is a pure function of `campId`, re-derived
each session with no persisted-tag or steady-state cached-peer-redial bypass, so discovery-namespace
rotation is a sound mechanism on the shipped transport, and the merge-layer epoch check layers under
it as defense-in-depth. Confidence is held at ~80% rather than higher only because the WAN rendezvous
transport is not yet wired in, so its interaction with an epoch is designed-for but not yet
exercisable.

## Open questions for Governor — resolved 2026-09-19

**Resolved by the owner (see Status above):** (1) T202 closed as-is, this ADR is the "why not more"
answer; no follow-up ticket opened now. (2) The reconnect/discovery-tag verification this originally
deferred was **done on 2026-09-19** (see the discovery bullet under blast radius and the raised
confidence) rather than left for a future scoping task. (3) Support/CLI-level notice is sufficient;
director-facing partial-rotation UX is not a product requirement. The original questions are kept
below for the record.

1. Does the owner want T202's ticket formally closed as-is (current SECURITY.md disclosure +
   known-gap test stands as the accepted state), with this ADR filed as the answer to "why not
   more," or does the owner want a follow-up ticket opened now (unscoped, like `T222-update-on-open`
   was for its own load-bearing gap) so the deferred work is tracked rather than forgotten?
2. If a follow-up ticket is opened: should its first task be the verification this ADR flagged as
   unresolved (`authGate.js`/discovery-tag reconnect semantics), ahead of any design or code, given
   that fact changes which of the two admission mechanisms (rendezvous-absence vs. merge-layer
   epoch check) actually carries the security property?
3. Is director-facing UX for "some devices have not caught up to a purge" a product requirement the
   owner wants scoped alongside the eventual mechanism, or is a support-only/CLI-level notice (in
   the spirit of `mcp__shoresh__check_projection_health`) sufficient given the camp-director
   audience this app serves?
