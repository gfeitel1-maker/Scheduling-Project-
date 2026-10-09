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
  - docs/adr/2026-10-02-distributed-revocation-authority.md
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
     Evaluated at heads, not at the claim's own causal point, deliberately: if a valid admin later
     re-grants the removed host (section 8.3), the claim must stop being effective. A blind revoke made
     without the host's grant never reaches this clause, because under the section 8.1 amendment that
     vote does not count (its author saw no valid grant of the host).
5. The claimant is also still a valid admin at heads (a claimant revoked later leaves a host-less
   head; the next admin claims with `parent_epoch_id` = the revoked claimant's epoch, which clause 4
   satisfies).

**Admin status here means the effective-grant set of section 2.1.** In clauses 2 and 5, and for every
vote and denominator behind clause 4, "valid admin" means a member of `Admins(heads)` as computed by
the single effective-grant fixed point of section 2.1. There is **no host-only filter**: the owner's
first "tighten" ruling (2026-10-09), which held only host-feeding grants to an effectiveness rule, is
superseded by the keeper's option (A) decision the same day, which fixes the weakness at its root for
every authority computation, host or not. The attack that motivated it (a quorum-removed admin M
backdates `grant(X)` for a stand-in X onto pre-removal heads; X revokes host B at `quorumThreshold(2) = 1`
and claims) is refused because M's backdated grant is not effective, so X is not an admin, X's vote
does not count, and X cannot claim (tests 13a to 13c). The T331 base residual ("a removed admin can
backdate a grant and regain admin") is **closed by this amendment, pending acceptance** (section 2.1).

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

### 2.1 The effective-grant fixed point (one rule for grants, votes and the denominator)

**This AMENDS T331 grant validity** (`docs/adr/2026-10-02-distributed-revocation-authority.md`,
amendment note there, proposed pending acceptance). T331's `stateAt` accepts a grant iff its signer was
a valid admin *at the grant's own causal point*. That is why a removed admin can backdate: the signer
genuinely was valid at the point the grant claims to descend from. The replacement is one definition,
used by `grantedSet` (who is an admin), by the vote tally (whose votes count) and by `n` in
`quorumThreshold(n)`, for every removal, host or not.

**Terms.** `G` is the set of signature-verified `genesis`/`grant` entries; `<` is the causal-ancestor
relation of the Automerge document. A *counted vote* against admin `s` is a `revoke` vote whose author
holds an effective grant that is a causal ancestor of the vote (or is the founder) and, per section 8.1,
whose own ancestors contain an effective grant of `s` (or `s` is the founder). A *removal quorum*
`Q(W)` holds for a set `W` of counted votes by distinct voters iff `|W| >= quorumThreshold(n_W)`, where
`n_W` is the number of admins in the effective set evaluated on the **joint causal past of `W`** (the
union of the ancestors of its votes, excluding the votes themselves). The removal of `s` *takes effect*
iff some `W` of counted votes against `s` satisfies `Q(W)` and no later grant of `s` that has the votes
as ancestors supersedes them (the unchanged T331 staleness rule). `C_s` is the set of counted votes of
the removal in force at heads.

**Grant effectiveness.** A grant `g` (signer `s`, target `t`) is **effective** iff the genesis entry,
or one of:

1. **Alive signer.** `s` is an admin at heads: `s` is the founder, or holds an effective grant, and the
   removal of `s` has not taken effect. Position in the causal graph is irrelevant here: an admin who is
   current and effective could simply mint the same grant today, so backdating gains nothing.
2. **Pre-removal grant of a removed signer.** The removal of `s` has taken effect, `s` held an effective
   grant (or is the founder) that is a causal ancestor of `g` (the old `isValidSignerAt` condition, kept
   for this branch), and the removal does not need a vote that has not seen `g`: there is no `W` among
   the counted votes in `C_s` that lack `g` as an ancestor with `Q(W)`. Equivalently: `g` precedes the
   removal iff the quorum could not have been reached by voters who had never seen `g`. A backdated
   grant fails this test, because the voters who removed `s` did not have it. This is the branch that
   section 7 applies to `device_approval` ("the grant is a causal ancestor of the signer's removal");
   section 7's rule is this rule, with an approval in place of a grant.

`Admins(P)` for a causally closed set `P` is the set of devices that hold an effective grant in `P`,
less those whose removal has taken effect in `P`. `Admins(heads)` is the one set every consumer reads:
`grantedSet`, `authority_cache` (`admin` and `revoked`), Gate A and Gate B, the three verifiers, host
claim clauses 2, 4 and 5, vote counting, and every `n`.

**The fixed point.** Effectiveness and removals depend on each other (a grant is effective depending on
a removal; a removal depends on which votes count and on `n`, which depend on which grants are
effective). The set is defined as the limit of a descending iteration:

1. `E_0` := every grant in `G` that is valid under today's T331 rule (signer valid at the grant's own
   causal point). Today's behaviour is the starting state.
2. `E_{k+1}` := `E_k` restricted to grants that satisfy the effectiveness rule above when voters,
   counted votes and `n` are all computed from `E_k`. Nothing is ever added back.
3. Stop when `E_{k+1} = E_k`. The result `E` is stable (every member satisfies the rule against `E`).

*Termination.* `E_k` is a subset of a finite set and never grows, so the loop stops within `|G|` rounds.
A two-hop chain (M to X to Y, test 13b) needs two rounds: X's grant falls in round 1, and Y's falls in
round 2 because its signer X is no longer an admin.

*Uniqueness and merge-order independence.* Every step is a pure function of the **set** of signed
entries and their ancestor relation. No step reads delivery order, arrival time, or a local cache, so
every device holding the same entries computes the same `E`; with different entries it computes a
possibly different `E`, which is ordinary eventual consistency, converging once the entries are
shared. The operator is **not monotone** (dropping a grant lowers `n` and also removes votes), so no
lattice theorem is claimed; the uniqueness is by construction of the descending iteration, and the
build must prove it empirically: a property test that runs every permutation of delivery for each
fixture in section 13 and 16 and a brute-force oracle for `Q`, comparing `E` across permutations.
*Stickiness is deliberate and fail-safe*: a grant dropped in round k is not readmitted in a later
round even if a later round would have accepted it, which can only withhold authority, never grant it.

**Why the denominator is read on the voters' joint past, not at heads (deviation to flag, keeper
decision needed).** The accepted T331 text recomputes `n` at heads on every evaluation (its case (c)).
Under the effective-grant rule that is unsound by itself: M, quorum-removed by honest A and B at
`n = 3` (threshold 2), later has backdated stand-in grants X1 and X2 delivered. A heads denominator
becomes 5 (threshold 3), A and B no longer reach quorum, M is *not removed*, and M's backdated grants
survive the alive-signer branch. The attack un-removes M through the denominator alone, with the
iteration never getting a chance to drop X1 and X2. Reading `n_W` on the joint causal past of the voting
set makes a removal that took effect a function of what its voters had seen, so grants arriving later
cannot raise the bar for it. The consequence: **a concurrent legitimate admin the voters had not seen
no longer raises the bar for a removal already carried** (T331 case (c) narrowed in that one respect);
ordinary growth of the admin set by genuine grants the voters had seen still raises it exactly as today.
This is the only part of this amendment I am not able to take straight from the keeper instruction.

**Why removals of non-host admins cannot shrink `n` illegitimately.** `n` is only ever shrunk by a
removal that took effect, which needs `Q(W)` over counted votes by effective admins at the quorum
`n_W` they saw: the same majority of the other admins as today, for host and non-host admins alike. A
stand-in or a removed admin's backdated grantee is not effective, so it neither votes nor sits in `n`;
it therefore can neither supply a missing vote nor inflate `n` to block a genuine one (test 13c). The
one other way `n` falls is the liveness cost below (an honest admin's grant dropped because its signer
was removed by voters who had not seen it); that requires a genuine quorum to have removed the signer
and is the same shrink the quorum has already authorised, never one a minority can cause.

**Liveness cost (named, accepted by the keeper's decision).** An honest admin H granted by signer S
loses effective admin status if S is later removed by voters who had not synced that grant. H must be
re-granted by a current admin. Fail-safe by design: the same observable fact (a grant the removing
quorum never saw) is exactly what a backdated attack looks like.

**Required visible re-grant path (keeper condition): a flag on the device's row in LAN & Devices.**

- *When it shows:* on every current admin's `devices` screen (`src/screens/`, sidebar entry `devices`,
  label "LAN & Devices"), on the row of any device that holds a verified grant that is **not**
  effective because its signer's removal took effect, and that has not been revoked or re-granted.
  Derived from replay (the grant exists in `G`, is not in `E`, and its signer is in a taken-effect
  removal), never from a local flag, so it appears on every admin device in the same projection and
  clears everywhere once the re-grant syncs. A device whose grant was dropped by the chain rule (its
  signer was itself ineffective) shows the same flag; a director who does not recognise the device
  simply does not re-grant it.
- *Flag copy:* label "Admin access lapsed"; detail "<Signer name> made this device an admin, then was
  removed before every admin had seen it. Until a current admin approves it again, it can't act as an
  admin." Action "Make admin again".
- *What the action does:* it mints an ordinary `grant` through the existing admin-mint path (T332), signed
  by the acting current admin, which is the alive-signer branch and therefore always effective. On
  completion the flag clears, `n` is restored, and the device regains host eligibility (it may claim, and
  counts in quorums). It uses no new IPC, `authorize()` capability or entry kind.
- *The affected device itself* shows the same flag on its own row ("Ask a current admin to approve this
  device as an admin again"), with no action button, because it cannot act.
- *Design standard:* `DESIGN_STANDARD.md` §5 (states) and §8 (transitions) apply. The action has pending
  (button busy, disabled), success (flag removed, row updated) and failure (inline error, flag stays)
  states; the flag appearing or clearing is a text and colour-token change with a 150 ms fade, and under
  reduced motion it is an instant change plus the same text change, never no feedback. No banner; the
  flag uses the existing flag treatment (`--warning` family, not `--danger`, since this is recoverable).

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
**Pre-admission surface is unchanged:** no authority entry, epoch or key is ever sent to a peer that is
not admitted; a denied peer receives only the existing typed denial (section 9). Authority entries
reach a device only over an admitted, authenticated sync.

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
| Already-admitted **devices** | **Keep working, for non-admin devices only because of section 7.** Admin devices are admitted by `authority_cache`. Non-admin devices are admitted by the replicated `device_approval` record, **not** by the local `devices.authorized_at` (which only the approving host holds). Only the 24 h *token* lapses; the device re-logs-in against the new host by identity-key login (section 7.1), with no host-held secret. | `evaluateAuthenticate` / `evaluateLogin` consult the approval-derived status (section 7). Test 3. |
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
- **Effectiveness (the same rule as grants, section 2.1).** An approval is effective iff its signer is
  in `Admins(heads)`, **or** its signer's removal took effect and the approval precedes it (the
  section 2.1 pre-removal test with an approval in place of a grant). An approval signed concurrently with, or
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

### 7.1 Login across epochs: bind to the device identity key, not a host-held secret (B1b)

**The second defect in B1 (confirmed from code).** `evaluateLogin` (`electron/auth/connectionAuth.js`)
requires a local `devices` row and compares `device_secret_identifier`, an HMAC secret minted by the
approving host (`approveDevice` in `electron/main.js`) and re-delivered from the same row by
`evaluatePairingRequest`. `devices` is not projected (no entity in `projector.js` / `campDocument.js`).
So a client K approved by old host A has no row and no secret on new host B: `not_paired` /
`bad_secret` regardless of `authority_cache`. Section 7's `approved` status alone does not let K log in.
`evaluateAuthenticate` has the same dependency on a row (it self-inserts a pending one).

**Decision: for authority-recorded devices, network login is bound to the libp2p peer id, which is the
public identity of the device's `device_identity_key` and is authenticated by the Noise handshake
before `evaluateLogin` runs.** No host-held secret is needed, so nothing has to carry across epochs.
(Rejected alternative: a rebind-on-first-contact proof signed with the identity key. It adds a message
and a challenge for the same guarantee Noise already gives; kept only as the fallback if the Noise
peer id is unavailable on some transport, which it is not on libp2p.)

- `device_approval` and `grant` already carry `target_peer_id`; for the identity path it becomes
  **required for `device_approval`** (signed, inside the v3 canonical message). `approveDevice` takes it
  from `devices.libp2p_peer_id`, which was bound at the Noise-authenticated pairing request. If the
  peer id is not yet bound, `approveDevice` completes the legacy local approval but **surfaces** that the
  device will not survive a succession (no silent success), and mints the record on the device's next
  contact.
- Replay resolves, per device, the effective peer id (`resolveAuthorityPeerIds` extended to the
  `device_approval` kind, same causally-latest tie-break) and the projector writes it to a new nullable
  `authority_cache.peer_id` column (derived, never synced; the `status` CHECK gains `'approved'`).
- **`evaluateLogin`**: status `revoked` denies, unchanged. If status is `admin` or `approved`, a
  `peerId` is presented, and `peerId === authority_cache.peer_id`, the device is **identity-bound**: skip
  the `devices` row, the `trust.authorized` check and the secret comparison entirely, then run
  `attemptLogin` (PIN/lockout, unchanged). Otherwise (no peer id recorded, no peer id presented, or a
  different one) fall through to today's row-and-secret path, so same-host logins and pre-upgrade devices
  behave as before. A mismatch is not a new code: it simply fails the legacy path with the existing
  generic `not_paired` / `bad_secret`.
- **`evaluateAuthenticate`**: same condition; for an identity-bound device it **skips the pending
  `INSERT OR IGNORE INTO devices`** and skips `bindOrVerifyPeerIdentity` (equality with the signed peer
  id is stronger than trust-on-first-use), still verifying the token and `verified.deviceId === device_id`.
  Everything after (`persistAppliedTombstones`, which has a `devices` foreign key, see the build check)
  must tolerate a missing row: the build either guards that insert for identity-bound devices or writes
  the report row only when a `devices` row exists. Flagged as a seam, not assumed.
- Why this is no weaker: the old secret was a bearer value that anyone holding the device's disk could
  replay from another machine; the peer id requires the private identity key (already the T162 binding
  rationale). A copied token or copied secret does not authenticate; a copied identity key was already
  the accepted compromise (T162).
- **Migration.** Schema: `authority_cache.peer_id` nullable plus the widened status CHECK (forward
  migration, `electron/db/rollback/vNN_down.js`, `npm run schema:check`). Data: existing devices keep
  working on the legacy path until the section 7 backfill writes their `device_approval` (which now
  includes `target_peer_id`). A device whose peer id was never bound has no identity path and is
  re-approved in person, the already-stated residual.
- **Test (red first, real handlers, real sqlite):** K is approved by A; B is a different host that has
  synced the authority log; assert `SELECT COUNT(*) FROM devices WHERE id = K` is **0** on B (and
  `authorized_at` / `device_secret_identifier` absent), then K, presenting A's old peer-bound identity
  over a real Noise connection, passes `evaluateAuthenticate` and `evaluateLogin` on B and syncs, still
  with **no `devices` row for K afterwards**. Red against today's code: `not_paired`. Negative: the same
  login from a different peer id, or after K is revoked, is denied with the existing generic reasons.

### 7.2 Non-blocking items folded in

- **`currentRevokedDeviceIds` and the projector's target set (re-approval after a non-admin revoke).**
  Today both treat any device named by any entry as "ever targeted" and mark it `revoked` unless
  granted (`projector.js` `everyTargetDeviceId`; `authorityReplay.js` `currentRevokedDeviceIds`, also
  consumed by the rotating discovery tag). A `device_approval` target would therefore project as
  `revoked`, and a non-admin re-approved after an earlier revoke would stay revoked forever. Change: the
  target set is built only from `grant` / `revoke` kinds; `approved` is computed separately; a revoke is
  superseded by an effective approval that is causally later (section 7), and `currentRevokedDeviceIds`
  must exclude such a device so discovery does not treat it as revoked. Test: revoke a non-admin, then
  re-approve it; it is `approved` in `authority_cache`, absent from `currentRevokedDeviceIds`, and admitted.
- **Fail-safe de-trust cost, pinned.** An approval signed by an admin whose removal reached a device
  before the approval did (or concurrent with it) is void, so devices approved by a not-yet-synced admin
  need a current admin's re-approval. Deliberately fail-safe; test: approval by M concurrent with M's
  removal is void, a causally earlier one is not, and the de-trusted device is re-admitted after
  re-approval by a current admin.
- **Capability.** `device_approval` is written only through `approveDevice`, which is `devices.approve`
  (admin) and, after T351, available to an admin on any trusted non-revoked device, not only the setup
  device. The mint is therefore admin-only and mode-agnostic; a staff-role write of the kind is
  untrusted by the replay (signer must be a valid admin at the entry's causal point).

## 8. Two-device deadlock (T333) in scope: amend T331 vote counting, no new channel

Source: `docs/work/tickets/T333-two-device-revocation-recovery.md` and the "Known limitation (v1)"
section plus Amendment 2026-10-03 of `docs/adr/2026-10-02-distributed-revocation-authority.md`.

**What the first draft got wrong (confirmed from `stateAt` in `electron/automerge/authorityReplay.js`).**
`stateAt` drops a revoke vote as stale only when the target's grant has the vote as a causal
ancestor (the vote predates a re-grant). A vote that is **concurrent** with the grant (the revoker had
not seen it: a blind vote) stands, and `quorumThreshold(2) = 1`, so at N=2 one blind vote does remove
the target when the grant arrives. The first draft's self-heal ("the replay reclassifies the target to
`admin` when the grant arrives") was therefore false, and the receive-only channel built on it only
let a locked-out peer deliver a grant that the replay would still not honour. That channel is
**dropped** (section 9, Decision 3 below).

### 8.1 Decision: a revoke vote counts only if its author had seen a valid grant of its target

**This is a deliberate amendment to `docs/adr/2026-10-02-distributed-revocation-authority.md`**
(its vote-counting rule and its "Known limitation (v1)" section; that ADR carries a short amendment
note, marked proposed and pending acceptance of this ADR, and T333 closes against this one). The
current rule in `authorityReplay.js` stays untouched until this ADR is accepted. Rule, in `stateAt`'s
vote-staleness step (the predicate is **inverted** from the first revision of this section):

> A revoke vote V against a **granted** target T (an admin in the evaluated granted set) counts toward
> quorum at an evaluated point iff **V's own causal ancestors contain at least one valid `grant` of T**
> (validity per the existing `isValidSignerAt`, unchanged), **or T is the epoch-0 founder** (admin via
> `genesis`, which every device holds). A vote whose author had seen no valid grant of T (a blind vote)
> does not count. The existing staleness rule is **kept unchanged**: a `grant` of T that has V as a
> causal ancestor supersedes V. A grant that does not have V as an ancestor (concurrent with V, or
> backdated onto earlier dependencies) never supersedes and never voids V. Revokes of non-admin devices
> are not quorum votes (they are immediate, section 7.2) and are unchanged.

**"Valid grant" now means an effective grant (section 2.1).** For the saw-grant clause, a grant of T
counts iff it is a member of the effective set `E`; the old test (signer valid at the grant's own
causal point) is `E_0`, the first iteration of the fixed point, and is no longer sufficient alone.
Because the effective set is a descending limit that only removes grants, the section 2.1 fixed point
can only remove a grant from consideration, never add one.

The predicate reads the entry set and ancestor relation only, so it is a pure function of the
signed entries and is merge-order independent (the section 2.1 argument). Nothing a third party adds to the document later can change whether V counts, except a
grant that already has V as an ancestor (an author who saw V).

**Why inverted.** The first revision counted V only if every valid grant of T in the evaluated
ancestors was an ancestor of V. That makes V's validity depend on grants V's author never saw, so any
admin able to author a `grant(T)` on pre-vote dependencies could void a legitimate quorum after the
fact (section 8.2, backdated-grant attack). The inverted predicate makes validity depend only on what
the voter saw.

**Consequences, stated plainly.**

- At N=2 a blind revoke (author saw no grant of T) does not remove T: the target stays `admin`, Gate A
  never denies it, and nothing needs to "heal". No `revocation_basis` marker, no
  `uncorroborated_revoke` reply, no `authority_entries_push` channel exist in this design.
- **The founder cannot be blind-revoked, and a vote against it always counts.** In a strict 2-device
  camp each admin holds the other's grant by construction, so the T333 lockout as ticketed cannot be
  reached; the amendment closes the residual window in which a grant is in flight.
- **Residual (said plainly).** A revoker that has never seen a target's grant sees "a device with no
  grant" and revokes it on the non-admin immediate path; once the grant arrives that vote does not
  count. Until then Gate A on that revoker denies the target. In a 3+ device camp the grant arrives via
  any third peer. In a strict 2-device camp it cannot occur. It can occur in a camp that *was* larger
  (admin T granted by a since-removed third admin C, and the remaining admin has not synced that grant
  while T is its only reachable peer); that is **out of T333's stated scope**, recorded as a residual
  risk and an accepted limitation, not claimed fixed.
- **Re-grant power is not widened, and is in one respect narrower than today's draft.** Only a grant
  whose author saw V (V is its ancestor) supersedes V, exactly as now. A concurrent or backdated grant
  does not.

### 8.2 No-readmission argument (and why it holds)

Claim: a device that has been genuinely quorum-revoked is never readmitted by a blind vote, by a
backdated or concurrent grant, by delivery order, or by any peer-pushed message.

1. Admission is decided only by the replay over the document. There is no marker, no sticky flag and no
   channel that admits anything, so there is no lifecycle for a later quorum to leave stale.
2. A blind vote V_b (its ancestors contain no valid grant of T) never counts at any evaluated point.
   The sequence "blind revoke, then genuine quorum" is decided by the genuine votes alone: each genuine
   voter has a valid grant of T among its own ancestors, counts, and removes T once
   `quorumThreshold(grantedSet.size)` is reached. V_b contributes nothing before or after.
3. **Backdated-grant attack.** Admins M and T are removed by a genuine quorum, or M is itself removed
   and T is the target. M (no longer a valid admin at heads, but valid at an earlier causal point)
   authors `grant(T)` with dependencies chosen to be the pre-vote heads and relays it through any
   admitted peer; any merge order delivers it. Under the inverted predicate: (a) each genuine vote V
   has a valid grant of T among its **own** ancestors (the original one), so V still counts;
   whether the backdated grant exists, or arrives first or last, changes nothing about V's ancestors;
   (b) the backdated grant does not have V as an ancestor, so the unchanged staleness rule does not
   supersede V; (c) the grant adds no new admin, because T was already granted and T's removal is
   decided by the votes, not by how many grants exist. T stays removed in every merge order. The
   relaying peer is irrelevant: authorship and causal position are inside the signed entry, not
   properties of the carrier. The first revision failed exactly here, which is why it was inverted.
4. Counting is per distinct signer over a pure ancestor-set function, and removals only lower other
   targets' thresholds (the existing monotone fixed point). Nothing in the amendment adds a path that
   adds an admin; the only way T returns is a new `grant` by a valid admin **who saw the votes** (V is
   its ancestor), the existing authorized readmission act.

If a reviewer finds a sequence that violates point 2 or 3 the amendment fails; the red-first tests
(10, 11, 11b) are the deterministic evidence, not this argument. **Confidence in the amendment: 78%**
(the rule is small and keeps the old staleness rule; the risk is an interaction with the existing
round-4 multi-vote handling and tie-break paths that only the permuted-merge-order tests will expose).

### 8.3 Composition with succession (replaces the first draft's 8.4)

`host_claim` clause 4 (section 2) is evaluated at heads against the amended replay.

- **Founder host A, 2 devices.** B's revoke of A counts (genesis), clause 4 holds, B claims and is host.
  If A was merely lagging, that was still a deliberate revoke by a human on B; A is out. There is no
  self-heal and none is claimed.
- **Non-founder host H, blind revoke.** B revokes H without having H's grant: the vote does not count,
  H stays a valid admin at B's heads, clause 4 fails, and B cannot claim (`host_still_valid`). When H's
  grant syncs nothing changes. There is nothing to revert.
- **Epoch revert is only the authorized re-grant case.** A claim that was effective can stop being
  effective only if a valid admin later re-grants the removed host **with the removal votes as causal
  ancestors** (the authorized readmission act) or the quorum membership changes at heads. Then the
  epoch reverts, the claimant shreds its staged key and re-attestation re-runs (section 3,
  `reattested_epoch_id`). **Withheld-then-released** (Red Hat concern): a valid admin M holds a
  pre-signed re-grant of H, lets B claim, then releases it. Bound, restated for the inverted predicate:
  the entry's validity is evaluated at the causal point M signed it chose, and M can choose a point
  but cannot choose both. A re-grant pinned to **pre-removal** dependencies does not have the removal
  votes as ancestors, so it supersedes nothing and voids nothing: H stays removed and no revert occurs.
  A re-grant that does supersede the votes must have them as ancestors, so M must have seen them and
  must be a valid admin at that later point, which is an ordinary authorized re-grant by a current
  admin (no new power: M could equally claim host or quorum-revoke B). The cost of that case is one
  revert plus one re-attestation, deterministic and identical on every peer. Test 12c pins both halves
  and that no token or credential signed during the window is accepted after a revert.

### 8.4 What is removed from the first draft

`revocation_basis` column, `uncorroborated_revoke` Gate A reply, `authority_entries_push` message type,
its caps and rate limit, and test 10/11 as written. Nothing here adds a pre-admission surface.

## 9. Partitioned (island) devices (B2) and the pre-admission surface

**The bound, stated plainly.** Revoking a host cuts off its ability to issue **only on devices that
have adopted the new epoch**. A revoked host on a LAN island with some of the camp's devices keeps a
working camp there: its `isCurrentHost` stays true locally, it never sees `host_claim`, and it can
mint tokens that island devices accept. Nothing in this design can reach a device that is not
reachable. What the design guarantees is the **path back**, with no new disclosure to anyone who is
denied:

- **Pre-admission surface (makes section 4's statement true).** Gate A and Gate B reply to a denied
  peer with the **existing typed denial only** (`4401 invalid_token`, `4403 device_not_authorized`,
  `4404 device_revoked_by_authority`, `4405 peer_identity_mismatch`). Nothing else is sent: **no
  authority-log entry, no epoch, no host key, no new code.** In particular there is **no
  `stale_host_epoch` code**: an island device's old-epoch token fails `verifySessionToken` and returns
  the same `4401 invalid_token` as any bad token, so the response distinguishes nothing about epochs
  or about whether the host changed. A genuinely revoked peer gets the existing `4404` and nothing
  else. No inbound push message is accepted from a denied peer either; the only messages a
  not-yet-admitted peer can send are the ones that already exist (authenticate, login, pairing
  request), each already rate-limited in `authGate.js`.
- **Island devices that are not revoked** (clients and admins) learn the new epoch **after
  admission**, in two ordinary steps: (1) their stale token is rejected `4401`, which already triggers
  re-login (`onAuthRejected`; the build verifies this assumption, risk list); (2) they re-log in to the
  new host by the **identity-key login of section 7.1** (no shared secret needed) and are admitted.
  **Post-admission, on an OK login/authenticate reply only,** the new host returns its `host_claim`
  chain entries together with the **minimal verification set** for them (the claimant's grant chain to genesis; for a quorum-path
  claim the counted removal votes with their authors' grant chains to genesis; and, for **every signer
  on those chains whose removal took effect, the removal's counted votes**, because the receiving device
  needs them to run the section 2.1 pre-removal test on that signer's grants; signed entries,
  nothing else, and this set is required: without it a stale island device could not verify and would
  fail closed; never to a denied peer, so the pre-admission surface
  is unchanged). The receiving device verifies the chain from genesis (`createVerifiedEntryTrust` plus
  `currentHostEpoch`, the same functions the projector uses) **before** it changes
  `camps.signing_public_key`, so it does not need to wait for, or depend on, the old host or a full
  sync to learn the key it must trust to read the new host's tokens. It then receives the rest of the
  authority log through normal authenticated sync, and its projector confirms the same head. The login
  reply's `camp` block is still **ignored for key adoption** by an already-paired device (only first
  pairing trusts it, section 4); a chain that fails verification changes nothing. The verified chain
  head is the only source of the key on a device that already has one.
- **A revoked island host that meets a current peer** gets `4404` and nothing more. It learns it was
  removed from that denial plus, if it later meets any admitted device, from ordinary sync it is no
  longer admitted to; an honest one closes its join window and drops `isCurrentHost` on the first
  projection that shows a later epoch (section 4), which needs no outbound disclosure.
- **Island-approved devices.** Devices the island host approved after its removal are void by the
  section 7 effectiveness rule once the logs merge; they are denied on the current epoch until a current
  admin re-approves them.
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
    `evaluateAuthenticate` / `evaluateLogin`: identity-bound path (section 7.1: skip the `devices` row and
    secret when the Noise peer id equals `authority_cache.peer_id`; skip the pending-row insert and the TOFU
    bind; guard the `persistAppliedTombstones` foreign key). **No new reply, code or message type** (section 9).
11c. Peer-trust seams the `authority_cache.peer_id` branch must reach, or the admitted device is
    still dropped before `evaluateAuthenticate` runs: `electron/sync/automerge/peerIdentity.js`
    `createBoundPeerTrust` (today trusts by a bound `devices` row; the trust predicate gains
    `authority_cache.peer_id` for status `admin` or `approved`, and not `revoked`);
    `electron/sync/automerge/peerAddressBook.js` `redialTrustedPeers` / `selectCoordinationCandidates`
    (take that predicate, so B redials and coordinates with K without a `devices` row);
    `electron/sync/automerge/mutualAuth.js` `wireMutualAuth` (its `isPeerTrusted` must be the widened
    predicate in both directions). One predicate, three callers.
11a. `electron/automerge/authorityReplay.js` `stateAt`: the section 2.1 effective-grant fixed point (one
    descending-iteration pass over the entry set; `grantedSet`, vote counting and every `n` read its result,
    and `n` is evaluated on the voters' joint causal past) and the T331 vote-counting amendment of section 8.1
    (inverted predicate: a vote against a granted target counts iff its own ancestors contain a valid
    grant of the target, or the target is the founder; the staleness rule is unchanged); `docs/adr/2026-10-02-distributed-revocation-authority.md` gets an amendment note.
11b. `electron/automerge/projector.js` / `authorityReplay.js` `currentRevokedDeviceIds`: target set from
    `grant` / `revoke` only, `approved` computed separately (section 7.2); `authority_cache` gains
    `peer_id` and the `approved` status (migration + rollback + `schema:check`).
12. `electron/main.js` `approveDevice`: mint `device_approval`; backfill job; PIN-reauth
    (`attemptLogin`) in `acceptHostRole` / `releaseHostTo`; LOST-path delay and confirm.
12b. UI: `src/screens/` devices screen ("LAN & Devices") gains the "Admin access lapsed" flag and the
    "Make admin again" action (section 2.1), derived from replay output (`currentRevokedDeviceIds` sibling:
    grants in `G` not in `E`), reusing the T332 admin-mint path.
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
3. **Non-admin client approved only by the old host is admitted by the new host with no `devices` row
   (section 7.1).** K is a non-admin approved by A only (A writes `device_approval` with
   `target_peer_id`). On B assert `SELECT COUNT(*) FROM devices WHERE id = K` is 0 before **and after** K
   authenticates and logs in over a real Noise connection, so the pass cannot come from any local
   column or secret. K is admitted and **syncs in both directions** (B->K and K->B), with zero `devices` rows for K on B
   at the end (so the redial, coordination and mutual-auth paths of seam 11c are exercised, not just
   the login handlers). Red first against today's code: `not_paired`. Negatives:
   a different peer id, and K after revocation, get the existing generic denials. Also: an approval by A
   concurrent with A's removal is void; a non-admin revoked and then re-approved is `approved`, absent
   from `currentRevokedDeviceIds`, and admitted; a device approved by a not-yet-synced admin is
   de-trusted until a current admin re-approves it.
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
2a. **Test 2 under the fixed point.** The 2-device revoke and lost cases of test 2 are re-run with the
    section 2.1 rules in force: the remaining admin is in `Admins(heads)` through the founder or an
    alive-signer grant, its single vote is a counted vote, `n_W` is 2, the quorum holds, and it claims. No
    case in test 2 may need a grant from a removed signer.
9. **Partition / island.** A (revoked) and client K on an island, B and C on the current epoch. While
   partitioned A keeps issuing (assert the bound). On reconnect: K's old token gets plain `4401
   invalid_token` (assert the reply is byte-identical to a tampered token's: no epoch oracle); K re-logs
   in to B by identity-key login and is admitted. **A is OFFLINE for the whole claim**: no message of any
   kind reaches or comes from A, so K's adoption cannot depend on A or on the old host's key. On the OK
   login reply B returns its `host_claim` chain entries; K verifies them from genesis
   (`createVerifiedEntryTrust` + `currentHostEpoch`) before changing `camps.signing_public_key`, and
   the test asserts the column is unchanged if the returned chain is truncated, re-parented or signed by
   a non-admin. The returned chain MUST include the claimant's grant chain and the revoke votes needed
   to verify a quorum-path claim (the minimal verification set: the claim, the claimant's grant chain to genesis, the
   counted quorum votes with their authors' grant chains to genesis, and for every signer on any of those
   chains whose removal took effect, that removal's counted votes with their grant chains, since K needs
   them to evaluate the section 2.1 pre-removal branch); test 9 asserts K verifies a quorum-path claim from
   exactly this set and that omitting any member, including the removal votes behind a pre-removal branch, makes K fail closed (key unchanged). Then K syncs and closes any window. Nothing is sent to a denied peer (see 9a). A is denied `4404`; `isCurrentHost` becomes false after its projection shows the
   later epoch and host-only handlers return `not_current_host`; a device A approved on the island is
   denied until re-approved.
9a. **Pre-admission negative (blocker 3).** A corroborated-revoked peer and a never-approved peer each
    connect to B: the only bytes B sends are the existing typed denial. Assert no authority-log entry,
    epoch, key or new code is present in anything B sends, and that an `authority_entries_push`-style
    message from a denied peer is not parsed (unknown type, no state change).
10. **T333 blind vote does not count (amendment, red first).** Replay unit test on `stateAt`: admin T
    granted by G; admin V casts a revoke concurrent with G (V has not seen G); N=2 so threshold 1.
    Today T is removed (red); after the amendment T stays `admin` and Gate A admits it. Also: the
    founder cannot be blind-revoked (a vote against the founder counts).
11. **T333 no readmission (Security and Red Hat re-confirm, as T333 requires).** Blind revoke, then a
    genuine quorum revoke (voters have G as ancestor): T is removed, in **every permutation** of merge
    order and delivery, and never readmitted by any later delivery of the blind vote, of G, or of any
    peer message. A genuine causally-later revoke still removes. A valid admin's later re-grant (with
    the votes as ancestors) is the only way back.
11b. **Backdated grant cannot void a quorum (red first, against the first revision's predicate).**
    Admins M and T are quorum-removed. M then injects `grant(T)` with dependencies set to the
    pre-vote heads, delivered through an admitted relay peer. T stays removed in **every merge order**
    (all permutations of the removal votes, the original grant and the injected grant), on every peer,
    and Gate A still denies T. Companion: a grant that does have the votes as ancestors, signed by a
    valid admin, does readmit (the authorized act).
12. **Composition, 2-device.** (a) Founder host A, B revokes A: B claims and is host, A out, no revert (**12a** also covers the live handoff `host_release` then `host_claim`, which must still work under the fixed point with no grant from a removed signer).
    (b) Non-founder host H blind-revoked by B: the vote does not count, clause 4 fails, `host_claim` is
    refused `host_still_valid`. (c) Withheld-then-released: B claims after a genuine quorum removal of
    H. (i) M releases a re-grant of H pinned to pre-removal dependencies: no revert, H stays removed,
    B stays host, in both orders. (ii) A valid admin M releases a re-grant that has the removal votes
    as ancestors: the epoch reverts, B's staged key is shredded, H re-attests, identical on every peer
    in both orders, and nothing signed in the window is accepted afterwards.
13. **Backdated grants cannot reach authority (fixed point, red first, every merge order).** All
    sub-tests assert the result for **every permutation** of delivery of the entries involved, on every
    peer, and that `E` is identical across permutations.
    - **13a one-hop.** 2-admin camp (host B, admin M); M is quorum-removed. M injects a backdated
      `grant(X)` onto pre-removal heads through an admitted relay. X revokes B and claims. Assert: the
      claim is refused (`host_still_valid` / not an admin), X is not in `Admins(heads)`, X's vote does not
      count, B stays a valid admin and host.
    - **13b two-hop.** M backdates `grant(X)`; X (ineffective) grants Y; Y revokes B and claims. Assert:
      refused; Y is not an admin; both grants are dropped (two iteration rounds; the test asserts the
      round count is at most the chain length).
    - **13c three-admin denominator.** Admins A, B (host), M; M quorum-removed by A and B (threshold 2).
      M's backdated stand-ins X1 and X2 are delivered in every order, before and after the removal
      votes. Assert: M is removed in every order (the denominator is not inflated), and a following
      revoke of B by A alone has the **same** threshold and outcome as a control run without the
      backdated grants, so the stand-ins neither block nor enable it. Companion: the same stand-ins
      granted by M *while M is still a valid admin and seen by the voters* are effective, raise `n`
      exactly as today, and are pinned so the alive-signer branch is not mistaken for fixed.
    - **13d companions.** A grant whose signer is an admin at heads is effective regardless of its
      causal position; a grant that precedes its signer's removal (the quorum could not be reached
      without a voter who saw it) is effective; a grant that is not in the signer's causal future of its
      own grant is dropped.
    The T331 base residual is marked closed in the amendment; 13a to 13c are its regression pin.

16. **Liveness: an honest admin loses status and the flag restores it.** Admins A, S, H; S grants H and
    is quorum-removed by A and one more voter who has not synced S's grant of H. Assert: H is not in
    `Admins(heads)`, H is not host-eligible (claim refused), the "Admin access lapsed" flag appears on
    H's row on A's `devices` screen and on H's own, with the copy of section 2.1; A uses "Make admin
    again": the grant is minted and effective, the flag clears on both devices once synced, `n` is
    restored, H counts in quorums again and its claim is accepted. Failure of the mint leaves the flag in
    place and shows an inline error. Under reduced motion the flag still appears and clears with the text
    change. Same result in every merge order.
17. **Minimal verification set includes the fixed point's inputs.** Extension of test 9: K verifies a
    claim whose chain relies on the pre-removal branch from exactly the set in section 9, and fails
    closed (key unchanged) when the removal votes behind that branch are omitted.
14. **Re-attestation** is audited as one privileged bulk event, is resumable after a kill, and a fresh
    joiner projects every user.
15. **Epoch 0 unchanged and purge/rebuild.** A camp with no claims behaves exactly as today (existing
    suites green); `ensureHostSigningKey` refuses to mint on a non-founder; a purged-and-restored
    device does not regain host status from a superseded key.

## Residual risks

- **Island bound (B2).** A revoked host keeps a working camp on an island and can issue to island
  devices until they meet a current peer. Not preventable by any design; the path back and the void
  approvals are specified and tested.
- **Existing camps whose host is lost before running the upgraded build** have no `device_approval`
  records for non-admin devices; those devices are re-approved in person.
- **T333 residual.** A revoker that has never seen a target's grant treats the target as a non-admin and
  denies it until the grant arrives (section 8.1). Cannot occur in a strict 2-device camp by history;
  can occur if the grant came from a since-removed third admin and the target is the only reachable
  peer. Accepted limitation, not claimed fixed.
- **Vote-counting amendment** changes T331 semantics (a vote counts only if its author saw a valid
  grant of its target; blind votes no longer count); no new admin power, but Security and Red Hat must
  re-confirm no-readmission, including the backdated-grant attack (tests 11 and 11b) and the fixed point (tests 13a to 13c, 16).
- **Identity-bound login** depends on `target_peer_id` being bound at approval; devices without it stay on
  the legacy secret path and are re-approved in person after a succession.
- **T331 base residual CLOSED by this amendment (pending acceptance).** A removed admin can no longer
  backdate a grant and regain admin or reach host authority: section 2.1 makes such a grant ineffective
  everywhere, for every removal. Tests 13a to 13c pin it. What remains of the any-admin-signs model is
  the alive-signer branch: a *current* admin can mint grants, and a quorum can remove them.
- **Liveness cost of the fixed point.** An honest admin granted by a signer later removed by voters who
  had not synced the grant loses effective admin status and must be re-granted by a current admin
  (visible flag and action, section 2.1, test 16). A shrink of `n` for the camp until that happens.
- **Fixed-point assurance.** The operator is not monotone; uniqueness is by construction of a descending
  iteration over the entry set, with sticky drops. Security and Red Hat must try to break it (mutual
  removal between two admins, chains through a removed signer, and delivery-order permutation).
- **Denominator on the voters' joint past** narrows T331 case (c) (section 2.1). Flagged for the keeper.
- **Claim by a malicious admin** gains credential and join power until the quorum revokes it; same
  exposure T331 already accepts. The tie-break is grindable and is not a control (section 4).
- **Claimed key the claimant does not hold:** availability fault; repair is revoke-and-reclaim.
- **Epoch revert** (section 8.3, authorized re-grant only) re-runs re-attestation and discards a staged key; brief window where
  two devices each believe they are host is bounded by sync.
- **24 h token turnover:** every device re-signs in once; test 4 fails if `onAuthRejected` does not
  already behave that way (assumption, not verified here).
- **Conflict rows:** the build must confirm re-attestation rewrites do not surface as human conflicts.
- **Stolen-and-unrevoked host stays host until the quorum acts.** Same exposure as today.

## Reused vs. new

**Reused unchanged:** the authority log and its signing key (`device_identity_key`), the causal replay
and tie-break primitives, the quorum, `authority_cache`, the three verifiers and the
`camps.signing_public_key` column they read, token and credential formats, join proof, LAN pairing.
**New:** the section 2.1 effective-grant fixed point (replacing the host-only filter), two entry kinds (plus `device_approval`), one vote-counting amendment, an identity-bound login branch, one replay function, one derived single-row table, one key-staging and
re-attestation pass, `isCurrentHost`, and three small IPCs.

## Confidence

Re-mint with log-authorized claim: **80%**. Replicated `device_approval` record for B1: **80%**
(directly fixes the confirmed local-column defect; the backfill residual is real). T333 vote-counting
amendment with no new channel: **78%** (small rule that subsumes the old one; no-readmission argument in
section 8.2 rests on admission being decided only by the replay, to be re-confirmed red-first by Security
and Red Hat). Identity-key login across epochs (B1b): **80%** (reuses the Noise-authenticated peer id and
the T162 binding; the `persistAppliedTombstones` foreign-key seam is the unverified part). Evidence: the
code facts cited above; deterministic evidence is the tests, not this document.

## Open questions

None for the owner. Who may claim and the small-camp quorum are decided (section 2, citing the
2026-10-02 ADR); single-admin camps are out of scope by ruling. Tunables left to the build: the LOST-path
delay length (default 5 minutes) and the push-channel caps.

**For the keeper (technical, answered here, one deviation to confirm).** (1) Do removals of non-host
admins shrink `n` illegitimately? No, with reasoning in section 2.1. (2) The instruction asked for the
same effective set in `n`; doing exactly that with `n` read at heads is unsound (a removed admin's
backdated stand-ins inflate the denominator and un-remove it before the iteration can drop them), so
section 2.1 reads `n` on the voters' joint causal past. Confirm that narrowing of T331 case (c), or
direct otherwise.
