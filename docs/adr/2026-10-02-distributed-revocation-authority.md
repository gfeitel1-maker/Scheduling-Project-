---
title: "Distributed-authority revocation: any admin signs, causal-ancestor validity, founder removable"
document_type: adr
authority: normative
status: proposed
date: 2026-10-02
decided: null
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

**Ticket:** T331. **Status: proposed — not accepted.** No code, no capability opened, no merge. Goes
to the product owner for acceptance. This ADR **supersedes**
[`docs/adr/2026-10-02-signed-revocation-witness.md`](2026-10-02-signed-revocation-witness.md) (T330)
in full.

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
  `sharesGenesis` themselves stay unchanged); `electron/automerge/projector.js` (verify-and-replay
  loop, mirroring the tombstone/T330 loop, producing the derived "currently admin"/"currently revoked"
  cache); `electron/sync/automerge/syncNode.js` (gate B); `electron/sync/automerge/mutualAuth.js` /
  `authGate.js` (gate A); `electron/automerge/rebuildSupportCommand.js` and
  `purgeSupportCommand.js` (carry `camp_authority_log` and its derived cache forward); `electron/
  main.js`'s `approveDevice`/`revokeDevice` handlers (now also mint a signed `camp_authority_log`
  entry via the acting admin's own `device_identity_key`, in addition to any existing immediate local
  action).
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

## Open questions for the owner

1. **Is the offline-race residual (an about-to-be-revoked admin's concurrent offline actions validate
   under the strict causal-ancestor rule) an acceptable v1 risk**, bounded by symmetric
   mutual-destruction, full auditability, and manual counter-action in a small, in-person-vetted
   fleet — or does the owner want this flagged as a reason to revisit a quorum/co-sign requirement
   later, understanding that reopens the any-admin-signs constraint this ADR was built to satisfy as
   given? Not resolved here; genuinely a product/risk call, not a technical one.
2. **Should `camp_authority_log` admin status (device-revocation authority) and `users.role = 'admin'`
   (in-app permission authority, Host-signed today per T172) be unified into one concept, or is it
   acceptable for v1 that a device can hold `camp_authority_log` admin status without also holding a
   `users.role='admin'` credential (or vice versa)?** This ADR deliberately keeps them separate to
   bound scope; unifying them would mean also distributing `users.role` signing away from
   `host_signing_key`, which is a second, comparably large decision this ADR does not make.
3. **Should the purge-tombstone single-host finding (above) be spun off as a follow-up ticket now**,
   given the hard verification work it would reuse is already designed here, or deferred until a
   second incident (same "pre-production, no live camps, already-disclosed gap" reasoning the
   2026-09-19 ADR used for a structurally similar deferral)?
4. **Who decides whether a newly-paired device gets admin status at the pairing moment** — is this
   always the approving admin's choice (as designed above), or does the owner want a product rule
   (e.g., "only the original founder, while still present, may grant admin" — which would itself be a
   constraint this ADR's any-admin-signs design does not currently impose)?
