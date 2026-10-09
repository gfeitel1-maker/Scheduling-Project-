---
title: "Host succession: when the founding or current host is removed or lost, another admin device becomes the host by re-minting the host key"
document_type: adr
authority: normative
status: proposed
implementation_state: not-started
date: 2026-10-09
decided: ""
deciders: [product-owner]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
supersedes: []
amends:
  - docs/adr/2026-07-25-device-trust-revocation.md
related_adrs:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
  - docs/adr/2026-09-08-libp2p-join-flow.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
related_docs:
  - docs/work/specs/2026-10-03-t332-client-admin-minting-design.md
  - docs/work/tickets/T351-lift-setup-device-gates-to-any-admin-device.md
  - docs/work/tickets/T333-two-device-revocation-recovery.md
  - docs/work/tickets/T340-wan-activation-go-live-checklist.md
  - docs/current/KEY_RECOVERY_STORY.md
related_tickets: [docs/work/tickets/T351-lift-setup-device-gates-to-any-admin-device.md, docs/work/tickets/T340-wan-activation-go-live-checklist.md, docs/work/tickets/T333-two-device-revocation-recovery.md]
affects:
  - electron/automerge/authorityLog.js
  - electron/automerge/authorityLogSignature.js
  - electron/automerge/authorityReplay.js
  - electron/automerge/projector.js
  - electron/automerge/campDocument.js
  - electron/auth/localAuth.js
  - electron/auth/connectionAuth.js
  - electron/sync/automerge/authGate.js
  - electron/auth/authSignature.js
  - electron/automerge/tombstoneSignature.js
  - electron/main.js
  - electron/sync/automerge/syncNode.js
  - electron/sync/automerge/syncStarter.js
  - electron/automerge/hostKeyPreservation.js
  - electron/db/schema.sql
  - electron/db/rollback/
  - SECURITY.md
  - docs/current/KEY_RECOVERY_STORY.md
---

# ADR: Host succession by re-minting the host key under authority-log control

## Owner ruling (2026-10-09, relayed verbatim by the board keeper)

> "if the founding computer or original host s removed, someone else becomes the host and then holds the keys"

The model this ADR implements is therefore **succession**: there is always exactly **one current
host**, but no **permanent** host. When the founding or current host device is removed (revoked
through the T331 quorum) or lost, host authority passes to another admin device, which then hosts
joins, shows the camp code, approves devices, and holds the keys. Standing constraints from the
same thread: no relay; pairing only over the local network (LAN-pairing-first, T340); keys never
exist outside a trusted device; no WAN activation.

The owner ruled the **model**. The **mechanism** below is the Architect's recommendation and is
`proposed` until accepted.

## Context

What "host" actually is today, read from the code on `main` (not from memory):

- The host is **whichever device holds the `host_signing_key` row** (`electron/auth/localAuth.js`,
  `ensureHostSigningKey`, created once at `bootstrapCamp` and lazily re-created by `chooseMode` on any
  non-`client` device). The row is never replicated and is preserved byte-for-byte across purge/rebuild
  (`electron/automerge/hostKeyPreservation.js`).
- That one Ed25519 key signs **three things**: (1) `camp` and `device` session tokens
  (`issueCampToken`, `issueDeviceToken`), which is how a join login and every network admission
  succeeds; (2) `users` credential tuples `{id, role, pin_hash, pin_salt, cred_version}`
  (`signAuthFields`, so creating a user or promoting an admin is host-only); (3) purge tombstones
  (`signTombstone`).
- Every device **verifies** all three against the **local** column `camps.signing_public_key`
  (`verifySessionToken`, `upsertUsersEntity`, `upsertTombstonesEntity`), deliberately not a document
  field (Security F1 in `projector.js`; the first-pairing reply carries it to a joiner).
- A device with no host key answers a joiner's login with a `local` token, which
  `evaluateAuthenticate` rejects for the network. This is proven by
  `electron/sync/automerge/clientHostedJoin.test.js` and is why `getJoinCode` / `setJoinWindow` are
  still founding-only after T351.
- The Add-a-device secret is process state on the host (`joinSecret` / `joinWindowOpen` in
  `electron/main.js`); the join proof is checked in `syncNode.js` `onPairingRequest`.
- **Admin authority is separate and already distributed** (T331): `camp_authority_log`
  (`genesis` / `grant` / `revoke`), signed with each admin's own `device_identity_key`, replayed by
  causal ancestry (`authorityReplay.js`), with quorum `floor((N-1)/2)+1` for removing an admin or the
  founder. The founder is *removable as an admin* today, but if the founder is also the only
  `host_signing_key` holder, removing or losing it leaves **nobody able to sign tokens, credentials or
  tombstones** (`h-purge-survives-fired-founder` is the same defect seen from the purge side; the T331
  ADR deferred it explicitly).

So the missing piece is not a new authority *voting* mechanism; it is **how the single signing role
moves**, authenticated by the authority log that already exists.

## Success predicate and non-goals

**Predicate (observable):** after the host device is revoked through the quorum, or declared lost and
revoked the same way, an admin device that is still trusted can (a) become the host, (b) show the
camp code and complete a LAN join of a brand-new device, (c) approve it, and (d) create a user,
and every other device agrees which device is host and which key is valid; the old host's tokens,
codes and signatures no longer work; the old host cannot undo this by being the last one to speak.

**Non-goals:** no standing host process; no relay, no WAN or DHT path, no change to
`SHORESH_RELAY_ENABLED`; no key escrow or recovery-phrase product; no change to who may *revoke*
(T331 quorum is untouched); no automatic election (a human on a trusted device accepts the role);
no recovery for a single-admin camp (out of scope by owner ruling, below).

**Hard requirement (owner/keeper ruling 2026-10-09):** a 2-device camp where one device leaves
(revoked) or is lost must end with the remaining admin device as host holding the keys, and
must not deadlock under sync lag (T333, in scope, section 8).

**Single-admin camp: out of scope by owner ruling.** Owner 2026-10-09: "for a camp that only has 1
person, they need to transfer files before they go. that is where the excel underlying doc will
help repopulate things". Recovery is the canonical Excel export re-imported on the next director's
device; no host-key recovery is designed for it.

## Candidate approaches considered (divergent ideation, `adhd` skill)

Mechanisms evaluated against the succession model; incompatible ones dropped:

| # | Mechanism | Verdict |
|---|---|---|
| A | **Re-mint**: the successor generates a **new** host keypair on its own device and publishes the new public key in a signed authority-log entry; verifiers switch to it; the old key's authority ends by log entry | **Chosen.** Works when the old host is dead (nothing to transfer). The old key is not "taken away"; it simply stops being the trusted key, so a compromised or ex-host copy is inert. Key never leaves the device that made it. |
| B | **Transfer** the existing private key to the successor (encrypted export over LAN pairing) | **Dropped.** Impossible in the LOST case, which is half the ruling. In the REMOVED case the old device keeps a working copy forever, so "the old key's authority ends" is false. Also puts a private key on the wire, against "keys never exist outside a trusted device." |
| C | **Pre-shared shards** (Shamir split of the host key across admins) | **Dropped.** Survives loss, but verifiers still trust the *same* public key, so a removed host holding the original key or a shard is never cut off. Adds a ceremony and a new secret-handling surface. |
| D | **No host key**: any admin signs tokens/credentials with its `device_identity_key`; verifiers accept any currently valid admin signature | **Dropped as incompatible** with "exactly one current host … holds the keys," and a far larger rewrite of three verifiers and every token. Noted as the escape hatch if the owner ever withdraws the one-host model. |
| E | Automatic election (uptime, lowest id, round-robin) | **Dropped (trap).** A device a human did not choose silently gains credential-minting power; liveness-based rules need a sequencer, which T331 already rejected. |

Within A there are two sub-choices, settled below: how the successor is authorized (release by the
live host vs. quorum-only when the host is gone) and how conflicting claims resolve (deterministic
change-hash tie-break).

## Decision

### 1. Two new authority-log entry kinds, no change to admin membership

`camp_authority_log` gains two writer-chosen kinds beside `grant` / `revoke`. Neither alters
`grantedSet`; they only drive a new derived value, the **host epoch chain**.

| Kind | Written by | Fields (all signed) | Meaning |
|---|---|---|---|
| `host_release` | the **current host** device | `id`, `target_device_id` = designated successor, `signer_device_id` = host | "I consent to `target` becoming host." Optional; only used for a live handoff. |
| `host_claim` | the **successor** device | `id`, `signer_device_id` = `target_device_id` = claimant, `host_public_key` (hex SPKI DER of the key it just minted), `parent_epoch_id` | "I am host from epoch N+1, here is my new public key." |

Both are signed with the writer's own `device_identity_key` through `signAuthorityEntry`, extended
so `host_public_key` and `parent_epoch_id` are inside the signed canonical message for these two
kinds only (a new domain context, e.g. `shoresh-authority-sig-v3-host`, so grant/revoke signatures
and their v2 context are untouched and the shapes can never be confused). Without binding the public
key into the signature, any document writer could swap the key in a valid claim.

**Epoch 0** is implicit: the genesis entry's `target_device_id` is the host and the trust root is
whatever `camps.signing_public_key` already is. **A camp that never has a succession needs no
migration entry and no document change.** An epoch's id is the id of the claim entry that created
it; epoch 0's id is the genesis entry's id.

### 2. How the successor is chosen

A `host_claim` is **effective** iff all of the following hold at the claim's own causal point (the
same `stateAt(claimChange)` ancestor query T331 already uses, so it is merge-order independent):

1. The signature verifies against the claimant's peer id resolved from the log (the existing
   `createVerifiedEntryTrust`).
2. The claimant is a valid admin at that point.
3. `parent_epoch_id` equals the then-current epoch (a claim cannot reach back and replace an epoch
   already succeeded; a claim whose causal ancestors already contain another effective claim with
   the same parent is dominated and ignored).
4. **Authorization**, either:
   - **Handoff (host alive):** a trusted `host_release` naming the claimant, signed by the parent
     epoch's host, is among the claim's causal ancestors (a signed consent, monotone: it cannot be
     un-said); or
   - **Quorum-only (host removed or lost):** the parent epoch's host device is **not a valid admin
     at the document's current heads** (full replay), i.e. it was removed by the existing T331 revoke
     (immediate for a non-admin target, majority of the **other** admins for an admin or founder).
     Evaluated at heads, not at the claim's own causal point, deliberately: a claim made on a
     device that had not yet synced the host's grant (a blind revoke, T333) must stop being
     effective if the grant later arrives and the replay reclassifies the host as a valid admin.
     Evaluating at the claim's own causal point would make a claim made in ignorance permanent.
5. The claimant is also still a valid admin at heads (a claimant revoked later leaves a host-less
   head; the next admin claims with `parent_epoch_id` = the revoked claimant's epoch, which clause 4
   satisfies).

**Who may claim and the small-camp rule are already decided, not open.** Claimant = any currently
valid **admin device** (clause 2); there is no separate "name the successor" vote because the
removal quorum already acted. The quorum is the one already accepted in
`docs/adr/2026-10-02-distributed-revocation-authority.md`: the **majority of the OTHER admins** (the
target gets no vote), `quorumThreshold(n) = floor((n-1)/2) + 1` at
`electron/automerge/authorityReplay.js:323`; that ADR (~:508) records that it reproduces the owner's
"at 2 admins, the other agreeing is enough". Nothing here changes it. **Consequence for the hard
requirement:** in a 2-admin camp the one remaining admin alone satisfies the revoke quorum
(threshold 1), then alone satisfies clause 4 and claims. It ends as host holding the keys, for both
a device that leaves (revoked) and a device that is lost.

**Safeguards on the claim act (no escalation beyond these):**

- The claimant must be an admin device (authority status `admin`; `authorize()` capability
  `host.claim`, admin-only).
- **Director PIN re-authentication** for the succession act: the `acceptHostRole` / `releaseHostTo`
  IPCs require the PIN again and verify it through `attemptLogin` in
  `electron/auth/localAuth.js` (the single PIN-check funnel, so lockout and timing behave as
  everywhere else); the acting user must be an admin and the same user as the session token. A
  wrong PIN is a denied, audited attempt that writes nothing.
- **LOST-host path only:** a short, claimant-local delay (default 5 minutes, a monotonic local
  timer, tunable) plus an explicit typed confirmation ("the old host is gone and will not come
  back"). The delay is friction against a mis-click, **not** a verifier rule: no peer enforces it
  (no cross-device clock reasoning); the real controls are who may claim and the quorum revoke. The
  handoff path (host alive and consenting) has no delay.
- Both acts are written through `recordAuditEvent` (`host.claim`, `host.release`, outcome and
  reason).

A *wrong* successor is repaired the way a wrong admin is: quorum-revoke that device and the next
claim is again authorized by clause 4. The product surface is a prompt on admin devices once the host
is gone: "The host device was removed. Make this device the host?" A human accepts; nothing is
automatic (rejects E).

**LOST host.** "Lost" is not observable; it is the case where the host cannot sign a release. Path:
revoke the lost device through the ordinary T331 quorum, then one admin claims (with the delay
above). Single-admin camps: out of scope (non-goals).

### 3. How host signing authority moves: re-mint, not transfer

On accepting the prompt the successor device, entirely locally:

1. Generates a **new** Ed25519 keypair (same code path and encoding as `ensureHostSigningKey`, hex
   SPKI/PKCS8 DER). The private key is written only to this device's own database.
2. Writes `host_claim { host_public_key, parent_epoch_id }` through the existing `appendOp` path.
3. Becomes **host-capable only once its own projection reports the claim effective** (section 4).
   Until then the new private key is staged and no handler treats the device as host. This closes
   the window where a losing claimant believes it won.
4. Runs a **re-attestation pass** (below), then enables host-only handlers.

Why the old key's authority ends without anyone deleting it: every verifier reads one key,
`camps.signing_public_key`. The projector overwrites that column from the verified epoch chain
(section 4). A token, credential tuple or tombstone signed by the old key then fails verification. A
removed host that keeps its private key holds an inert key. An old host that is still reachable and
honest deletes its `host_signing_key` row on the first projection showing a later epoch (key
shredding, best effort; correctness does not depend on it).

**Re-attestation pass (the one real cost of re-minting).** Old signatures live in the document:
`users.auth_sig` and tombstone signatures. A device trusting only the new key accepts an *unchanged*
credential already in its local table (existing rule in `upsertUsersEntity`) but refuses a row it has
never seen carrying an old-key signature, so a freshly joined device would project every user as the
safe `staff`/empty-PIN default. The successor therefore re-signs, with the new key and **the same
values and the same `cred_version`**, every `users` row's `auth_sig` and every tombstone's
signature. This needs no PIN knowledge (it signs the stored hash and salt), is bounded by users plus
tombstones, and is idempotent. The existing monotonicity checks (`>=` on `cred_version`, "not older"
on tombstone version) pass for an equal version, so no bump is needed. The pass is a **privileged bulk action** (it re-signs every credential), so it is audited through
`recordAuditEvent` (`host.reattest`: epoch id, counts of users and tombstones, outcome, resume
count) and runs only after the PIN-reauthenticated claim. A `reattested_epoch_id`
marker (section 4) makes the pass resumable after a crash, and re-runs automatically if the epoch
changes again (including a revert, section 8). We deliberately do **not** make verifiers
accept a history of past keys: a removed host could then keep forging credential changes with its old
key indefinitely, which breaks "revoked old host cannot issue."

### 4. How every device learns the current host and key, and split-brain

Devices learn it the way they learn who is revoked: from the **replayed authority log** carried by
the already-authenticated sync. No new network surface, no new transport message, no discovery
change (so T340 and the WAN ladder are untouched).

- `authorityReplay.js` gains a pure `currentHostEpoch(ctx)` beside `currentAuthorityState`. It walks
  the chain from epoch 0: among the effective claims whose `parent_epoch_id` is the current epoch it
  picks the winner, appends it, and repeats.
- **Deterministic tie-break (split-brain).** Two admins can claim concurrently (partition, two prompts
  accepted at once). If one claim is a causal ancestor of the other, the earlier wins and the later
  is dominated (clause 3). If mutually concurrent, the winner is the claim whose authoring **change
  hash** is lexicographically lowest, the same merge-order-independent tie-break
  `isCausallyAtLeastAsLate` already uses for concurrent grants. Every peer computes the identical
  winner from the document alone; convergence needs no coordination. **The tie-break is a convergence rule, not a security control.** A change hash can be ground by a
claimant that varies its entry content, so a malicious admin can bias which of two concurrent claims
wins. That buys nothing a malicious admin could not already do by claiming: the real control is *who
may claim* (a valid admin, and only after the host was removed, clause 4) and the quorum's power to
revoke a bad host. The loser's device sees it lost,
  deletes its staged private key, and shows "another device became host first." The loser never
  re-attests (it was never host-capable), and anything it signed in the gap is overwritten by the
  winner's re-attestation.
- The projector writes the derived result in the same transaction that rebuilds `authority_cache`:
  a single-row, never-synced table `host_authority(id=1, epoch_id, host_device_id, host_public_key,
  reattested_epoch_id, updated_at)`, and sets `camps.signing_public_key` to the chain head's
  `host_public_key` **only when the chain has at least one effective claim**. Epoch 0 leaves the
  column exactly as today. `host_authority` joins the `authority_cache` exclusion class (never in
  `PROJECTIONS`).
- **"Am I the current host"** becomes one function, `isCurrentHost(db)`: this device's id equals
  `host_authority.host_device_id` **and** its `host_signing_key.public_key` equals
  `host_authority.host_public_key` (epoch 0: equals `camps.signing_public_key`). A stale key (old
  host, split-brain loser) fails the second clause by itself. This replaces the `mode === 'client'`
  test and the bare "does a `host_signing_key` row exist" test at the host-only handlers
  (`getJoinCode`, `setJoinWindow`, `createUser`, `promoteToAdmin`, credential and tombstone signing,
  `issueCampToken` / `issueDeviceToken`).
- **Trust root.** The document is not the trust root for the key; the **genesis-rooted,
  signature-verified chain** is. The projector copies only the verified chain head into the local
  column, never a raw document field, which is what Security F1 required (a document writer without a
  valid admin signature cannot move it). This is the assumption T331 already stands on (genesis is
  axiomatic and unsigned, anchored in person at first join).
- A **new joiner** still receives `signing_public_key` in the first-pairing login reply from the host
  it is standing next to (unchanged human anchor); the projector reconciles it to the verified chain
  head on first sync, so a revoked host someone mistakenly joins through cannot permanently pin a
  joiner to its old key.

### 5. What happens to what the old host issued

| Artifact | Rule | Mechanism |
|---|---|---|
| `camp` / `device` tokens (24 h TTL) signed by the old key | **Rejected as soon as a device adopts the new epoch.** Validity is keyed to the epoch by construction: the verifier holds one key. | `verifySessionToken` unchanged; the column changed. |
| Already-admitted **devices** | **Keep working, for non-admin devices only because of section 7.** Admin devices are admitted by `authority_cache`. Non-admin devices are admitted by the replicated `device_approval` record, **not** by the local `devices.authorized_at` (which only the approving host holds). Only the 24 h *token* lapses; the device re-logs-in against the new host. | `evaluateAuthenticate` / `evaluateLogin` consult the approval-derived status (section 7). Test 3. |
| **Pending join code / open Add-a-device window** on the old host | **Hygiene on an honest old host, not enforcement against a malicious one.** An honest old host closes its window on observing the next epoch. A malicious or island old host ignores that, so the real controls are elsewhere: its tokens fail verification on every current-epoch device, its device is revoked at Gate A/B, and any device it approves afterwards produces a `device_approval` entry that is void (section 7). A joiner paired through it reaches only its island and is not trusted by the camp. | `getJoinSecret` / `setJoinWindow` gate in `main.js` (honest-host hygiene only). |
| `users.auth_sig`, tombstone signatures | Replaced by the successor's re-attestation (section 3). | `reattest` job. |
| Anything the old host signs **after** the epoch changed | **Rejected** (wrong key); a changed credential from the old key is audited as a denied `users.credential_change` exactly as a forged one is today. | existing `recordAuditEvent` path. |

### 6. Migration for existing camps

- **Founder = epoch 0 host.** No data migration, no new rows. A camp that never has a succession
  behaves byte-for-byte as today; `host_authority` starts empty and is filled by the first projection
  that sees any claim.
- The one required cleanup: `chooseMode` currently calls `ensureHostSigningKey` on *any* non-`client`
  device, silently minting a fresh host key. After this ADR that lazy minting is allowed only for the
  genesis founder at epoch 0 (`bootstrapCamp` and the existing back-fill for camps predating the
  key). A non-founder obtains host status only through a `host_claim`; otherwise a restored or
  reinstalled device would mint an unrelated key nobody trusts.
- Assumption to verify at build time: every live camp already has a genesis entry (T331 mints it at
  bootstrap; pre-T331 camps need the back-fill the T331 ADR described). Without genesis there is no
  epoch 0 to succeed.
- Schema: one new derived table (`host_authority`), a forward migration plus
  `electron/db/rollback/vNN_down.js`, and `npm run schema:check`. The new entry kinds are data in the
  generic `camp_authority_log` modeled entity, so `campDocument.js` needs only the extended
  completeness predicate, not a new entity.

## 7. Carrying device trust across epochs (B1, confirmed from code)

**The defect in the first draft.** A non-admin (staff/client) device's trust is `devices.authorized_at`,
a **local, unsynced** column written only on the approving host (`electron/main.js`, `approveDevice`
and its idempotent re-approval path). `evaluateAuthenticate` (`electron/auth/connectionAuth.js`)
skips that local check only when `authority_cache` says `admin`. After succession, every
staff/client device approved only by the old host would be denied at the new host
(`device_not_authorized`). "Already-admitted devices keep working" was false for them.

**Decision: a signed, replicated device-approval record in the authority log.** No re-approval pass
that needs the old host (impossible when it is lost), and no local column promoted to a synced one.

- New kind `device_approval` (same v3 signing context family as the host kinds, fields inside the
  signed message): `id`, `target_device_id`, `target_peer_id` (best-effort, as for grants),
  `signer_device_id`. Written by the approving admin in `approveDevice` beside the existing
  `devices.authorized_at` write (non-fatal on failure exactly like the admin grant mint; a failed
  mint is surfaced, not swallowed, because without it the device is stranded by a later succession).
- Replay derives a third `authority_cache` status, `approved` (non-admin, trusted), alongside
  `admin` and `revoked`. `evaluateAuthenticate` and `evaluateLogin` skip the local
  `devices.authorized_at` check for `approved` exactly as they do for `admin`, while the existing
  unconditional `revoked` deny still wins. A `revoke` of the target (immediate for a non-admin)
  supersedes an approval unless the approval is causally later than that revoke (re-approval).
- **Effectiveness (stricter than grants, on purpose).** An approval is effective iff its signer was a
  valid admin at the approval's causal point **and** is a valid admin at the current heads, **or** the
  approval is a causal ancestor of the signer's removal. An approval signed concurrently with, or
  after, the signer's revocation (the island case, section 9) is void. Fail-safe cost: a device
  approved by an admin whose removal was never synced with that approval must be re-approved by a
  current admin.
- **Backfill for existing camps.** On first start after the upgrade, any admin device writes
  `device_approval` entries for each locally authorized, non-revoked, non-admin device it approved
  (idempotent by `target_device_id` + signer). The old host does this on its next start before it
  can be lost. **Residual:** a host that is lost before ever running the upgraded build leaves its
  non-admin devices without a record; they appear as pending at the new host and are re-approved in
  person over the LAN (the existing pairing path). Stated, not hidden.
- `devices.authorized_at` remains the local, host-side record and idempotent re-delivery source; the
  approval record is what makes trust survive a host change.

## 8. Two-device deadlock (T333) in scope: receive-only authority-entry channel, derived marker

Source: `docs/work/tickets/T333-two-device-revocation-recovery.md` and the "Known limitation (v1)"
section plus Amendment 2026-10-03 of `docs/adr/2026-10-02-distributed-revocation-authority.md`. In a
strict 2-device camp a **blind** revoke (the revoker has not synced the target's grant) projects the
target `revoked`; Gate A then denies the only connection over which the correcting grant could
arrive. Resolution here, which settles the T333 design (and amends that ADR, to be confirmed by
Security and Red Hat as T333 requires):

1. **The marker is derived, never stored.** On every projection the replay computes, per `revoked`
   target, `revocation_basis` in `authority_cache`: `corroborated` iff some effective revoke entry
   for the target has the target's genesis/grant entry as a causal ancestor (the revoker knew what
   it was removing); otherwise `uncorroborated`. Because it is recomputed from the document each
   time, **it has no lifecycle to get wrong**: when the grant arrives the replay reclassifies the
   target (to `admin`) or, when a genuine quorum arrived, to `revoked`/`corroborated`. There is no
   sticky flag a later quorum could leave stale.
2. **Gate A consults the basis, but only to open a receive-only channel, never admission.** For a
   `revoked`/`uncorroborated` peer, Gate A still denies admission and sync (unchanged), but replies
   with `uncorroborated_revoke` and accepts one narrow inbound message type on the existing
   authority-gated protocol (`electron/sync/automerge/authGate.js`): `authority_entries_push`, an array of raw
   signed authority-log entries. The receiver sends nothing back beyond the typed reply, verifies each
   entry with the same `createVerifiedEntryTrust` signature check the projector uses (a document or
   peer writer without a valid admin signature changes nothing), ingests the valid ones idempotently
   (by entry `id`), caps count and bytes, rate-limits per peer, and audits.
   Whole-document Automerge sync is **not** opened to the revoked peer, so its edits do not merge.
3. **Admission comes only from the replay.** If the pushed grant makes the replay say `admin`, normal
   admission resumes (that is the self-heal). **No-readmission guarantee:** the channel itself
   never admits anything and the marker is derived, so a device genuinely quorum-revoked (including
   the blind-revoke-then-genuine-quorum sequence: first revoke uncorroborated, later quorum entries
   whose causal ancestry contains the grant) is `revoked`/`corroborated`, the channel is closed to it,
   and nothing a revoked peer pushes can reverse a quorum (replay is the sole authority).
4. **Composition with succession in a 2-device camp.** A and B; B blind-revokes the host A (B never
   synced A's grant), then claims (clause 4 holds at B's heads). If A is genuinely gone, nothing
   else happens: B is host. If A is merely lagging, A pushes its grant over the channel; the replay
   at B's heads reclassifies A as a valid admin, B's quorum-only claim is no longer effective
   (clause 4 is evaluated at heads), the epoch reverts, B shreds its staged key, A is host again and
   its re-attestation re-runs (keyed on the epoch id). If A and B had instead completed a genuine
   quorum revoke, A stays `revoked`/`corroborated` and cannot return.
5. Cost accepted: a genuinely revoked non-admin device is `uncorroborated` by definition (no grant
   exists to be an ancestor), so it also keeps the receive-only push channel. It can only submit
   signed entries it holds, nothing is sent to it, and everything is capped and audited.

## 9. Partitioned (island) devices (B2)

**The bound, stated plainly.** Revoking a host cuts off its ability to issue **only on devices that
have adopted the new epoch**. A revoked host on a LAN island with some of the camp's devices keeps a
working camp there: its `isCurrentHost` stays true locally, it never sees `host_claim`, and it can
mint tokens that island devices accept. Nothing in this design can reach a device that is not
reachable. Peers on the current epoch deny the island host (its tokens do not verify against the new
key, and its device is `revoked` at Gate A/B). What the design guarantees is the **path back**:

- **Denial path when an island device later meets a current peer.** The current peer rejects the
  island device's old-epoch token with a typed code `stale_host_epoch` (distinct from
  `invalid_token`) and, to peers whose Noise peer id is bound to a known device row, returns the
  signed authority entries (a small, bounded set). The island device verifies them with the same
  signature check, ingests them, and its replay derives the new epoch. It then: drops its stale
  `isCurrentHost`, closes any join window, deletes a superseded host key if it held one, and (as a
  client) re-logs in to the new host. Heal requires no trust in the denier, only in the signatures.
- **A revoked island host that meets a current peer** is denied by Gate A (revoked); with an
  `uncorroborated` basis it falls under section 8's receive-only channel; with a corroborated one it
  gets only the typed denial and the entries, so it learns it was removed.
- **Island-approved devices.** Devices the island host approved after its removal are void by the
  section 7 effectiveness rule once the logs merge; they are denied on the current epoch until a
  current admin re-approves them.
- **Island-written data.** Edits made by a revoked island host do not merge (Gate A), by design.
  Island clients that are not revoked re-login to the new host and merge normally.

## Code seams (what the build touches)

1. `electron/automerge/authorityLogSignature.js`: v3 host-entry canonical message and sign/verify for
   `host_release` / `host_claim`.
2. `electron/automerge/authorityLog.js`: `mintHostReleaseEntry`, `mintHostClaimEntry`.
3. `electron/automerge/authorityReplay.js`: `isCompleteEntry` for the new kinds, `currentHostEpoch`.
4. `electron/automerge/projector.js`: write `host_authority` and the `camps.signing_public_key` head
   in the authority-log transaction; ensure it runs **before** `users` and `tombstones` project in
   `projectAll`.
5. `electron/auth/localAuth.js`: stage-only `rotateHostSigningKey`, `isCurrentHost`; gate
   `issueCampToken` / `issueDeviceToken`; restrict `ensureHostSigningKey` to epoch 0.
6. `electron/auth/authSignature.js`, `electron/automerge/tombstoneSignature.js`: sign only as current
   host; add the re-attestation pass.
7. `electron/main.js`: replace `mode === 'client'` at `getJoinCode` / `setJoinWindow` and the
   `createUser` / `promoteToAdmin` paths with `isCurrentHost`; new IPC `getHostStatus`,
   `acceptHostRole`, `releaseHostTo` (admin-gated through `authorize()`, new admin-only capabilities
   `host.claim` / `host.release`); close the join window on epoch change.
8. `electron/sync/automerge/syncNode.js` / `syncStarter.js`: `getJoinSecret` and `isJoinWindowOpen`
   fail closed unless `isCurrentHost`; the host's `setAuthToken` path uses the current key.
9. `electron/automerge/hostKeyPreservation.js`: purge/rebuild restore must not resurrect a
   superseded key as host (compare to `host_authority`).
10. UI: Device screen shows the current host and, on admin devices after a host removal, the "Make
    this device the host?" prompt; Add-a-device and Approve/Deny enabled only on the current host.
    `DESIGN_STANDARD.md` §5 and §8 apply to the claim-in-progress and re-attest states (pending,
    success and failure feedback; reduced motion is never no feedback). Failures surface; no banners
    (use flags).
11. `electron/auth/connectionAuth.js`, `electron/sync/automerge/authGate.js`: `approved` status in
    `evaluateAuthenticate` / `evaluateLogin`; `stale_host_epoch` and `uncorroborated_revoke` replies;
    `authority_entries_push` handler.
12. `electron/main.js` `approveDevice`: mint `device_approval`; backfill job; PIN-reauth
    (`attemptLogin`) in `acceptHostRole` / `releaseHostTo`; LOST-path delay and confirm.
13. `SECURITY.md` ("Ed25519 Host-only token minting") and `docs/current/KEY_RECOVERY_STORY.md` ("Host
    signing key" row) updated in the build PR, not here.

## `org-interface-contracts` checklist

- **Idempotency.** `host_release` and `host_claim` ids are random UUIDs bound into the signature, like
  grant/revoke. A replayed identical entry is the same record. Re-attestation re-signs identical
  values, so running it twice is a no-op.
- **Concurrent retries.** Two claims, or one device claiming twice, converge by the deterministic rule
  in section 4; a duplicate claim from the same device is dominated by its own earlier one.
- **Unknown outcome.** A claimant that crashes after writing the claim but before seeing it effective
  re-derives its state from the projection on restart; host-capability is never assumed from having
  written. The re-attest job is resumable via `reattested_epoch_id`.
- **Error shape.** `acceptHostRole` returns `{ ok:false, reason }` with distinct reasons (`not_admin`,
  `host_still_valid`, `claim_lost`, `already_host`); handlers that previously threw `mode ===
  'client'` text return `not_current_host` carrying the host's name so the UI can say who to go to.
- **Authority boundary.** Every new handler goes through `authorize()`; the replay, not the writer,
  decides effectiveness (no self-reported "I am host"); the key never enters the document or
  `PROJECTIONS`.
- **Trust-boundary data.** `host_public_key` arrives from other devices, so it is validated (hex SPKI
  DER, parses as Ed25519) and signature-verified before the projector copies it anywhere.

## Red-before-green tests the build must include

All against the real handlers and the real replay, in the style of `clientHostedJoin.test.js` (real
nodes, real sqlite, no mocked `authorize()`). Each is written and seen failing first.

1. **Succession after revoke (handoff).** A (host) releases to B (PIN re-auth); B claims; every
   device's projection shows B as host and B's key in `camps.signing_public_key`; B can create a user;
   A cannot, and A's previously issued tokens no longer verify on any device.
2. **Succession after loss via quorum, incl. N=2.** Three admins A (host, offline forever), B, C: B
   alone cannot claim while A is valid; B and C quorum-revoke A; B claims after the delay and typed
   confirm; effective. **N=2: the single other admin revokes (threshold 1) and claims and ends as host
   holding the keys**, for both "A revoked" and "A lost".
3. **Non-admin client approved only by the old host is admitted by the new host.** Client K is a
   non-admin approved by A only (A writes `device_approval`); K's `devices.authorized_at` on the new
   host's database is NULL (assert it, so the pass cannot come from the local column). After B becomes
   host, K re-logs in to B and is admitted and syncs. Red first against today's code: K is denied
   `device_not_authorized`. Also: an approval by A concurrent with A's removal is void.
4. **Old tokens rejected, admitted devices keep trust.** A client with an A-signed `camp` token gets
   `invalid_token` after adopting the epoch, re-logs in to B and syncs; its approval status and
   `authority_cache` are unchanged.
5. **New host completes a LAN join** end to end and the joiner projects all pre-existing users
   correctly (proves re-attestation).
6. **Revoked old host cannot issue.** A, still holding its key and a running node, signs a credential
   change, a tombstone and a device token: all refused on peers, the credential attempt audited as
   denied.
7. **Split-brain.** B and C claim concurrently while partitioned; after merge in both orders every
   peer elects the same winner; the loser deletes its staged key.
8. **Stale, wrong-parent, non-admin, swapped-key claims** are each ignored; a claim without the PIN
   re-auth, or in the LOST path without delay and confirm, writes nothing.
9. **Partition / island.** A (revoked) and client K on an island, B and C on the current epoch. While
   partitioned A keeps issuing (assert the bound). On reconnect: K's old token gets `stale_host_epoch`
   plus the entries, K verifies them, flips to the new epoch, closes any window, re-logs in; A is
   denied, learns its removal, `isCurrentHost` becomes false, host-only handlers return
   `not_current_host`; a device A approved on the island is denied until re-approved.
10. **T333 recovery, strict 2-device camp.** B blind-revokes A (A's grant unsynced). A connects: Gate A
    replies `uncorroborated_revoke`, accepts only `authority_entries_push`, A pushes its grant, B's
    replay reclassifies A as `admin`, admission resumes; A's edits did not merge before that.
11. **T333 no readmission.** Blind-revoke-then-genuine-quorum: B blind-revokes A, then a genuine quorum
    revoke syncs in; A is `revoked`/`corroborated`, the push channel is closed, and A is never
    readmitted by any push, replay order, or stale marker (permuted merge orders). Security and Red Hat
    re-confirm this one, as T333 requires.
12. **Composition, 2-device.** B blind-revokes host A and claims; A's grant arrives; the claim stops
    being effective at heads, the epoch reverts, B's staged key is shredded, A re-attests and is host;
    and the same sequence with a genuine quorum leaves B host and A out.
13. **Re-attestation** is audited as one privileged bulk event, is resumable after a kill, and a fresh
    joiner projects every user.
14. **Epoch 0 unchanged and purge/rebuild.** A camp with no claims behaves exactly as today (existing
    suites green); `ensureHostSigningKey` refuses to mint on a non-founder; a purged-and-restored
    device does not regain host status from a superseded key.

## Residual risks

- **Island bound (B2).** A revoked host keeps a working camp on an island and can issue to island
  devices until they meet a current peer. Not preventable by any design; the path back and the void
  approvals are specified and tested.
- **Existing camps whose host is lost before running the upgraded build** have no `device_approval`
  records for non-admin devices; those devices are re-approved in person.
- **Receive-only channel** is a new pre-admission surface (capped, rate-limited, signature-verified,
  audited); a revoked non-admin device keeps it. Needs Security sign-off.
- **Claim by a malicious admin** gains credential and join power until the quorum revokes it; same
  exposure T331 already accepts. The tie-break is grindable and is not a control (section 4).
- **Claimed key the claimant does not hold:** availability fault; repair is revoke-and-reclaim.
- **Epoch revert** (section 8.4) re-runs re-attestation and discards a staged key; brief window where
  two devices each believe they are host is bounded by sync.
- **24 h token turnover:** every device re-signs in once; test 4 fails if `onAuthRejected` does not
  already behave that way (assumption, not verified here).
- **Conflict rows:** the build must confirm re-attestation rewrites do not surface as human conflicts.
- **Stolen-and-unrevoked host stays host until the quorum acts.** Same exposure as today.

## Reused vs. new

**Reused unchanged:** the authority log and its signing key (`device_identity_key`), the causal replay
and tie-break primitives, the quorum, `authority_cache`, the three verifiers and the
`camps.signing_public_key` column they read, token and credential formats, join proof, LAN pairing.
**New:** two entry kinds, one replay function, one derived single-row table, one key-staging and
re-attestation pass, `isCurrentHost`, and three small IPCs.

## Confidence

Re-mint with log-authorized claim: **80%**. Replicated `device_approval` record for B1: **80%**
(directly fixes the confirmed local-column defect; the backfill residual is real). Receive-only
authority-entry channel for T333 with a derived marker: **70%** (new pre-admission surface; the
no-readmission argument rests on admission being decided only by replay, to be re-confirmed red-first
by Security and Red Hat). Evidence: the code facts cited above; deterministic evidence is the tests,
not this document.

## Open questions

None for the owner. Who may claim and the small-camp quorum are decided (section 2, citing the
2026-10-02 ADR); single-admin camps are out of scope by ruling. Tunables left to the build: the LOST-path
delay length (default 5 minutes) and the push-channel caps.
