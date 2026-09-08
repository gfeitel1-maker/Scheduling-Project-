---
title: "ADR: How a new device joins a camp over libp2p (Stage 6 join flow)"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
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
`camps` and `users` rows. That path disappears with the op-log. It is replaced by #325, which models
`camps` and `users` as document entities — so a Client that *reaches* sync now receives identity
through the CRDT. What is missing is only the human step that makes it start.

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

While — and only while — the director has the **Add a device** window open, the Host advertises a
*second* mDNS service tag alongside its normal camp tag:

```
joinDiscoveryTag(code) = _shoresh-join-<sha256(code)[0..15]>._udp.local
```

The joining device hashes the typed code the same way and discovers on that tag. Two different
camps advertise two different tags and structurally never see each other's mDNS traffic, exactly as
`campDiscoveryTag` already establishes.

**The window is the real access control on discoverability.** An idle Host advertises no join tag at
all, so a stale code discovers nothing. This is what makes a stable, non-secret code safe: it is
only ever useful in a moment the director deliberately opened.

### 3. The mechanism, end to end

| # | Where | What happens |
|---|---|---|
| 1 | Host | Director opens **Add a device**. Host displays the camp name and the code, and begins advertising the join tag. |
| 2 | Client | Join screen asks for the code (replacing today's IP-address picker). |
| 3 | Client | Starts a libp2p node with **no campId and no camp document** — a clone of the shared `GENESIS`, never a locally invented one (handoff finding 2). Discovers on the join tag. |
| 4 | Client → Host | `pairing_request` over `/shoresh/auth/1.0.0` — the existing, tested handler. |
| 5 | Host | Director sees the requesting device's name and approves or denies. |
| 6 | Client | Prompts for name + PIN; `login` over the same protocol; receives a camp token. |
| 7 | Both | Mutual auth completes; Automerge sync delivers the document, which now carries `camps` and `users` (#325). |
| 8 | Client | Projects. The `camps` row materialises. **The device now knows its campId** — persists the doc under it, drops the join tag, and switches to `campDiscoveryTag` for every future session. |
| 9 | Client | Shows **"You've joined <Camp Name>."** |

Step 9 is the point of the whole design. The camp's name is revealed at the first moment it can be
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
- **J2 — Host side.** Add-a-device window: display, join-tag advertisement while open, teardown on
  close.
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
