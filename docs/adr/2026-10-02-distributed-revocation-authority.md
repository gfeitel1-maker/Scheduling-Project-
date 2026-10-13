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

## Known limitation (v1) — strict two-device-camp revocation deadlock (owner-accepted; T333 recovery rejected 2026-10-11)

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

## Amendment 2026-10-11: T333 uncorroborated-revoke marker

**Status: REJECTED 2026-10-11, not built (owner ruling, option B).** Recorded as a rejected alternative. Red Hat found an inherent stale-view window: a two-device camp cannot tell a blind revoke from a genuine quorum revoke it has not yet heard of. So probation adoption would readmit a genuinely quorum-revoked device and send it camp data until the quorum syncs. That breaks the absolute no-readmission guarantee, and the Grader returned FAIL. Recovery is also LAN-only, because a revoke rotates the rendezvous secrets. The "Known limitation (v1)" above stands, with its recovery path: re-pair, add a third device, or export to a new camp and re-upload. The design text below is kept for the record and is not current instruction.

### Candidate approaches considered

1. **Stored device-local marker table** (what the ticket sketches): a row set at `revokeDevice` time, cleared by projection. Rejected: a stored flag can go stale, and a stale flag is exactly the blind-revoke-then-quorum readmission hole. Needs a schema bump and a migration for a fresh-camps-only product.
2. **Derived predicate over existing device-local state (chosen)**: "uncorroborated" is computed on read from `applied_authority_log` + `authority_cache`, both fully re-derived from the document on every projection pass. No new table, no schema change, no lifecycle to forget, nothing to restart-persist.
3. **Admit the peer as a normal peer when the predicate holds**: simplest gate edit. Rejected: the predicate cannot tell a blind-revoked admin from an ordinary single-admin-revoked device (a lost laptop), because the revoking device has no grant knowledge in either case. Full admission would hand a revoked ordinary device the camp's data. Not acceptable.
4. **Restricted "probation" admission with a quarantine doc (chosen as the admission shape)**: the predicate permits one narrow thing only: the revoked peer may *deliver* its document into a scratch doc; this device discloses nothing of its own and merges nothing until the scratch doc proves the grant.
5. **Out-of-band recovery** (owner re-approves in the UI, or a "forgive revoke" button): rejected. It is the inert-affordance shape that was reverted; any un-revoke that is not driven by a verified grant is a readmission path.

Recommendation: 2 + 4. Confidence: medium-high on the predicate and lifecycle (it reduces to facts the existing replay already computes); medium on the probation channel, because I did not prototype the Automerge sync of an empty-start scratch doc and the Maker must prove it in the first red test.

### 1. What "uncorroborated" means, and where the marker lives

Let `S` be this device. Target `T` is **uncorroborated-revoked on S** iff, evaluated against S's own verified state:

- `authority_cache(T) = 'revoked'`, AND
- `applied_authority_log` has at least one `kind = 'revoke'` row for `T` with `signer_device_id = S`, AND
- `applied_authority_log` has **no** row for `T` with `signer_device_id != S` and `kind = 'revoke'` (no other admin's vote has been seen), AND
- `applied_authority_log` has **no** row for `T` with `kind IN ('grant','genesis')` (S has never synced a verified entry establishing `T`'s role).

Any other signer's valid revoke carries its causal ancestors (including the grant, if `T` were an admin) into S's document when merged, so condition 3 is implied-safe for admins and merely stricter for ordinary devices. `applied_authority_log` only ever contains entries that passed signature and causal-validity checks (`electron/automerge/projector.js:424-427` region, `isEntryTrusted` skip at the insert loop), so a forged grant cannot be used to fake corroboration in either direction.

**Where it lives: nowhere new.** It is a pure read-time function `isUncorroboratedRevoke(db, selfDeviceId, targetDeviceId)` over the device-local, never-synced `applied_authority_log` / `authority_cache` (`electron/db/schema.sql:1897-1923`). Justification: (a) it cannot sync as authority because neither table is registered in `PROJECTIONS`; (b) it cannot go stale because both inputs are rebuilt from the document by `upsertCampAuthorityLogEntity` on every pass (`electron/automerge/projector.js:410-411` delete-and-reinsert), including purge/rebuild; (c) restart persistence is by construction; (d) no schema bump. The one thing it does not record is "S's revoke was blind at mint time"; it does not need to, because the predicate is true exactly while S has no grant knowledge of `T`, which is the definition.

Known cost, stated plainly: an ordinary device revoked by a single admin also satisfies the predicate (no grant exists for it anywhere). Section 2 is designed so that this costs nothing but a bounded read.

### 2. Gate A consult rule: probation, not admission

The predicate never turns a denial into an admission. `evaluateAuthenticate` (`electron/auth/connectionAuth.js:142-153`) still returns `{ ok: false, code: 4404, reason: 'device_revoked_by_authority' }`, now with one added field `probationEligible: true` when the predicate holds. Every existing caller that checks only `ok` keeps denying, so a missed call site fails closed. Only the auth transport (`electron/sync/automerge/authGate.js`) reads the field; on `probationEligible` it keeps the stream open for the probation exchange instead of closing, and never adds the peer to the live admission set.

What the probation peer **may** do: send Automerge sync messages for the camp document, received into a **scratch document that starts empty**, driven by a sync state created from that empty doc. S therefore sends nothing derived from its live document (its first sync message says "I have nothing"; the peer answers with its whole doc).

What it **may not** do, enforced by structure not by checks:
- No data flows from S to the peer (the scratch doc contains only the peer's own data).
- Nothing from the peer is merged into S's live document or projected, until the adoption test below passes.
- It is never entered in `peerDeviceIds` or the admitted set, so Gate B (`isPeerRevoked`, `electron/sync/automerge/syncNode.js:373-377`), `evaluateLogin` (`connectionAuth.js:303`, still denies on `'revoked'`), `evaluatePairingRequest` (`connectionAuth.js:228`) and every `authorize()` call treat it exactly as a revoked device. No authority action is honored on its behalf; `tearDownRevokedConnectedPeers` (`syncNode.js:163-170`) is unaffected because the peer is not in `peerDeviceIds`.

**Adoption test (the only way out of probation).** After each received message, replay the scratch doc's `camp_authority_log` with the existing `createVerifiedEntryTrust` + `createAuthorityReplayContext`. Adopt iff (a) the scratch doc's genesis entry equals S's genesis (same camp), and (b) the scratch doc's replay shows `T` in `grantedSet`, i.e. a verified grant chain back to the founder. On adopt: `Automerge.merge(live, scratch)` through the normal merge/project path (`projectAndNotify`). Projection re-derives `authority_cache`: with the grant now present, S's lone revoke is a vote, `T` becomes `'admin'`, `clearStaleRevocation` clears `devices.revoked_at` (`projector.js:437-447`) and the connection closes; the peer reconnects through the ordinary `'admin'` branch. If the test never passes, the scratch doc is discarded when the stream ends. A revoked ordinary device can therefore never write into S's document, and learns nothing.

Bounding: probation streams are one per peer, capped in size (reuse the existing frame cap), rate-limited with the existing per-source limiter, and the scratch doc is in memory only. No wall-clock expiry on the predicate: it costs nothing to keep true, and an expiry would reintroduce the permanent lockout for an admin who is offline a long time. (Governor question 1.)

### 3. Lifecycle

There is no stored marker to clear. The predicate flips false, atomically with the projection pass that makes it false, on each of:

- **Grant arrival, self-heal:** a verified `grant`/`genesis` row for `T` appears (`applied_authority_log` rebuild) AND the replay now yields `'admin'`: condition 4 fails, status is no longer `'revoked'`, Gate A takes the existing `'admin'` branch.
- **Genuine quorum revocation arrival:** the grant and further valid votes arrive and the replay stays `'revoked'`: conditions 3 and 4 both fail, predicate false, `probationEligible` is absent, Gate A denies as today.
- **Another admin's revoke arrives for an ordinary `T`:** condition 3 fails, denied.
- **Any rebuild/purge/restart:** re-derived from the document, same result.

Safety does not depend on cleanup timing: the predicate is evaluated on read, so there is no interval in which a stale "yes" can be consulted after the inputs changed. This is the property that removes the hole in the ticket's stored-marker framing.

### 4. Proof sketch: blind revoke then genuine quorum cannot readmit

Claim: if `T` is genuinely quorum-revoked in the document S holds, `isUncorroboratedRevoke` is false and no scratch doc can reach adopt.

1. Genuine quorum revocation of an admin `T` requires, in the replay (`electron/automerge/authorityReplay.js:306-318`, vote tally over distinct valid signers), a valid `grant` for `T` in `T`'s causal ancestry plus enough valid revoke votes from distinct signers. Quorum with S as the only signer is impossible unless the quorum threshold is 1, in which case S's revoke is genuinely sufficient and no grant knowledge is required to be correct (see Governor question 2).
2. Once S has merged the quorum, the document contains the grant and at least one revoke with `signer != S`. Conditions 3 and 4 are false in the next projection; the predicate is false on every later read, including after restart.
3. Adoption requires a verified grant chain for `T` and a replay in which `T` is not revoked. Merging the scratch doc into live can only add changes; the live replay is monotonic (this ADR's "monotonic under merge" section), so quorum votes already in the live doc still hold `T` at `'revoked'` after the merge. A scratch doc made by `T` alone cannot remove a vote already in the live document, and cannot forge one (signature + causal-validity checks).
4. A revoked device cannot move the predicate in its favour: the predicate can only be made true by *absence* of entries, and S controls what its live doc contains because nothing from a probation peer is merged before adoption.
5. Therefore the only transition from `'revoked'` to admitted is the one the ticket wants: a verified grant makes S's own lone revoke a mere vote. That is a replay outcome, not a gate exception.

The sequence "S blind-revokes `T`; later the quorum forms": between the two, `T` can reach S in probation only. After the quorum syncs in via a third device (or via `T` itself delivering it), the predicate is false. If the quorum entries and the grant arrive in a *single* sync message, the projection that evaluates them is one pass, so the predicate is never true alongside them.

### 5. Red tests the Maker must write (before any implementation)

Pure predicate (new unit test next to wherever `isUncorroboratedRevoke` lands):
1. True for a self-signed revoke with no grant/genesis row for `T` and no other signer.
2. **Never set for corroborated revokes:** false when a verified `grant` for `T` exists (admin case, and quorum case); false when another signer has a revoke for `T`; false when the revoke was signed by another device only; false when `T` is `'admin'`.
3. **Cleared paths, both:** start true; apply (a) the grant only, status becomes `'admin'`, predicate false and `devices.revoked_at` cleared; (b) a genuine quorum (grant + enough votes), status `'revoked'`, predicate false.
4. **Restart persistence:** close and reopen the DB (and separately run the full purge/rebuild path); the predicate gives the same answer in both the true and the false state.
5. Forgery: an untrusted/forged grant entry (bad signature or invalid signer) does not clear the predicate (not inserted into `applied_authority_log`), and a forged revoke from another signer does not either.

Gate and transport:
6. `evaluateAuthenticate` returns `ok:false` with `probationEligible:true` only when the predicate holds; in every other `'revoked'` case it carries no such field. `evaluateLogin` and `evaluatePairingRequest` still deny a probation-eligible device.
7. Probation peer is never in the admitted set or `peerDeviceIds`; no sync message S sends contains any change from S's live doc (assert on the bytes: scratch starts empty); no change from the peer appears in S's live doc before adoption.

End to end (real two-device harness, no third device; use `test/integration` helpers):
8. **Strict 2-device recovery:** X (not the founder-of-record for A's grant) blind-revokes admin A under lag; A reconnects; A's grant is adopted; A ends `'admin'`, `devices.revoked_at` cleared on X, A fully admitted on the next connection, X's Roster shows A as not revoked.
9. **Never-readmit, plain:** quorum-revoked A is refused on a reconnect attempt on every peer, no probation offered.
10. **Never-readmit, blind then quorum:** X blind-revokes A (probation available, assert); then the genuine quorum arrives (via a third device C that carries grant + votes); assert predicate false, A denied at Gate A, A's scratch-doc delivery attempt is never merged, and A is refused after restart of X.
11. **Single-message case:** grant + quorum votes delivered in one merge; assert there is no observable state with status `'revoked'` and `probationEligible` true.
12. **Ordinary revoked device in probation:** a lost ordinary device revoked by X gets no data from X and writes nothing into X's live doc (the adoption test fails for lack of a grant); stream closes.
13. Existing 2026-10-03 amendment tests 1-6 stay green, unchanged. Test 5 of that list ("two-device residual is observed") is **inverted by this ticket** and must be rewritten to the recovery assertion above.

### Files affected

- `electron/auth/connectionAuth.js` (the predicate call and `probationEligible` field in `evaluateAuthenticate`), a new small module for `isUncorroboratedRevoke`, `electron/sync/automerge/authGate.js` and `electron/sync/automerge/syncNode.js` (the probation stream and scratch-doc adopt). `docs/adr/` "Known limitation (v1)" and `SECURITY.md` Known limitations are updated by the Maker when green.

### Contract check (`org-interface-contracts`)

Idempotent: the predicate is a pure read; adopt is an Automerge merge, idempotent by construction. Concurrent retries: probation streams are per-peer and independent; a repeated delivery re-runs the same adoption test. Unknown outcome: a dropped probation stream leaves S unchanged; the peer retries. Error shape: the existing `{ok:false, code:4404, reason}` plus one optional field, so unmodified callers fail closed. Authority boundary: `authority_cache` stays the single enforcement truth; no gate reads a stored flag; nothing probation-side reaches `authorize()`. Trust boundary: all peer data is verified (signature, causal validity, genesis match) in a scratch doc before it touches the live doc.

### ADR / schema

No schema change, no new synced primitive, no Tier-4 capability. Reversible: removing the field and the probation branch restores today's behavior.

### Open questions for Governor

1. Product call: is a lock-out of an offline-for-weeks blind-revoked admin acceptable with no expiry on probation eligibility? Recommendation is no expiry (above), confidence medium.
2. Confirm the quorum threshold for a two-admin camp: if a founder alone can quorum-revoke a sole other admin, a "blind" revoke by the founder is not blind at all and this ticket only covers non-founder revokers. The Maker must read the threshold in `authorityReplay.js` before test 8 and report it.

### Revision 2026-10-11b: design-review corrections (Security F1-F3, Red Hat R1-R6) — supersedes the conflicting parts of the amendment above

The Security and Red Hat design reviews of the amendment above raised blockers. They are resolved here; where this section and the amendment above disagree, **this section governs**. The predicate (Section 1) and the lifecycle (Section 3) are unchanged. The probation channel (Section 2) is replaced by the following.

**Q2 answered (quorum threshold).** `quorumThreshold(n) = floor((n-1)/2)+1` (`electron/automerge/authorityReplay.js`): n=1 and n=2 need one vote, n=3 and n=4 need two. In a camp with two admins either admin alone can fully revoke the other, and that revoke is genuine, not blind. A *blind* revoke of an admin therefore needs at least three admins ever granted, with the revoker not yet holding the target's grant. The "strict two-device" scenario is the case where the third admin (the granter, F) is offline or absent and only X (revoker) and A (target) can reach each other. The end-to-end test builds F as a signing identity that never runs a node.

**Wire shape (replaces "scratch doc driven by a sync state").** No Automerge sync is run with the probation peer, so the untested "sync from an empty-start doc" question disappears:
1. `evaluateAuthenticate` gains an optional `selfDeviceId`. Inside the existing `authority_cache = 'revoked'` branch it still returns `ok:false, code:4404, reason:'device_revoked_by_authority'`, and adds `probationEligible:true` only when (a) `isUncorroboratedRevoke(db, selfDeviceId, T)` and (b) the device row's already-bound `libp2p_peer_id` equals the connecting peer id. (b) is a **read-only** comparison, never `bindOrVerifyPeerIdentity` (which would TOFU-bind an attacker's peer id as a side effect of a denial). This closes Security F1: a stolen token presented from a different peer id gets plain 4404.
2. `authGate.js` sends `auth_failed` with `probation:true` and records a one-shot, 60-second, size-capped (50) pending grant `{peerId -> deviceId}`. Only that peer id can then open a new protocol `PROBATION_PROTO` (`/shoresh/probation/1.0.0`), which is a different protocol id from every normal protocol so no `hello`, schema or camp metadata of S's live doc is ever sent on it. The handler consumes the grant, receives **one** frame (the peer's whole document, capped at the existing 32 MiB frame cap, which is therefore also the cumulative cap) and passes the bytes to `syncNode`. S sends back only a tiny JSON ack (`probation_adopted` or `probation_refused`). The pending grant, not the connection, is what authorises the push, and the peer is never added to `authenticatedPeers` or `peerDeviceIds`.
3. The revoked device's side: `mutualAuth` already receives the `auth_failed` reply via `onRejected`; a new injected `onProbationOffered(peerId)` fires when `reply.probation === true`. `syncNode` wires it to push `A.save(<own live doc>)` over `PROBATION_PROTO` and, on `probation_adopted`, call `mutualAuth.tryAuthenticate(peerId)` so the normal admitted path runs.

**Adoption = verify the UNION, then merge (Security F2, Red Hat R2).** S never merges the peer's document on the strength of a replay of the peer's document alone. In one synchronous section (no `await`, so no quorum entry can land between the check and the merge):
1. Re-evaluate `isUncorroboratedRevoke(db, selfDeviceId, T)` **now**; false means refuse. (This is the mid-stream re-check: a quorum that arrived after the grant was issued flips the predicate false.)
2. `A.load` the bytes; refuse unless `sharesGenesis`.
3. Build `trial = A.merge(A.clone(liveDoc), incoming)`, run `createVerifiedEntryTrust` + `createAuthorityReplayContext` on `trial`, and require **`T` in `grantedSet` of the trial**, and `resolveAuthorityPeerIds(trial).get(T) === fromPeerId` (the Noise-authenticated peer id equals the grant's `target_peer_id`; Security F1, second layer).
4. Only then `A.merge(liveDoc, incoming)` for real, reconcile and project. If any step fails, nothing is merged and nothing is written. A trial that leaves `T` revoked (for example the peer's document carries one more vote against `T`) is therefore discarded in full, including the peer's data.

The peer's whole document, including its own edits, is merged on success. That is acceptable because success means the union replay classifies `T` as a current, verified admin.

**The guarantee, restated honestly (Security F3, Red Hat R1).** The original wording ("absolute") overclaimed. The true, provable statement is:

> **Once a genuine quorum revocation of `T` is in S's own document, `T` is never admitted by S and S never merges anything from `T` via probation, in any ordering, including after restart.**

What is *not* claimed: S cannot know about a quorum it has not yet received. If S blind-revoked `T`, a real quorum Q revoked `T` elsewhere, and `T` (cut off from Q) reaches S before Q does, S's view is "one lone vote against a granted admin", which is below threshold; the adoption test passes and `T` is admitted by S. This is an honest-failure window (plain sync lag between S and Q), and it is **bounded and self-closing**: when Q's entries reach S by any path, the replay is monotonic under merge, `T` is `'revoked'` again, `tearDownRevokedConnectedPeers` evicts `T`, Gate A denies it, and the predicate is false. What `T` obtained during the window is what an admitted peer of S gets. This residual cannot be closed without S knowing a quorum it does not know; it is recorded in `SECURITY.md` and needs the owner's explicit acceptance. A test asserts the re-eviction.

**Residuals recorded rather than designed away (Red Hat R3-R6).**
- *R3, WAN:* `revokeDevice` forgets the revoked peer's address and rotates the rendezvous namespace and address key, and the revoked device is never sent the new values. Recovery is guaranteed over the LAN, and over any path where the revoked device still knows how to reach S. It is **not** guaranteed over the WAN ladder once rotation has run. No new rendezvous channel is added for a revoked peer (that would be a readmission-adjacent leak).
- *R4, latent vote:* after recovery S's lone vote against `T` stays in the document (it is permanent by the replay's own rule, and `T` is granted, so it is a counted vote). At n=3 `T` is then one honest revoke from another admin away from removal. No tidy-lie fix is attempted; the Roster shows `T` as an admin because that is what the replay says. Re-granting `T` would void the stale vote (the replay drops votes that predate a later grant) and is the operator remedy.
- *R5, two blind revokers:* if two different admins each blind-revoke `T`, the predicate is false (another signer exists) and, once the grant arrives, two votes at n=3 are a legitimate quorum. That is the correct replay outcome, not a bug, and it is **not** recoverable by this mechanism. The ticket's scope is the single-revoker lock-out.
- *R6, DoS:* a probation delivery costs one `A.load` + one trial merge + one replay. It is gated by a valid camp token, a bound peer id, a one-shot 60 s grant and the 32 MiB frame cap. The only standing cost is that a revoked ordinary device (a lost laptop) can make S do that work once per authenticate; accepted as an honest-failure cost.

**Red tests added by the reviews** (in addition to the 13 above): peer-id mismatch gets no `probationEligible` and cannot push; a peer document carrying an extra vote against `T` is discarded whole; a quorum arriving between the grant and the push is refused at the commit-time re-check; the stale-S window admits and the later quorum re-evicts.

### Closure (T333 landed)

The "Known limitation (v1)" section above is closed by this mechanism, with the residuals listed in this revision. `SECURITY.md` Known limitations records the same.

## Amendment 2026-10-13: genesis anchored on the camp signing key

**Defect.** The genesis entry was "axiomatic" and unsigned, and the replay took the founder from the first genesis in record-id order. Any paired device could write a genesis whose id sorts first and names itself, become founder and admin in every replay, then sign a revoke of the real founder that verified. Reproduced end to end before the fix (counselor `admin`, founder `revoked`).

**Rule.** The founder is the genesis entry whose signature verifies against **this device's local `camps.signing_public_key`**, the same trust root as the signed device roster (T376, `deviceRosterSignature.js`). The key is written locally at bootstrap or join and is never read from the document. The signature covers `{id, camp_id, target_device_id, target_peer_id}` under its own domain-separation context (`shoresh-genesis-sig-v1`, `genesisSignature.js`), so it cannot be replayed under another id, camp or target, and cannot verify as a roster, credential or authority-entry signature. Bootstrap signs the genesis with the Host signing key. Replay counts only a genesis that verifies; every other genesis is ignored (the projector logs it with gate `genesis-not-camp-signed`). If several verify, the lowest id wins; only a holder of the camp key can mint one.

**Why not pinning the first genesis seen.** A joiner receiving a document that already contains a forged genesis cannot tell the forgery from the real one by anything in the document. Only the camp key, which the joiner holds from the authenticated join reply, separates them.

**Required root.** The camp root `{campId, publicKey}` is a required parameter of every entry point that reads genesis: `createVerifiedEntryTrust`, `createAuthorityReplayContext`, `currentRevokedDeviceIds`, `currentAuthorityState`, `isValidAdminAt`, `resolveAuthorityPeerIds`, `revocationDigest`, `rotatingDiscoveryDigest`, `rotatingServiceTag`, `electedRotator`, `checkRendezvousRotation`, `collectRevocationEvidence`, `validateRefusalEvidence`. A missing root throws; there is no fallback to trusting the document. Production callers read it with `readCampRoot(db)`. A device that has no `signing_public_key` yet passes `publicKey: null`: no founder resolves, so no admins and no authority rows (fail closed), and projection does not throw.

**Same-seam fix.** The projector recorded an `applied_authority_log` row for any validly signed revoke without the "signer was an admin at the entry's causal position" test that `currentRevokedDeviceIds` applies. It now records a grant or revoke only when its signer was an admin at that position, and a genesis only when it is the camp-signed one.

**Host handoff.** A handoff moves the private half of the camp key and leaves `camps.signing_public_key` and `camp_authority_log` untouched. The founder remains the original device (genesis names a device, not "the Host"), the admin set is unchanged on both devices, and the new Host's grants apply because it is an admin by grant. Pinned by `electron/auth/hostHandoff.founder.test.js`.

**Consequences.** Fresh camps only: a camp whose genesis was written unsigned resolves no founder, and no backfill or shim is provided (pre-production, no live users). Whoever holds the camp private key (the Host) can mint a founder genesis; that is already the authority the key carries. Tests that build documents with a genesis sign it with a test camp key (`genesisTestKit.js`) instead of weakening the rule.

**An entry is one signed change (round 3).** Authority is a pure function of the SET of Automerge changes, never of which write currently wins a field and never of the order changes are listed in (`getChangesMetaSince` order is not canonical for concurrent changes). An entry (genesis, grant or revoke) is defined by ONE change that writes every field of the record and its signature together. `signedEntries` (`authorityReplay.js`) reads the collection at each change's own heads, keeps the fields whose winning write belongs to that very change, and counts a record only if that change wrote every field its kind requires. Writes to the same record by any other change are ignored, so a concurrent overwrite of a signed value (a genesis or grant `target_peer_id`, a revoke's target or signer) can neither alter an entry nor erase it, in either merge order. Required fields: genesis `target_device_id`, `target_peer_id`, `signature`; grant also `signer_device_id`; revoke `target_device_id`, `signer_device_id`, `signature`; `kind` selects the set, and a kind outside those three (`constructor`, `__proto__` and the like) is ignored, never a lookup that can throw. A peer id not yet known is written and signed as `''`.

Signatures bind every field: genesis `{id, camp_id, target_device_id, target_peer_id}` (camp key); grant `{id, kind, target_device_id, target_peer_id, signer_device_id}`; revoke `{id, kind, target_device_id, signer_device_id}` (a revoke signs `''` in the peer-id slot). The authority-entry context is `shoresh-authority-sig-v3`. Identical copies of one entry (same id and values) collapse to the causally earliest, so replaying a captured entry later changes nothing; concurrent copies are both kept. The mint helpers write each entry inside one `runAtomic`, which the document layer applies as a single change. `mintRevokeEntry` therefore produces a revoke that is one change, and refusal evidence (`removalEvidence.js`) ships that change and its causal past; the revoke's own change must write nothing but that entry and its provenance/authorship markers, and a change that carries anything else is not evidence. Fresh camps only: an entry written one field per change is not an entry.

**A removed device is never granted admin again.** A signed entry binds its values but not its causal position, so a byte-identical copy of a genuine revoke written on a fork concurrent with a later re-grant would count as a fresh vote and cancel that re-grant. The precondition is closed by construction: `approveDevice` refuses to approve a device whose local row or `authority_cache` says it was revoked, and the replay (`stateAt` in `authorityReplay.js`) ignores a grant whose target was granted and then removed in the state strictly before that grant. Removal is final for a device id; a removed machine returns through Start fresh with a new id.

**Known limitation (v1).** The same replay still works on a removal vote that never reached quorum: with three or more admins, a pending vote against admin X, and a director's pair-again of X with "make admin", a copied vote placed alongside the re-grant counts again, so X can be removed with one fewer fresh vote. No escalation and no leak. The fix is to sign each entry's causal position (the writing change's deps) and verify the change's deps equal the signed heads, so a copy anywhere else fails verification. Recorded in SECURITY.md, Known limitations.
