---
title: "Per-record envelope encryption as an erasure model — recommend against, now"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-09-19
decided: 2026-09-19
deciders: [product-owner]
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-15-at-rest-encryption-scoping.md
  - docs/adr/2026-09-08-flat-record-shape.md
  - docs/adr/2026-09-08-crdt-conflict-reconciliation.md
related_tickets:
  - docs/work/tickets/T202-camper-record-purge-path.md
program: security-hardening
affects: []
---

# Per-record envelope encryption as an erasure model — recommend against, now

> **Status: PROPOSED (2026-09-19), recommending AGAINST adoption.** Spun off from T202 during its
> architecture discussion. This is speculative future work, not a confirmed defect: nothing is broken
> today that this would fix. The deliverable asked for was an ADR recommending for or against, with a
> key-custody and performance analysis. **Recommendation: do not build this now.** Confidence: **high**
> on "not now" — that rests on custody and the absent erasure benefit, and survived an adversarial
> (Red Hat) pass against the code. The forward path (per-camp genesis rotation) is scoped here but
> **deliberately not decided**: rotation has a heavy fleet-wide re-pair cost of its own and needs its
> own sized ADR + Architect pass before it is treated as settled (see "The alternative that actually
> fits").

## The idea, stated precisely

Instead of physically deleting a record, encrypt each record's field *values* under a **per-record
key**, let the Automerge (CRDT) history keep the ciphertext forever, and make **purge = discard that
one key**. The history stays intact and replicates as usual; without the key the ciphertext for that
record is permanently unreadable. This is the well-known *crypto-shredding* / *crypto-erasure*
pattern. Its appeal for this architecture is real and worth naming plainly: it promises **erasure
that is instant, targeted to one record, and independent of the frozen genesis** — three things
T202's purge is not.

T202's purge, by contrast, is a **whole-device document regeneration**
(`electron/automerge/purgeSupportCommand.js`): it deletes the row, rebuilds a fresh `.automerge` whose
history never mentions it, and in the same stroke wipes every non-replicated host-only table camp-wide
and this device's signing keys, and empties the entire op-log. It is a sledgehammer. A scalpel is
genuinely attractive.

So the question is not "is crypto-shredding a good pattern" — it is. The question is whether it *fits
this system*, and whether it solves the problem T202 could not.

## The problem it must solve — and the one it does not

T202's honest, documented gap (SECURITY.md, "What it does not reach") is not the whole-device blast
radius. It is this: **nothing stops an already-paired, stale peer from reintroducing a purged record
via ordinary sync.** `sharesGenesis()` is the only gate `syncNode.js` applies, and it cannot tell "a
peer worth merging" from "a peer whose stale copy of this exact record must never come back." Reliable
multi-device erasure therefore needs a coordinated, fleet-wide step — T202 names it as a deferred
**per-camp genesis rotation**.

**Envelope-per-record encryption does not solve that.** It relocates it. To read a record, every
device that projects it needs its key; so either:

1. **Keys live in the replicated document.** Then "discard the key" is itself a CRDT delete, and the
   old key value survives in history exactly like the data it was meant to protect — the problem
   recurses one level down, unsolved.
2. **Keys live outside the CRDT, per device.** Then a purge must delete one 32-byte key from *every*
   device, including offline and stale ones — which is the **same coordinated fleet-wide delete** as
   T202's genesis rotation, only applied to a smaller object. A stale peer that still holds the key
   and the ciphertext can still read, and re-share, the record. The reintroduction hole is not closed;
   it is moved from "delete the data everywhere" to "delete the key everywhere."
3. **Keys live with a single custodian** (e.g. the Host serves decryption on a revocable lease, and
   erasure = the Host forgets the key). This *does* make erasure a single-point operation — and it
   **contradicts the core architecture.** Stage 6 deliberately abolished the Host-as-server: every
   device is autonomous, works offline, and holds its own data by design. Reintroducing a mandatory
   online key authority to read your own camp's records is a different product.

This is the load-bearing finding: **the hard part of erasure in a replicated CRDT — reaching every
copy, including stale peers — is unchanged by envelope encryption.** The pattern's marketing benefit
("delete a key, not data") assumes the key is easier to reach everywhere than the data. In a
serverless P2P fleet it is not; it is the identical coordination problem on a smaller payload.

## Where it actively collides with existing decisions

Beyond not solving the core problem, it fights three decisions already made and paid for.

**1. The flat record shape's conflict semantics (ADR 2026-09-08).** A field is a scalar CRDT register,
and a human-facing conflict is raised by *comparing values* of concurrent same-field writes —
`conflictEntries` in `electron/automerge/reconcile.js` walks `A.getConflicts(collection, key)` per
field and derives the `conflicts` row purely from value inequality at the register level. Two devices
writing the same field to the *same* plaintext today produce identical scalars and no conflict. Under
envelope encryption with a **random per-write nonce**, identical plaintext produces different
ciphertext, so every concurrent same-field write looks like a disagreement and floods the `conflicts`
surface with false conflicts.

There are three escapes, and none is free — this is a genuine cost, not an absolute blocker:
(a) fully deterministic (nonce-free) encryption, which leaks value-equality broadly (same ciphertext
anywhere means same plaintext); (b) a **deterministic per-`(record, field)` nonce** (AES-SIV style),
which narrows the leak to "two writes to the *same* field of the *same* record are equal" — much
tighter than (a), and a standard field-level-comparable-encryption technique, but still an equality
leak on children's data, and it makes the nonce derivation part of the schema; or (c) storing a
keyed plaintext-hash beside the ciphertext for the comparator to use, which is just (b)'s leak in a
different wrapper plus a second thing to keep consistent. All three re-introduce complexity at exactly
the seam the flat-record-shape ADR simplified — it removed a whole class of bug by making fields plain
comparable scalars. This weakens the case; it does not carry it. The load-bearing objection is custody
(above), which holds regardless of how the nonce is derived.

**2. At-rest encryption's threat model (ADR 2026-09-15).** At-rest already encrypts the whole
`.automerge` and SQLite under a per-device keychain key. Between *paired* devices the trust model is
explicit: "whoever has the document already has the camp's data." So per-record envelope encryption
buys **no confidentiality** that at-rest does not already provide against the offline-file threat.
Nor does it help against the one partial-trust actor this codebase actually names and accepts — "a
staff member with a legitimately paired device who bypasses the app itself, by editing the local
database or running modified code" (SECURITY.md, "Accepted cost"): that actor holds the document, and
under any offline-capable custody model (keys in the document, or a per-device key store on their own
machine) holds the key too. So envelope encryption does not close that hole either. Its *only*
marginal benefit over the status quo is the erasure use case above — which, per the previous section,
it does not actually deliver.

**3. The codebase's "no gratuitous hard-fail" posture.** At-rest encryption is the codebase's *first*
deliberate hard-fail, recorded as a reluctant exception. Per-record keys multiply that failure mode by
the number of records: any key-store corruption, partial-sync, or custody bug renders *individual
children's records* silently unreadable, with no graceful degradation and no rebuild source (the
plaintext is gone by construction). That is a large, permanent data-loss surface added to protect
against a threat (a trusted paired peer) that is out of scope by the trust model.

## Key custody — the analysis the ticket asked for

Custody is the whole decision, and every option is bad here:

| Custody model | Erasure works? | Cost |
|---|---|---|
| Keys in the replicated document | **No** — key survives in history like the data | Recurses the problem; net-zero |
| Per-device key store, replicated over a side channel | Only with a coordinated fleet-wide key-delete | A **second sync system with real delete semantics** — the exact thing the CRDT was chosen to avoid — plus the same stale-peer hole as T202 |
| Single custodian (Host serves keys) | Yes, single-point | **Abolishes local-first autonomy**; reintroduces an online authority to read your own data |
| Per-record keys wrapped by the existing per-device at-rest key | No erasure benefit | You can only shred by deleting the wrapping (device) key — which shreds *everything*, i.e. T202's blast radius with extra steps |

There is no custody option that is both (a) compatible with serverless, offline-capable, per-device
autonomy and (b) able to erase one record across the fleet. That is not an implementation gap; it is
the same impossibility T202 ran into, wearing a crypto hat.

## Performance — the analysis the ticket asked for, and why it is not the blocker

Performance is the one axis where this idea is *fine*, which is worth stating so it is not mistaken for
the reason to reject it:

- **Write path.** With a per-*record* key (not per-field), editing one field encrypts one small value
  under an already-derived key — one AEAD seal per write. Negligible. The ticket's worry about
  "re-encryption on every field edit" only bites under per-*field* keys or whole-record re-encryption,
  neither of which is required.
- **Read/projection/rebuild path.** Every projection and every full rebuild must decrypt every field
  of every record. A camp is on the order of hundreds of campers and dozens of activities — low
  thousands of fields. Modern AEAD (AES-GCM / XChaCha20-Poly1305) runs at ~GB/s; thousands of tiny
  values is single-digit milliseconds for a full rebuild. Not a concern at this data scale.

**Performance does not decide this.** Key custody and conflict semantics do. Rejecting on performance
would be rejecting for the wrong reason.

## The alternative that actually fits

The erasure requirement T202 could not meet points at the thing T202 already named as its deferred
follow-up: **per-camp genesis rotation** — minting a new genesis so a stale peer's document no longer
`sharesGenesis()` and is *refused*, not merged, on reconnect. It has real merits over envelope
encryption: it addresses the reintroduction hole at its actual cause (the sync-admission gate) for
**all** seven participant entities at once, it does not fight the flat-record conflict seam, it adds no
second sync-with-delete system, and it needs no online key authority.

**But it is not the clean, obviously-smaller bolt-on the first draft implied, and that claim is
withdrawn here.** Priced honestly against the code, rotation is itself a heavy, fleet-wide event:

- **It cuts off every device, not just the stale or malicious one.** `sharesGenesis()` is the only
  admission gate, so the instant the genesis changes, *every* other device — including honest ones,
  including the two that are offline for the week — fails the check on reconnect and is refused, not
  merged. Each must go back through the human-in-the-loop pairing flow (`joinStart`/`approveDevice`).
  This is the same "everyone is now a stranger" shape the codebase already documents as a painful,
  accepted failure class for `device_identity_key` loss (SECURITY.md) — here triggered deliberately,
  camp-wide, at once.
- **Genesis regeneration is not a runtime operation today.** `GENESIS_B64` is a pinned constant in
  `campDocument.js`; the "we've done this five times" in T202/D10 refers to *source edits plus a
  release*, not something a director can perform. A per-camp *runtime* rotation is net-new mechanism,
  not a config toggle.
- **It compounds with an already-open gap.** A Host that purges (T202) already loses its
  credential-minting `host_signing_key` and must re-establish identity — explicitly out of scope in
  T202, tracked as a follow-up. Rotation stacks fleet-wide re-pair on top of that unresolved cost.
- **The transition window fails silently.** While some devices have rotated and others have not,
  `syncNode.js` drops the non-matching documents with no surfaced error — a director would see sync
  simply stop, with nothing indicating why.

Off-device copies (a prior export, a `schedule_snapshots` row, a backup) are untouched by rotation —
a limit crypto-shredding shares, since a copy made before the key-delete kept its key.

So the honest comparison is not "rotation dominates." It is: **envelope encryption is rejected on its
own merits (custody + no-erasure-benefit), and genesis rotation is the more architecturally-aligned
*candidate* for the erasure gap — but it needs its own sized ADR with an explicit re-pair-coordination
and key-loss cost analysis before it is treated as settled.** Do not let "genesis rotation is obviously
better" pass without that adversarial pass. What this ADR settles is the envelope-encryption question;
it scopes, but does not decide, the path forward.

## Decision

**Do not adopt per-record envelope encryption as the erasure model at this time.** Reasons, in order
of weight:

1. It does not solve the core problem (coordinated fleet-wide erasure against stale peers); it
   relocates it to key distribution, which is the same problem on a smaller object — or else requires
   an online key custodian that contradicts the local-first architecture.
2. It collides with the flat-record-shape conflict semantics and forces a false-conflict flood or a
   weaker deterministic-encryption construction on children's data.
3. It adds no confidentiality over the existing whole-file at-rest encryption within the stated trust
   model, while adding a large permanent per-record data-loss surface.
4. The actual erasure gap is more plausibly addressed by per-camp genesis rotation, which fits the
   architecture better — though rotation carries a heavy fleet-wide re-pair cost of its own and must
   earn its place in a separate, sized ADR rather than being assumed here.

Performance is explicitly **not** among the reasons — it is adequate. This decision settles the
envelope-encryption question only; it does **not** by itself commit the project to genesis rotation.

## Re-open triggers

Reconsider this decision if any of these change:

- A requirement appears to erase a single record **without** a fleet-wide re-pair **and** without
  T202's whole-device blast radius, at a scale where re-pair coordination is operationally impossible.
- The product acquires a legitimate, always-online authority (a directory/roster service) that could
  serve as a key custodian without breaking offline autonomy — making custody model 3 viable.
- The data footprint grows past D8's name/group/external-id minimum such that whole-device or
  whole-camp erasure granularity becomes unacceptable and only per-record shredding will do.

Until then, the honest, smaller move is genesis rotation. This ADR should not be read as "crypto-
shredding is a bad pattern" — it is a good pattern for the wrong shape of system. It is read as: it
does not fit *this* system, *today*, and would cost more than the gap it leaves open.
