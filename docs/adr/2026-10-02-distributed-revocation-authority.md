---
title: "Distributed-authority revocation: any admin signs, causal-ancestor validity, founder removable"
document_type: adr
authority: normative
status: accepted
date: 2026-10-02
decided: 2026-10-02
deciders: [product-owner]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
supersedes:
  - docs/adr/2026-10-02-signed-revocation-witness.md
amends:
  - docs/adr/2026-09-19-per-camp-genesis-identity.md
related_adrs:
  - docs/adr/2026-10-02-wan-discovery-transport-ladder.md
  - docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
  - docs/adr/2026-09-26-schema-version-gate-before-merge.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
related_docs:
  - docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md
related_tickets: []
implementation_state: not-started
affects:
  - electron/sync/automerge/syncNode.js
  - electron/sync/automerge/mutualAuth.js
  - electron/sync/automerge/transport.js
  - electron/automerge/projector.js
  - electron/automerge/campDocument.js
  - electron/automerge/rebuildSupportCommand.js
  - electron/automerge/purgeSupportCommand.js
  - electron/auth/deviceIdentity.js
  - electron/auth/deviceTrust.js
  - electron/auth/authorize.js
  - electron/db/schema.sql
  - electron/db/rollback/
  - SECURITY.md
---

# ADR: Distributed-authority revocation — any admin signs, causal-ancestor validity, founder removable

**Ticket:** T331. **Status: accepted (product owner, 2026-10-02).** This ADR **supersedes**
[`docs/adr/2026-10-02-signed-revocation-witness.md`](2026-10-02-signed-revocation-witness.md) (T330)
in full.

## Acceptance (product owner, 2026-10-02)

The owner accepted the two-tier quorum revocation model (relayed, verbatim): *"accept the above."*
The accepted model is:

- **Firing an ordinary (non-admin) device:** any **one** admin signs — immediate.
- **Firing an admin or the founder:** a **majority of the *other* admins** must agree (the target
  does not vote on its own removal). Threshold = `floor((N-1)/2)+1` over the N−1 other admins:
  **N=2 → the 1 other; N=3 → both others; N=4 → 2 of 3; N=5 → 3 of 4 — never all admins.**

Earlier owner rulings folded into this ADR and recorded below stand: the offline-at-the-instant-of-
firing residual is **accepted as bounded for v1**; the distributed admin-revoker is kept **separate**
from the Host-signed `users.role='admin'` for v1 (follow-up board item
`q-unify-admin-role-and-device-revocation`); and the existing purge-tombstone `host_signing_key`
single-host gap is a **separate follow-up** (`h-purge-survives-fired-founder`), out of scope here.

This is explicit current human instruction (Constitution Article I), recorded as the Article IV
acceptance. The implementation is built via the Maker through the full security + battle-test gate;
the ADR being accepted does not itself ship code or open any capability.

## Why T330 is superseded, not amended

T330 correctly fixed three mechanical defects in T329's revocation design (unsigned LWW scalar,
wrong enforcement path, non-monotonic under merge) by making the revocation witness **Host-signed**
— reusing `tombstoneSignature.js`'s exact shape, where only the device holding `host_signing_key`
can mint a valid entry.

**The product owner rejected that premise, not the mechanics.** Host-only signing reintroduces
exactly the central authority this app's Stage-6 cutover was built to remove. `docs/current/
PLATFORM_STATE.md` and this repo's root `CLAUDE.md` both state the cutover plainly: *"the table is a
device-local history ledger... it is not the replication mechanism"* and the app moved from a
"permanent Host process serving a socket" model to peer-to-peer Automerge/libp2p sync with **no**
standing host. `host_signing_key` is a single-row, single-device table
(`electron/db/schema.sql`, `CHECK (id = 1)` shape, confirmed by direct read of
`electron/auth/localAuth.js:278-299` and `electron/auth/deviceIdentity.js`'s own header comment
distinguishing it from the per-device identity key). Making revocation depend on it means: if that
one device is offline, lost, or is itself the device being fired, **no removal can ever be signed** —
the exact single point of failure the owner is rejecting, now moved from "host serves the socket" to
"host signs the witness." The scenario the owner gave is unambiguous: A, B, C, D are mutually
LAN-trusted; A is unavailable *or fired*; B↔C and C↔D must keep working, and A must be removable by
someone else. T330's design cannot do the second half of that if A happens to be the Host.

**What survives from T330, reused wholesale:** the *shape* of a signed, append-only, non-scalar
witness; the three enforcement points (handshake gate, per-sync-message gate, live teardown on
projection); the monotonic-under-merge argument for an append-only set versus an LWW field; the
carry-forward-through-purge/rebuild discipline; the `org-interface-contracts` checklist. None of that
is wrong — only "who may sign" is wrong. This ADR keeps T330's enforcement architecture and replaces
its trust root.

## Candidate approaches considered (divergent ideation, `adhd` skill)

Five parallel frames (regulator, biology, hostile-attacker, markets, remove-load-bearing-assumption)
generated ~29 raw ideas on two linked questions: *where does admin authority root, and how does a
receiver decide a signature counts.* Clustering by underlying angle:

- **Threshold/quorum authority** (regulator: "threshold-shared root secret split across founding
  devices"; attacker: "quorum co-sign before an op is even pending"; biology: "quorum-sensing
  concentration diffused through the DAG"). `[N6 V7 F5]`. **Rejected per explicit owner constraint**
  (any-admin-signs, not a committee) — kept below only as the named fallback if the causal-ancestor
  rule's residual (see "Hard cases" below) proves unacceptable to the owner later. Not built.
- **A single global sequencer / monotonic counter assigning order to authority events** (markets:
  "futures contract... expiry causal-height"; the literal `seq` field T330 used for tombstones).
  `[N3 V6 F6]` — **trap**: a single counter needs a single assigner, which is a host by another name.
  Rejected outright; replaced by using Automerge's own change-dependency DAG as the ordering, which
  requires no assigner at all.
- **Self-reported basis field, trusted at face value** (a device claims "I was admin as of op X").
  `[N2 V4 F3]` — **trap**: this is exactly the "self-report, not independently verified" failure
  class T330's own divergence already named and rejected for the handshake layer; a removed admin
  can self-report anything. Rejected.
- **Causal-ancestor validity over Automerge's real change-dependency graph** (regulator: "verifier
  walks the actual change DAG... not any field the document claims about itself"; biology: "thymic
  checkpoint... any signature matching a pattern never licensed is apoptosed before causal order is
  even consulted" / RNAi: "degrades as noise" if no matching live target; markets: "clearing rule...
  longest-unbroken-causal-descent... scoped to the admin sub-document"). `[N8 V8 F9]` ★. **Chosen.**
  Automerge's `deps` on every change is content-addressed and cryptographically chained — it cannot
  be forged, unlike a self-reported field — and it requires no sequencer, no quorum, and no
  wall-clock. It is the one mechanism every hostile-attacker-frame idea's *defense* converged on
  independently.
- **Symmetric mutual-destruction on concurrent conflicting claims** (attacker: mutual pre-signed
  "reinstatement," closed by "valid only if the signer's authority was unrevoked at every ancestor it
  depends on, recursively"; remove-load-bearing: "permanent disagreement... fork of competing
  claims... reconciliation is a merge of claims, not a single truth"). `[N7 V8 F8]` ★. **Chosen** as
  the deterministic, convergent resolution for the one case the causal-ancestor rule alone cannot
  order: two devices concurrently revoking each other, neither op causally preceding the other. Both
  apply; both end up revoked. No oracle, no tiebreak table, no wall-clock — a pure function of the op
  set.
- **Device identity itself as a rotating/forking CRDT** (remove-load-bearing: "who is this device is
  itself a converging CRDT, not a fixed identity"). `[N7 V4 F3]` — **trap for v1**: elegant but this
  app already has a stable per-device identity (`device_identity_key`, libp2p peerId, persistent
  across restarts per ADR 2026-09-14) that the causal-ancestor design can reuse directly; rotating
  device identity is a solution to a problem this design doesn't have yet. Not built.
- **Retroactive re-derivation of validity on every read rather than stamped once at write**
  (remove-load-bearing: "a removed admin's past signatures are retroactively reinterpreted by
  replaying the DAG forward... validity is a property computed fresh on each read"). `[N6 V7 F8]` ★.
  **Chosen implicitly** — this is exactly what "causal-ancestor validity" means operationally: there
  is no persisted "is this signature valid" bit; it is recomputed (and cached) from the change graph,
  which is why it converges identically on every peer regardless of merge order.

**Traps excluded:** a global sequencer (reintroduces a single assigner); trusting a self-reported
basis field (exactly the failure class already rejected once this session for the handshake layer);
device-identity-as-CRDT (solves a problem this design doesn't have, premature per
`karpathy-guidelines`).

## Decision — the authority primitive

### Where admin authority comes from, and how it is bounded (no PKI, in-person root)

Per-device signing keys **already exist and need no new key material.** Every device — Host or
Client, the distinction this ADR is dissolving for authority purposes — already generates and holds
its own persistent Ed25519 keypair the first time it runs a sync node:
`electron/auth/deviceIdentity.js`'s `ensureDeviceIdentity`, stored in the device-local, never-synced
`device_identity_key` table, bound to that device's stable libp2p `PeerId` (ADR
2026-09-14-device-identity-and-token-binding.md). This key is distinct from `host_signing_key`
(Host-only, used today for `users.role`/PIN credential signatures and tombstones) — it belongs to
every device by construction. **This ADR uses `device_identity_key`, not `host_signing_key`, as the
signing key for every admin-authority action.** No new keypair type, no new custody question: this
closes the single-signer problem by reusing a primitive this codebase already has, rather than
inventing one.

**Authority is bounded by the same thing campId/genesis already bound it by: it is per-camp, and its
root is the in-person pairing event, not an open PKI.** A new, genesis-registered Automerge
collection, `camp_authority_log`, is an append-only set of two entry kinds, each signed by the
**acting** device's own `device_identity_key`:

```
{ kind: 'grant',  target_device_id, target_peer_id, signer_device_id, signature }
{ kind: 'revoke', target_device_id,                 signer_device_id, signature }
```

Signed fields (canonical, domain-separated — new context `shoresh-authority-sig-v1`, never
interchangeable with a tombstone or auth-field signature, same discipline as
`canonicalTombstoneMessage`): `['kind', 'target_device_id', 'signer_device_id']`. **No `seq` field,
deliberately** (see "why no sequencer" below) — ordering comes from Automerge's own change DAG, not
from a self-reported counter.

**The genesis grant is axiomatic, not signed.** The founding device — whoever runs `campBootstrap` —
is seeded as the first entry in `camp_authority_log` at document creation, with no signature, exactly
as today's genesis mechanism seeds the document shape itself with no external authority to appeal to
(there is no admin before the first one). This is the in-person root: a camp physically begins on one
device, in one director's hands, the same moment that already mints `campId` and the camp's first
`users` row. Every other admin grant after that **must** be signed by a currently-valid admin and
flows through the existing in-person pairing UX — `electron/main.js`'s `approveDevice` flow (the
director looks at the device in front of them and approves it) is the natural point to **also** mint
a `grant` entry, if the approving admin chooses to grant admin status rather than staff-only trust.
No new UX primitive; this rides the pairing moment that already exists.

**Open question, named rather than silently resolved (see "Open questions" below): today, `users.role
= 'admin'` is a *different*, pre-existing authority concept — a Host-signed credential field (T172,
`authSignature.js`, SECURITY.md Q1) governing in-app permissions (scheduling, staff records, etc.)
via `PERMISSIONS`/`authorize()`. This ADR's `camp_authority_log` is a *new*, parallel authority
concept scoped specifically to device admission/revocation.** In practice the camp director is
usually both, but they are not the same mechanism, and unifying them is a larger, separate decision
this ADR does not make.

### Why no sequencer, and why causal-ancestor validity is the enforceable rule

A signature counts only if the signer held a live (granted, not yet revoked) admin credential **at
the causal point it signed from** — not at wall-clock "now," which this project's own prior
experience (`reference_cpu_time_not_wall_clock_on_this_machine`, the T229/T288 lessons) has already
taught cannot be trusted across devices with no shared clock and no server. Automerge gives this for
free: every `Change` object has a `deps` array of content-hashes of the changes it was built on top
of — a cryptographically chained, unforgeable causal-ancestry graph (the exact same hash-chaining
`genesisRootHash`/`sharesGenesis` already rely on for document-shape validity). "Was S a valid admin
when they authored change C" is answered by walking C's `deps` transitively (the set of changes
causally preceding C) and replaying only the `camp_authority_log` entries that appear among those
ancestors:

```
isValidAdminAt(deviceId, changeHash, doc):
  ancestors = changesReachableBackwardFrom(changeHash, doc)     # via deps, transitively; excludes changeHash itself
  state = { [FOUNDER_DEVICE_ID]: GRANTED }                       # genesis axiom
  for entry in authorityLogEntriesAmong(ancestors), topologically sorted by deps:
    if isValidAdminAt(entry.signer_device_id, entry.changeHash, doc):   # recursive, memoized per changeHash
      state[entry.target_device_id] = (entry.kind === 'grant') ? GRANTED : REVOKED
  return state[deviceId] === GRANTED
```

This is a **pure function of the document's change set** — every peer holding the same changes
computes the same answer regardless of merge order or which peer asked, which is exactly the
convergence property `org-interface-contracts` requires of a sync primitive. It is memoizable per
change-hash (admin-authority events are rare; the recursion depth is bounded by the authority log's
own size, not the document's full history). It requires **no global sequencer** (no single device
ever assigns order to anything) and **no wall-clock** (ordering is purely causal).

**The two hard cases, answered concretely:**

1. **An already-removed admin attempts to sign a new removal.** Their new `revoke` entry's own
   change `C` has `deps` reaching back to their last state. Walk `C`'s ancestors: if a `revoke` entry
   targeting them is among those ancestors (i.e., their own removal causally precedes the change they
   are now trying to author), `isValidAdminAt(signerDeviceId, C)` returns `false`, and the new entry
   is **dropped at verification — never applied, never entered into the derived "currently revoked"
   set, on every peer, deterministically.** This is the literal mechanism the owner asked for: "a
   signature counts only if the signer was a valid, non-removed admin at the causal point of
   signing," computed from real causal ancestry, not a self-reported field a removed admin could
   fabricate.
2. **A malicious admin.** Everything the malicious admin signs while still causally valid is, by
   definition, a legitimately authorized action under this model (any-admin-signs means exactly that
   — a bad actor who is currently a valid admin can revoke others; that is the capability the owner
   explicitly asked for, not a bug). What the malicious admin *cannot* do: forge ancestry (Automerge's
   hash chaining prevents claiming a causal basis they didn't actually build on), resurrect themselves
   after a valid revocation reaches them causally, or make their own signature retroactively "count"
   before the causal point it was actually authored at. **Every admin action is permanently,
   append-only, fleet-wide auditable** (`camp_authority_log` is itself the audit trail — who granted
   or revoked whom, from what causal basis, is never deleted, mirroring the regulator-frame's
   "traceable, human-reviewable" requirement) — so a malicious admin's damage is bounded by what they
   do before another admin notices and counter-revokes them, not hidden.

**The genuinely hard sub-case — bounded, not solved, flagged for the owner:** a device that is about
to be revoked, and senses it (or simply goes offline and is revoked while absent), can author damaging
`revoke`/`grant` entries **offline**, with `deps` pointing at the last state it synced — a state in
which it genuinely was still a valid admin. When it reconnects, those entries are **concurrent** with
the revocation that targeted it (neither is the other's causal ancestor), so the strict ancestor rule
above validates them: the offline device *was* a legitimate admin at the causal point it signed from.
This is not a bug in the rule; it is the honest limit of causal ordering in an offline-tolerant CRDT
with no real-time consensus — the same class of residual every frame's attacker-branch converged on
(backdating, forking-and-merging-back, pre-signed future-activating payloads). Two things bound it
without a quorum or a clock:

- **Symmetric mutual-destruction, not asymmetric victory.** If the offline device's concurrent action
  is itself a `revoke` of the admin who is removing it (or of any other admin), both revocations are
  independently valid at their own causal point and both apply — the malicious device does not "win"
  by racing, it drags its target down with it, and both end up removed. This is a pure, deterministic,
  convergent function of the op set (no tiebreak table, no wall-clock), computed identically by every
  peer.
- **It is not a silent win.** Every entry this device authors while racing is permanently visible in
  `camp_authority_log` the moment it propagates — a director sees exactly what the offline device did
  and when (causally), and can counter-revoke any rogue grant it minted, with that counter-revoke
  itself valid (the rogue grant's target was never causally protected from a later legitimate
  revocation).

**This residual is not fully closable under the owner's own constraint (any-admin-signs, no quorum,
no central clock) — only bounded.** The two mechanisms that *would* fully close it — a quorum/co-sign
requirement before a revocation takes effect, or a wall-clock grace window — are exactly the two
things the owner has separately ruled out (quorum, explicitly; wall-clock ordering, by this project's
own standing lesson that device clocks cannot be trusted for correctness). **This is presented to the
owner as a bounded choice, not papered over**: accept the residual as scoped above (small, trusted,
in-person-vetted fleet; full auditability; symmetric mutual-destruction; manual counter-action), or
decide later that a second incident class justifies revisiting quorum. Not resolved here — see "Open
questions."

**Confidence: ~75% that the causal-ancestor rule, with symmetric mutual-destruction, correctly
implements "any-admin-signs" as specified and defeats the two named hard cases (malicious,
already-removed) deterministically and convergently. ~55% confidence on the offline-race residual
being an acceptable risk for v1 — that is a product/risk judgment for the owner, not a technical one
this ADR can resolve on its own.**

### Enforcement — reusing T330's three points, re-keyed to the new derived set

The enforcement architecture is **unchanged from T330**; only what it reads is different. Derived
state is cached locally, device-local and never-synced, recomputed incrementally as
`camp_authority_log` entries are verified at projection time, and fully recomputed on purge/rebuild
(same carry-forward discipline `tombstones`/T330's revocation set already use —
`rebuildSupportCommand.js`/`purgeSupportCommand.js` never start the derived cache from empty and
never let a recomputed "currently revoked" set regress).

- **(A) Handshake gate** (`mutualAuth.js`/`authGate.js`) — before replying `auth_ok`, check the
  connecting device against this device's own locally-verified "currently revoked" set (never the
  connecting peer's self-report). Refuses a revoked device on every redial, cached-address or fresh
  discovery, same shape as T330.
- **(B) Production sync-message gate** (`syncNode.js`'s `handleSyncMessage`, mirrored into
  `handleReceived` for parity, production path targeted by the acceptance test — the literal T329
  finding) — check at the top, before `A.receiveSyncMessage`, immediately after the existing
  schema-compatibility check.
- **(C) Live teardown on projection** (`projector.js`) — the moment any device, including one that
  revoked nobody itself, verifies a new `revoke` entry (via the causal-ancestor check above) that
  resolves to "currently revoked," it calls the existing, unchanged `revokePeer(peerId)` if that
  device is a live connection — closing the third-device residual exactly as T330 did.

### Why this is monotonic under merge, and why purge/rebuild carries it forward

Unchanged from T330's argument in shape: `camp_authority_log` is an append-only set, not a scalar; two
concurrent grants/revokes of *different* targets never conflict at the Automerge level; the derived
"currently admin" / "currently revoked" sets are **recomputed from the verified entry set**, never
themselves transmitted or merged, so there is no scalar to roll back. The one genuinely new
convergence question T330 didn't have to answer — *what if the "winner" of a conflict depends on
causal order, not on which document key won a merge* — is answered by the `isValidAdminAt` replay
above, which is itself a pure function of the merged change set and therefore convergent by
construction, independent of merge order. Purge/rebuild re-seeds and re-verifies the full
`camp_authority_log` and reconstructs the derived cache from scratch by re-running the replay over
every entry — never restoring a stale cached "currently revoked" set, following the same discipline
already landed for `v51_down`/`rebuildTableCarryingColumns` and T330's tombstone-carry-forward
argument.

## Related finding: purge-tombstone signing has the identical single-host assumption

**Confirmed by direct read of `electron/automerge/tombstoneSignature.js`:** `signTombstone` throws
unless the calling device holds a `host_signing_key` row (line 39-43), and verification trusts
`camps.signing_public_key` as the one trust root (line 56-67) — the comment at the top of the file
states plainly *"a tombstone is presence... Host-signed exactly like a users credential change."*
**This is the exact same single-point-of-failure the owner rejected in T330, applied to purges rather
than revocations, and it is not fixed by this ADR.** If the Host device is fired or unavailable, a
camp cannot mint a new purge tombstone either — purge (T233/T202) inherits the same "must distribute
this authority too" problem.

**Not solved here, by design** (scope discipline: this ADR's ticket is distributed *revocation*
authority; widening it to also redesign purge signing would blur one already-large decision into two).
**Named so the owner can decide whether to spin off a follow-up**: once `camp_authority_log` and its
causal-ancestor verification exist, retargeting `signTombstone`/`verifyTombstone` to sign with
`device_identity_key` instead of `host_signing_key`, gated by the same "signer was a valid admin at
the causal point of signing" check, is a mechanically small follow-up — the hard design work (the
verification rule) is already done by this ADR; only the signing-key swap and a migration of the
existing `host_signing_key`-era tombstones remain. Flagged as a candidate follow-up ticket, not
authorized or scoped here.

## Discovery is unaffected — confirmed against the accepted WAN ladder ADR

Per the accepted parent ADR (`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`, Slice 1): the
persisted-peer direct-reconnect path (`peerAddressBook.js`'s remembered multiaddr redial) and the
planned DHT discovery (Slice 3, Kademlia `provide`/`findProviders`) are **both peer-to-peer by
construction** — neither depends on, nor rediscovers through, any single designated host. If device A
is unavailable (or has been revoked), B↔C and C↔D continue to find and redial each other exactly as
they would with A present; A's absence removes only A as a *discovery target*, never the discovery
*mechanism*, which was never host-centric to begin with (mDNS today; DHT when Slice 3 lands). This
ADR's enforcement gates (A/B/C above) layer on top of that peer-to-peer discovery exactly as T330's
did — discovery finds a candidate peer; the handshake/sync gates decide whether that peer is still
trusted. Revoking A changes who gate (A) will admit; it changes nothing about how B, C, and D find
each other.

## Blast radius / files affected

- **New:** `electron/automerge/authorityLogSignature.js` (sibling of `tombstoneSignature.js`'s
  shape, but signs/verifies with `device_identity_key`'s per-device keypair, not
  `host_signing_key`); a causal-ancestor replay module (e.g.
  `electron/automerge/authorityReplay.js`) implementing `isValidAdminAt` over Automerge's
  `getAllChanges`/`decodeChange`/`deps` — **org-source-verification required**: confirm the exact
  Automerge API shape for enumerating changes and their `deps` against the version actually pinned
  in `package-lock.json` before building, not from general Automerge familiarity.
- **Changed:** `electron/automerge/campDocument.js` (new genesis-registered collection,
  `camp_authority_log`, additive to `MODELED_ENTITIES`/`GENESIS_ENTITIES`, same subset-guard-enforced
  regeneration pattern already used for `tombstones` — `GENESIS_B64`/`genesisRootHash`/
  `sharesGenesis` themselves stay unchanged; entries now include `grant`, `revoke` (immediate,
  non-admin targets), and `revoke-vote` (accumulating, admin/founder targets) kinds);
  `electron/automerge/projector.js` (verify-and-replay loop, mirroring the tombstone/T330 loop,
  producing the derived "currently admin"/"currently revoked" cache plus a per-target vote tally for
  `revoke-vote` entries, re-evaluated against the dynamically-recomputed `N`/threshold on every
  projection pass); `electron/sync/automerge/syncNode.js` (gate B); `electron/sync/automerge/
  mutualAuth.js` / `authGate.js` (gate A); `electron/automerge/rebuildSupportCommand.js` and
  `purgeSupportCommand.js` (carry `camp_authority_log` and its derived cache forward, vote tallies
  included); `electron/main.js`'s `approveDevice`/`revokeDevice` handlers (now also mint a signed
  `camp_authority_log` entry via the acting admin's own `device_identity_key` — a `grant`/immediate
  `revoke` for a non-admin target, or a `revoke-vote` for an admin/founder target — in addition to
  any existing immediate local action).
- **Schema:** new device-local, never-synced tables — e.g. `applied_authority_log` (verified entries)
  and a derived cache table for the current admin/revoked sets, joining the `device_identity_key`/
  `host_signing_key`/`tombstones`-derived-cache exclusion class (never registered in `PROJECTIONS`,
  `campScopedEntities.js`, or the syncable-field list; must be added to the standing exclusion-class
  guard test). This is a schema migration (`CURRENT_SCHEMA_VERSION` bump, its own `vNN_down` rollback,
  full `npm run schema:check` coverage per ADR 2026-09-26).
- **`SECURITY.md`**: gains a "Distributed revocation/admin authority" subsection replacing any
  forward-reference this ADR's acceptance would otherwise leave stale, documenting the causal-ancestor
  rule, the founder's revocability, and the named offline-race residual in plain language.

## Reused vs. new

**Reused:** `device_identity_key`/`ensureDeviceIdentity` (every device's existing per-device Ed25519
keypair — no new key material); the canonical-message/domain-separation signing pattern from
`tombstoneSignature.js`/`authSignature.js`; the three-point enforcement architecture from T330
(handshake gate, production sync-message gate, live teardown-on-projection); the genesis-registration
pattern used for `tombstones` (T233); the purge/rebuild carry-forward discipline; `approveDevice`'s
existing in-person pairing UX as the root for new admin grants; `campId`/document-per-camp scoping,
unchanged (ADR 2026-09-19).

**Genuinely new:** the `camp_authority_log` collection and its genesis registration; the
causal-ancestor (`isValidAdminAt`) replay over Automerge's change-dependency graph — the first use in
this codebase of Automerge's low-level change/`deps` introspection API for an authorization decision,
rather than for sync internals; the symmetric mutual-destruction resolution rule for concurrent
conflicting claims; the derived admin/revoked local cache and its migration.

## `org-interface-contracts` checklist

- **Idempotency:** verifying and applying the same `camp_authority_log` entry twice is a no-op
  (insert-or-ignore on a stable entry id; `isValidAdminAt` is a pure, memoized predicate with no side
  effect beyond the cache write).
- **Concurrent-retry safety:** two devices independently projecting the same incoming entries
  concurrently converge to the same derived admin/revoked state, because the replay is a pure function
  of the change set — no lock or coordination primitive required.
- **Unknown-outcome handling:** an entry that fails signature verification, or whose signer resolves
  to `isValidAdminAt(...) === false` at its own causal point, is dropped silently at projection — never
  half-applied, never retried, never surfaced as ambiguous.
- **Error shape:** handshake refusal for a revoked device reuses `evaluateAuthenticate`'s existing deny
  shape with its own distinguishing reason string, same as T330.
- **camp/authorize()/PROJECTIONS boundary:** the derived admin/revoked cache and `applied_authority_log`
  join the `device_identity_key`/`host_signing_key`-derived-cache exclusion class — never synced, never
  registered as a modeled camp entity; must be added to whatever standing guard enforces that exclusion
  today.

## Battle tests the eventual Maker must pass (red-before-green)

1. **Any currently-valid admin can revoke any other admin, including the founder.** Three admins
   (founder + two granted later); a non-founder admin revokes the founder; assert the founder's device
   is refused at gate (A)/(B) on its next connection attempt, with no Host-only code path involved at
   all (confirm by running the whole scenario with the founder's device as the *only* one that ever
   held `host_signing_key`, and the founder still gets revoked correctly by someone else).
2. **An already-removed admin's new revoke is dropped, not applied.** Admin S is validly revoked by
   admin T; S (still holding its own `device_identity_key`) signs a new `revoke` entry targeting a
   fourth device, citing a causal basis from before its own removal propagated. Assert this entry
   fails `isValidAdminAt` once S's removal is in its ancestor set and never enters the derived revoked
   cache on any peer.
3. **Concurrent mutual revocation converges symmetrically, independent of merge order.** Two admins
   concurrently (no shared causal ancestor) revoke each other; `A.merge` the two documents in both
   orders; assert the derived "currently revoked" set is identical and contains both devices either
   way.
4. **Causal-ancestor validity is not a self-reported field.** Attempt to forge a `camp_authority_log`
   entry whose claimed basis is a change hash that does not actually appear in that entry's own
   change's `deps` (i.e., bypass the real Automerge causal chain); assert this is either impossible to
   construct through the public API (the chain is enforced structurally) or is rejected at
   verification if attempted via a malformed/replayed change.
5. **Discovery is unaffected by a revocation.** Three-device LAN topology (B, C, D) with A revoked and
   offline; assert B↔C and C↔D continue to discover and sync via the existing mDNS path with no change
   to discovery behavior, only to admission at gate (A) if A ever reconnects.
6. **Production-path enforcement, not the test-only path (carried from T330/T329).** Integration test
   through the real `generateSyncMessage`/`receiveSyncMessage`/`handleSyncMessage` round trip —
   `handleReceived` is explicitly asserted NOT to be the path the test exercises.
7. **Purge/rebuild never regresses the derived revoked set.** Run a purge/rebuild after several
   grant/revoke cycles; assert the derived admin/revoked cache after rebuild is identical to before it.
8. **Quorum threshold matches the N=1..5 table exactly.** For each of N=2,3,4,5, construct that many
   admins, cast votes one at a time against an admin target, and assert the target is removed only
   once the count reaches the table's threshold — not before, not requiring more.
9. **N=3 requires both others; N=4 tolerates one offline.** Concretely assert the N=3 case needs both
   non-target admins' votes (one alone is insufficient) and the N=4 case removes the target with any
   2 of 3 non-target admins voting, with the third never signing.
10. **Concurrent quorum-vs-counter-revoke resolves symmetrically (case a, walked above).** Reproduce
    the `F`/`S1`/`S2` scenario exactly as walked; assert both `S1` and `S2` end up revoked on every
    peer after merge, independent of merge order.
11. **Overlapping partial quorums converge via set union (case b).** Two peers each see a different
    2-of-4 subset of votes for the same target; after merge, assert both peers compute the same
    4-vote total and the same removal outcome.
12. **A shrinking admin denominator never blocks an in-progress vote (case c).** Start a vote at N=5
    (threshold 3); revoke one of the non-voting, non-target admins mid-vote (dropping N to 4,
    threshold to 2); assert votes already cast still count and the lower threshold is the one applied
    on the next evaluation — never a higher one, never a reset.

## Committee/quorum revocation for an admin or founder target — added per owner direction (2026-10-02)

The owner, after reviewing the any-admin-signs design above, asked for a **two-tier rule by target**:
removing an ordinary (non-admin) device stays exactly as designed above — any one currently-valid
admin's signature suffices, takes effect immediately. **Removing an admin, or the founder, is the
high-stakes case and requires a committee/quorum** — "like a cabinet voting out a president" — of the
*other* admins. The target never counts toward its own removal.

### Candidate quorum formulations considered

- **Fixed "any 2 other admins," capped at however many others exist.** `[N4 V7 F6]`. Degrades
  identically to strict majority at N=2 and N=3 (see table below — with only 1 or 2 other admins,
  "any 2" and "majority" collapse to the same requirement), and only diverges from majority once
  there are 4+ others, where it becomes *weaker* than majority (a fixed 2-of-10 quorum, say) — a
  real security cost for larger admin sets with no corresponding liveness benefit over majority at
  the sizes this app actually has. **Rejected**: it buys nothing at the small N this product
  actually runs at, and gives away security at sizes it might grow into.
- **N-1 unanimity of the other admins, minus an explicit offline-tolerance carve-out** (e.g. "all
  others, unless one has been offline > T days"). `[N3 V3 F5]` — **trap**: reintroduces wall-clock
  reasoning this project has already learned not to trust across devices with no shared clock
  (`reference_cpu_time_not_wall_clock_on_this_machine`), and a device offline for a legitimate
  reason (vacation, broken laptop) is indistinguishable from one being deliberately stonewalled —
  exactly the deadlock the owner named as unacceptable. **Rejected.**
- **Strict majority of the other admins** (`floor((N-1)/2) + 1`, where `N` is the total valid-admin
  count including the target). `[N6 V9 F9]` ★. **Chosen.** It is the literal "cabinet" model — more
  than half the rest of the cabinet must agree — and it is the formula that produces exactly the
  owner's own stated case ("at 2 admins, the other agreeing is enough") without being special-cased:
  plug `N=2` into the general formula and it falls out, rather than being hand-coded as a special
  rule for small camps.
- **A percentage threshold of the full admin set** (e.g. "two-thirds of all admins, target
  included"). `[N5 V5 F5]` — **trap**: counting the target toward its own removal contradicts the
  owner's explicit "cabinet-not-president" framing (the president doesn't get a vote on their own
  impeachment), and a percentage-of-everyone formula behaves worse than majority-of-others at small
  N (e.g. two-thirds of 3 total = 2, same as majority-of-others there, but the target is still
  implicitly in the denominator, which is the wrong shape even where the number matches). Rejected
  in favor of the cleaner majority-of-others shape.

### The recommended rule

**Threshold = `floor((N-1)/2) + 1`, where `N` is the count of currently-valid admins — including the
target — and the threshold is computed over the `N-1` *other* admins.** The target never signs
toward its own removal.

| N (admins incl. target) | Other admins (N-1) | Threshold (votes needed) | Offline the vote still survives | Notes |
|---|---|---|---|---|
| 1 | 0 | — (unsatisfiable) | n/a | **Irreducible residual, named below** — a sole admin cannot be quorum-removed; there is no committee. |
| 2 | 1 | 1 | 0 | The owner's own stated case: "the other admin agreeing" is the whole quorum, by the general formula, not a special case. |
| 3 | 2 | 2 | 0 | **The tight case** — both other admins must sign. No offline tolerance at all. See honest tradeoff below. |
| 4 | 3 | 2 | 1 | First point real offline tolerance appears: any 2 of the 3 others. |
| 5 | 4 | 3 | 1 | 3 of 4 others; one can be offline. |

**N=1 is irreducible under any formula, not a defect of this one.** A camp with exactly one admin has
no committee to convene — this is true of a literal cabinet-of-one too. The only way out is for that
admin to first grant a second admin (the existing any-admin grant path, unchanged); if that admin is
unreachable or malicious and no second admin was ever granted, the camp's admin layer is
unrecoverable by this mechanism and would need an out-of-band remedy (support involvement, a fresh
camp). **This ADR recommends — as a product follow-up, not scoped here — nudging every camp toward a
second admin during setup**, so N=1 is a transient state, not a steady one. Flagged, not built.

**N=3 is the honest hard case the owner needs to see plainly: with only two other admins, no
quorum rule above "any 1 other admin" can tolerate even one of them being offline, because
requiring more than 1 of 2 means requiring both.** This is forced by the arithmetic of small
numbers, not a flaw in the formula — the real security-vs-liveness tradeoff only has room to exist
once there are at least 3 *other* admins (N≥4). Below that, the choice is binary: either quorum for
an admin-target at N=2/N=3 is only as strong as any-admin-signs already is (if the threshold were
set to 1 regardless of N), or it demands full consensus of the (small) rest. **The recommended
formula picks the latter** — true majority, not a diluted one — on the reasoning that a camp this
small is also small enough that reaching both of two co-admins is an hours-not-weeks problem, not a
structural deadlock; the tradeoff is named here precisely so the owner can weigh it against the
practical reality of a specific camp's staff availability.

**The general tradeoff, stated once:** a lower threshold tolerates more simultaneous offline admins
but lets a smaller clique act unilaterally against a peer admin; a higher threshold is safer against
collusion but risks the vote never completing if too many admins are simultaneously unreachable.
**Strict majority of the others is the recommended point on that curve** — it is the standard
"cabinet" answer, it degrades to exactly the owner's N=2 case without special-casing, and once N≥4
it always tolerates at least one admin being offline, with the tolerance growing as the admin set
grows. Confidence: ~75%.

### The denominator problem — computed deterministically, same way for every peer

`N` is not frozen at "vote start" and is not a self-reported field. It is computed the exact same way
admin validity itself is computed: **`N` is the size of the admin set derivable via `isValidAdminAt`
over the evaluating peer's own current document state (its sync frontier/heads), excluding nothing
but counting the target if the target is still admin as of that same state.** Every peer, once it has
received the same set of changes, computes the identical `N`, the identical threshold, and the
identical vote tally — this is the same convergence property the causal-ancestor replay already
gives the grant/revoke mechanism, extended rather than re-invented. Different peers mid-sync may
transiently disagree (one has seen more changes than another), which is ordinary eventual
consistency, not a correctness defect — once they hold the same changes, they agree.

**`N` is recomputed on every evaluation, not cached from vote-start — see case (c) below for why this
is the right choice, not just the convenient one.**

### Entry shape and composition with the causal-ancestor rule

`camp_authority_log` gains one more entry kind for the high-stakes case (grants and ordinary-device
revokes are unchanged from the design above):

```
{ kind: 'revoke-vote', target_device_id, signer_device_id, signature }
```

Each `revoke-vote` is scored by the **same per-signer causal rule already established**: a vote
counts only if `isValidAdminAt(signer_device_id, thatVoteChange)` is true — the signer held a live
admin grant at the causal point they cast their own vote, exactly as for a `grant`/`revoke` entry.
Votes for the same target accumulate as an append-only set (one entry per signer; a second vote from
the same signer for the same target is idempotent, not double-counted). **The target is removed, on
a given peer's evaluation, the instant the count of currently-valid votes for that target reaches the
threshold computed from that peer's own current `N`** — no new primitive beyond "count valid
append-only entries against a dynamically recomputed threshold," which is a small, composable
extension of the replay already built for grant/revoke, not a second verification mechanism.

Whether a `revoke`/`revoke-vote` is even the right entry kind for a given target is itself derived,
not declared by the signer: at the moment a signer casts a vote (or an immediate single-signature
revoke for a non-admin target), the signer's own client checks `isValidAdminAt(target, currentHeads)`
to decide which shape to author. A receiver re-derives the same check independently rather than
trusting the sender's framing — consistent with this ADR's standing rule that nothing about
authority is ever trusted from a self-report.

### Convergence of concurrent and partial quorums — the three nasty cases, walked

**(a) A quorum forms concurrently with the target revoking one of its own voters.** Concrete worked
example, N=3 (`F`, `S1`, `S2`; target `S1`; threshold 2 of 2 others): `F` and `S2` each cast a
`revoke-vote` against `S1`. Concurrently (neither change is a causal ancestor of the other), `S1`
signs a `revoke` against `S2`, trying to knock out one of its own voters before the quorum completes.
**Walk it:** `S2`'s vote is checked via `isValidAdminAt(S2, S2'sVoteChange)` — and `S1`'s revoke-of-S2
is *not* in the ancestor set of `S2`'s vote (they're concurrent) — so `S2`'s vote is valid and counts
regardless of `S1`'s attempt. Symmetrically, `S1`'s revoke-of-`S2` is checked via
`isValidAdminAt(S1, thatChange)` — the quorum against `S1` had not causally completed before `S1`
signed (also concurrent) — so `S1`'s revoke-of-`S2` is *also* valid as authored. Once merged: `F`+`S2`
reach the threshold of 2 against `S1` → `S1` is removed. `S1`'s own revoke-of-`S2` is independently
valid → `S2` is removed too. **Final convergent state: both `S1` and `S2` end up revoked** — the
same symmetric-mutual-destruction pattern already established for ordinary concurrent grant/revoke
conflicts falls out here with zero new machinery, because a `revoke-vote` is scored by the identical
per-signer causal rule as every other entry kind.

**(b) Two overlapping partial quorums.** `revoke-vote` entries for the same target accumulate as an
ordinary append-only set, deduplicated by `(target, signer)`. If one peer sees `{F, S1}` vote and
another independently sees `{S2, S3}` vote for the same target (different partial views, perhaps
during a network partition), the merged state is simply the **union**: `{F, S1, S2, S3}`. Whichever
peer first holds the union evaluates the same count against the same threshold and reaches the same
answer — this requires no new convergence argument beyond "set union is commutative and
idempotent," which Automerge already gives for free for map/set-shaped collections.

**(c) The admin set shrinks mid-vote (a denominator admin is itself removed while a vote is in
progress).** Because `N` is recomputed fresh from the evaluating peer's current state rather than
frozen at vote-start, a shrinking admin pool **only ever makes an in-progress vote easier to
complete, never harder** — fewer others means a lower threshold on the next evaluation, and any
votes already cast by admins who remain valid still count (a vote's validity is pinned to the
signer's *own* causal point, not to the denominator at the time it was cast). This is the same
property as (c)'s cousin case: shrinking the denominator cannot retroactively invalidate a vote that
was valid when cast, and can only lower the bar for the votes still outstanding. No special-case
logic is needed — recomputing `N`/threshold fresh on every evaluation, rather than caching it, is
what makes this converge correctly without extra bookkeeping.

### Recommendation for v1: adopt the two-tier model (quorum-for-admin-targets), any-admin kept as fallback

**Recommended: adopt the two-tier rule as designed above — any-single-admin for ordinary device
targets (unchanged), strict-majority-of-others quorum for admin/founder targets — for v1.
Confidence: ~70%.** It matches what the owner asked for exactly (committee for the high-stakes case,
simple for the ordinary case) and the N=3 tightness, while real, is bounded to the single smallest
case where a true quorum can exist at all (N=1 has no quorum by construction regardless of formula).

**Fallback, named explicitly per the owner's request: if the N=3 case (or any case up to N=4) proves
operationally painful in practice** — e.g. a real camp finds itself with exactly 3 admins and
struggling to reach both others when one legitimately needs removing — **the simpler fallback is to
keep any-admin-signs for every target, admin or not**, exactly as this ADR originally designed before
this revision. That fallback has no deadlock risk at any N, at the cost of losing the committee
safeguard the owner specifically asked for against a single rogue or compromised admin acting against
a peer admin. **The owner decides which to ship; this ADR's recommendation is the two-tier model,**
on the reasoning that the committee safeguard is exactly the property a "fire the founder" scenario
needs, and the N=3 cost is a real but narrow and self-resolving case (it stops being the tightest
case the moment a camp grows to 4 admins).

## Tier-4 / capability impact

**None.** Every mechanism lives on the already-wired LAN/document-sync layer, exactly as T330 stated.
No new libp2p package, no `transportCapabilities.js` row touched. `kadDht`, `dcutr`,
`circuit-relay-v2`, and `bootstrap` remain `signoff: null`, unaffected either way by this ADR.

## What this supersedes/amends

**Supersedes `docs/adr/2026-10-02-signed-revocation-witness.md` (T330) in full.** T330's enforcement
architecture (three gates, append-only witness shape, carry-forward discipline) is reused; its trust
root (Host-only signing via `host_signing_key`) is replaced by the distributed `camp_authority_log`
primitive and the causal-ancestor validity rule described above.

**Amends `docs/adr/2026-09-19-per-camp-genesis-identity.md`** only insofar as it reuses, not disturbs,
that ADR's load-bearing clarification that genesis carries no camp identity and `campId` does — this
ADR adds a new genesis-registered *collection* (`camp_authority_log`), not a new genesis *root*,
consistent with that ADR's rejection of per-camp genesis mutation.

**References, does not reopen,** `docs/adr/2026-10-02-wan-discovery-transport-ladder.md` — discovery
is confirmed unaffected (see above); this ADR is a corrected Slice 2 of that ladder's build plan, same
position T330 occupied.

## Owner rulings recorded (2026-10-02)

The owner ruled on the three open questions from the prior revision of this ADR. Recorded here for
the permanent record; none of them changed the mechanism itself.

1. **Offline-race residual (former Open Q1): ACCEPTED as bounded for v1.** Owner: "very low for my
   field... it is fine." No change to the mechanism — the causal-ancestor rule, symmetric
   mutual-destruction on concurrent conflicts, and full auditability stand exactly as designed above.
   This is now a closed, accepted risk, not an open question.
2. **Unifying `camp_authority_log` admin status with `users.role='admin'` (former Open Q2): kept
   SEPARATE for v1.** A follow-up is filed on the board: **`q-unify-admin-role-and-device-revocation`**.
   Out of scope here — this ADR's `camp_authority_log` and the existing Host-signed `users.role` field
   remain two distinct authority concepts, as originally designed.
3. **Purge-tombstone single-host finding (former Open Q3): FOLLOW-UP, not fixed here.** A follow-up
   is filed on the board: **`h-purge-survives-fired-founder`**. `tombstoneSignature.js`'s
   `host_signing_key` dependency remains unchanged by this ADR; the follow-up ticket is where that
   gets addressed, reusing this ADR's causal-ancestor verification work as its starting point.

## Open questions for the owner

1. **Adopt the two-tier quorum-for-admin-targets model (recommended, ~70% confidence), or keep
   any-admin-signs for every target including admins (the named fallback, no deadlock risk at any
   N, but no committee safeguard against a single rogue admin)?** See "Committee/quorum revocation"
   above for the full tradeoff, the N=1..5 table, and why N=3 is the tightest case under the
   recommended formula. This is the one load-bearing decision this ADR cannot make on its own — the
   formula is fully specified either way, but which rule ships is the owner's call.
2. **Should product UX nudge every camp toward a second admin during setup**, so the N=1
   irreducible-residual case (a sole admin cannot be quorum-removed by construction, same as a
   cabinet of one) is a transient state rather than a steady one for small camps? Named as a
   recommendation above, not scoped or built here.

## Amendment 2026-10-03 — gate precedence & self-heal (RISK 1)

**Status: accepted, organizer-delegated per the T327 delegation.** Relayed ruling: *"the organizer
has accepted this amendment on the owner's behalf per the T327 delegation (it's an amendment within
the delegated build, no spend/infra)."* This is an amendment within the already-accepted T331 build,
not a new product decision — the precedence/self-heal mechanism below implements the owner's own
2026-10-02 acceptance of the quorum model; it does not change what was accepted, only closes a gap
in how it is *enforced* against a pre-existing, never-reconciled gate.

### The problem (Red Hat HIGH, confirmed)

T331 made `authority_cache` (derived from `camp_authority_log` replay) the enforcement truth, at Gate
A (`electron/auth/connectionAuth.js:168`) and Gate B (`syncNode.js`). It never reconciled this with
the **legacy** Host-local device-trust gate at `connectionAuth.js:131`
(`deviceTrustStatus`/`deviceTrustReason`, `electron/auth/deviceTrust.js:4-14`), which reads
`devices.revoked_at` **directly** and rejects a connection **before** Gate A is ever reached.

Concretely: device X calls `revokeDevice(A)` where A is actually a currently-valid admin, but X's own
`authority_cache` has **no row for A at all** — X has never synced A's grant entry (X joined after A
was promoted, or has been offline since). `wasAdminOrFounder` (`electron/main.js:1423`) reads `false`
(no row ≠ `'admin'`), so X takes the unconditional immediate-removal path and stamps
`devices.revoked_at` on its own local `devices` row for A. On X's *next* evaluation of a connection
from A, the legacy gate at `connectionAuth.js:131` rejects A outright, before Gate A's
`authority_cache` check (which would have correctly left A admitted, since X's own replay — once it
has the real document state — would classify X's revoke as a vote, not an immediate removal) is ever
consulted. The quorum protection T331 designed is bypassed **on X specifically**, by a gate T331 never
touched.

### 1. Precedence rule

**When an `authority_cache` row exists for a device, that row is authoritative for the revocation
decision at every gate; `devices.revoked_at` is consulted only when no row exists for that device.**

Concretely, in `evaluateAuthenticate` (`connectionAuth.js`), the authority lookup already performed
for Gate A (line 168) must be hoisted to run **before** the legacy trust check at line 131, and its
result must participate in that check:

```
authorityStatus = authority_cache.status for verified.deviceId   // undefined if no row

if authorityStatus === 'revoked':
    deny 4404 device_revoked_by_authority      // today's Gate A, unchanged in effect
elif authorityStatus === 'admin':
    // authoritative: this device is NOT revoked, full stop — do not consult devices.revoked_at,
    // do not let a stale local stamp override a fleet-confirmed-live admin
    (skip the legacy revoked_at check entirely for this device)
else:  // authorityStatus is undefined — no authority_cache row for this device at all
    fall back to today's devices.revoked_at / deviceTrustStatus check, unchanged
```

`evaluateLogin`'s `deviceTrustStatus` call (line 260) gets the identical treatment — it is the same
class of local-only admission gate and must not diverge from `evaluateAuthenticate`'s rule, or a
wrongly-locked-out admin could pass the network gate but still be refused at the login step on the
same device.

**Why this cannot readmit a genuinely quorum-revoked device.** The `'revoked'` branch is unchanged
and still blocks unconditionally — that is Gate A, already correct per T331, and this amendment adds
nothing to it. The only behavior this amendment changes is: a device whose `authority_cache` row says
`'admin'` is no longer *additionally* blockable by a stale local `devices.revoked_at`. An
`authority_cache` row only ever says `'admin'` when this device's own causal-ancestor replay — a pure
function of the real Automerge change set, per T331's `isValidAdminAt` — currently grants that device
admin status. A device that is truly fleet-revoked (quorum reached, or an ordinary target with a
valid single-admin revoke) has a `'revoked'` row, not an `'admin'` one; there is no row state that is
simultaneously "authority_cache says admin" and "actually revoked by quorum." A not-yet-synced revoke
in flight is ordinary CRDT propagation lag — functionally identical to today's accepted behavior
before this amendment (a revoked device stays briefly admitted on a peer that hasn't synced the revoke
yet), not a new hole.

**Back-compat boundary.** A device with no `authority_cache` row at all — every device on a camp that
predates T331 and has never had `camp_authority_log` seeded, or (within a T331+ camp) a device that
has genuinely never been the target of any grant/revoke entry the evaluating device has synced — falls
straight back to exactly today's `devices.revoked_at` check, byte-for-byte unchanged. No distinction is
drawn between "genuinely pre-T331" and "T331 camp, this device just has no entry yet": the single rule
("no row → legacy check") covers both, which is also why back-compat needs no special-casing and no
camp-version flag.

### 2. Self-heal mechanism

**Mechanism A (gate-level, primary):** once the revoked-but-actually-admin device's grant entry
reaches the wrongly-locking device via *any* sync path — not necessarily a direct connection to the
admin being blocked — `authority_cache` is recomputed by `projector.js`'s existing
`upsertCampAuthorityLogEntity`/full-replay pass and the row for that admin flips from absent (or
stale) to `'admin'`. The very next evaluation of a connection from that admin at the precedence rule
above no longer consults `devices.revoked_at` at all — the lockout clears automatically, with no new
mechanism beyond the precedence rule itself and the replay T331 already runs on every projection pass.

**Mechanism B (projection-level, recommended in addition, for UI truth):** `projector.js`'s
projection pass should also **clear the stale `devices.revoked_at` row** (and
`revoked_by_user_id`/`revocation_reason`/`pairing_status`) whenever `authority_cache` resolves a
device to `'admin'` while `devices.revoked_at` is still set for it — i.e. make `devices.revoked_at`
a continuously-reconciled projection of `authority_cache` for any device `authority_cache` has an
opinion about, not a write-once stamp. This is not strictly required for the gate fix (Mechanism A
already stops the lockout), but without it the Roster/device-list UI keeps showing the admin as
"Revoked" indefinitely even after the network gate has quietly stopped enforcing it — exactly the
"never show the director a tidy lie" rule this ADR's own T332 fold-in (commit 97da1ee2) was written
to uphold. Scope this to devices `authority_cache` has a row for; a device with no row is still
governed by `devices.revoked_at` directly (per the back-compat boundary above) and must not be
touched.

**The nasty sub-case — does this break the "blocked the delivering connection" deadlock?** Per-device:
yes, with one honestly-named exception. `devices` is a device-local SQLite table, never synced — when
X calls `revokeDevice(A)`, only **X's own** local `devices.revoked_at` for A is stamped; every other
device's local `devices` row for A is untouched. X blocking A therefore only blocks connections
**specifically to X**. In any topology where X has at least one other reachable peer (B or C) that is
not itself blocking A, X syncs the Automerge document normally with that peer, receives A's grant
entry via ordinary CRDT sync (no connection to A required at all), and Mechanism A fires on X's next
evaluation of A. **Confirmed this breaks the deadlock in any fleet with a third reachable device.**
**Residual, named rather than papered over:** a strict two-device topology (X and A are each other's
only peer), or a network partition where X's only ever-reachable peer is A, has no third path for the
grant to arrive by — X stays locked out of A until some other channel (A reconnects after X
independently learns otherwise, or manual intervention) breaks it. This is the same shape of bounded
residual the base ADR already accepts for the offline-race case above (no quorum, no clock → some
narrow topologies cannot be fully closed) — not a new concession, the same one, applied to a second
scenario. Not fixed here; named for the owner/organizer same as the base ADR's own residual.

### 3. Scope of the fix

**Closes the whole lockout class, not only the T332 widening.** The bug is in
`connectionAuth.js`/`deviceTrust.js`, which `evaluateAuthenticate`/`evaluateLogin` call identically
regardless of whether the device that called `revokeDevice` was acting in host mode or client mode —
T332 only *widened who could reach* the vulnerable code path (previously host-only, now any
authorized admin), it did not introduce the gate-precedence bug itself. The precedence fix is applied
at the gate, independent of caller identity, so it closes the lockout for a host-originated
misclassification exactly as it does for a client-originated one.

### 4. `revokeDevice`'s immediate-path decision — recommendation

**Keep `revokeDevice`'s existing structure (always mint, pre-mint `wasAdminOrFounder` snapshot decides
whether the unconditional-immediate-removal guarantee applies) — do not restructure the minting
order.** Analysis: the ambiguity is a genuine knowledge gap, not a decision-ordering bug — a device
that has never synced an admin's grant entry has no way to know, at mint time or after, that the
target is anything other than ordinary, because its own causal-ancestor replay is a pure function of
*its own* change set, which does not yet contain that grant. Re-checking `authority_cache` after
minting (as `effectivelyRevoked` already does for the `wasAdminOrFounder === true` branch) does not
change this for the `wasAdminOrFounder === false` branch, because the gap is in what the document
*contains locally*, not in when the check runs.

**Do, however, make `devices.revoked_at` a continuously-reconciled projection of `authority_cache`
(Mechanism B above) for every camp with an active `camp_authority_log`** — which is every camp post
the T331 schema migration, since the genesis entry is seeded unconditionally at document creation.
This does not prevent the initial wrong stamp (nothing can, given the knowledge gap), but it guarantees
the stamp is corrected the moment better knowledge arrives, on every device, not only at the gate.
`revokeDevice`'s own manual `UPDATE devices SET revoked_at = ...` (line 1461-1463) should remain for
the immediate/single-admin case (it is correct there, and removing it would add latency to the common
case for no benefit) but must no longer be the *only* writer of that column — `projector.js` must be
able to override it in either direction (set or clear) on every projection pass.

### Schema / Tier-4 confirmation

**No schema change.** `authority_cache` and `devices` already exist with the columns this design
reads and writes; this is a logic-ordering and reconciliation change in `connectionAuth.js`,
`deviceTrust.js` (or a thin wrapper), and `projector.js` only.

**No Tier-4 capability involved.** Everything here operates on the already-wired local SQLite
projection and the already-synced `camp_authority_log` collection; no new libp2p package or
transport capability is touched, consistent with the base ADR's own Tier-4 statement.

### Red-before-green tests the Maker must pass

1. **Sync-lag lockout, then self-heal.** Three devices (F founder, A granted admin later, X with no
   `authority_cache` row for A). X calls `revokeDevice(A)`; assert X's local `devices.revoked_at` is
   stamped for A (today's behavior, unchanged) but assert a connection attempt from A to **a third
   device (F or a new device C)** is unaffected. Then sync X with F/C (not with A); assert X's
   `authority_cache` row for A flips to `'admin'`; assert a subsequent connection attempt from A to X
   now succeeds at `evaluateAuthenticate`, and (Mechanism B) assert X's local `devices.revoked_at` for
   A is cleared by the next projection pass.
2. **Genuinely quorum-revoked device stays blocked — no readmission.** Reach real quorum against
   admin A (per the base ADR's own battle tests); assert `authority_cache` resolves A to `'revoked'`
   on every peer; assert a connection attempt from A is refused at Gate A/B on every peer, including
   one whose local `devices.revoked_at` for A was never set at all (i.e. revocation enforcement does
   not depend on the legacy column once `authority_cache` says `'revoked'`).
3. **Pre-T331 / no-authority_cache-row back-compat, unchanged.** A device with no `camp_authority_log`
   entries at all touching it (simulating a pre-T331 camp, or an ordinary device nobody has ever
   granted/revoked through the distributed mechanism) is still correctly blocked by a direct
   `UPDATE devices SET revoked_at = ...` with no corresponding `authority_cache` row; assert the gate
   behaves byte-for-byte as it did before this amendment in that case.
4. **Host-mode and client-mode hit the identical fix.** Repeat test 1 with the revoking device acting
   as Host instead of Client (no code-path branch in `connectionAuth.js` distinguishes the two); assert
   identical self-heal behavior, confirming the fix is not T332-specific.
5. **Two-device residual is observed, not silently passing.** X and A are each other's only peer; X
   wrongly revokes A exactly as in test 1; assert X stays locked out of A indefinitely absent a third
   path (document this as an expected, asserted-bounded residual, not a silent gap — the test should
   fail loudly if some change accidentally "fixes" this in a way that contradicts the quorum model,
   e.g. by letting the gate itself leak authority state cross-device without a document-level channel).
6. **`evaluateLogin`'s legacy check gets the same treatment as `evaluateAuthenticate`.** Repeat test 1
   against `evaluateLogin` specifically — an admin wrongly locked out of the network gate must not
   separately fail login via `deviceTrustStatus`'s own direct `revoked_at` read.

## Known limitation (v1) — strict two-device-camp revocation deadlock (owner-accepted, fast-follow T333)

**Owner ruling 2026-10-03 (Option 2 — ship now, document the limit).** The gate-precedence +
self-heal in Amendment 2026-10-03 closes RISK-1 for any camp with **three or more** reachable devices:
a blind revoke made under sync lag self-corrects as soon as the revoking device syncs the missing
grant from any third peer (its replay reclassifies the target to `'admin'` and the self-heal clears
the stale `devices.revoked_at`). **In a strict two-device camp where the two devices are each other's
only peer, this does not self-heal:** if one device performs a blind revoke of the other (who is a
currently-valid admin) under sync lag, it stamps `devices.revoked_at` locally **and** its own replay
projects that peer as `'revoked'` in `authority_cache` (its single revoke entry looks sufficient
because it has not synced the grant that would make it a quorum vote). Gate A then denies the only
connection over which the missing grant could arrive, so the lockout persists **until a third device
joins the camp** (at which point the grant propagates and the state self-corrects).

Stated plainly, no euphemism: **in a 2-device camp, an accidental revoke of an admin under sync lag
can lock that admin out until a third device joins.** Camps of 3+ devices self-heal automatically.

A recovery mechanism (a 2026-10-03b amendment) was designed and implemented, then **reverted** before
merge: clearing the legacy `devices.revoked_at` column had no effect because the block is Gate A's
`authority_cache` read, which the recovery (correctly, to avoid readmission) does not touch — so the
affordance was inert, and shipping an "undo" button that does nothing would itself be the kind of
tidy lie this ADR chain exists to prevent. The proper fix (Gate A consulting an uncorroborated-revoke
marker to allow reconnection, **plus** a marker lifecycle that clears on corroboration so a
blind-revoke-then-genuine-quorum sequence cannot become a readmission hole) re-touches the admission
gate's readmission guarantee and is deferred to **fast-follow ticket T333**, where Security must
re-confirm the no-readmission sequence. Until then this limitation stands as accepted for v1.
