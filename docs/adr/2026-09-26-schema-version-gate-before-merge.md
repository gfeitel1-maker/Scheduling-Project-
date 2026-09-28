---
title: "Schema-version handshake and a version gate before Automerge merge"
document_type: adr
status: accepted
authority: normative
implementation_state: in-progress
date: 2026-09-26
decided: 2026-09-26
deciders: [architect, product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
amends:
  - docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md
related_adrs:
  - docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md
  - docs/adr/2026-09-17-wan-rendezvous-seam.md
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/adr/2026-09-08-flat-record-shape.md
  - docs/adr/2026-09-18-connectivity-observability-event-vocabulary.md
related_tickets:
  - docs/work/tickets/T222-update-on-open.md
  - docs/work/tickets/T271-schema-version-gate-before-merge.md
program: relay-sync
---

# ADR: Schema-version handshake and a version gate before Automerge merge

## Status

Accepted, 2026-09-26, architect (per T271, authorized by owner via the relay/sync program).
**Amends** `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` rather than superseding
it: that ADR's Decision A ("a camp's devices all run the same build") stands as the product's
*intent*. What this ADR removes is that decision's dependence on a mechanism (update-on-open) the
owner rejected, and replaces it with a real, load-bearing enforcement mechanism at the one place
mixed versions actually become dangerous: the merge step. The 2026-09-18 ADR's premise-removed
note (added 2026-09-26) explicitly asked for this resolution and named it as an open architecture
decision for T271's Architect to make — this document is that decision.

**Revision, 2026-09-26 (same day, before build): the door vs. the merge — owner ruling.** A
downstream reviewer flagged this ADR's strict exact-match default against a hard owner constraint:
**the gate must never present to a director as "this device is blocked from syncing."** That is
precisely the failure mode the owner rejected when closing T222 (update-on-open) — a device held
at the door on version grounds. A revision toward an additive-tolerant policy (relaxing the gate to
allow merges across non-breaking version skew) was drafted to address this, but **the owner then
ruled directly on the question, verbatim: "as fine. self resolve. yes to enable gate."`** Decision,
as ruled: **strict exact-match, and the mismatch is silent and self-resolving — no director-facing
flag or banner.** The additive-tolerant draft and its `mergeBreaking`/migration-audit machinery are
**withdrawn**; this ADR's original strict-exact-match design (below) **stands as originally
written**, with the owner's ruling now recorded as the reasoning that makes it acceptable.

**Why strict-exact-match + silence satisfies the constraint, made unmissable for the next reader:**
this gate is not the update-on-open the owner rejected because it never operates on a *device* —
it operates on a *merge attempt*, silently, once, per received document. Two authenticated,
trusted, online devices are **never told, anywhere, that they are blocked** — there is no log
line, no UI state, no connectivity event visible to a director that says "device X can't sync."
What actually happens, entirely beneath any director-visible surface: a version-mismatched merge
is declined internally (see Decision 3), the connection and trust relationship are otherwise
unaffected, and the *next* document delivery — automatically, the moment either device upgrades —
succeeds with no further action from anyone. **There is no director-visible "not syncing" state at
any point in this design.** A staggered rollout (director's laptop updates Tuesday, office machine
Friday) looks, from the director's chair, identical to today: both devices show as connected the
whole time; the data simply catches up once both are current. That is the confirmed answer to
"is there any residual director-visible blocked state": **no** — silence is the mechanism, not an
incidental property of it, and it is the owner's explicit choice, not an engineering shortcut.

**Revision, round 3 — post-ship correction (Decision 2 was wrong; the carrier, not the policy,
was the defect).** T271 shipped the strict-exact-match policy above, but implemented the
compatibility signal as a field on the shared Automerge **document root** (`genesisDoc()` stamping
`schemaVersion` via a synthetic change), checked in `syncNode.js`'s `handleReceived`. Red Hat and
Security found, and this revision confirms by reading the shipped code, that this carrier choice
was itself broken in three ways — not edge cases, but the common/default paths:

1. **HIGH — every pre-existing camp document is frozen forever.** `schemaVersion` is written only
   at `genesisDoc()` — document *creation* time. Nothing stamps it onto a document created before
   T271 shipped, and no write path ever back-fills it. For every such document,
   `readDocSchemaVersion(incoming)` returns `null` on every delivery, `isSyncCompatible(null, 76)`
   is `false` by design (fail-closed on unknown), and the merge is refused — silently, forever, on
   every delivery, from every device. This is the exact opposite of "self resolve": a document that
   existed before this ADR shipped can never sync again without a manual repair, and nothing
   anywhere signals it.
2. **The shared-root field is racy and wrong even where it IS stamped.** The document root is
   merged CRDT state, not a per-device fact. If a v76 and a v77 device both write to the same
   field, it becomes an LWW race between two values, and worse: once *any* device has ever written
   a higher version into the shared root, *every other device* — including two mutually-compatible
   v76 devices syncing with **each other**, with no v77 device anywhere in that specific exchange —
   reads that stale higher value and refuses to merge with each other too. A shared field cannot
   answer "is the peer who sent me THESE bytes compatible with me"; it can only answer "has this
   document ever, anywhere, been touched by a higher version," which is a different and useless
   question for this purpose.
3. **The shipped gate only covers the wrong sync path.** `syncNode.js`'s real, production sync
   mechanism (per the Stage 5f-2 comment in the file itself) is the incremental
   `A.generateSyncMessage`/`A.receiveSyncMessage` exchange (`stepSync`/`handleSyncMessage`,
   triggered from `onPeerAdmitted`) — `handleReceived`/`sendDocTo` (where the T271 gate was placed)
   is, per that same comment, now used only for direct-send and adversarial-input tests. **The
   shipped gate is not on the path that actually runs in production.** `onPeerAdmitted` calls
   `stepSync(peerId)` unconditionally, and `handleSyncMessage` calls `A.receiveSyncMessage`
   unconditionally — neither checks compatibility at all. This is worse than the original pre-T271
   defect being partially fixed: it is fully unfixed on the path that matters.

**The fix is a carrier change, not a policy change.** The strict-exact-match *policy* (Decision 2's
compatibility rule) and the "refuse the merge, not the auth" *placement* (Decision 3) both remain
correct and are unchanged by this revision — what was wrong is *what value the gate compares*.
Decision 2 is rewritten below to use the **per-device schemaVersion already carried in the
`authenticate` handshake** (Decision 1's field, which the first two drafts of this ADR left as
"observability-only" — that restriction is what was wrong) as the sole authoritative signal, and
the document-root field/`genesisDoc()` synthetic change/`readDocSchemaVersion` are **removed
entirely** rather than kept as a second, now-provably-unreliable source of truth. See the rewritten
Decision 2 and Decision 3 below; nothing above this point in the Status section needed to change.

## Context — verified against the tree, not memory

- `electron/sync/automerge/syncNode.js:190` refuses a document that does not share this camp's
  Automerge genesis (`sharesGenesis`, `electron/automerge/campDocument.js:380`), then at line 200
  calls `A.merge(currentDoc, incoming)` **unconditionally** on any same-genesis document. No
  schema-version check exists on this path.
- `electron/sync/automerge/mutualAuth.js:343` sends `{ type: 'authenticate', token, device_id }`.
  No version field. `electron/sync/automerge/authGate.js` replies `{ type: 'auth_ok' }` or a deny
  shape; a peer's schema version is never known to either side.
- Contrast `electron/sync/automerge/rendezvousRecord.js:159-161`, which already version-gates a
  different wire artifact (`if (version !== VERSION) return { unsupportedVersion: true }`, checked
  before any further parsing). The absence on the merge/handshake path is an inconsistency in this
  project's own established practice, not a considered omission.
- `electron/db/localDb.js:33` — `CURRENT_SCHEMA_VERSION = 76`. Migration guards are one-wide
  (`>= N-1 && < N`, `localDb.js` ~3089), and `migrationDomainState.test.js` asserts no gaps from 1
  to `CURRENT_SCHEMA_VERSION`. v77 exists unmerged (T267); v78 exists on a peer branch.
- **Installed dependency, verified (`org-source-verification`):** `@automerge/automerge` resolves
  to **3.4.1** in this checkout's install tree (`package-lock.json` pins `^3.4.1`; the installed
  package.json at `node_modules/@automerge/automerge/package.json` in the main checkout confirms
  `3.4.1`). Automerge's `merge(doc1, doc2)` is a structural CRDT merge over the whole document — it
  has no schema-version concept, no partial-merge or field-filtering hook, and no way to reject or
  subset a merge by any application-level compatibility rule. **The gate must therefore sit in
  application code, strictly before `A.merge` is called** — there is nothing inside Automerge 3.4.1
  itself to delegate this to.
- `electron/automerge/campDocument.js` documents the actual document encoding
  (`docs/adr/2026-09-08-flat-record-shape.md`): one Automerge map key per `recordId\x00field`,
  not per record. Writes go through `applyProjection`-equivalent logic where **"a field not
  registered in `PROJECTIONS[entity].fields` -> silent no-op"** (campDocument.js:407). This is
  exactly why a **purely additive** schema change (a new field, a new entity type) is already
  safe-by-construction across versions: an older device's code simply never writes or reads a key
  it doesn't know about, and Automerge's merge just carries that key through untouched for when the
  device eventually upgrades. **The real danger is a *renaming* migration** (T271's example: v73's
  table rebuild, `localDb.js` ~3091 renaming SQLite columns) — if a rename ever changes the field
  *name* a device's write path encodes into the document key (not just the SQLite column), two
  devices on either side of that migration write two *different* keys for the same logical field,
  and the CRDT merge has no way to know they mean the same thing: both keys survive, one is stale,
  and nothing surfaces this as an error. That is silent, permanent data drift baked into shared
  CRDT history — worse than a crash, because it looks fine.
- The projector (`electron/ops/projector.js`, referenced from `CLAUDE.md`) already fails atomically
  and surfaces the failure (`onProjectionError`) when a merged doc violates a domain invariant it
  can detect — but a field-rename collision is not a domain-invariant violation the projector can
  see; both keys are individually well-formed, so this existing safety net does not catch this
  specific class of risk. That gap is why a gate is needed at all, rather than relying on the
  projector's existing error-surfacing.
- **The two defects this ADR exists to close, cited for T271 as well as here**:
  `electron/sync/automerge/mutualAuth.js:33` — the `authenticate` message construction carries no
  version field, so a peer's schema version is never known to either side; and
  `electron/sync/automerge/syncNode.js:187→200` — `sharesGenesis` is checked, and then `A.merge` is
  called unconditionally immediately after, with no schema-compatibility check of any kind in
  between. These two line ranges are the entire defect; the rest of this document is the fix.

## Candidate approaches considered (adhd divergence)

1. **Handshake-only version gate** (check `schemaVersion` at `mutualAuth`/`authGate`, refuse auth
   on mismatch). *Rejected as sole mechanism*: the handshake partner's app version is not
   necessarily the *document's* origin version once relaying exists (`syncNode.js`'s own comment:
   "a newly-admitted peer is sent the whole doc" — a doc can arrive via a peer merely relaying it).
   Gating identity on a proxy for the thing that actually matters (the document's field encoding)
   is the wrong seam to make load-bearing, though it's still useful as a cheap early signal.
2. **Document-embedded version gate only** (read a `schemaVersion` field out of the decoded
   incoming doc before merge; no handshake change). *Rejected as sole mechanism*: works but is
   strictly reactive — a fully incompatible peer is dialed, authenticated, and sent a whole
   document transfer before anything notices, wasting a WAN peer's bandwidth/time and giving no
   early observability signal in the connectivity-events vocabulary that already exists for this
   kind of thing (`docs/adr/2026-09-18-connectivity-observability-event-vocabulary.md`).
3. **Capability/version-range negotiation in the handshake** (peer advertises a supported range,
   the two sides negotiate a common subset to merge). *Rejected*: over-engineered for what this
   ticket needs — Automerge has no field-subset merge primitive to execute a negotiated "partial"
   merge against (confirmed above), so a negotiated range has nothing to act on beyond "merge or
   don't." Designing a negotiation protocol to produce a binary outcome is solving a harder problem
   than the one that exists.
4. **Reuse the `rendezvousRecord.js` VERSION-byte pattern verbatim on the handshake payload only.**
   *Rejected as sole mechanism* for the same reason as (1) — right pattern, wrong single location,
   given relaying.
5. ★ **Both (1) and (2) together, non-redundantly scoped**: handshake carries `schemaVersion` as a
   cheap, early, observable check (peer-identity-adjacent, feeds the existing connectivity-events
   vocabulary); the document itself carries an authoritative `schemaVersion` root field that is the
   thing actually checked immediately before `A.merge`, because that is the value that determines
   whether the *bytes about to be merged* are safe, independent of who relayed them. This is the
   smallest design that is actually correct: it doesn't invent a negotiation protocol Automerge
   can't execute against, and it doesn't rely on a proxy signal (peer version) where a direct one
   (document version) is available and cheap to check (already decoded via `A.load` at
   `syncNode.js:175`).

**Converged on 5.** Confidence: high that the two-signal design is correct given Automerge 3.4.1's
actual merge semantics (verified, not assumed). The exact compatibility *policy* (strict
exact-match vs. additive-tolerant) was debated further during design and is now settled by direct
owner ruling — see the door-vs-merge note above and Decision 2 below.

## Decision

### 1. Wire contract change — handshake

Add `schemaVersion: CURRENT_SCHEMA_VERSION` (integer, from `electron/db/localDb.js`) to the
`authenticate` message body sent from `mutualAuth.js:343` and to `authGate.js`'s reply. This is an
**additive field on an existing message type**, not a new message type — every existing test that
asserts message shape with `toEqual({ type: 'authenticate', ... })` (there are many; see
`grep` results above) must add the field, which is the visible, mechanical cost of this change and
should be called out to Maker directly.

- **Forward/backward compatibility of the field itself**: a v76 device talking to a v80 device
  that sends `schemaVersion` — v76's authGate must not reject the message merely for carrying an
  extra field it doesn't require; treat `schemaVersion` as optional-to-send, required-to-log. A
  device that omits it (a hypothetical pre-T271 build) is treated as `schemaVersion: null` /
  "unknown" — logged, not silently trusted as compatible and not auto-rejected either (see
  Decision 2's default policy).
- **What this field is used for — REVISED, round 3: this is now the sole authoritative signal**,
  not an observability-only optimization as the first two drafts said. See Decision 2 (rewritten)
  below for the reasoning and the fail-closed handling of a peer that omits it.

### 2. The authoritative signal — REWRITTEN, round 3: per-device handshake value, not a document field

**The document-root `schemaVersion` field, `genesisDoc()`'s synthetic stamping change
(`schemaVersionChangeBytes`/`GENESIS_SCHEMA_CHANGE_ACTOR`), and `readDocSchemaVersion` are REMOVED
entirely.** They are not kept as a secondary or defense-in-depth signal — a field this ADR itself
now shows to be unreliable (frozen-forever on pre-existing documents, racy under concurrent
stamping, and answering the wrong question — "has this document ever seen a higher version,"
not "is the peer who sent me these bytes compatible with me") is worse to leave in place than to
remove, per the reviewing agent's framing: a dead, misleading field invites a future reader to
trust it. `genesisDoc()` reverts to exactly what it was before T271: `A.load(GENESIS_B64)` with no
additional applied change. This also **resolves Red Hat/Code-Reviewer's genesis byte-identity
concern for free** (see the tripwire note at the end of this section) rather than needing a new
test to defend a mechanism that no longer exists.

**The authoritative signal is the per-device `schemaVersion` already carried in the `authenticate`
handshake (Decision 1), recorded per `peerId` at authentication time, and read back by `peerId` at
merge time — never derived from document content.**

- **Mechanism**: `onAuthenticate` (`syncNode.js`) already receives `msg.schemaVersion` (sent by
  `mutualAuth.js:344/370`, already logged by `authGate.js:161-162` — the wiring exists, it was just
  never stored). On a successful `evaluateAuthenticate`, record
  `peerSchemaVersions.set(fromPeerId, typeof msg.schemaVersion === 'number' ? msg.schemaVersion :
  null)` in a new `Map` alongside the existing `syncStates` map, cleared on disconnect the same way
  `syncStates` already is (`onPeerDisconnected`). `isSyncCompatible` (Decision 1's function) is
  unchanged in shape — it still takes two version numbers and returns a boolean — only what gets
  passed to it changes: `isSyncCompatible(peerSchemaVersions.get(peerId), CURRENT_SCHEMA_VERSION)`
  instead of `isSyncCompatible(readDocSchemaVersion(incoming), CURRENT_SCHEMA_VERSION)`.
- **Fail-closed, unchanged in spirit, now unconditional**: a peer whose handshake omitted
  `schemaVersion` (a hypothetical pre-T271 peer — moot in practice, since T271 is what makes the
  gate exist at all, but still handled) or sent a non-numeric value is recorded as `null` and
  treated as incompatible by `isSyncCompatible`'s existing `typeof === 'number'` check — **no
  merge, no sync-state exchange, nothing succeeds for that peer, ever, until it sends a real
  version.** This is if anything a strengthening of Security's fail-closed requirement against
  ACCIDENTAL mismatch, not a weakening: previously an attacker who stripped the *document's* field
  could still merge if the document field happened to read as compatible garbage; now the signal is
  anchored to a live, per-connection, freshly-authenticated fact rather than mutable shared state.
  **This gate is an accident-prevention mechanism for honest version skew — it provides NO defense
  against a malicious or compromised already-authenticated peer**, which can forge its own announced
  `schemaVersion` for free simply by lying in the `authenticate` frame; no forgery of the
  authentication itself is required, since the field is self-reported and never independently
  verified. This is consistent with, not an exception to, `SECURITY.md`'s already-accepted
  limitation that a compromised paired peer is attacker-controlled at the CRDT layer — this gate
  narrows the *accidental* mixed-version-fleet case, not the adversarial one.
- **The pre-existing-document defect disappears with no backfill, no migration, and no LWW race —
  this is the definitive convergence argument requested**: the signal is now a fact about *the
  connection*, learned fresh at every authentication, never stored in or read from the document.
  A document created before T271 shipped has no `schemaVersion` field to be missing, stale, or
  racy — there is nothing in the document for this gate to read at all anymore. Two v76 devices
  syncing with each other converge exactly as they always did, regardless of what any third,
  differently-versioned device may have ever written into the shared document — because the gate
  never inspects the document to decide compatibility, only the live peer connection. There is
  categorically no shared mutable state for two concurrent stampers to race over, because nothing
  is stamped. **Upgrade convergence**: upgrading this Electron app requires restarting the process
  (there is no live in-place code swap), which tears down and re-establishes the libp2p connection,
  which re-runs the `authenticate` handshake with the new build's real `CURRENT_SCHEMA_VERSION`.
  The very next connection cycle therefore re-evaluates compatibility from scratch with the correct,
  current value on both sides — no stale state to reconcile, no partial state to migrate, nothing
  to converge apart from a fresh handshake that already happens on every reconnect today.
- **Why the connection's version is a sound proxy for the document's actual data shape, stated
  explicitly (the one caution flagged during design)**: under **strict exact-match**, a peer whose
  handshake reports `CURRENT_SCHEMA_VERSION = 76` could never, by construction, have authored or
  merged any `77`-shaped write — this device's own code is the only thing that has ever produced
  `77`-shaped writes, and this device has never accepted a merge from anything but another
  exact-match-76 peer (recursively, back to whenever this camp's fleet last had a fully-converged
  version). So the connection's version and the document's actual field-encoding cannot diverge
  under this policy — the invariant is maintained by the gate itself, transitively, not assumed.
  This argument would NOT hold under an additive-tolerant policy (a relayed document could carry
  data shapes from a version its immediate sender never itself ran) — which is a further reason
  strict-exact-match, not additive-tolerance, is the right default for this carrier, independent of
  the owner's separate ruling on the director-visibility question.
- **Genesis byte-identity tripwire — Red Hat/Code-Reviewer MEDIUM, resolved by removal**: removing
  `schemaVersionChangeBytes`/`GENESIS_SCHEMA_CHANGE_ACTOR` means `genesisDoc()` is once again just
  `A.load(GENESIS_B64)` on a frozen, immutable base64 blob with no change applied on top — two
  separately-constructed calls are trivially byte-identical (same input, same deterministic decode,
  zero operations applied), which is a *stronger* guarantee than the fixed-actor/fixed-time trick
  the shipped code used to approximate the same property. **No new tripwire test is required by
  this ADR** for that reason; Maker should confirm whatever pre-existing genesis-identity coverage
  predates T271 (this class of guarantee is not new to this ADR — see `sharesGenesis`/
  `genesisRootHash`'s existing comments) still passes once the synthetic change is removed, but
  this ADR is not introducing a new invariant to test, only reverting to the one that already
  existed before T271 touched `genesisDoc()`.

**Compatibility rule (unchanged from the owner's ruling — this revision changes the carrier, not
the policy) — OWNER-RULED, 2026-09-26, verbatim: "as fine. self resolve. yes to enable gate."**
Decision: **strict exact-match**, and the mismatch is **silent and self-resolving** — no
director-facing flag, banner, or any other surfaced state (this project's own "no banners, use
flags" convention, `CLAUDE.md`, is honored by *not creating a flag either* — there is nothing here
that rises to something a director needs to see; see the door-vs-merge note above for why silence
is precisely what keeps this from being update-on-open).

- Default policy: a merge (or sync-state exchange — see Decision 3) is allowed only when the
  connected peer's handshake-reported `schemaVersion` equals this device's own
  `CURRENT_SCHEMA_VERSION` exactly. `null`/non-numeric (peer sent nothing usable) is always
  incompatible — never an automatic pass.
- **Why exact-match, and why this is not the additive-tolerant idea it was briefly revised toward**:
  a prior draft of this revision proposed relaxing the gate to allow merges across version skew
  except at migrations explicitly flagged `mergeBreaking`, leaning on this ADR's own finding that
  the flat-record-shape encoding's "unknown field -> silent no-op" (`campDocument.js:407`) makes a
  purely additive migration safe to merge across by construction. **That draft is withdrawn by the
  owner's ruling above, in favor of the simpler slice**: strict exact-match needs no per-migration
  classification machinery, no migration-history audit, and no `MIGRATION_MERGE_COMPAT` table — it
  is the smaller, safer, and now explicitly owner-approved default. The additive-tolerant idea
  remains available as later, separately-decided follow-on work if the strict default ever proves
  too aggressive in practice (see "Follow-on work"), but it is not part of what T271 builds.
- **Effect on the owner's "when someone comes online, they sync" rule**: preserved for the
  overwhelming common case — two devices on the same build (the normal state of a camp's fleet
  between releases) sync exactly as today, with zero added friction and zero visible change. For a
  device on a different schema version, nothing is blocked and nothing is shown: the merge/sync
  exchange for *that specific peer connection* is silently declined, the connection and trust
  relationship are unaffected, and the very next connection cycle — automatically, once either
  device upgrades — succeeds with no further action from anyone. **Confirmed: under
  strict-exact-match + silent-self-resolve, there is no director-visible "two devices can't sync"
  state at any point.** The only residual case is an internal, invisible, self-healing delay on
  specific peer connections — never a visible blocked-device state — and the owner has ruled this
  framing acceptable; it does not need a fourth owner-ask.

### 3. Where the gate lives, and what "incompatible" does — REWRITTEN, round 3: three call sites, not one

**The shipped code gated only `handleReceived` — the whole-document push path — which the module's
own Stage 5f-2 comment says is now used only for direct-send and adversarial-input tests. The real,
production sync mechanism, `stepSync`/`handleSyncMessage` (the incremental
`A.generateSyncMessage`/`A.receiveSyncMessage` exchange, triggered from `onPeerAdmitted`), had NO
gate at all.** This is Red Hat's MEDIUM finding, confirmed by reading the shipped file: `stepSync`
calls `A.generateSyncMessage` unconditionally and `handleSyncMessage` calls
`A.receiveSyncMessage` unconditionally, for every peer, regardless of version. The fix must cover
all three places `syncNode.js` touches an Automerge merge/sync primitive for a remote peer:

```
// New: recorded at authentication time (onAuthenticate), alongside the existing syncStates map,
// cleared on disconnect the same way. peerId -> number | null.
const peerSchemaVersions = new Map()

function isPeerSyncCompatible(peerId) {
  return isSyncCompatible(peerSchemaVersions.get(peerId) ?? null, getLocalSchemaVersion())
}

// 1. stepSync — do not even BEGIN a sync exchange with an incompatible peer. No sync state is
//    created or advanced for it, so there is nothing for the peer to be marked "caught up" on
//    (Red Hat's bookkeeping concern is closed structurally: the exchange never starts, so there is
//    no acked state to falsify).
function stepSync(peerId) {
  if (!isPeerSyncCompatible(peerId)) return   // silent — no log spam on every trigger, unlike the
                                               // one-shot refusals below; being incompatible is not
                                               // a new fact each time this fires
  const state = syncStates.get(peerId) ?? A.initSyncState()
  // ... existing generateSyncMessage/send, unchanged
}

// 2. handleSyncMessage — refuse to APPLY an incoming sync message from an incompatible peer.
async function handleSyncMessage(bytes, { fromPeerId }) {
  if (!isPeerSyncCompatible(fromPeerId)) {
    console.error(`syncNode: refused a sync message from ${fromPeerId} — schema version ` +
      `mismatch; sync paused for this peer, will resume once versions match`)
    return   // do NOT call A.receiveSyncMessage, do NOT touch syncStates for this peer at all —
             // critically, this means the sync state is NEVER advanced/acked for bytes that were
             // never applied, so the sender's own state (once it re-triggers stepSync on its side,
             // e.g. on its next reconnect after upgrading) still shows this peer as behind and
             // re-offers the same data. This is the mechanism that answers Red Hat's "does a
             // refused delivery mark the peer caught-up" question: no, because the refusal happens
             // BEFORE any syncStates.set call for this exchange, not after.
  }
  // ... existing receiveSyncMessage path, unchanged
}

// 3. handleReceived — same check, same shape, now sourced from the peer map instead of document
//    content (readDocSchemaVersion and the whole-doc-level check are removed, per Decision 2).
async function handleReceived(bytes, { fromPeerId }) {
  // ... existing A.load + sharesGenesis check, unchanged ...
  if (!isPeerSyncCompatible(fromPeerId)) {
    console.error(`syncNode: refused a document from ${fromPeerId} — schema version mismatch; ` +
      `merge skipped, will retry once versions match`)
    return
  }
  // ... existing A.merge path, unchanged
}
```

`isSyncCompatible` (Decision 1's pure function) is unchanged in shape and remains the single Maker
seam for the comparison logic itself; `isPeerSyncCompatible` is a thin, equally pure/testable
wrapper that only changes what's looked up.

**Silent per owner ruling — no connectivity event, no director-facing surface, unchanged from the
prior revision.** The `console.error` lines above are developer-facing logs only (matching the
existing `sharesGenesis` refusal's shape), not part of any UI, flag, or connectivity-events
surface. `stepSync`'s incompatible-peer return is deliberately silent even at the log level — it
fires on every sync trigger for the duration of the mismatch (peer admission, every subsequent
local write, every inbound message from other peers), and logging each one would be exactly the
kind of unbounded-repeat log noise this project already guards against elsewhere (see
`mutualAuth.js`'s `DISCOVERY_EMIT_WINDOW_MS`/`shouldEmitDiscovery` precedent for the same class of
problem) — the one-shot `handleSyncMessage`/`handleReceived` refusals above are the meaningful,
rate-bounded-by-construction log signal (one per actually-received frame, not per trigger).

- **On incompatible version: refuse the merge/sync-message, not the authentication.** Identity/trust
  (`authGate.js`/`mutualAuth.js`) and data-merge-compatibility (`syncNode.js`) are kept as
  independent concerns, matching this codebase's existing seam boundaries (auth is "is this a
  device this camp trusts," merge is "is this data safe to combine"). A version-incompatible peer
  stays authenticated — it can still relay connectivity, still gets included in `getPeers()` — and,
  per the mechanism above, automatically resumes normal sync (fresh `A.initSyncState()`, since
  `stepSync` never created one while incompatible) the moment its next authentication reports a
  matching version, with no re-discovery or re-dial needed beyond the reconnect an upgrade already
  causes. Refusing authentication instead would force a full re-discovery cycle post-upgrade for no
  benefit and would conflate two boundaries this project's own `SECURITY.md`/`authorize()`
  discipline treats as deliberately separate.
- **The incoming bytes/sync message are discarded, never partially applied.** No `setCurrentDoc`,
  no `A.merge`, no `A.receiveSyncMessage`, no projection, and — critically for `handleSyncMessage`
  — no `syncStates.set` for this exchange either, so the sender is never told (via its own sync
  state) that this peer has what it just tried to send.

### 4. Enable-ordering recommendation

**This gate must land before `INTERNET_TRANSPORT_SIGNOFF` flips to `true` / before T211
(rendezvous wiring) is unparked. Confidence: high.**

Evidence: the entire reason this ADR exists is the 2026-09-26 premise-removed note on the
2026-09-18 ADR, which was triggered specifically by the relay/sync program widening this
transport from an mDNS-bounded LAN (where every peer is, in practice, a device from the same camp,
overwhelmingly running the same build) to any internet peer publishing a rendezvous record — a
population where version skew is not a corner case but the expected steady state (this project's
own `INTERNET_TRANSPORT_SIGNOFF` gate in `transportBoundary.guard.test.js` already treats "opening
this boundary" as requiring a completed security review; the same reasoning applies to opening it
without any schema-safety check at all). Shipping WAN transport before this gate exists would
reopen, at internet scale, the exact silent-data-drift risk this ADR's Context section traced to a
specific, real mechanism (field-key rename collisions surviving in shared CRDT history
undetected).

## ADR relationship: amend, not supersede

`docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`'s Decision A ("a camp's devices all
run the same build") is **retained as the product's stated intent** — this ADR does not change what
Shoresh promises to support. What changes is the *mechanism* backing that intent: the 2026-09-18
ADR rested entirely on update-on-open (T222), which the owner rejected ("when someone comes online,
they sync"). This ADR supplies a different, real mechanism — a version gate at the one place
mixed versions become dangerous — that makes the *same* intent (devices converge on one version)
actually safe to violate transiently, rather than requiring it never be violated at all. The
2026-09-18 ADR should be updated to reference this document in place of T222 as "the mechanism that
makes this true," and T222 itself can remain filed/open/unowned as originally recorded (it may
still be worth building for its own UX reasons — prompting a stale device to update — but it is no
longer the thing standing between the fleet and data corruption).

## Owner decisions — RULED, 2026-09-26

Both points this ADR originally flagged as open owner-asks are now settled by the owner's direct
ruling ("as fine. self resolve. yes to enable gate."):

- **Refuse-vs-degrade on incompatible version**: RULED — strict exact-match (refuse), no relaxation
  policy needed for this slice. The additive-tolerant alternative (a migration-audit-driven range)
  remains available as later, separately-decided follow-on work only if strict-exact-match is ever
  found too aggressive in practice — it is not authorized now and was explicitly not what the owner
  chose.
- **Whether a version-incompatible peer surfaces to the director**: RULED — no. "Self resolve"
  means exactly what Decision 2/3 now specify: no flag, no banner, no connectivity event, nothing
  visible. This is the smaller, safer slice per the owner's own framing, and it is why the
  `mergeBreaking`/migration-audit machinery drafted mid-design is unnecessary — strict-exact-match
  needs none of it.

No further owner decisions are outstanding for T271 as scoped by this ADR.

## Follow-on work (not authorized by this ADR, filed for later)

- **Additive-tolerant relaxation, IF EVER NEEDED**: should strict-exact-match prove too aggressive
  in practice (e.g., a rollout window observed to take unusually long to converge), the
  additive-tolerant design drafted and withdrawn during this ADR's revision — a per-migration
  `mergeBreaking` declaration plus a `v1..v76` classification audit — remains available as a
  starting point, but requires its own owner decision before being built; it is not pre-authorized
  by this ADR.

## No SQLite migration required — confirmed (unaffected by the round-3 revision)

**Confirmed, definitively: NO SQLite migration is required, before or after this revision.** Before
round 3, the reasoning was that the document-root field lived in the Automerge/CRDT storage layer,
wholly separate from SQLite. After round 3, the reasoning is even more direct: there is no
document-root field at all anymore — the signal lives entirely in an in-memory, per-connection
`Map` (`peerSchemaVersions`) inside `syncNode.js`, populated from the handshake and never persisted
anywhere, SQLite or otherwise. Nothing in this design touches a SQLite table, column, or index, so
there is no v79 to allocate and no `rollbackV79(db)` to write. (`CURRENT_SCHEMA_VERSION` itself is
still read from `electron/db/localDb.js:33` — but reading an existing constant is not a migration.)

## Consequences — UPDATED, round 3

- `mutualAuth.js`'s `authenticate` message and every test asserting its exact shape must be updated
  to include `schemaVersion` (mechanical, many call sites — flagged above). **Unchanged from the
  prior revision.**
- `campDocument.js`'s `genesisDoc()` **reverts to its pre-T271 shape** — `schemaVersionChangeBytes`,
  `GENESIS_SCHEMA_CHANGE_ACTOR`, and `readDocSchemaVersion` are **removed**. This is new to round 3
  and is a straightforward revert, not a new risk — see Decision 2's genesis-byte-identity note.
- `syncNode.js` gains: a `peerSchemaVersions` Map (populated in `onAuthenticate`, cleared on
  disconnect alongside `syncStates`), an `isPeerSyncCompatible(peerId)` helper, and a gate call in
  **three** places — `stepSync`, `handleSyncMessage`, and `handleReceived` — not one. This is the
  main size change from the shipped T271: the shipped version only touched `handleReceived`.
- No connectivity event, no UI surface (silent, per owner ruling) — unchanged.
- Files Maker will touch (round 3 additions in **bold**): `electron/sync/automerge/mutualAuth.js`,
  `electron/sync/automerge/authGate.js`, `electron/automerge/campDocument.js` (**revert the T271
  addition**), `electron/sync/automerge/syncNode.js` (**larger change than shipped — three gate
  sites, new `peerSchemaVersions` map, `onPeerDisconnected` wiring**), plus the test-shape ripple
  listed above (`mutualAuth.test.js`, `authGate.test.js`, `syncNode.test.js`, `syncProtocol.test.js`,
  `pairingLogin.test.js`, `docUnification.test.js`, `syncNodeAuthGate.test.js`, `transport.test.js`,
  `syncNodeRemoteOps.test.js`, `transportAuthCloseRace.test.js`), **`campDocument.test.js`** (remove
  coverage of the reverted synthetic-change mechanism), **`test/integration/scenarios/
  35-schema-version-gate.automerge.js`** (rewrite — see Verification below; its current construction
  writes a doc-root `schemaVersion` directly, which no longer exists), and
  **`test/integration/harnessAutomerge.js`** (its `startSyncNode` substitution seam already supports
  simulating a different local version via `localSchemaVersion`; round 3 additionally needs a way to
  simulate a *peer's* handshake-reported version for the incremental-path scenarios below). No files
  under `electron/db/` require changes.
- No code ships with this ADR — it is a design decision. See T271 for the implementation ticket
  (now reopened for a round-2 fix, not closed).

## Verification (Maker test seams)

At `test/integration/` (the mandated integration harness for sync per `TESTING_STANDARD.md`), the
existing scenario 35 (`test/integration/scenarios/35-schema-version-gate.automerge.js`) must be
**rewritten**, not extended — its current construction plants a doc-root `schemaVersion`, which no
longer exists after round 3. `harnessAutomerge.js`'s `AmHost`/`AmClient` already let a test start a
node with a simulated `localSchemaVersion` (its own version); round 3 needs the harness to also let
a test simulate what version a peer *announces in its handshake*, independent of that peer's own
`localSchemaVersion` — e.g. an injectable `schemaVersion` override passed through to the
`authenticate` message construction, mirroring the existing `localSchemaVersion` override's "test
seam, defaults to the real constant for every production caller" shape.

1. **Same-genesis, matching versions, real incremental path** (non-regression — this is the "when
   someone comes online, they sync" case): two `startSyncNode` instances, identical
   `CURRENT_SCHEMA_VERSION`, synced via the real `onPeerAdmitted` → `stepSync` → `handleSyncMessage`
   path (not `sendDocTo`). Assert convergence proceeds exactly as before this ADR existed.
2. **Same-genesis, mismatched versions, real incremental path** (the case the shipped T271 scenario
   did NOT cover — plant the actual defect Red Hat found, not the whole-doc-push path that no
   longer represents production traffic): two nodes admit each other normally (real handshake, real
   `schemaVersion` field, mismatched values), so `onPeerAdmitted` fires and `stepSync` runs for both.
   Make a local write on one side. Assert: (a) the OTHER side's document heads never advance — the
   mismatched write never lands; (b) SQLite projection on the receiving side is untouched; (c) no
   exception escapes; (d) **the peer connection and authenticated/trusted state survive unchanged**
   — both `getPeers()` lists still show each other connected; (e) **`syncStates` for this peer pair
   is never advanced past its initial state on either side** — this is the load-bearing assertion
   Red Hat asked for: read the internal sync-state bookkeeping (or a test-only accessor for it) and
   confirm it still reads "nothing acked" after the refused exchange, proving a refused delivery
   does NOT mark the peer caught-up and therefore does not suppress a future re-offer; (f) **nothing
   observable is emitted** beyond a developer log line — no connectivity event, no callback a UI
   layer could be listening on.
3. **Recovery, real incremental path**: after scenario 2, without disconnecting, simulate the
   lagging side "upgrading" (the harness's function-form `localSchemaVersion`/handshake-version
   override, proving self-resolve doesn't secretly require a fresh dial) so both sides now report
   matching versions on the NEXT trigger. Trigger `stepSync` again (a new local write, or the
   harness's equivalent of "peer re-announces"). Assert the previously-withheld write now lands on
   both sides, with a fresh `A.initSyncState()`-based exchange (not a resume of stale state),
   proving "automatic, silent self-resolve" end-to-end on the path that actually runs in production
   — not asserted only in prose, and not only on the whole-doc-push path scenario 35 originally used.
4. **Pre-existing document, no backfill needed** (directly proves the HIGH defect is closed): build
   a document the way a pre-T271 camp's document would look — no `schemaVersion` field of any kind
   (there is no longer a document-root field at all, so this is simply an ordinary document from
   before this ADR existed) — and sync two devices on it with **matching** `CURRENT_SCHEMA_VERSION`
   via the real incremental path. Assert convergence succeeds normally, with **no migration step, no
   backfill call, and no special-casing** anywhere in the test setup — proving the carrier change
   (Decision 2) actually eliminates the freeze rather than merely working around it in this one test.
5. **Genesis identity** (Red Hat/Code-Reviewer MEDIUM, resolved by removal): a plain unit test
   (`campDocument.test.js`) asserting two separately-constructed `genesisDoc()` calls produce
   identical `A.getHeads()` — trivially true once the synthetic schema-stamping change is removed,
   but assert it explicitly rather than relying on the removal alone, so a future re-introduction of
   a per-call side effect on `genesisDoc()` is caught immediately.
6. **Handshake field presence, unit-level** (`mutualAuth.test.js`, `authGate.test.js`): assert
   `schemaVersion` is present on outbound `authenticate` messages, and that a message *without* it
   (simulating an older peer) does not throw or get rejected at the **auth** layer specifically —
   it is recorded as `null` in `peerSchemaVersions` and handled by the sync-compatibility gate, not
   by `authGate`/`evaluateAuthenticate`, per Decision 3's separation of identity from compatibility.

## org-interface-contracts checklist

- **Idempotency**: unaffected — the gate runs before any write, in all three locations (`stepSync`,
  `handleSyncMessage`, `handleReceived`); refusing the same peer's exchange repeatedly is a pure
  no-op every time (nothing was applied the first time either), and — new in round 3 — refusing
  never advances `syncStates`, so a refused attempt leaves exactly the same retry-safe state behind
  as no attempt at all.
- **Concurrent retries**: two overlapping incompatible-version attempts both refuse independently
  and safely; no new shared *mutable document* state is introduced — `peerSchemaVersions` (round 3's
  replacement for the removed document field) is local, per-process, per-connection state, not
  CRDT/shared state, so there is nothing for two devices to race over (this is precisely the defect
  round 3 removes: the prior document-root field WAS shared mutable state, and WAS racy — see
  Decision 2's finding #2). `isSyncCompatible`/`isPeerSyncCompatible` remain pure functions.
- **Unknown outcomes**: N/A — this is a synchronous local check against already-known, locally-held
  state (the peer's recorded handshake version), not a network call that can time out ambiguously.
- **Error shape**: refusal is a developer-facing log line only (rate-bounded by construction: silent
  in `stepSync`'s per-trigger path, logged once per actually-received frame in
  `handleSyncMessage`/`handleReceived`), matching the existing `sharesGenesis` refusal's shape. No
  connectivity event, no UI-observable state — silent and self-resolving per the owner's ruling.
- **Scope/authority boundary**: does not touch `authorize()`, camp isolation, or the `PROJECTIONS`
  registry. Deliberately does not gate authentication (Decision 3) to avoid entangling the
  identity/trust boundary with a data-compatibility concern.
- **Trust-boundary validation — REVISED, round 3**: the untrusted value is now the **handshake's**
  `schemaVersion` field (`msg.schemaVersion` in `onAuthenticate`), not a document field —
  `readDocSchemaVersion` is removed along with the document-root mechanism it read. The same
  validation posture applies to the new location: a missing, non-numeric, or out-of-range
  `msg.schemaVersion` must be recorded as `null` in `peerSchemaVersions` without throwing (treated
  as incompatible, per Decision 2's "unknown = don't merge" default) — a malicious or buggy peer
  must not be able to craft a `schemaVersion` value, in the handshake or anywhere else, that crashes
  the receiving node or bypasses the gate by omission.
