---
title: "Shared signed device roster: any two enrolled devices admit each other, with or without the host"
document_type: adr
authority: normative
status: accepted
implementation_state: in-progress
date: 2026-10-12
decided: "Direction accepted by the owner 2026-10-12 ('Shared device list (Recommended)'); design amended 2026-10-12 for the Security and Red Hat design-review findings (see 'Design-review amendments')"
deciders: [product-owner]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
supersedes: []
amends:
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
related_adrs:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
  - docs/adr/2026-10-09-host-succession-simple.md
  - docs/adr/2026-10-09-setup-device-gates-lifted-to-any-admin-device.md
related_tickets:
  - docs/work/tickets/T376-shared-signed-device-roster.md
affects:
  - electron/auth/connectionAuth.js
  - electron/auth/localAuth.js
  - electron/automerge/campDocument.js
  - electron/automerge/projector.js
  - electron/automerge/purgeCollateral.js
  - electron/sync/automerge/syncNode.js
  - electron/sync/automerge/peerIdentity.js
  - electron/sync/automerge/joinSession.js
  - electron/main.js
  - electron/db/schema.sql
  - SECURITY.md
  - docs/current/WHERE_DATA_LIVES.md
---

# ADR: Shared signed device roster

## Problem (evidence, current v1)

Pinned by `electron/sync/automerge/hostOffTokenExpiry.integration.test.js` (commit 565dc85f):

- The `devices` table is SQLite-only and never syncs (`docs/current/WHERE_DATA_LIVES.md`). Each client knows only the host, so with the host off two clients refuse each other at t=0 with `device_not_authorized` (test 0; the check is `evaluateAuthenticate` in `electron/auth/connectionAuth.js`, the `deviceTrustStatus` branch after the `authority_cache` precedence block).
- Network admission requires a host-signed token. `issueCampToken`/`issueDeviceToken` (`electron/auth/localAuth.js`) sign with `host_signing_key`; `TOKEN_TTL_MS` is 24h (`electron/auth/localAuth.js`, line 151) and `verifySessionToken` rejects past `exp`. Nothing renews a client's token, and the host returning does not recover an expired client (tests A-D).
- Net effect: a camp whose host laptop is off for a day stops syncing between the other devices, and nothing the director can do without the host fixes it.

## Owner ruling

"Shared device list (Recommended)": the approved-device roster lives in the camp document, signed so it cannot be forged (the `camp_authority_log` model). Any two approved, unrevoked devices admit each other directly; permission renews without the host. The host is needed only to add brand-new devices. Removal propagates through the same roster and a removed device is refused everywhere.

Standing rules applied: fresh camps only (no migration, no backfill), no cross-version compatibility, honest-failure model plus the stolen-device model below, no-readmission of a revoked device is absolute.

## Candidate approaches considered

1. **Signed roster in the document, admission by roster + Noise key proof (chosen).** Roster entries are host-signed enrollments; removal reuses the existing T331 revoke. Assumption: the libp2p Noise handshake already proves possession of the device identity key.
2. **Longer or renewable tokens.** Client-held refresh, 30-day TTL, or any-admin-signed tokens. Rejected: a long TTL only moves the cliff (a camp off-season hits it), and any-admin signing makes every admin a token mint, which is a larger authority change than the owner ruled. It also leaves clients unable to learn each other (test 0 would still fail).
3. **Sync the existing `devices` table.** Rejected: `devices` carries `device_secret_identifier`, `authorized_by_user_id`, revocation stamps and pairing state, i.e. per-device local secrets and legacy revoke stamps. `WHERE_DATA_LIVES.md` keeps it local deliberately, and replicating it unsigned would repeat the Q1 forgery hole (`electron/auth/authSignature.js` header).
4. **Reuse `camp_authority_log` for enrollment (a new `enroll` kind).** Rejected: that log is signed by device identity keys and validated by causal-ancestor replay of admin standing (`electron/automerge/authorityReplay.js`). Enrollment is signed by the host key and has no quorum semantics. Bolting a second signer class into the replay raises risk in the most heavily reviewed seam for no saving. Removal, however, is exactly the log's job and is reused as is.
5. **Peer-vouched mesh (any enrolled device can vouch for new ones).** Rejected: contradicts the ruling that only the host adds brand-new devices, and weakens the stolen-client story.

Confidence in the chosen design: high (about 85 percent) on mechanism, medium on the two honest residuals called out below (stale-view window, loss of the 24h expiry bound). Evidence: every primitive (host-key signatures, derived device-local cache, revoke precedence) already exists and is reused.

## Decision

### 1. Roster representation

A new modeled entity `device_roster` in the Automerge document, added to `EXTRA_MODELED_ENTITIES` next to `camp_authority_log` (`electron/automerge/campDocument.js`, line 105). Like that entity it has no SQL mirror table.

Entry (one record per enrolled device; record id equals `device_id`):

| field | meaning |
|---|---|
| `device_id` | the device's `devices.id` |
| `device_peer_id` | its libp2p peer id, i.e. the base58 form of its `device_identity_key` public key. This IS the identity public key (Ed25519 peer ids embed it, `electron/auth/deviceIdentity.js`; `electron/automerge/authorityLogSignature.js` header recovers keys the same way), so no separate public-key field exists |
| `added_at` | ISO time, informational |
| `added_by_device_id` | the host device that signed, informational |
| `sig` | Ed25519 by `host_signing_key` over the canonical tuple |

Decisions on the fields the brief asked about:
- **Binding the peer id.** Yes, signed, replacing TOFU for enrolled devices. This is the main security gain: a device's peer id is fixed by the host's signature, not by whoever connects first.
- **`role`: omitted.** Admin standing is already the signed authority log (`authority_cache`). A role column in the roster would be a second source of truth that can disagree with it. The roster says only "this device is a camp member".
- **`revoked`: omitted.** Removal is a T331 `revoke` entry, not a mutation of the roster entry. The roster is append-only, which is what makes forged-overwrite and readmission arguments simple.

**Signing an add.** The host key signs, because the only path for brand-new devices is the host approving a join. Signature primitive: a sibling of `electron/auth/authSignature.js` (same hex-DER Ed25519 host key, same `camps.signing_public_key` verification, own domain context `shoresh-roster-sig-v1`), signed tuple `[id, camp_id, device_id, device_peer_id, added_at]`. Binding `id` and `device_id` stops a captured entry being moved to another device; binding the peer id stops key substitution; binding `camp_id` (this device's own `camps.id`, checked on verify) keeps an entry from one camp inert in another even if a host key were ever reused.

**When the host mints.** The joiner's peer id is not known at `approveDevice` time (a pending request carries only a device id; the Noise-proven peer id is bound at login, `evaluateLogin` via `onLogin` in `syncNode.js`). So the host mints on the first successful `login` from a device it has just approved, where the peer id is the Noise-proven `fromPeerId`, not a client claim. The mint is idempotent (a device already in `roster_cache` with that peer id is skipped) and runs only on a device that holds `host_signing_key`. Its own genesis enrollment is written by `bootstrapCamp` (genesis may change, fresh camps only). Handoff (`2026-10-09-host-succession-simple`) moves the same key and the same public key, so existing entries stay valid and the successor can sign adds. A successor that is already enrolled needs no new entry.

**Removal.** Reuses the T331 revoke entry minted in `revokeDevice` (`electron/main.js`, line ~1724, `mintRevokeEntry`) unchanged: any valid admin signs it, ordinary devices are removed immediately, admin targets go through the existing quorum. No new removal primitive.

**Replay and projection (amended: monotonic, never destructive).** In `projector.js`, after `upsertCampAuthorityLogEntity` (it MUST run after it, because it reads `authority_cache`; a test pins the order), a new `upsertDeviceRosterEntity(db, doc)` maintains a device-local, never-synced table:

`roster_cache(device_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL UNIQUE, verified_at TEXT)`

An entry is **added** to `roster_cache` only if all hold: the signature verifies against `camps.signing_public_key` and the local `camps.id`; both ids are non-empty strings; neither its `device_id` nor its `peer_id` is already in the cache; and its `peer_id` is not the peer id of any device that `authority_cache` marks `revoked`. The revoked-peer comparison reads the **verified raw document entries as well as the cache** (a revoked device's own entry may exist only in the document), so a revoked machine cannot return under a new device id. Unsigned, mis-signed, partially written, wrong-key and wrong-camp entries are silently skipped, exactly as `upsertCampAuthorityLogEntity` skips untrusted entries. Absent `signing_public_key` adds nothing.

**The cache is monotonic.** A row, once verified, is never removed because the document record later fails verification, is overwritten, or is deleted. It is removed only by a rebuild/purge of this device (the table is wiped with the other device-local caches and re-derived from the document). Revocation does not delete the row: it denies at admission through `authority_cache` (precedence below). This closes the Security/Red Hat HIGH finding that any document writer (a stolen staff client) could overwrite or delete signed entries and thereby drop every device out of every peer's roster: a writer can no longer subtract anything a peer has already verified. What a writer still can do: corrupt an entry before a given peer has verified it (that peer, or a newly joining device, will not learn that device until the host re-signs it) and, on a device that is rebuilt from a corrupted document, lose entries until the host re-signs. That is a stated residual (below), no longer a total-lockout path.

**Collisions.** Two validly signed entries with the same `device_peer_id` under different `device_id`s (a re-enrolled restored key, a handoff race) cannot throw: entries are processed in ascending `device_id` order and the loser is skipped by the not-already-in-cache check before any insert, so the projector never raises on `UNIQUE` and a collision cannot halt projection of the whole document. Two hosts simultaneously signing one `device_id` (different `added_at`/`sig`): both signatures verify; the first one processed wins and the second is skipped; the resulting `conflicts` row on a signed record needs no human decision.

Because the derivation is order-independent for a fresh cache (sorted processing) and monotonic afterwards, every peer converges on the same admitted set once it has seen the same valid entries. `roster_cache` is added to the device-local list in `electron/automerge/purgeCollateral.js`.

### 2. Admission

Between two roster members the 24h host-signed network token is **not needed and is dropped from network admission.** Admission becomes:

`admit(peerId, claimedDeviceId)` iff
1. `roster_cache` has a row with `peer_id = peerId` and `device_id = claimedDeviceId`, and
2. `authority_cache` has no `revoked` row for `device_id` (revoked beats everything, unchanged precedence), and
3. the legacy `devices.revoked_at` stamp is absent unless `authority_cache` says `admin` (the existing 2026-10-03 RISK-1 precedence, kept verbatim).

**Proof of possession needs no new challenge-response.** `peerId` comes from libp2p's Noise handshake, which proves possession of the private key behind that peer id. `startSyncNode` passes `ensureDeviceIdentity(db).privateKey` to libp2p (`electron/sync/automerge/syncNode.js`, lines 122 and 716), so the Noise key is the device identity key. A roster entry binding `device_id` to that peer id is therefore verified by the transport itself. This is why the token can go: the token only ever added "the host once said yes", which the signed roster now says durably. (Recorded as a claim to confirm at implementation per org-source-verification: Maker pins it with a test that a peer presenting a rostered `device_id` from a different peer id gets `peer_identity_mismatch`.)

**What the `authenticate` frame carries.** `{type:'authenticate', device_id, schemaVersion, appliedTombstones}`; `token` is removed from the frame. `evaluateAuthenticate` (`electron/auth/connectionAuth.js`) takes the roster path; its `verifySessionToken`/`local_token_not_valid_for_network` branch is deleted. The 4401-4405 code convention is unchanged (`device_not_authorized` 4403, `device_revoked_by_authority` 4404, `peer_identity_mismatch` 4405; a bad claimed id for the peer is 4405). `createBoundPeerTrust` (`electron/sync/automerge/peerIdentity.js`), the discovery-time `isPeerTrusted` seam, becomes a lookup of `roster_cache` by `peer_id`.

**Token's remaining role.** The local PIN session token (`issueLocalToken`, HMAC with the device's own secret) is unchanged and is what `authorize()` sees. The network use of `camp`/`device` tokens ends. Maker's first step is `graphify affected "issueCampToken()"` and `"issueDeviceToken()"` plus a `grep -a` for string uses, to delete every network-admission use and confirm what else, if anything, consumes a `camp` token. If something does, it keeps the token and loses only its admission role; that is a Maker finding to report to Governor, not a design change.

**Bootstrap of a brand-new device (the host-only path).** Unchanged front half: join window, code proof (`verifyJoinProof`), director approval, `pairing_request`/`pairing_approved` (not token-gated). Back half changes:
- Host side: the first successful `login` from an approved device (`onLogin`, `enrollInRoster`) writes the roster entry and projects it locally, so the host admits the joiner immediately.
- Joiner side: the joiner cannot verify a roster before it holds the camp document, and the host's signing public key arrives only inside that document. Its trust root for the first sync is the one it already uses: the host peer id verified by `checkHostProof` against the join-code proof, admitted through `node.admitPeer(hostPeerId)` in `joinSession.js` (the signing public key reaches the joiner in the join reply, written before projection, `joinSession.js` lines ~408; the roster itself arrives only inside the document). **That admission is in-memory, scoped to that one host peer id and that one connection, and dies with the connection** (`authenticatedPeers.delete` on disconnect). It is therefore single-use and bounded by construction: no persistent pin exists, nothing is written to SQLite, and on reconnect the host is admitted only if `roster_cache` holds it, with `authority_cache` revoked precedence applied (including `tearDownRevokedConnectedPeers` on projection). A test pins that a fresh node in a populated-roster camp does not admit an unrostered peer because of any earlier pin. Pairing and rejoin message types are otherwise untouched. **Known limit (owner-visible, not fixed):** the host must stay on until the joiner's first document sync completes (the join flow reports success only when the camp has arrived, `waitForCamp`); a joiner whose host goes off before then cannot take its first document from another device, because it holds no roster to verify it against. After that first sync the host is not needed.

**Precedence with T331/`authority_cache`.** Unchanged and now strictly additive: `revoked` denies first; `admin` skips only the legacy devices stamp; the roster supplies the positive "is a member" fact that `devices.authorized_at` supplied before. `devices.authorized_at` stops being an admission input for network peers (it remains the Device Manager's display state).

**TOFU peer-id binding.** `bindOrVerifyPeerIdentity` is no longer in the admission path for rostered devices (the signed binding replaces first-use). `devices.libp2p_peer_id` stays a routing convenience, as `peerIdentity.js` already documents.

### 3. Revocation, no-readmission, and the stale-view window

- A removal is a signed `revoke` entry in the document; it syncs like everything else, and each peer's next projection writes `authority_cache` `revoked`. `revokePeer` evicts a live connection (existing, `electron/main.js` revoke handler); `isPeerRevoked` re-checks admitted peers on projection (existing gate B support). A removed device is refused at every roster member that has seen the entry, on reconnect and live.
- **Absolute no-readmission.** (a) `authority_cache` `revoked` outranks the roster and log entries are append-only; (b) `evaluatePairingRequest` already refuses a revoked device id; (c) new: a roster entry whose peer id equals a revoked device's peer id is dropped at projection, so the same keypair cannot return under a new device id; (d) the host cannot re-add the revoked id because the projection ignores it even if signed. A removed physical machine returns only as a new device with a new identity key, approved by a director as one.
- **Honest stale-view window.** Revocation is eventually consistent. A peer that has not yet received the revoke entry keeps admitting the removed device, and any edits that device makes through such a peer are accepted and persist (data writes are not causally gated by revocation; T331 gates authority, not data). The window is: from the moment the admin revokes until a given peer learns of it, bounded by how soon that peer syncs with any device that holds the entry. A removed device that stays partitioned with a stale peer set can keep exchanging with that set only. This cannot be closed in an offline-first system without a coordinator, which the owner ruled out. Why acceptable: the removed device already holds a copy of everything it could read (a copy cannot be recalled by any design), the realistic case is a camp whose devices reconnect within a day, and the admin sees "removed on N of M devices" is out of scope (no new UI). What we do guarantee: after any one honest peer learns of the revoke, that peer refuses the device and, on reconnect, the device cannot obtain the revoke-unaware peers' state through it. Gate B live re-check also evicts it from a peer the instant that peer projects the revoke.

### 4. Host role after the change

The host does exactly two things: (1) open the join window / issue the code and approve a join, (2) sign the roster add for that approval. It also still signs `users` credential tuples and purge tombstones (unrelated, unchanged). It is not involved in any admission between existing members and not in renewal; 24h tokens no longer gate anything. Handoff is unchanged (same key, same public key; the successor's roster entry already exists).

### 5. Stolen-device threat model

Common facts: a device holds its own SQLite (camp data), its device identity private key, its `device_secret_identifier`, and the PIN-hash material for local login. At-rest encryption (SQLCipher, T175/T345) protects those when the machine is powered off or the disk is imaged and the key is not co-located; it does not help against a thief who gets into a running, unlocked session or against a machine whose unlock secret is stored with it. Treat encryption as defence against the cold-disk case only.

| Stolen | What the thief can do | Until when | How removal stops it |
|---|---|---|---|
| **Client** (non-admin) | If the DB opens: sync as that device with staff-level data access, read and write camp data, and keep doing so with the host off. Cannot add devices, cannot revoke, cannot mint admin | **Until the removal propagates.** This is a real regression: today the 24h token gives an automatic bound for a stolen client nobody reports (and only while the host is also unreachable). With a roster there is no expiry. A lease would reintroduce host dependence, so none is added | Any admin removes it; peers that learn of it refuse it and evict it live; same key cannot be re-enrolled |
| **Admin** | All of the client's powers plus: revoke ordinary devices (denial of service), grant admin to rostered devices, resolve conflicts, run setup actions the admin gates allow. Cannot enroll a brand-new device (needs host key). Admin-vs-admin removal needs quorum (T331), so a lone stolen admin cannot evict other admins | Until another admin removes it (quorum rules apply to removing an admin) | Revoke entry as above; the quorum rule is the T331 design, unchanged |
| **Host** | Everything above, plus: sign roster enrollments offline for devices of its own (it can mint rostered members without a director's click), forge `users` credentials and purge tombstones, sign network tokens (now irrelevant). The worst case | Until the camp is rebuilt. There is no key rotation (`2026-10-09-host-succession-simple`: `camps.signing_public_key` never changes) | Honest-failure model scopes a malicious admin or host out. Recovery for a lost or stolen host key is the existing owner rule: export the last file, start a new camp, re-upload. The roster does not make this worse than today (the host key already forges credentials) but does add "can enroll devices without a pairing click" |

**R3, accepted under delegated owner authority (Keeper ruling, 2026-10-12).** The loss of the automatic 24h bound is accepted on three conditions, all implemented: (1) removing a device is one obvious action on the Devices screen (Revoke), effective fleet-wide from any computer that was made an admin, not only the host; on a computer that was never made an admin the removal is local and the screen says so (`revokeDevice` is mode-agnostic; pinned by `main.authorityEndToEnd.test.js`, client-mode admin); (2) the Director's Guide and SECURITY.md say plainly "If a device is lost or stolen, remove it from Devices right away; until you do, it can still sync."; (3) no lease or expiry is added (it would reintroduce host dependence).

**R1, self-certifying entries (Keeper ruling, 2026-10-12).** A device may present its OWN Host-signed roster entry on the `authenticate` frame (`roster_entry`). The verifier checks the Host signature, that the signed peer id is the Noise-authenticated peer id and the signed device id is the claimed one, and that the device is not revoked in `authority_cache`; it then merges the entry into its document (only a document that already holds the camp), so `roster_cache` derives it exactly as for a synced entry and admission still reads only `roster_cache`. This closes the "a newcomer is unknown to a peer the Host never reached" gap with the Host off. No other trust changes. Pinned by `selfCertifyingRoster.integration.test.js`.

Two further notes: a stolen device that was **already revoked** gains nothing (refused everywhere per section 3, and cannot re-enroll). A roster entry never grants admin; being a thief with a rostered device is staff-level data access, which is what every paired client has today.

### 6. Exact red tests

All in `electron/sync/automerge/hostOffTokenExpiry.integration.test.js` (rename to `hostOffRoster.integration.test.js` and keep the clock harness: `Date.now = realNow() + offset`), one file at a time with `--no-file-parallelism`. `seedMutualTrust` is deleted; tests no longer insert `devices` rows by hand, they use the real join flow, so the roster comes from the host's first-login enrollment.

Flipped existing tests (title prefix changes from "documents current v1" to a behaviour statement):
- **0.** host stopped, no seed, t=0: `link(a,b).admits === true`; neither direction returns `auth_failed`; an edit from A reaches B. (Was: `device_not_authorized`, admits false.)
- **A.** established link survives past TTL (unchanged, true); reconnect at TTL+60s now **admits**: `postRelink.admits === true`, no `invalid_token`; `reaches(a,b,'a-post-ttl-relinked') === true`. Keep the control (reconnect at TTL-90s admits). Also assert `verifySessionToken(a.db, a.token) === null` still holds, proving admission no longer depends on the token.
- **B.** C2 away 25h with the host off: on return `r.admits === true`, and the edit C1 made while C2 was away **arrives** (`arrived === true`). (Was false.)
- **C.** restart past TTL: `r.admits === true` with the stored (expired) token; after local PIN re-login (`claims(relogin.token).type === 'local'`) admission is still true and unchanged. (Was `invalid_token`.)
- **D.** host returns after expiry: A to host admits with no token; the two previously logged facts become assertions: `hostAdmitsA === true`, `toA === true` (host edit reaches A) and `fromA === true` (A edit reaches host); `link(a,b).admits === true`. `a.token === oldToken` is dropped as meaningless.

New tests (same file or a sibling `deviceRoster.integration.test.js`; a three-client harness helper `setupThreeJoinedDevices` is new test infrastructure):
- **E. revocation propagates, host off.** A (admin) revokes C while B is connected and the host is off; B refuses C on reconnect with `device_revoked_by_authority`; a live C connection to B is evicted (`isPeerAuthenticated` flips false) once B projects the entry; C's later edits do not reach B.
- **F. forged and unsigned entries ignored.** Table of entries written straight into B's document: no `sig`; `sig` from an attacker keypair; valid host `sig` with `device_peer_id` edited afterwards; valid entry copied under a different record id; a client self-enrolling. Assert `roster_cache` has no row, `link` is refused with `device_not_authorized`, and the legitimate rostered devices still admit each other. A control row with a valid host signature does admit (non-vacuity).
- **G. revoked device refused everywhere, no readmission.** After C is revoked: C is refused by A and by B; the host re-signs a roster entry for the same `device_id` (ignored); the host signs an entry binding C's old peer id to a new device id (dropped by the peer-id rule); a `pairing_request` for the old device id is refused (existing `evaluatePairingRequest`). Rebuild from document (purge then rebuild) reproduces `roster_cache` and the same refusals.
- **H. stale view, stated and bounded.** Partition so B has not received C's revoke: B still admits C and C's edit reaches B (asserts the documented window, with a comment citing section 3); then B syncs with A, B evicts C live, C reconnect is refused, and C's edit made in the window **remains** in B's document (documents that data is not rolled back).
- **I. peer-id binding.** A peer presenting a rostered `device_id` from a different peer id gets `peer_identity_mismatch`; a roster-member peer id claiming another member's `device_id` is refused.
- **F2/F3. overwrite and delete.** A rostered non-admin overwrites a field of, or deletes, every roster record in its document and syncs: peers that already verified the entries keep admitting each other (monotonic cache). Non-vacuity: an implementation that re-derives destructively fails this test.
- **G2. revoked entry only in the document.** Revoked device's roster entry exists only in the document on a freshly rebuilt peer; a new roster entry for the same peer id under a new device id is still dropped.
- **K1/K2. unit.** Two valid entries with one peer id project without throwing and the same winner in either document order; roster projection after authority-log projection (a revoke and the entry targeted by it applied in either order give the same cache).
- **0b. negative twin.** Two clients that were never rostered refuse each other with `device_not_authorized`.
- **J. ordering.** A newly enrolled device D is refused by B until B has the roster entry, then admitted after sync without a restart (covers `mutualAuth` denied-recently retry).
- **K. host-only add.** A non-host rostered client cannot add D: forging an entry signed by A's identity key is skipped (F-style), and `approveDevice` on a non-host throws or is not offered (existing guard).
- Unit: roster signature canonical form and domain separation (never verifies as an authSig or authority sig); `upsertDeviceRosterEntity` is merge-order independent (apply the same changes in two orders, equal cache); absent `signing_public_key` leaves the cache unchanged; `schema:check` family green after the table bump.

### 7. Files and schema

Touched: `electron/automerge/campDocument.js` (entity + allowed fields, as for `camp_authority_log`), `electron/automerge/deviceRosterSignature.js` (new, sibling of `authSignature.js`), `electron/automerge/projector.js` (`upsertDeviceRosterEntity`, order list, reconcile exclusion like `camp_authority_log`), `electron/automerge/purgeCollateral.js`, `electron/auth/connectionAuth.js` (roster admission, drop token branch), `electron/auth/localAuth.js` (stop minting network tokens if graph confirms no other consumer), `electron/sync/automerge/syncNode.js` (`onAuthenticate`, frame without token, first-sync host pin), `electron/sync/automerge/peerIdentity.js` (`createBoundPeerTrust` reads `roster_cache`), `electron/sync/automerge/joinSession.js` (pin and drop token hand-off), `electron/main.js` (`bootstrapCamp` mints the Host's own roster entry; failure fails the bootstrap), `electron/sync/automerge/punchGossip.js` (registry trusts roster members), `electron/db/schema.sql` (+ `roster_cache`), `SECURITY.md`, `docs/current/WHERE_DATA_LIVES.md`, the test files above.

**Schema change: yes**, one device-local table `roster_cache`, so a schema version bump with the full `npm run schema:check` family (fresh camps only: no migration of existing data, no backfill; a camp created before this ships is re-created, per the standing rule). Genesis changes (host self-enrollment). The document gains a new entity; no cross-version compatibility is kept. Load note for Maker: follow the brief's rule of one test file at a time, no `npm ci`/verify locally, CI is the gate.

## Design-review amendments (2026-10-12)

Security (score 3) and Red Hat (score 2) reviews of this ADR were incorporated before implementation:

| Finding | Resolution |
|---|---|
| Any document writer can overwrite/delete signed entries and lock every device out; recovery fails | Monotonic `roster_cache` (section 1); tests F2 (overwrite) and F3 (delete) pin that admissions of verified devices survive |
| First-sync trust window unbounded; signing-key arrival misdescribed | Section 2: in-memory, single-connection, host-peer-scoped admission; key arrives in the join reply before projection; test pins no persistent pin |
| `roster_cache.peer_id UNIQUE` can throw and halt projection | Deterministic sorted processing, skip-before-insert (section 1); unit test K1 |
| Joiner cannot finish first sync if host goes off after approval | Documented known limit (section 2); not fixable without a roster the joiner cannot yet verify |
| Device that loses its identity key is locked out | Residual 5: remove and re-pair as a new device; 4405 is the signal |
| Revoked device's peer id read from the wrong source | Section 1: the check reads verified raw document entries plus the cache; test G2 has the revoked entry present only in the document |
| 24h bound lost for an unreported stolen client | Accepted by the ruling (section 5, residual 1); Device Manager continues to show last-seen |
| Projection order | Roster projection runs after authority-log projection; test K2 pins the order |
| Camp scope | `camp_id` in the signed tuple |
| Roster add minted at approve time needs the peer id | Minted at first successful login on the host instead (section 1) |
| Test coverage gaps | Negative twin of test 0 (never-rostered clients refuse each other), revoke-before-entry order test, 4405 test, three-client tests use the real join flow |

## Refusal evidence (amendment 2026-10-13)

A refused device must learn that it was removed, because a revoked device is refused by every peer and cannot sync the revoke. Rules:

1. **A refusal is never a verdict.** A device marks itself removed (`self:removed_from_camp`, `electron/sync/automerge/selfRemoval.js`) only when its own signed authority state (`authority_cache`, re-derived by projection) says it is revoked. A joining device with no roster refuses its own host, and a hostile peer can claim anything, so the refusal's reason text is only a prompt to re-check own state.
2. **Evidence is real Automerge changes.** A revocation refusal (`device_revoked_by_authority`) carries the actual changes that wrote the revoke entries and the revoking signer's grant chain, never re-authored entries. The refused device validates them (`validateRefusalEvidence`: same camp lineage, only authority-log changes, revoke signers admin at their own causal position), applies them like ordinary sync, and re-derives. Wrong-camp, unrelated or oversized evidence is rejected whole.
3. **Roster-bound recipient gate.** A peer is sent evidence only if the roster binds its peer id to the device id it claims (`mayReceiveRevocationEvidence`), so a stranger claiming a revoked device id learns nothing.
4. **A false removal heals itself.** After every projection, a device marked removed whose own state no longer says revoked (the revoke was superseded, or turned out invalid once the device caught up) clears the mark (`healRemovedMark`), tells the renderer (`shoresh:access-restored`), and resumes admission. A removed device keeps trying to reach peers (at most one attempt per peer per minute), because only a peer that admits it again lets it learn the removal was false. No re-pair is needed.

**Accepted residual (v1, owner-delegated ruling):** a stale device that has not yet learned admin D was revoked can be made to sign itself out by D, using a backdated but causally valid revoke delivered in a refusal (insider with retained keys plus a stale victim). Effect: recoverable sign-out. Nothing leaks and nothing escalates. Recorded in `SECURITY.md` "Known limitations".

## Interface-contract check (`org-interface-contracts`)

- **Idempotency / concurrent retries:** roster entries are keyed by `device_id`, signed over the id; writing the same entry twice is an identical-field write (no conflict); two hosts' simultaneous add of one device writes the same device_id with different `added_at`/sig, which can raise a `conflicts` row on a modeled field. Mitigation: entries are written once, at first login, which is skipped when `roster_cache` already holds the device; the projection verifies whichever signature wins and both are valid.
- **Unknown outcome:** `approveDevice` writes the `devices` row and sends `pairing_approved`; the roster entry is written later, at the joiner's first login, and is idempotent, so a crash before it leaves an unrostered device whose next login enrolls it.
- **Error shape:** unchanged 4401-4405 reasons through `authGate`.
- **Authority boundary:** `authorize()` is untouched; roster membership grants connection admission only, never a role (same separation the `device` token had).
- **Trust boundary validation:** every roster entry arrives from another device and is signature-verified before use; forged entries are inert.

## Residual risks (stated, not hidden)

1. No automatic expiry for a stolen, unreported client (section 5). Owner-visible tradeoff of the ruling.
2. Revocation stale-view window (section 3).
3. A document writer can overwrite or delete a roster record. The monotonic cache (section 1) means this cannot remove a device a peer has already verified, so it is no longer a total-lockout path; it can only keep a not-yet-verified device out of a given peer's roster (or out of a rebuilt device's) until the host re-writes the signed record. Not an escalation: no one can add a device without the host key.
4. First-sync trust in the join-pinned host peer id is as strong as the join code, unchanged.
5. A healthy device that loses its identity key (restore from backup, keystore reset) is refused with `peer_identity_mismatch` (4405). The way back is the director removing the old device and pairing it again as a new device (new identity key, new roster entry). No in-place re-key exists, deliberately: it would be a path for a revoked machine to return.
6. Stale entries for wiped devices stay in the roster until an admin removes them; removal is a revoke. The Device Manager keeps showing every device with last-seen, so an absent device is discoverable.
7. If the host's own device is revoked, its key can still sign roster adds (the key, not the device row, is the authority, as for `users` credentials today); a revoked host is a host-key compromise, handled by the rebuild recovery in section 5.

## Open questions for Governor

None that block Maker. Two Maker-time confirmations that could change scope, to be reported not decided: whether any non-admission code consumes the `camp` token (graph plus grep), and that the Noise key equals the device identity key in the harness path (test I pins it).
