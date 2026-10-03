---
title: "T335 — Key-turning: rotating discovery tag derived from signed T331 revocation state"
document_type: spec
authority: proposed
status: draft
task_class: security-auth
created: 2026-10-03
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/adr/2026-10-02-distributed-revocation-authority.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, SECURITY.md]
related_docs: [docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md, docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md]
archive_when: T335 is implemented, security + Red Hat have reviewed the pure-derivation function, and T334 Slice 3 proceeds against a provably-rotating tag
---

# T335 — Key-turning: the rotating discovery tag prerequisite

**Scope:** this is the prerequisite sub-slice T334 §0 names before the DHT is wired. It does **not**
open `kadDht`/`bootstrap`, install any package, or touch Tier-4 capability state. It is LAN/document-
layer only — same class as T331. It replaces the failed T329 `camp_epoch` design with a derivation
from the already-proven T331/T332 signed authority state.

## Candidate approaches considered

Divergence run under three frames (regulator, attacker, inversion) against the core question: how
should the rotating tag be computed so it is forgeable-proof and a revoked device provably cannot
compute the post-revocation value. The three frames converged on the same requirement set rather
than producing genuinely different mechanisms — summarized here as candidates, not three separate
agent transcripts:

- **(A) Imperative rotate-on-revoke-event, write a new document field** (what T329 did, redesigned
  to be signed). Rejected: still requires *something* to write a mutable field, re-opening the LWW
  merge-race class T329 failed on (regulator frame: "fork disambiguation," inversion frame: "tag
  cached/not invalidated on new entries"), and still needs an imperative call site that can be
  missed (Article V hidden-problem risk the ADR itself flags).
- **(B) Pure function of converged signed replay state, no document write at all.** Every device
  recomputes the tag locally from (a) a one-time-minted per-camp secret and (b) the sorted set of
  currently-revoked device ids, which is *already* the output of T331's `currentAuthorityState`
  replay — the same pure, merge-order-independent function `authorize()` already trusts. No new
  field, no race, no imperative trigger to forget. **Chosen.**
- **(C) Bind the tag to a Merkle root / full change-graph hash from genesis**, per the attacker
  frame's "collude to eclipse newer revocations" worry. Rejected as unneeded: under (B), a device
  that has had entries withheld (eclipsed, offline, or revoked-and-cut-off) computes a **different**
  revoked-set digest than devices with the full state — it doesn't need to be caught by a Merkle
  proof, because it already fails to arrive at the *same* tag, which is the only property discovery
  needs (fail-closed by construction, not by added machinery).

★ Non-obvious pick: (B) is non-obvious because the natural instinct (and the T329/T334-draft
instinct) is "rotation = a write that happens when a revoke happens." The converged design has no
rotation *event* at all — "rotation" is just what you get when you recompute a pure function against
a document that has changed. There is nothing to trigger, and therefore nothing to forget to trigger.

Traps flagged and avoided (from the divergence output, folded into the design below rather than
listed separately): wall-clock or device-local-timer inputs to the digest (inversion frame) — the
digest uses only causally-ordered signed state; caching the computed tag across document mutations
(inversion frame) — recompute on every discovery tick, never persist as "the" tag; mixing an
unsigned field into the digest alongside the signed log (inversion frame) — the only inputs are the
one-time-minted secret (not security-load-bearing, see below) and the T331 replay's own output.

## §1 — The rotating-tag derivation

### 1.1 Inputs, both already causal/signed or non-sensitive

1. **`campDhtSecret`** — the existing `rendezvousDiscovery` document field
   (`electron/sync/automerge/rendezvousNamespace.js`), **mint-only, never rotated**. `mintRendezvousNamespace`
   already handles the one-time, idempotent-against-sequential-calls, safe-even-if-concurrent mint
   (its own header comment: a concurrent double-mint produces one complete winner, never a hybrid —
   this is the SAME property that made T329's two-field split dangerous and this module's single-field
   design safe). This secret is 256 bits of randomness; it is not itself an authorization credential
   (it does not gate document access or admission) — it only widens the discovery tag against
   brute-force/enumeration the way `joinCode.js`'s T286 scrypt derivation already widens the join
   code, and reuses that *same* file's established pattern (derive a tag from a secret + a public
   salt) rather than inventing a second one.
2. **The signed, causal revoked-device-id set** — the output of T331's
   `currentAuthorityState(Automerge, doc, { founderDeviceId })` in `electron/automerge/authorityReplay.js`
   (`admins` = `grantedSet`), combined with the "every device ever targeted" set (today computed
   inline in `projector.js`'s `upsertCampAuthorityLogEntity`, specifically `everyTargetDeviceId`).
   **New, small, pure addition to `authorityReplay.js`** (same module, same "causal-ancestor/quorum
   MATH" scope its header already claims — not a new seam): export
   `currentRevokedDeviceIds(automerge, doc, { founderDeviceId } = {})` returning the sorted array
   `[...everyTargetDeviceId].filter(id => !admins.has(id)).sort()`. This reuses
   `createAuthorityReplayContext`'s existing `stateAt`/`currentState` machinery (already merge-order-
   independent — see `headsClosure`'s and `isCausallyAtLeastAsLate`'s comments) rather than adding a
   second replay path; `projector.js`'s `upsertCampAuthorityLogEntity` can be refactored to call this
   same function instead of recomputing `everyTargetDeviceId` itself (not required for T335, but a
   natural follow-up so there is exactly one definition of "who has ever been revoked").

   Entries are only counted once they have passed the **same `isEntryTrusted` signature-verification
   gate** T331 already applies before anything contributes to `grantedSet`/`votes` — `isValidAdminAt`/
   `currentAuthorityState`'s caller (`projector.js`) supplies that predicate; a bare `kind=revoke`
   field with no valid signature or no causally-prior admin grant for its signer never reaches the
   replay at all. The digest therefore satisfies the inversion-frame requirement directly: there is
   no path by which an unsigned or unverified entry can feed the tag.

### 1.2 The digest and the tag

```js
// electron/automerge/authorityRevocationDigest.js  (new, pure, no SQLite, no network)
import { createHash } from 'node:crypto'
import { currentRevokedDeviceIds } from './authorityReplay.js'

export function revocationDigest(automerge, doc, opts = {}) {
  const ids = currentRevokedDeviceIds(automerge, doc, opts) // sorted, deterministic
  return createHash('sha256').update(ids.join(',')).digest('hex')
}
```

```js
// electron/sync/automerge/rotatingDiscoveryTag.js  (new, pure, mirrors joinCode.js's pattern)
import { createHmac } from 'node:crypto'
import { readRendezvousNamespace, mintRendezvousNamespace } from './rendezvousNamespace.js'
import { revocationDigest } from '../../automerge/authorityRevocationDigest.js'

// `secretHex` is the mint-only campDhtSecret's `namespace` field (already 64 hex chars / 256 bits —
// see rendezvousNamespace.js's DISCOVERY_PATTERN). HMAC, not scrypt: the secret already has full
// entropy, so slowing the derivation down (joinCode.js's reason for scrypt, there defending a
// 50-bit human-typed code) buys nothing here and would needlessly cost every discovery tick.
export function rotatingDiscoveryDigest(automerge, doc, campId, opts = {}) {
  const { namespace: secretHex } = readRendezvousNamespace(doc, campId) ?? mintIfNeeded(doc, campId)
  const digest = revocationDigest(automerge, doc, opts)
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(digest).digest('hex').slice(0, 32)
}
```

(`mintIfNeeded` is a thin wrapper the caller — `syncStarter.js`'s startup path — calls once per camp
lifetime via the existing `mintRendezvousNamespace`; shown inline above only to keep the derivation
function pure and total. The real call site mints once at the point rendezvous/discovery is first
enabled, exactly as `rendezvousNamespace.js`'s own header already anticipates for "the wiring ticket
(T211)" — T335 is that wiring, scoped to mint-only.)

**Nothing is written to the document to "rotate."** `rotateRendezvousNamespace` (the random-rewrite
primitive) is **not called by this design** — it stays exactly as unused-in-production as T334 §0
found it, and stays available only for the director-initiated manual "rotate now" control the ADR
keeps as an *additional* trigger (out of scope for T335; if built later, it would rotate
`campDhtSecret` itself via a fresh mint-and-overwrite, independent of this derivation, which tolerates
a secret change the same way it tolerates a revocation: the HMAC key changes, the digest changes, the
tag changes, no special-casing needed).

### 1.3 Why this is not forgeable

The tag is `HMAC(campDhtSecret, sha256(sorted(revoked_ids)))`. Both inputs are **only** reachable
through verified, causal document state:

- `campDhtSecret` is read from the document field no non-admitted device ever had write access to
  produce usefully (a concurrent mint race still yields one *legitimate* 256-bit value some admitted
  device generated — never a value an attacker chose).
- `revoked_ids` passes through T331's `isEntryTrusted` signature gate before it can appear in
  `grantedSet`/`everyTargetDeviceId` at all — a forged or unsigned revoke entry is dropped before the
  replay, exactly as it already is for authorization purposes today.

A device cannot choose a tag; it can only correctly recompute the one tag that follows from the
document state it actually holds.

### 1.4 Why a revoked device cannot compute the new tag

T331's authorization layer (per this ticket's framing, already shipped) cuts off a revoked device's
further document sync. Concretely: once `authority_cache`/the replay marks a device revoked, that
device's connection attempts are refused at the handshake/sync-message gate
(`docs/adr/2026-10-02-distributed-revocation-authority.md`'s `isPeerRevoked` gate in `syncNode.js` /
`mutualAuth.js`). A device that cannot sync cannot receive any `camp_authority_log` entry written
after its own cutoff point — including every later revocation of *other* devices. Its local replay of
`currentRevokedDeviceIds` is therefore frozen at whatever causal state it held at cutoff, so its
locally-computed digest (and hence tag) diverges from every trusted device's digest the moment any
further revocation lands anywhere in the camp. It is not that the revoked device is blocked from
*using* the new tag — it structurally cannot *derive* it, because deriving it requires document state
it will never receive again.

One honest edge case, explicitly not a correctness requirement: a device may have already received
the very revoke entry that targets itself (the revoking admin's write may reach it before the
connection-level cutoff fully propagates), in which case it can transiently compute the *one* new tag
that followed from its own revocation. This does not weaken the design — T331's independent
authorization gate still refuses that device's connections regardless of what tag it advertises or
dials under (§2, layering). It only matters for *subsequent* revocations of other devices, which this
device will never see.

### 1.5 Determinism across merge order (regulator-frame requirement, answered directly)

`currentRevokedDeviceIds` is built entirely on `authorityReplay.js`'s existing `stateAt`/`headsClosure`
machinery, already documented and tested as merge-order-independent (pure DAG-ancestor reachability,
with `isCausallyAtLeastAsLate`'s hash-string tie-break for genuinely concurrent entries). Sorting the
resulting id array before hashing removes the one remaining place a Set's undefined iteration order
could otherwise leak into the digest. Two devices holding the identical change set therefore always
produce the identical digest and the identical tag, regardless of the order changes were received or
merged in.

## §2 — Trigger: no trigger, a pure recomputation

There is no "rotate" call. `rotatingDiscoveryDigest` is called every time a discovery tag is needed —
on `syncStarter.js`'s existing periodic tick (the same cadence `rendezvousClient.js`'s tick loop
already uses) and whenever the local Automerge document changes (an existing `doc`-change
subscription point in `syncStarter.js`). Because it is a pure function of current document state, the
tag "advances" exactly once a revocation's signed entry has been causally applied locally — no
intermediate imperative step can be skipped, because there is no imperative step. This directly
satisfies the inversion-frame's "tag must never be cached across mutations" requirement: the
derivation is cheap (one HMAC + one SHA-256 over a typically-small id list) and is never persisted as
"the current tag" anywhere; it is recomputed at the point of use.

## §3 — Layering with T331 (stated explicitly, per the ADR's "both, not either/or")

This is the **liveness/discoverability** layer, exactly as
`docs/adr/2026-10-02-distributed-revocation-authority.md`'s "Composing with discovery-namespace
rotation" section already frames it: rotation shrinks how long a revoked device's *old* tag remains
useful for *finding* a peer at all. It never substitutes for authorization. A revoked device that
somehow still holds a cached address, or that mirrors a tag it saw before cutoff, is still refused at
the handshake by T331's `isPeerRevoked` gate (`syncNode.js`/`mutualAuth.js`) — Slice 1's cached-address
reconnect (`peerAddressBook.js`) already terminates at the same authentication gate per that ADR's own
"cannot bypass this witness" section. T335 adds nothing to that gate and changes nothing about it;
it only makes the revoked device harder to *find* in the first place, closing the window the owner
describes as "the keys turn, cutting off a removed device" at the discovery layer, in addition to (not
instead of) the access layer T331 already closed.

## §4 — Scope boundary: which existing consumers get wired, and what's explicitly deferred

**Wired now (safe, no capability, document/LAN layer only):**

- **mDNS tag** (`electron/sync/automerge/discovery.js`). `campDiscoveryTag(campId)` is static today
  (hash of `campId` alone). Add a second, additive function:
  `rotatingServiceTag(automerge, doc, campId)` → `` `${SERVICE_TAG_PREFIX}${rotatingDiscoveryDigest(automerge, doc, campId).slice(0, 16)}${SERVICE_TAG_SUFFIX}` ``,
  same shape/length constraints as the existing function. `createMdnsDiscovery` already accepts a
  `serviceTag` override when `campId` isn't the sole input (`discovery.js:80-83`); `syncStarter.js`'s
  `peerDiscovery` wiring (`:295`) passes the rotating tag through that existing override path instead
  of the static `campId`-only derivation. The static `campDiscoveryTag` function is **kept, unchanged**
  for any caller that still needs a stable per-camp identifier unrelated to discovery (none currently
  known, but removing a used pure function is out of scope for this ticket); only the discovery
  call site in `syncStarter.js` switches to the rotating variant.
- **Rendezvous namespace** (`rendezvousNamespace.js`). No change to the module's shape — `mintRendezvousNamespace`
  is reused as-is for the one-time secret mint. `rotateRendezvousNamespace` remains unwired in
  production by this ticket (see §1.2) — it is not removed, since the ADR keeps a manual "rotate now"
  as an *additional*, separately-scoped control.

**Explicitly deferred (not this ticket):**

- **The DHT itself** (`@libp2p/kad-dht`, `@libp2p/bootstrap`, `dhtDiscovery.js`) — that is T334 Slice
  3, which can now proceed against a tag that provably rotates, closing exactly the gap its own §0
  identified. T335 does not install, import, or reference either package.
- **Cloudflare rendezvous tier re-ranking** (ADR's Slice 5, "ladder ordering/never race tiers") —
  untouched.
- **Director-initiated manual "rotate now"** — out of scope; would be a `rotateRendezvousNamespace`
  call site gated behind a UI action, independent of this derivation (see §1.2's note on tolerating a
  secret change).
- **`projector.js` refactor to share `currentRevokedDeviceIds`** — mentioned in §1.1 as a natural
  follow-up, not required for T335 to be correct; flagged rather than bundled in, per
  karpathy-guidelines (don't widen the diff for a refactor the ticket doesn't need).

## §5 — Schema / Tier-4

**No schema change.** `authorityRevocationDigest.js` and `rotatingDiscoveryTag.js` are both pure,
in-memory functions over the existing Automerge document (`camp_authority_log`, `camps.rendezvousDiscovery`)
and existing SQLite-free replay (`authorityReplay.js`). No new table, column, or document field.

**No Tier-4 capability opened.** No new npm package. The new files import only `node:crypto` and the
existing `authorityReplay.js`/`campDocument.js`/`rendezvousNamespace.js` modules — all already in the
dependency graph. `transportCapabilities.js` is untouched; `kadDht`/`bootstrap` stay `signoff: null`
exactly as T334 §0 left them.

## §6 — Interface-contract check (org-interface-contracts)

This introduces no IPC handler, no new sync-protocol wire message, and no op-log primitive — it is a
pure derivation consumed only by the existing `peerDiscovery` array (an in-process libp2p
configuration list, not a wire message). The relevant checks:

- **Idempotency:** `rotatingDiscoveryDigest` is a pure function; calling it twice against the same
  document state yields the same answer. No side effect to be idempotent *about*.
- **Concurrent-retry safety:** N/A — no write, no retry.
- **Unknown-outcome handling:** if `readRendezvousNamespace` returns `null` (rendezvous/secret never
  minted for this camp), the mint helper mints it synchronously before deriving — there is no
  observable "unknown" tag state; a camp either has a minted secret or gets one on first use.
- **Error shape:** `revocationDigest`/`rotatingDiscoveryDigest` throw only if `authorityReplay.js`'s
  own functions throw (e.g. no genesis entry found) — same failure mode the existing replay already
  has; no new error shape introduced.
- **camp/authorize()/PROJECTIONS boundary:** untouched. This derivation reads the document and the
  replay's output; it writes nothing, so it never touches `applyWrite`/`PROJECTIONS` or `authorize()`.

## §7 — Red-before-green test seams

1. **Pure-function determinism, order-independent.** Build two Automerge docs that apply the same
   set of genesis/grant/revoke changes in different orders (or via different merge sequences), assert
   `rotatingDiscoveryDigest` returns the identical value from both. Red today only in the sense that
   the function doesn't exist yet; once written, this must pass on the first commit — it is a
   correctness property of the design, not a behavior that needs to be grown into.
2. **Revocation advances the tag.** Before any revoke entry lands, compute the tag; apply one valid,
   signed revoke entry via the existing `mintRevokeEntry` helper; recompute. Assert the two tags
   differ. This is the literal red-before-green the ADR's acceptance criteria demand ("a
   red-before-green proof that rotation-on-revocation actually cuts a removed device off") — write the
   assertion first against today's static `campDiscoveryTag` (which will fail, proving the current
   code does *not* rotate), then against the new `rotatingDiscoveryDigest` (which must pass).
3. **A revoked device cannot derive the new tag.** Simulate: device D computes digest at state S0
   (D admin). D is revoked (a second admin's signed revoke entry, never applied to D's own local doc
   copy — i.e. D's doc is frozen at S0, modeling cutoff). A third device, which did receive the revoke,
   computes digest at S1. Assert D's frozen-state digest (still S0) differs from the trusted digest at
   S1. This directly tests the "cannot compute" property without needing a real network cutoff.
4. **No unsigned/peer-writable field.** A structural/governance-style test: assert
   `rotatingDiscoveryDigest`'s only document reads are `camp_authority_log` (via `authorityReplay.js`)
   and `camps.rendezvousDiscovery` (via `readRendezvousNamespace`), and assert no new `A.change`/write
   call exists anywhere in `authorityRevocationDigest.js` or `rotatingDiscoveryTag.js` (e.g. a grep-
   based test asserting neither file imports `A.change` or any `write*`/`applyWrite` helper). This is
   the test that would have caught T329's F1 at design time.
5. **Unsigned/unverified revoke entries never move the digest.** Inject a `camp_authority_log` entry
   with `kind: 'revoke'` but no valid signature (or a signature that doesn't verify against the
   claimed signer's resolved peer id). Assert `currentRevokedDeviceIds`/`revocationDigest` is
   unchanged versus the state before the entry — mirrors T331's own existing test pattern for
   `isEntryTrusted`, applied to this new consumer of the same replay.

## §8 — Open questions for Governor

1. **Whether to bundle the `projector.js` refactor** (sharing `currentRevokedDeviceIds` instead of
   `upsertCampAuthorityLogEntity` recomputing its own `everyTargetDeviceId`) into this ticket or leave
   it as a flagged follow-up (§4). Recommendation: leave it — T335's diff should stay minimal and
   additive; the duplication is small and low-risk until a second consumer appears.
2. **Whether `rotatingServiceTag`'s mDNS wiring is itself in scope for T335 or should land as a
   separate, immediately-following ticket.** The task brief asked for "wires the rotating tag into
   the existing discovery consumers it's safe to touch now," which this design includes (§4) — flagged
   only because it is the one piece of this ticket that touches `syncStarter.js`'s live wiring rather
   than adding new, inert pure functions, and Governor may want Maker to land the pure derivation
   first, separately reviewed, before the wiring PR.
3. **Director-initiated manual "rotate now"** (ADR's "additional, not sole, trigger") is explicitly
   out of scope here — confirm whether a follow-up ticket should be opened now or deferred until a
   director actually asks for it (no UI currently exposes it).
