---
title: "CRDT sync — security gap register"
document_type: reference
status: active
---

# CRDT sync — security gap register

**Living document.** Every security gap found while moving from op-log/WebSocket sync to
Automerge/libp2p, what was done about it, and what is still open. Started 2026-09-08 at the owner's
request: *"keep a list of the security gaps and/or address them as they come up for potential
solutions to make as we go."*

**Why it exists.** Two of the first eight integration-scenario ports found live vulnerabilities that
~5,000 passing unit tests could not see. That is a high enough rate that the findings need somewhere
durable to live rather than being spread across commit messages and PR bodies.

**Where the authority is.** Accepted tradeoffs belong in [`SECURITY.md`](../../SECURITY.md) — that is
the normative document and this register never overrides it. This is the working list: what was
found, how, what shape the fix took, and what remains.

## How to read the status column

| Status | Means |
|---|---|
| **FIXED** | Closed in code, with a test that fails if it comes back |
| **ACCEPTED** | Real, understood, deliberately not fixed — owner-decided, recorded in `SECURITY.md` |
| **OPEN** | Known, not yet decided or not yet done |
| **BY DESIGN** | Looks like a gap, is not — recorded so it is not "found" again |

---

## FIXED

### 1. A revoked device kept syncing until it happened to disconnect

**Found by** porting integration scenario 05 (revocation) to libp2p — the first port written.
**Shipped in** #337.

Admission to exchange documents was granted once and otherwise only cleared on `peer:disconnect`.
Revoking a device stamped `devices.revoked_at`, which correctly blocked *future* authentication — but
a device that was **already connected** stayed in the live admission set and kept receiving the
camp's documents until it dropped off the network by itself.

The WS transport had no equivalent gap: revoking closed the socket, which evicted it.

**Fix.** `transport.js` gains `revokePeer(peerId)`, the counterpart of `admitPeer`. `main.js`'s
`revokeDevice` looks up the device's `libp2p_peer_id` and evicts it as part of revoking, not as a
follow-up step.

**Shape worth reusing:** the fix belongs with the *state change* (revoking), not with the transport
noticing later. Anything that grants access needs a matching thing that takes it away in the same
breath.

### 2. An admitted device could wipe the Host's data with a foreign-genesis document

**Found by** porting integration scenario 14 (corrupt payload) to libp2p. **Shipped in** #337.
The most serious finding so far.

Every legitimate device clones the same frozen genesis, so every real document shares one root. A
document built on a *different* root is not a peer's view of this camp — and merging it is
destructive rather than merely useless: the two roots' collections collide as ordinary map keys,
Automerge keeps one side, and **the loser's entire collection disappears**. The projector then
delete-reconciles those rows out of SQLite.

Two things made this bad:

- **It is nondeterministic.** Which side survives depends on actor ids, so the same input destroys
  data on one run and not the next — the failure mode a director blames on themselves.
- **Nothing was checking.** The admission gate cannot catch it (the sender is a legitimately admitted
  device), and `campDocument`'s module-load subset guard cannot see an incoming document — it guards
  against *our own code* inventing a collection.

**Fix.** `campDocument.sharesGenesis(doc)` compares the first change's hash against the frozen
genesis root; `syncNode` refuses any received document that fails it, and logs the refusal.

**Shape worth reusing:** an invariant held "by construction" on the write path is not held on the
*receive* path. Anything arriving from a peer needs the invariant checked, not assumed.

---

## ACCEPTED

### 3. Role enforcement is device-side under CRDT sync

**Found by** porting integration scenario 16 (mid-session role change).
**Decided by the owner 2026-09-08:** *"accept it and record it for the security concern."*
**Recorded in** `SECURITY.md` → Known limitations. Full analysis and the options weighed:
[`../work/evidence/2026-09-08-crdt-removes-host-side-authorization.md`](../work/evidence/2026-09-08-crdt-removes-host-side-authorization.md).

Under the op-log the **Host** ran `authorize()` on every incoming operation, so a device could be
admitted to the network yet still refused an action above its role. Under CRDT sync a device does not
submit operations — it writes into its own document and the documents merge, and nothing in the
receive path consults a role. Measured: a device demoted to `staff` *on the Host* wrote anyway, and
the Host accepted it.

Everything that keeps a stranger out is unchanged. What changed is the trust placed in a device the
director has **already approved**. Accepted because validating a merged document per change means
re-deriving who wrote what and whether they could, on every merge — most of the way back to the
central authority the local-first design exists to remove.

**If this is ever revisited,** the two options that were not taken are written up in the evidence
doc: authorize at the merge boundary (Automerge has actor ids, so authorship is available), or keep
admin-only entities out of the shared document.

---

## OPEN

### 4. PIN material replicates in the document

**Status: open, pre-existing, owner's call.** Carried forward from the Stage 6 handoff.

`users.pin_hash` and `pin_salt` are modeled document fields, so they replicate to every paired
device. This is **status quo, not a regression** — they replicated via the op-log's `full_sync`
too — but the cleaner shape is authenticating against the Host over libp2p so they never leave it.

**Cost of fixing:** offline login on a second device stops working, because the device would no
longer hold anything to check a PIN against. That is a real product cost for a camp with patchy
Wi-Fi, which is why it is a decision rather than a task.

They are scrypt hashes with per-user salts, not plaintext, and `camps.signing_secret` and every
genuinely Host-only table remain structurally excluded (`hostOnlyExclusion.test.js`).

---

## BY DESIGN

### 5. The camp join code is not a secret

Recorded so it is not re-reported as a finding. The join code is **displayed on the Host's screen**
and derived from the camp id — it is a routing label, not a credential. What protects a camp is what
sits behind it: the director's per-device approval, PIN authentication, mutual authentication, and
now immediate eviction on revocation.

Both sides prove they hold the code by HMAC before the director is prompted and before any PIN is
sent, which closes the mirrored-tag attack (an attacker re-advertising the public mDNS tag they can
already see). See [`../adr/2026-09-08-libp2p-join-flow.md`](../adr/2026-09-08-libp2p-join-flow.md) §5.

### 6. Windows blocks inbound connections on "Public" networks

Environmental, not a code defect: the app discovers peers, looks healthy, and accepts nothing.
Documented rather than automated — the fix needs administrator rights and conflicts with the
per-user install. Carried from the Stage 5 handoff.

---

## NOT A SECURITY GAP, BUT A CUTOVER BLOCKER

Recorded here because it was found the same way and by the same work, and
because losing it would be a silent feature removal rather than a visible one.

### 7. Trash and Restore read the op-log, and stop working without it

**Found by** porting integration scenario 18 (restore while the Host is away).
**Status: OPEN — blocks 6d (removing the op-log).**

`electron/ops/trash.js` and `electron/ops/restore.js` answer their questions by
querying the `operations` table directly — 7 such queries between them:

- `listDeleted(db)` finds deleted records by looking for the latest op per entity being a
  `__deleted__` marker.
- `lastKnownFields(db, …)` reconstructs what a record held by replaying its ops in `seq` order.
- `isDeleted(db, …)` reads the latest op for an entity.

Two consequences, and the second is live **today**:

1. **After 6d there is no `operations` table**, so the entire Trash screen and every restore stop
   working. Not degrade — stop.
2. **Already, on a device that received a deletion through document sync rather than making it**,
   there are no op rows for that record. `isDeleted` returns false and the record cannot be
   restored from that device at all. The scenario hit this immediately: the Host deleted, the
   deletion replicated correctly, and the second device could not restore it.

The document does hold what is needed — deletion is a real state in it, and Automerge keeps history
— so this is re-implementable rather than a lost capability. It is simply work that the cutover plan
does not currently list, and it must be done before the op-log is removed.

**Not attempted here.** Rebuilding Trash on document history is its own slice with its own product
questions (what "deleted" means when two devices disagree, how far back history goes, whether
restore should reconstruct fields or just undelete).

---

## 8. Field provenance and authorship do not replicate — OPEN, and it costs a director their work

**Status: OPEN. Live today.** Not a vulnerability in the attacker sense; a silent data-loss defect
with a security-shaped cause.

**What replicates.** `applyWrite(doc, { entity, entity_id, field, value })` — field VALUES and
nothing else. The CRDT document carries no `source`, no `author_user_id`, no `device_id`. Under the
op-log every one of those travelled with the op.

**What that breaks.** `electron/ops/ingest.js:479` protects a director's hand edits from being
overwritten by a re-import:

```js
if (latest && latest.source === 'human') continue
```

`latest` is read from the `operations` table. A device that RECEIVED a hand-edit through a document
merge has no op row for it, so `latest` is absent and the field is treated as never hand-edited.

**The scenario, in the director's words.** They fix a group name on the iPad. It appears correctly on
the office computer — the value replicated fine. They re-import next season's spreadsheet on the
office computer. Their correction is silently reverted, because that machine has no record that a
human made it. Nothing errors. Nothing is flagged.

**Also affected:** record history and Trash attribution. A received change has no author, so it shows
as "Unknown" — the exact symptom T22 was raised to fix, reintroduced by a different route.

**Why it is not merely the missing ledger.** Writing op rows from received merges (the agreed 6d
narrowing) is necessary but NOT sufficient: the document itself carries no provenance, so a
synthesized op row would have nothing truthful to record in `source`. Closing this requires the
DOCUMENT to carry a per-field human/import marker. That is a document-model change, and it should be
decided deliberately rather than folded into the ledger slice.

**Related:** the op-log's Security V1 control (a Host FORCED `source: 'human'` on every submitted op,
so a Client could never forge `import` provenance) has no CRDT equivalent — same root cause, same
place to fix it. Its test, `provenance.s2a.test.js`, was retired with the transport; see
`docs/work/evidence/2026-09-08-retired-ws-scenarios.md`.

**Found by:** re-sweeping for dangling imports after deleting the WS layer, using `grep -a` at a
peer session's prompting. The original sweep used a regex that required a `sync/` path prefix and
missed four sibling-relative imports inside `electron/sync/` itself.

---

## HARNESS PARITY GAPS

Not product defects, but recorded because each one made a scenario fail while the
product was fine — and each was a place the harness did LESS than `main.js` does.
A harness that quietly diverges from production is a source of false confidence in
both directions.

| Gap | Symptom | Fix |
|---|---|---|
| Dual-write never configured | Every domain operation (`deleteRecord`, ingest, merge) applied locally and replicated **nothing**, behind one warning line | `configureDualWrite` |
| A restarted Host never re-issued its own token | Reconnect timed out with everything else looking healthy — the Host could not authenticate outward, so sync was one-way | `AmHost.start` self-issues when a camp already exists, as `startAutomergeSyncNodeIfEnabled` does |
| A restarted Host started from an EMPTY document | A Host that came back had forgotten everything; only `assertDocIsSupersetOrEmpty` stood between that and a wiped camp | `AmHost.start` seeds from SQLite, as `ensureAutomergeDocSeeded` does |

The third is the one to remember: it is not a vulnerability, but it is the same
shape as one — a device rejoining with an empty view of the camp, with a single
guard preventing that from becoming a deletion.

---

## Method note

Both FIXED entries were found the same way: by writing an integration scenario in which two real
devices do something a person would actually do, and asserting the outcome rather than the mechanism.
Neither was reachable by unit tests, because both required a real second participant.

All 27 WS scenarios are now accounted for (20 ported, 6 retired, 1 deferred), and the WebSocket layer
is gone. The porting was not a formality: it produced two vulnerabilities, a cutover blocker, three
harness gaps, and the finding below — none of which 5,000 passing unit tests had surfaced.
