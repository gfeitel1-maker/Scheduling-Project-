---
title: "ADR: How a new device joins a camp over libp2p (Stage 6 join flow)"
document_type: adr
status: accepted
authority: normative
implementation_state: in_progress
date: 2026-09-08
decided: 2026-09-08
deciders: [product-owner-delegated]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/plans/2026-09-07-stage6-cutover-plan.md
related_tickets: []
related_adrs:
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-09-06-libp2p-membership-mapping.md
  - docs/adr/2026-07-25-device-trust-revocation.md
supersedes: []
affects: []
program: shoresh-future-architecture
---

# ADR: How a new device joins a camp over libp2p (Stage 6 join flow)

> **Status: ACCEPTED under delegated authority (2026-09-08).** The product owner stepped away from
> the session having said, verbatim: *"you have decision making authority with your peer session to
> drive this implementation through to the end."* Under Constitution Article I #1 (explicit current
> human instruction outranks the constitution itself), that delegation covers Article IV's
> "architecture change without an accepted ADR" and "product-judgement question" gates for this
> slice.
>
> **What the owner should look at on return** is §4 — the join code and the words on the two
> screens. That is the part a delegation cannot really substitute for, because it is the part they
> will recognise or not recognise as *their camp*. Everything else here is mechanism.

## Context

Stage 5 is complete and hardware-validated: two devices that already know each other converge over
libp2p. Stage 6 retires the op-log and the WebSocket layer. Stage 6a (porting the integration
harness) stopped at 3/27 on a blocker that is not a test problem: **a genuinely new Client cannot
bootstrap its camp identity over libp2p at all.** The harness needed test-only scaffolding to get a
second device to the point where sync could start.

This is simultaneously the owner's one standing product constraint on this work — the join flow
"has to be a recognizable form of identity pairing for people." A director setting up a second
device should experience pairing *their camp*, not an opaque key exchange.

### What actually blocks a fresh Client — three stacked problems, not one

Established by reading the code, not inferred:

1. **No node starts.** `startAutomergeSyncNodeIfEnabled` (`electron/main.js`) returns early when
   `SELECT id FROM camps LIMIT 1` is empty. A fresh device has no `camps` row, so no libp2p node is
   started, so nothing can happen.
2. **Nothing is discoverable.** `createMdnsDiscovery` (`electron/sync/automerge/discovery.js`)
   scopes mDNS by `campDiscoveryTag(campId)` — a one-way hash of the camp id. A device that does not
   know its campId cannot compute the tag, and @libp2p/mdns only ever surfaces peers advertising the
   identical tag. This is structural: not a filter that can be relaxed, but the entire discovery
   mechanism.
3. **Login is still WebSocket.** `chooseMode`'s client branch builds a `syncClient` and `login()`
   routes to `syncClient.loginRemote` over WS. The libp2p `login` handler exists and is genuinely
   tested (`electron/sync/automerge/pairingLogin.test.js`), but nothing in `main.js` reaches it.

Under the op-log, step 3 also delivered identity: the Host's `full_sync` shipped the Client its
`camps` and `users` rows. That path disappears with the op-log. #325 replaces half of it — `users`
now reaches a joining device through the CRDT — but only half; see §3.1, which corrects an
assumption this ADR originally got wrong about the other half.

### The prior decision this must not contradict

[ADR 2026-09-06 (membership mapping)](2026-09-06-libp2p-membership-mapping.md)'s open question 1 —
how a Client learns the Host's PeerId — was decided by the owner in favour of **(a) camp-scoped mDNS**
over **(b) an out-of-band pairing code** and **(c) dial-everything**.

That decision stands and is not reopened here. It answers *how a device that already knows its camp
finds its Host*, which is the returning-device case and remains camp-scoped mDNS, unchanged. It does
not answer the first-join case, and structurally cannot: its input is the campId the joining device
does not yet have. This ADR fills that gap and hands off to the existing decision the moment the
device has a campId.

## Decision

**Join with a camp code, shown on the Host and typed on the joining device.**

### 1. The code

A pure function of the camp id, derived at display time — **no new column, no new table, no stored
secret, nothing to expire or reconcile**:

```
joinCode(campId) = base32(sha256(campId))[0..7]   // 8 chars, Crockford alphabet, displayed as XXXX-XXXX
```

Properties that matter:

- **Not a secret.** It is derivable by anyone who holds the campId, and it is *displayed on screen*.
  It is a routing label, not an access credential — see §5.
- **One-way.** The camp id cannot be recovered from it, and the camp *name* never enters the
  derivation, exactly as `campIdHash` already guarantees for the existing tag.
- **Stable.** The same camp always shows the same code. A director can write it on a whiteboard at
  the start of the summer. There is no "the code expired, ask again" failure mode, which is the
  single most common way pairing UX goes bad in the field.

### 2. The join tag

The Host advertises a *second* mDNS service tag alongside its normal camp tag:

```
joinDiscoveryTag(code) = _shoresh-join-<sha256(code)[0..15]>._udp.local
```

The joining device hashes the typed code the same way and discovers on that tag. Two different
camps advertise two different tags and structurally never see each other's mDNS traffic, exactly as
`campDiscoveryTag` already establishes.

**What the Add-a-device window actually gates — corrected from this ADR's first draft.** The first
version said the Host advertises the join tag *only while the window is open*, and leaned on that
for the brute-force argument in §5. Two things changed that:

- **It is not cleanly buildable.** libp2p fixes its `peerDiscovery` services at node construction.
  Starting and stopping one on demand means holding the `@libp2p/mdns` instance and driving its
  lifecycle by hand — permanent coupling to a library internal, on the upgrade path of a dependency
  this project has already had to chase.
- **It buys nothing.** The Host is *already* permanently discoverable under `campDiscoveryTag`. A
  second opaque, one-way tag alongside it adds no exposure that the first one did not already
  create.

So the window gates **pairing, not discoverability**: the Host accepts a `pairing_request` on the
join path only while a director has Add-a-device open. Discoverability rests on the 40-bit code
space alone (§5), which is where the real resistance was anyway. Stated rather than quietly
retained, because §5's argument was written leaning on the stronger claim.

### 3. The mechanism, end to end

| # | Where | What happens |
|---|---|---|
| 1 | Host | Director opens **Add a device**. Host displays the camp name and the code, and begins accepting join-path pairing requests (§2). |
| 2 | Client | Join screen asks for the code (replacing today's IP-address picker). |
| 3 | Client | Starts a libp2p node with **no campId and no camp document** — a clone of the shared `GENESIS`, never a locally invented one (handoff finding 2). Discovers on the join tag. |
| 4 | Client → Host | `pairing_request` over `/shoresh/auth/1.0.0` — the existing, tested handler. |
| 5 | Host | Director sees the requesting device's name and approves or denies. |
| 6 | Client | Prompts for name + PIN; `login` over the same protocol; receives a camp token. |
| 7 | Client | Writes its `camps` row from the login reply — see §3.1, this is not what the ADR first assumed. |
| 8 | Both | Mutual admission completes (§3.2) and Automerge sync delivers the document; `users` and all domain data project. |
| 9 | Client | **Now knows its campId** — persists the doc under it, drops the join tag, and switches to `campDiscoveryTag` for every future session. |
| 10 | Client | Shows **"You've joined <Camp Name>."** |

### 3.1 Where camp identity actually comes from (corrected during implementation)

This ADR was first written assuming step 7 read "the `camps` row materialises out of the document,
because #325 models `camps`." **That is wrong, and the code says so in as many words.** From
`projector.js`:

> this projection path structurally can never be how a device gets its FIRST camps row … That row
> comes [from `full_sync`'s `INSERT OR REPLACE` in `syncClient.js`]; a libp2p-native equivalent is
> **Stage 6's problem**

`PROJECTIONS.camps.ensureExists` only ever *matches or refuses* — never creates — because `camps` is
a singleton whose accidental duplication would break token verification camp-wide. Modeling `camps`
(#325) converges a camp's **name** across devices that already have the row. It cannot mint one.

So the libp2p-native equivalent is: **the `login_ok` reply carries `{ id, name, signing_public_key }`,
and the joining device writes its own `camps` row from it, before admission.** Three consequences
worth stating:

- `signing_public_key` is what lets the device verify the Host's tokens from its next launch onward.
  It travels on the authenticated login reply and is **deliberately not modeled as a document
  field** — key material has no business in shared CRDT history, where there is no payload to grep
  for it afterwards. `signing_secret` never leaves the Host.
- The camp is sent only on the `ok` path, so a failed or unauthenticated attempt learns nothing —
  not the camp's id, not its name.
- The row must be written **before** admission starts the sync exchange: `users.camp_id` is an FK to
  `camps.id`, so a document projecting first would drop every user on an FK error, and might be the
  only merge that device ever receives.

### 3.2 The trust bootstrap, stated plainly

Admission is mutual (Stage 5 finding 4: a node only sends to peers that authenticated to *it*), so
the Host must authenticate to the joining device before anything flows. **It cannot.** Every token
this codebase issues is Ed25519-signed by the Host's key and verified against
`camps.signing_public_key` — which the joining device does not have until the exchange it is trying
to start. This is inherent to first pairing, not an oversight.

The resolution is `transport.js`'s `admitPeer`, called by `joinSession` only, only immediately after
a successful login to that exact peer. The trust anchor is human and is **the same one the op-log
already relied on**: the director typed this camp's code, approved this device on the Host's screen,
and signed in with a PIN against that peer's real user table. `full_sync` handed a Client its
identity on exactly that basis with no cryptographic proof of the Host either. From the next launch
onward every ordinary path verifies normally.

This is the single most security-consequential line in the slice and the thing the mandated security
review should start from. The misuse to review for is any caller that admits a peer it did not just
authenticate *itself* to.

Step 10 is the point of the whole design. The camp's name is revealed at the first moment it can be
revealed over an authenticated channel, so recognition is a thing the director *confirms*, not a
thing they had to take on faith from an IP address.

### 4. What a person sees

**On the Host:**

> **Add a device**
> On the new device, choose *Join a camp* and enter this code.
> ### K4P7-2MRQ
> Looking for devices… *(this code works while this screen is open)*

**On the joining device:**

> **Join a camp**
> Enter the code shown on your camp's Host computer.
> `[ ____ - ____ ]`

**Then, after approval and sign-in:**

> **You've joined Camp <name>.**

No IP addresses, no ports, no `campTag`, no key material anywhere in the flow.

## Alternatives considered

**Consented, time-boxed camp-name broadcast.** While the Add-a-device window is open, the Host
broadcasts `camps.name` in the clear; the joiner taps their camp by name with no typing at all.
Meaningfully simpler for a human. **Rejected:** it reintroduces the exact plaintext-name mDNS leak
that `campIdHash` was written to remove ("a stranger's laptop in a shared building, a hotel, a
JCC"), and reversing an accepted privacy fix for typing convenience is a bad trade when the typing
in question is eight characters. Per Constitution Article I, a change to a recorded security
tradeoff is an owner gate regardless — so even under delegation this is not mine to take.

**Dial-everything (the membership ADR's option (c)).** A fresh Client discovers Shoresh peers on a
generic tag and pairs with whatever it finds, picking from a list. This is closest to today's WS
JoinScreen — and today's WS JoinScreen, which shows `Port 5100 · camp-a3f9…`, is precisely the
experience the owner's constraint is a reaction to. **Rejected on the product constraint**, not on
mechanism.

**Ephemeral, Host-minted pairing codes.** Strictly stronger: a code that is a real short-lived
secret, checked in `pairing_request`. **Rejected as unearned complexity** — it buys resistance to an
attacker who is already on the camp's LAN *and* who must still defeat director approval and a PIN
(§5), at the cost of a mint/expire/rotate/re-display lifecycle and a new stored secret. If the
threat model changes, the code becomes ephemeral without any change to the flow a person sees; §1's
derivation is the only thing that moves.

## Security

**What the code is and is not.** It grants *discoverability of a Host that is already advertising
itself, during a window a director deliberately opened*. It grants nothing else. Every existing
control is unchanged and still stands in front of any data:

- the director's explicit per-device approval (`pairing_request` → human decision);
- PIN authentication through the same `attemptLogin` (scrypt + `timingSafeEqual`, 5 attempts, 30s
  lockout) both transports already share;
- mutual authentication before either side sends a document frame (handoff finding 4);
- `authorize()` re-querying role and device trust on every mutating call.

An attacker on the LAN who learns a code reaches the same place they would reach by scanning the
LAN for the WS port today: a pairing prompt on the director's screen, which they must convince a
human to accept.

**The code is proved, not just used to find things — and an earlier draft of this ADR got that
badly wrong.** That draft argued the code's 40-bit space made the join tag infeasible to guess. The
argument was sound and irrelevant: **the mDNS service tag is broadcast in the clear** — that is what
mDNS is — so an attacker never has to guess it. They watch the Host advertise the tag and advertise
the identical tag themselves, at zero cost and with no knowledge of the code whatsoever.

The chain that follows is the real threat, and it is worse than the one that was analysed: the
joining device discovers (or races to) the attacker; the attacker approves its own pairing request,
so the director's approval protects nothing; the joining device sends **the user's PIN** to the
attacker; the attacker answers with its own `camp` and becomes that device's permanent trust root.

That is parity with the WS path — an impostor at the right IP could always do the same — but parity
is not a reason to carry it forward when the fix is small. Both legitimate parties already hold the
code. Nobody who merely mirrored the tag does. So each side proves it:

```
joiner -> host  : join_nonce, join_proof   = HMAC-SHA256(code, "joiner|" + nonce)
host   -> joiner: join_confirm             = HMAC-SHA256(code, "host|"   + nonce)   (on the pairing reply)
```

- The Host verifies the joiner's half **before `evaluatePairingRequest`**, so a mirrored-tag peer
  never reaches the director's screen at all.
- The joining device verifies the Host's half **before it sends a PIN**, and again before it writes
  a camps row or calls `admitPeer`. Separate role labels stop either half being reflected as the
  other.
- One nonce per attempt, so a captured reply cannot be replayed against a different one.
- A `pairing_request` carrying no nonce is an already-paired device on the camp-scoped path, which
  never had a code. That path is unchanged.

So `admitPeer` (§3.2) admits **a peer that proved it holds the director's code**, which is a
materially better sentence than the one the first draft could write. The code is still not a
credential and is still displayed on a screen — but it is now something an attacker must actually
obtain rather than merely observe, which is what the 40-bit space was mistakenly credited with
already achieving.

The space still matters, just for a smaller claim: 32⁸ ≈ 1.1 × 10¹² makes the HMAC infeasible to
forge by guessing the code offline from an observed proof. A 4–6 character code is where that would
stop being true, which is why this one is 8.

**Not closed by this.** A device physically shown the code by the director can still be an attacker;
the code proves possession, not intent. And nothing here protects sessions *after* the first — a
trust-on-first-use pin of the Host's PeerId would, and is a sensible follow-on, but it is additive
and does not change the bootstrap.

**Rate limiting.** `registerAuthGate`'s existing dual-keyed throttle (by `fromPeerId` and by claimed
`device_id`) and `MAX_PENDING_PAIRING` apply unchanged — the join path uses the same protocol
handler, deliberately, so there is no second code path to keep in sync.

**Still nothing new on the wire.** The join tag is a hash of a hash of the camp id. No name, no key
material, no PIN material.

**Unchanged, and out of scope here:** PIN material (`pin_hash`/`pin_salt`) replicating in the
document. That is status quo from the op-log era and is tracked as an open owner decision in the
Stage 6 handoff; this ADR neither worsens nor fixes it.

Per the membership ADR's own open question 3, **security review is mandatory before the
implementation slice merges.** `electron/auth/**` is the highest-sensitivity surface in this repo.

## Migration, rollback, recovery

**Migration:** none. No schema change, no stored state, no existing device affected — a device that
has already paired never enters this flow, and its discovery path (`campDiscoveryTag`) is untouched.

**Rollback:** the slice is additive and sits behind `SHORESH_SYNC_ENGINE`, which is still
default-`oplog`. Reverting the commit restores the WS join flow exactly, because the WS join flow is
not modified by it.

**Recovery — the failure mode that actually matters.** A device gets stuck between "paired" and "has
a document": approved, logged in, but sync never delivers. Under the op-log this could not happen
(`full_sync` was one message). The Client must therefore treat "authenticated but no `camps` row
yet" as a **visible waiting state that can be abandoned**, never a spinner that hides a dead
connection, and never a state that writes a partial local identity. Concretely: if no document
arrives within a bounded window, the Client says so and returns to the Join screen with nothing
persisted. This is Article V's "the engine surfaces conflicts; it never resolves them silently"
applied to sync, and it is the single thing most likely to be got wrong in implementation.

## Implementation slices

Each is independently mergeable behind the existing flag, with a full `npm run verify` green before
merge.

- **J1 — derivation.** `joinCode` / `joinDiscoveryTag` as pure functions with pinned test vectors,
  in the style of `campIdHash.test.js` (which exists precisely because these outputs are a wire
  surface). No wiring.
- **J2 — Host side.** Add-a-device window: display the code, accept join-path pairing requests while
  open, refuse them when closed.
- **J3 — Client side, mechanism.** Start a node with no campId on a `GENESIS` clone; discover by
  join tag; route `login` to the libp2p auth protocol when the engine is `automerge`; adopt campId
  on first projection and re-scope discovery. Includes the §"Recovery" bounded-wait state.
- **J4 — Client side, screens.** The Join-by-code screen and the "You've joined <Camp>" confirmation.
- **J5 — harness.** Retire `seedCampIdentity` from `harnessAutomerge.js`; a Client joins the way a
  real device does. This is what unblocks Stage 6a's remaining scenarios, and it is the test that
  proves this ADR.

J5 is the exit criterion. Until a Client in the integration harness joins with no scaffolding, this
design is a claim, not a result.

## Consequences

- Stage 6a can resume toward 27/27, and several scenarios retired in the partial port as
  "op-log-only identity seeding" become portable again (that retirement predates #325 — see the
  correction note below).
- The op-log's `full_sync` loses its last unique responsibility. Nothing else in Stage 6 depends on
  identity arriving by a mechanism that only WS has.
- `harnessAutomerge.js`'s module header is stale as written: it asserts as an "IMPORTANT
  ARCHITECTURAL FACT" that `camps`/`users` are never modeled, which #325 reversed. It must be
  corrected in J5 rather than left to mislead the next reader.
