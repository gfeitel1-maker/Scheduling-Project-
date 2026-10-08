# Shoresh — Security Model

_Last updated: 2026-09-28_

The standing security program that governs how this model is maintained and tested lives at
[docs/work/security/2026-09-14-security-program.md](docs/work/security/2026-09-14-security-program.md)
(four tiers: automated gate, fuzzing, periodic assessment, and the enforced internet-transport
boundary trigger).

**Transport note (read first):** sync now runs on **Automerge over libp2p**
(`electron/sync/automerge/`), with peer connections encrypted and mutually authenticated by the
Noise protocol. The retired custom WebSocket server (`syncServer.js`/`syncClient.js`) is deleted.
Some sections below still say "WebSocket"/"WS" for the *mechanism* — pairing, revocation, token
rejection, the pre-auth `login`/`pairing_request` handling — because the auth **semantics** carried
over unchanged (the same shared decision functions in `connectionAuth.js` serve both). Read those
as "the network auth path", now the libp2p auth gate (`authGate.js`).

---

## Deployment boundary

Shoresh is designed for a **trusted private LAN** — a small, known group of collaborators
(camp directors, scheduling staff) on a network they control: a camp office router, a direct
switch, or equivalent. It is not hardened for the public internet.

**This boundary is an assumption with an expiry, and it is enforced by network topology, not by
code — be precise about how.** The production node binds **all interfaces** (`/ip4/0.0.0.0/tcp/0`,
`electron/sync/automerge/syncStarter.js` — the listen + mDNS wiring moved out of `main.js` in
T276) — NOT loopback (loopback would break LAN sync). What keeps it off the internet
today is **discovery**: peers are found only via `@libp2p/mdns` (link-local multicast); no DHT,
relay, or bootstrap is installed or wired. So the pre-auth surface is reachable by anything that can
route to the host's ephemeral port — shielded by NAT/firewall topology + an unadvertised port, not
by a code boundary. The intended next step (owner decision 2026-09-15) is **cross-internet sync,
direct hole-punch, NO relay** ("no server of any kind") — which a WAN security assessment
(`docs/work/security/2026-09-15-wan-dht-boundary-assessment.md`) found has hard blockers that must
be fixed first (join code, LAN-sized rate limits, unsigned builds) and one
networking invariant (symmetric-NAT/CGNAT pairs cannot be punched directly without a relay).
The join-code blocker has since been **addressed by T286** (see the WAN-connectivity hardening
ladder, [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md](docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md)):
the join secret is now ephemeral, window-scoped, random (never campId-derived), 50-bit, and
scrypt-tagged for rendezvous (`electron/sync/joinCode.js`) — replacing the earlier
`base32Crockford(sha256(campId)[:5])` derivation. LAN-sized rate limits and unsigned builds remain
open. This does not move the deployment boundary: the WAN rendezvous modules exist with tests but
are still **not wired into production discovery** (mDNS-only), so the boundary described above holds. Any
move to internet-reachable discovery requires that re-assessment first — enforced by
[docs/adr/2026-09-14-internet-transport-security-gate.md](docs/adr/2026-09-14-internet-transport-security-gate.md)
and its build-failing guard (which reads the real `electron/sync/automerge/syncStarter.js` discovery
wiring, not a dead loopback constant).

Pairing is accepted only from a private (RFC1918 / IPv6 ULA), loopback or link-local address. Carrier-grade NAT `100.64.0.0/10` falls outside that list, as does every Tailscale address and any VPN or relay path; all are refused with `pairing-requires-local-network` ([docs/adr/2026-10-08-max-connections-dos-mitigation.md](docs/adr/2026-10-08-max-connections-dos-mitigation.md)).

---

## What is hardened

### Device pairing gate

Every new device must be explicitly approved by an admin before it can sync or authenticate.
A joining Client requests pairing over the libp2p connection; it remains a pending device
(`devices.pairing_status = 'pending'`, `electron/auth/connectionAuth.js`) until an admin approves or
denies it in the Device Manager screen. (The renderer once had a `pairing_pending` device-mode phase;
that UI phase was retired in Stage 6c — the Host-side pending status is the real gate.) Approved devices receive
a `device_secret_identifier` (32 random bytes, hex-encoded) minted by the Host at approval
time.

### Device revocation

Revocation is immediate and enforced server-side. When an admin revokes a device, the Host:

1. Sets `devices.revoked_at`, `revoked_by_user_id`, and `revocation_reason` in the database.
2. Closes the device's live WebSocket connection.
3. Rejects any subsequent `authenticate` message from that device via `authorize()`.

### Ed25519 Host-only token minting

Session tokens used for network authentication (`type: 'camp'`) are signed with an Ed25519
private key that lives exclusively in the `host_signing_key` table on the Host device. That
private key is never replicated. Clients receive only the public half (`camps.signing_public_key`)
via full-sync, so they can verify tokens but can never mint them.

Client offline sessions use a different token type (`type: 'local'`) — HMAC-SHA256 keyed to
the device's own `device_secret_identifier`. These are accepted only for local IPC calls on
that device; the Host's WebSocket server rejects them outright.

### Per-device transport identity, and tokens bound to the peer presenting them

**A second, different private key exists on every device** (not only the Host), and it must not be
confused with `host_signing_key` above: `device_identity_key` holds that device's Ed25519 **libp2p
transport identity**. It never signs tokens and confers no role. Its only job is to make the
device's libp2p PeerId stable across restarts — which was previously not true, because libp2p
minted a fresh keypair on every process start.

- **Custody.** Generated lazily the first time a device starts a sync node, stored in the local
  SQLite database in the same singleton (`CHECK (id = 1)`) shape as `host_signing_key`, hex-encoded
  in libp2p's own protobuf marshal format. It is never replicated: it appears in no projection, no
  camp-scoped entity set, and no Automerge document, and a test pins that exclusion. It inherits
  at-rest encryption from SQLCipher along with the rest of the database (on by default); there is deliberately no separate key store for it.
- **What it buys.** A session token is no longer a pure bearer credential. On `authenticate` and on
  `login`, the peer identity libp2p's Noise handshake already proved for the connection is checked
  against `devices.libp2p_peer_id` on a trust-on-first-use basis: the first peer id presented for a
  device binds, every later one must match, and a mismatch is refused with reason
  `peer_identity_mismatch` and close code `4405`, audited. A token stolen off one machine and
  replayed from another is therefore rejected. This closes the property T155 characterized.
- **Accepted cost, stated plainly.** Losing the key — an app reinstall, a database restored from
  before it existed, a rollback of the schema past it — means the device presents a *new* identity
  and is refused by every device that knew the old one. **This is deliberately treated as needing to
  re-pair, not as an outage to route around.** Recovery is the existing flow: a director revokes the
  device's row from another device, and it pairs again as new. There is currently **no in-app
  message explaining a `4405` refusal to a director**, which is a known gap recorded in T162 rather
  than a property of the design.
- **Still open.** `devices.libp2p_peer_id` remains excluded from `authorize()` — admission ("who may
  connect") and authorization ("what may this actor do") stay separate layers, and a guard test
  enforces that `authorize.js` never reads the column.

Token lifetime is 24 hours. There is no in-band token-renewal message; a token past this window
simply stops verifying (`electron/auth/localAuth.js`), and freshness comes from the client
re-presenting its token on every restart (ADR `2026-08-16-client-reauth-on-restart`, described
below), at which point revocation is re-checked.

### Centralized `authorize()`

Every mutating IPC handler and every mutating WebSocket handler calls `authorize()` in
`electron/auth/authorize.js` before proceeding. `authorize()`:

- Verifies the session token (signature + expiry).
- Re-queries `users` and `devices` from the database on every call — role changes and device
  revocations take effect on the very next call, even from an already-connected session.
- Checks the action against a named permission matrix (`electron/auth/permissions.js`).
- Returns `{allowed: false, reason}` on any failure — never throws, never defaults to allowed.

The same `authorize()` call and the same action-derivation logic (`deriveWriteAction`,
`deriveBulkReplaceAction`) are used identically on both the IPC and WebSocket paths, so on the
**op-log** transport there is no way to bypass IPC-level restrictions by connecting directly to the
WebSocket.

**This does not extend to the Automerge/libp2p engine, which is now the default.** See "Role
enforcement is device-side under CRDT sync" under Known limitations — that is an accepted tradeoff,
not an oversight, and it is the one place the two engines differ in what they enforce.

### Audit log

All auth events and authorization denials are written to the `audit_events` table by
`electron/audit/auditLog.js`. Captured events include successful and failed logins (with
reason), denied `authorize()` calls (action + role + reason — no PIN or token material is
logged), and device pairing and revocation events.

### Login lockout

After 5 consecutive failed PIN attempts for a username, further attempts are blocked for
30 seconds (`LOGIN_MAX_ATTEMPTS = 5`, `LOGIN_LOCKOUT_MS = 30_000` in `localAuth.js`).

### Restore is bounded by an entity allowlist, and never touches accounts

Restoring a deleted record re-emits its last-known field values as ordinary ops
(`electron/ops/restore.js`, per
`docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md`). Because `users` is a
writable projection, an unbounded restore would re-emit `pin_hash` and `pin_salt` as ops
that **replicate**, resurrecting a deliberately-removed account with its old PIN. The
existing `IPC_PIN_FIELDS` guard does not cover that: it filters what reaches the renderer,
not what is written to the log.

So `restoreEntity` accepts only the eight setup entities and refuses everything else —
`users`, `camps`, `devices`, `schedule_templates`, `template_slots` — in the handler, on
both the IPC and the WebSocket path, before anything reads the op log. The decision for
every projected entity is recorded in `RESTORE_DECISIONS`, and a test fails if a new
projection arrives without one. Restore requires `admin`; `listDeleted` and
`getEntityHistory` are read-only and open to any authenticated role, and
`getEntityHistory` withholds PIN values against the same shared list
(`electron/ops/pinFields.js`).

### Spreadsheet parser (SheetJS) is pinned to the advisory-fixed line

A camp schedule file is attacker-authorable input the director imports from others, and it is
parsed by SheetJS (`xlsx`). The dependency is pinned to the **CDN tarball**
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` in `package.json`), **not** the
npm-registry `xlsx@0.18.5` — the registry line is frozen at 0.18.5 and carries two open high
advisories with no npm fix (prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9).
The fixes ship only from the SheetJS CDN. A plain `npm install` resolves the tarball, not the
registry — this is deliberate, per
`docs/adr/2026-09-13-sheetjs-parser-advisory-migration.md`. Re-check SheetJS advisories against
the installed version on every bump. Import read paths are additionally bounded by
`assertImportFileSize` / `assertWorkbookComplexity` (`src/utils/exportSanitize.js`), which cap
file size, sheet count, and rows before a workbook is walked.

---

## Known limitations

### LAN discovery-tag rotation is restart-bounded for a running process (v1, accepted; live rotation required in T334/DHT)

The discovery tag (the key devices find each other under) is derived as a pure function of the signed T331 revocation set (T335 — `tag = HMAC(campDhtSecret, hash(revoked_device_ids))`), so it changes automatically when a device is revoked. On the **LAN/mDNS layer**, however, a device that is **already running** keeps advertising/querying under its startup tag until the process restarts: `@libp2p/mdns` captures the outgoing-query `serviceTag` by value at `start()`, and libp2p exposes no stable API to retrieve and restart the constructed mDNS instance to re-advertise under a new tag. **Why this is accepted as bounded, not an auth hole:** T331's authorization gate still **refuses a revoked device admission regardless of the tag it advertises** — a revoked device cannot sync or be admitted even if it remains findable-by-tag on the LAN until peers restart. So on the pure-LAN layer this is an **obscurity/liveness** gap (a revoked device stays discoverable-by-tag to not-yet-restarted peers), **not** an admission/authorization gap. **This is NOT the cross-network cut-off** — the brute-force-safe, cut-off-on-revocation property for the **public DHT** is where it matters, and there live rotation is a **hard requirement of T334** (the DHT slice), re-confirmed by Red Hat + Security in that slice's battle-test gate, because DHT state travels over a persistent connection rather than a one-time UDP service-tag constant.

### Two-device-camp revocation deadlock under sync lag (v1, accepted; fast-follow T333)

Distributed revocation (T331, ADR `docs/adr/2026-10-02-distributed-revocation-authority.md`) cuts a
removed device/admin off fleet-wide, and the gate-precedence/self-heal work closes the sync-lag
mis-lockout of a legitimate admin **for any camp with three or more reachable devices**. In a **strict
two-device camp** where the two devices are each other's only peer, a blind revoke of an admin under
sync lag (the revoking device has not yet synced that admin's grant) can **lock that admin out until a
third device joins the camp** — the revoking device projects the target as revoked from its own
unsynced view and then denies the only connection over which the correcting grant could arrive. Camps
of 3+ devices self-heal automatically. A recovery affordance was designed and reverted (it was inert
against the real admission gate — see the ADR's "Known limitation (v1)" section); the proper fix
re-touches the admission gate's readmission guarantee and is tracked as fast-follow **T333**. Accepted
for v1 per the owner's 2026-10-03 ruling.

### No TLS / certificate trust on the sync connection

libp2p peer connections are encrypted and mutually authenticated by the **Noise protocol**, so
sync traffic is *not* sent in cleartext on the wire (this corrects the pre-libp2p description,
which said `ws://` plaintext — that transport is gone). What Noise does **not** provide is
TLS-style certificate trust or any protection once traffic leaves the local network: Noise
authenticates the *channel between two peers*, not *camp membership* (membership is proven
separately by the session token at the auth gate). Under the trusted-LAN model this is accepted.
The residual exposures that remain are the application-layer ones below (the PIN reaching the Host
process, and camp-membership trust), not wire-plaintext.

**Do not expose the sync transport to the internet.** Doing so requires the re-assessment gated by
[docs/adr/2026-09-14-internet-transport-security-gate.md](docs/adr/2026-09-14-internet-transport-security-gate.md)
— including whether Noise-only channel encryption is sufficient off-LAN and whether relays must be
independently authenticated.

### Raw PIN reaches the Host process on initial login

A Client verifies its PIN against the Host by sending it in the pre-auth `login` message (now over
the libp2p auth gate). The message travels inside the Noise-encrypted peer channel, so it is not
exposed on the wire — but the **Host process receives the PIN in cleartext** to run `scryptSync` on
it. This is necessary for the lockout mechanism and so the Host can issue the token. Under a
trusted-LAN model this is accepted; the exposure is the Host device itself and grows on a shared or
monitored network, and off-LAN it must be revisited (Tier-4 gate).

### Offline local tokens cannot be remotely invalidated

A Client that has a valid `local` token and is offline can continue to use it until expiry
(up to 24 hours from issuance). Revoking the device at the Host while the Client is offline
prevents future re-authentication but does not immediately invalidate the local token on the
Client's own process. Work queued offline during this window is submitted to the Host when
connectivity is restored — the Host's `authorize()` call on the WS path will then reject it.

A Client's `camp` token (issued when it logs in over the network, distinct from the
device-only `local` token above) is now re-presented to the Host on every process restart —
not only right after a fresh PIN entry — per
[docs/adr/2026-08-16-client-reauth-on-restart.md](docs/adr/2026-08-16-client-reauth-on-restart.md).
A revoked device therefore discovers the rejection (WS close 4401-4404) the next time it
restarts or reconnects — the Client clears the stale token and returns to the login screen —
instead of only ever finding out when the stored token's 24-hour window naturally expires.
This strengthens, but does not remove, the tradeoff above: a `local` token is still never
valid over the network by design (rejected outright with 4402, revoked or not), and a Client
that never reconnects to the Host still has no way to learn of a remote revocation until it
does.

### PIN hashes replicate, and a four-digit PIN is small (T150)

`users.pin_hash` and `users.pin_salt` are modeled document fields: they replicate to every approved
device and sit in a plaintext `.automerge` file on each one. That is deliberate — a device that
cannot reach anyone still has to be able to log its staff in — and it is not equivalent to
replicating plaintext credentials. But it does mean the hash is available to anyone holding the
file, and the PIN it protects is four numeric digits: ten thousand candidates.

The hygiene is sound: a unique 16-byte salt per user, `timingSafeEqual` comparison, plaintext PINs
never persisted anywhere, and a 5-attempt / 30-second lockout. The lockout defends the **online**
path only; it does nothing against someone working offline against the file.

The scrypt cost was raised in T150 (N=2^16, from Node's 2^14 default) and hashes are now
self-describing, so the cost can be raised again without a flag day. Be clear about what that buys:
it turns a few minutes of offline work into a few hours. **No KDF parameter makes a four-digit PIN
safe.**

What bounds the risk is the trust model, not the KDF. Whoever has the document already has the
camp's data, because the document *is* the data. Cracking a PIN buys **impersonation** — authorship,
and `staff` -> `admin` role escalation, which matters more given the section below — not access. The
open questions this leaves are PIN length and role separation. Both are product decisions.

Because the stored hash is now **self-describing**, it is also attacker-influenced: `pin_hash`
replicates, so a device that edits its own document directly (the exposure the section below already
accepts) could choose the parameters every other device then verifies at. That is an availability
angle, not an impersonation one — scrypt run at an absurd cost blocks the single Node thread rather
than revealing anything. `parseStoredHash` therefore **clamps** the parameters against a fixed
ceiling and never derives `maxmem` from the stored value; anything out of range, zero, negative or
non-integer reads as a failed login, since a hash we refuse to compute is a hash we cannot verify.

**T163 (owner decision 2026-09-14) closed the PIN-length half of that open question, not the role
half.** DIRECTORS (role `admin`) now need a 6+ digit PIN; staff keep 4. Both roles are digits-only —
a genuine widening beyond the ask, since any non-empty string up to 32 characters used to pass
despite the UI's numeric keypad. The chokepoint is `assertValidPin` inside `createUser`
(`electron/auth/localAuth.js`), reached by both `createUserHandler` and `bootstrapCamp`. Because a
staff -> admin role flip on an existing user is a separate risk — the server cannot infer a PIN's
plaintext length from its scrypt hash, so a role write alone could silently leave a 4-digit PIN
behind a director-privileged account — the generic `write()` IPC handler now refuses
`entity:'users' field:'role' value:'admin'` outright, and a new `promoteToAdmin` handler
(`electron/ops/promoteToAdmin.js`) is the only path that can perform the promotion: it requires a
fresh PIN meeting the admin floor and writes it atomically with the role change via `runAtomic`.
There is no grandfather path and no login-time refusal for a PIN that predates this change — there
is no live camp data yet, and the owner's standing preference is a clean cutover; if that ever
changes, a flagged-not-blocked login nudge (not a refusal) is the documented compromise, not a
revival of what this paragraph describes.

Be honest about what this raises and what it leaves untouched. It raises the offline guess space for
a director PIN from 10,000 to 1,000,000 — roughly 100x attacker cost, hours-to-days of offline
scrypt work rather than minutes, **not "safe."** It does **nothing** about blast radius: `admin` is
an unconditional wildcard in `electron/auth/permissions.js` (`PERMISSIONS.admin = ['*']`), so
cracking one director's PIN still buys every admin-gated action in the camp, not just that
director's own. Narrowing that wildcard is a follow-up the owner has been told about and is
deliberately not built here.

### At-rest encryption (what it does and does not protect)

At-rest encryption is on by default. Both the camp document (`<campId>.automerge`) and the local
database (`shoresh.sqlite`) are encrypted on disk with a random 32-byte per-device key sealed in the
operating system keychain (macOS Keychain / Windows DPAPI via Electron `safeStorage`). The plaintext key is never
written to disk; only its safeStorage-sealed form (`db.key.enc`) sits beside the data. See `docs/adr/2026-09-15-at-rest-encryption-scoping.md`.

**This defends one specific thing: a powered-off or stolen device.** Someone who takes the hardware, or
copies the files off it (a backup, a synced folder, a discarded disk), cannot read a camp's data without
also being able to log in as the same OS user on that machine.

**It does NOT defend against:** an attacker who is already logged in as the same OS user (a shared
office login is therefore not protected from its own users), a running and unlocked machine, or
malware running as that user. It is a trusted-device model, not full-disk encryption and not a defense
against a live, authenticated attacker. For a shared machine, use separate OS user accounts; the
keychain isolation is per-OS-user.

Plaintext `*.pre-migration-*.bak` copies are shredded (overwrite, then delete; best-effort on
APFS/SSD) once encryption has verified, because a plaintext copy defeats at-rest encryption; recovery
is a peer re-sync. See `docs/current/KEY_RECOVERY_STORY.md`.

**Recovery:** the key lives only in this device's keychain. If the OS keychain is reset or the device is
lost with no other paired device holding a copy, the encrypted data cannot be recovered. See
`docs/current/KEY_RECOVERY_STORY.md`.

**Downgrades are unsupported.** Running a build older than the encryption build against an encrypted database or
document is not supported: older builds cannot read either. The ruling is no downgrades and no mixed-version fleets.

- **It is a deliberate hard-fail:** no key means no readable data, with no graceful fallback (the key is
  minted and sealed automatically, with no passphrase to forget, and survives app reinstalls).
- **Turning it off is not an ambient setting.** Once a device holds its key file, the
  `SHORESH_AT_REST_ENCRYPTION` environment variable is ignored. No in-app disable is offered; a future
  director-gated disable is a separate ticket (`docs/adr/2026-10-08-at-rest-encryption-sticky-no-ambient-disable.md`).
- **Headless tools need a director-granted authorization.** The MCP server and CLIs reach an encrypted DB
  only through the Electron unlock helper (`electron/unlockDbKey.js`), which releases the key to a tool
  only if it presents a live, non-revoked per-tool secret (`SHORESH_TOOL_SECRET` or `--secret-stdin`,
  never argv). The director grants, lists and revokes these in the app (Devices screen, Connected Tools);
  each grant is named, scoped read or read-and-change, shown its secret once (only a hash is stored), and
  audited. The grants live in a keychain-sealed store outside the camp database, so they are readable
  without the camp key, including when the app is closed. Every check goes through one function
  (`checkToolAuthorization` in `electron/auth/toolAuthorizations.js`). The key itself is never written
  to disk and never passed on the command line
  (`docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md`, amended by
  the 2026-10-08 "director-authorized tool connections" ADR, PR #745).
- **Revocation stops future launches only.** A tool that already holds the key keeps it until it restarts.
- **Read scope is advisory.** It is enforced only by cooperating tools; a same-user process can bypass it.
- **This is accountability, not a cryptographic boundary.** A process running as the same OS user, with
  the same keychain access the app has, can still run the unlock helper's Electron entry itself and
  unseal the key. Authorization records which tools the director chose to connect and gives a clear
  refusal to the rest; it does not defend against a same-login attacker (that stays out of scope, as
  above), and there is no per-tool key wrapping.
- **Named refusals.** An unknown or forged tool secret gets `tool-not-authorized`; a revoked one gets
  `tool-authorization-revoked`; a read-only tool asked to write gets `tool-scope-read-only`. A headless
  tool launched with encryption on and no key also gets `tool-not-authorized`. `db_key_unavailable`
  remains only for the genuine case of an authorized tool whose keychain entry cannot be read, and for
  the interactive `openLocalDb` seam. Tool use and refusals are queued in the sealed store and recorded
  to `audit_events` by the running app.
- **Throwaway-DB scripts are pinned off, and a guard keeps every caller classified.** Scripts that build
  disposable plaintext DBs import `scripts/pinAtRestOff.js` first. `openLocalDbCallers.guard.test.js`
  fails if any non-test `openLocalDb` caller is neither keyed nor pinned, or if the key can be released
  without passing the authorization checkpoint.
- The interactive app acquires a real key via the OS keychain and, on the first launch with encryption
  on, migrates a plaintext file to encrypted once.

#### Children's records raise the stakes on that flag (ADR 2026-09-17 D8, T194)

Schema v66 introduces a `campers` table and the elective preference/assignment rows that hang off
it. That is the first time this app stores **records about identifiable children** — a display name,
a group, an optional external roster id, and, joined with `elective_preferences`, "this child asked
for this activity".

Two consequences, stated here rather than left implicit:

- **At-rest encryption is a precondition for real camp use of this feature, not an enhancement.**
  Encryption is on by default and, once a device holds its key, cannot be turned off by the
  environment (see above). A device that never ran encrypted, or one where the flag was explicitly
  set off before first keying, holds a plaintext list of children in a copied database or
  `.automerge` file; for this data class keeping it on is a precondition, not a hardening
  nice-to-have.
- **The footprint is deliberately, minimally scoped.** D8 fixes it at name, group and external id.
  No contact details, no medical data, no date of birth, no household or parent records. Adding a
  column here is an **ADR-level change**, not a field addition — the small footprint is the primary
  mitigation, and it only works while it stays small.

**Deletion is not erasure, and the difference is load-bearing.** The op-log, the Automerge document
and `audit_events` all outlive a projected row: deleting a camper removes the SQLite row, and a
rolled-back v66 migration drops the whole table, but neither is a purge. The real purge path is
ADR 2026-09-17 D10, tracked as **T202**; read that ADR for what it can and cannot reach before
telling anyone a child's record has been erased. Two structural guards ship with T194 in the
meantime: all eight participant entities are non-restorable (so a camper can never be enumerated in Trash or
re-materialized from the op-log by a restore), and `recordAuditEvent` **refuses** free text in the
three caller-supplied fields that can carry it — `metadata`, `targetId` and `reason` — whenever
`targetType` is one of the eight. `audit_events` is append-only and survives every purge, so a name
written there would be unrecoverable by T202 too. Be precise about the scope of that guard: it is
not a general PII filter on the audit log. `reason` stays free text for every **other** target type,
which is what every existing call site passes, and the guard keys on the exact registered entity
name — an unregistered spelling is refused outright rather than silently passing through
(`electron/ops/participantEntities.js` is the single definition every guard derives from).

Access is admin-only (D9) with **one read exception**. _Prior: "no non-admin role has any in-app
read path to any of the eight, and staff receive the exported artifact instead." Amended
2026-09-29 (T304) by owner ruling._

Staff hold **`campers.read`** — and nothing else on the participant domain: no write, delete,
restore, bulk_replace or import, and no access of any kind to the other seven entities. The ruling
was that the `staff` role in this product means administrative staff, and that a child's name is
not a secret from the people who are with that child; the occasion was that an elective import's
unnamed submissions are raised on the Roots home, which staff reach. See the D9 amendment in
`docs/adr/2026-09-17-individual-elective-scheduling.md`.

Mechanically the exception is `STAFF_READABLE_PARTICIPANT_ENTITIES`
(`electron/ops/participantEntities.js`), which `electron/auth/permissions.js` maps to `.read` only.
`campers` stays **out of `ENTITIES`** — that is what keeps `.write` from being derived alongside —
and stays **in `PARTICIPANT_ENTITIES`**, so the audit PII guard, the restore refusal and the MCP
entity-map exclusion are unchanged.

**Two read surfaces open with the grant, both counted before it was written:** `list('campers')`,
and per-record camper **history**, because `getEntityHistoryHandler` derives its action from the
entity name. `listByScope` does not — `campers` is absent from `SCOPED_LIST_ENTITIES`.

`electron/auth/participantEntitiesAdminOnly.test.js` still asserts the negative for everything
else: it derives its one skip from the same constant, inverts the `campers.read` assertion rather
than deleting it, and adds explicit checks that `campers.write` and every other verb are still
refused to a real staff token.

#### Camper-record purge — what it does and does not reach (T202, round 2 hardening)

A camper record can be purged via a support-level command (`purgeCamperRecord`,
`electron/automerge/purgeSupportCommand.js`), not a director-facing button. Purge deletes the
target camper and its dependent `elective_preferences`/`elective_assignments` rows and the fresh
document that replaces this device's `.automerge` is derived AFTER those deletes, so its history
never mentions the purged rows. The three deletes, the document regeneration, and a genesis
sanity-check all run inside **one SQLite transaction**: a failure anywhere in that block rolls the
deletes back rather than leaving SQLite purged while the on-disk `.automerge` (the source of truth)
still holds the camper — a split state that would otherwise look recoverable and not be. A crash in
the window after the transaction commits but before the rebuild completes is recovered by simply
**re-running `purgeCamperRecord` with the same id** — those steps are idempotent. (The one window
this does NOT cover is after the rebuild completes but before key-restore finishes; see "Ordering and
the one crash window" below.)

**This purge is a WHOLE-DEVICE rebuild, not a scoped delete, and the collateral is real, not
theoretical.** It reuses `rebuildProjectionFromDocumentAtPath`, which deletes and recreates this
device's entire SQLite file and reprojects only the entities the Automerge document replicates.
Every table this device keeps that is **not** document-replicated is wiped **camp-wide** in the
same stroke — confirmed against the schema, this is `conflicts`, `import_evidence`,
`import_decisions`, `open_reconciliation_decisions`, `pending_writes`, `pending_restores`,
`device_health_events`, `projection_failures`, `source_aliases`, `compound_cell_decisions`,
`location_word_decisions`, `declined_two_row_splits`, and `fixed_event_identity_gaps` (T267 — the
fixed-event backfill's unresolved-name worklist) — plus `camps.signing_secret` (the retired
legacy HMAC field, never read, whose loss is inert). (`schedule_snapshots` and every other
camp-scoped entity in `MODELED_ENTITIES`/`GENESIS_ENTITIES`, by contrast, ARE document-replicated and
correctly survive — they round-trip back in via the fresh document, exactly as an ordinary sync would
carry them.)

**This device's signing/identity keys ARE preserved across the purge (T202 follow-up).** The three
load-bearing device-identity artifacts — `host_signing_key` (Host-only, the credential-minting
private key), `device_identity_key` (every device's stable libp2p PeerId key), and
`camps.signing_public_key` (the local mirror used to VERIFY credential changes, excluded from the
document) — are read out of the pre-rebuild database and written back into the freshly-rebuilt one,
byte-identical, by `electron/automerge/hostKeyPreservation.js`. A purge therefore no longer silently
strips a live Host of its ability to mint credentials, nor changes this device's PeerId (which would
otherwise trip `peer_identity_mismatch`/`4405` on every already-paired peer). The rationale is that a
purge is **not** a "device lost/reset" event — the machine stays alive and stays Host — so the
`KEY_RECOVERY_STORY.md` "re-establish identity / re-pair" answer does not apply; and the three
artifacts are pure-random keypairs that encode no camper data, so preserving them weakens no
erasure claim. Preservation is confined to `purgeCamperRecord`: the shared
`rebuildProjectionFromDocumentAtPath` (disaster-recovery on a possibly-new machine) stays destructive,
where re-establishing identity is the correct answer. Because that reverses the behavior the
rebuild's own `NOT_RECOVERABLE_NOTICE` describes, `purgeCamperRecord` returns its **own**
`PURGE_NOT_RECOVERABLE_NOTICE` (`notRecoverable`/`keysRestored`/`before`/`after`) rather than relaying
the rebuild's now-inaccurate one, and pins the behavior with tests: the keys survive byte-identical, a
Client with no `host_signing_key` skips it cleanly, and `camps.signing_secret` is confirmed **not**
preserved. **`purgeCamperRecord` is a camper-erasure tool, NOT a credential-rotation or
compromised-device-remediation tool** — because it now preserves the keys, it must not be reached for
to "wipe" a suspected-compromised Host; the answer there remains device revocation + re-pairing.

**Ordering and the one crash window this preserves through.** Restore runs AFTER the rebuild and
BEFORE the pre-migration backups are shredded. That order is load-bearing: the backup the rebuild
writes still holds the original keys (it is copied from the pre-rebuild database), so a crash in the
narrow window between rebuild-finish and restore-finish leaves that backup as a manual recovery
source. This is the one window the transaction/idempotency guarantees below cannot auto-recover —
once the rebuild completes, the camper row and its `operations` history are gone, so a re-run hits the
refusal — an accepted, bounded regression, recoverable by hand rather than silently. A forced-throw
test pins that the backup survives and still contains the key.

**Operational precondition (documented, not enforced).** Run `purgeCamperRecord` only with the app /
sync node stopped on this device. `ensureHostSigningKey`/`ensureDeviceIdentity` lazily mint a fresh
key into an empty table on app startup; a concurrently-running app could mint an interim key into the
freshly-rebuilt table before restore writes the original back. No running-instance marker exists in
this codebase to enforce against, and the sibling support command `rebuild_projection_from_document`
carries the same unenforced precondition.

Because that collateral is real even when nothing needed purging, `purgeCamperRecord` **refuses
outright** — before doing anything destructive — when the given id names no camper row and has no
`operations` history on this device.

`purgeCamperRecord` also empties this device's `operations` history for the whole ledger (the
whole-file rebuild's side effect, not a targeted per-record prune) and discards every
`*.pre-migration-*.bak` for this device's database — these are otherwise **never** automatically
pruned by anything else (the retention pruner `rotatePreResolveBackups` covers only
`*.pre-resolve-*.sqlite` conflict/bulk-replace snapshots).

**Fleet-wide reintroduction is now prevented — logical erasure (T233).** _Prior: a purged device's
fresh document still shared genesis with every already-admitted peer, `sharesGenesis()` was the only
admission gate, and nothing stopped a stale peer from reintroducing the purged record via ordinary
sync — a hole closed only by physically re-pairing every device._ T233
(`docs/adr/2026-09-19-multi-device-erasure-propagation.md`) closes it: `purgeCamperRecord` mints a
**Host-signed, monotonically-versioned purge tombstone** (`electron/automerge/tombstoneSignature.js`)
— the purged id + entity + signature, no name, no reason — carried as a SQLite-backed, document-
replicated entity. `electron/automerge/projector.js`'s `upsertTombstonesEntity` verifies the Host
signature (trust root read from the local `camps.signing_public_key` column, never the document) and
version at **projection time**, then a denylist pass **refuses to project, and deletes, any tombstoned
camper and its `elective_*` dependents on every device that receives the tombstone**. A stale peer that
reconnects gets the tombstone as ordinary replicated state and its copy of the record never reaches the
projection again — no re-pairing, no genesis change. `purgeSupportCommand.test.js`'s formerly-"known
gap" test is inverted: it now merges an untouched peer's pre-purge document and asserts the camper is
**refused**, not reintroduced.

A finalized elective run's row (`elective_assignment_runs`) is deliberately outside this denylist —
it is the run, not camper data — but its replicated `snapshot_digest` field carries only run-scoped
`sha256(run_id:camper_id)` hashes of the campers in that run, never a camper id in cleartext, so the
run row surviving a purge carries no readable identity. **This is guess-resistance, not erasure, and
the difference is worth stating.** Every device has to recompute that key from a `camper_id` it
holds in order to subtract an erased camper, so any derivation a device can do, a camp peer can do:
someone holding a candidate id can hash it and confirm membership. An HMAC would not close that (its
key would have to be replicated to stay recomputable, and no fleet secret survives a genesis
rebuild). What the hashing buys is real and bounded: the id and name are no longer simply readable
in a replicated field. See `docs/adr/2026-09-30-elective-run-durability.md`, "Amendment
(2026-10-01): digest map keys".

**`campers.id` itself is opaque, not merely hashed where it is referenced (T321,
`docs/adr/2026-10-01-camper-id-high-entropy-format.md`).** The caveat this section used to carry —
that `deriveCamperId` embedded a camper's canonicalized display name directly into `campers.id`, so
a peer who guessed a purged camper's name could rederive the id and confirm membership anywhere that
id appeared — is closed, not merely narrowed. `campers.id` for every camper created under this
scheme is a random, opaque token (`mintCamperId`) carrying no information about the camper; nothing
can be guessed INTO it. The only place a camp's name/external-id key still exists is a new
replicated entity, `camper_identity_keys` (the deterministic name/external-id -> `camper_id`
lookup table sheet import resolves through before minting). That table is **purged and
tombstone-denylisted exactly like `campers` itself** — `purgeCamperRecord` deletes a purged
camper's `camper_identity_keys` row(s) in the same transaction as its other dependent-row deletes,
and a stale peer re-sending its pre-purge copy of that row is refused at projection the same way a
stale `campers` row is. So the narrower, honest remaining caveat is: while a camper is NOT purged,
the camper_identity_keys row mapping their name to their id is itself a single, cleartext,
replicated record (ADR decision 5 — the lookup's whole purpose requires the key to be readable) —
exactly the same shape every `elective_choices` label key already has, not a new exposure class.
Once purged, that one record is gone fleet-wide through the same mechanism as the camper row, and
every other FK/tombstone/digest key carrying that camper's (now-opaque) id reveals nothing about who
they were, before OR after the purge.

**What this is, precisely: logical erasure ("invisible forever"), not physical byte-erasure.** The
tombstone gates *projection*, so the record can never be seen or re-created on any device again — that
is the guarantee the product owner set (2026-09-19). But the purged field values still physically
remain in each device's `.automerge` history (at-rest-encrypted by default), unreadable through the app. Removing those bytes from the whole fleet has no
stable form cheaper than a coordinated genesis rotation (a re-pair of every device), which is retained
as a documented **break-glass**, not this path. Still genuinely out of reach by any path: any copy of
the `.automerge` or database made before the purge (a backup, an export, a device that never
reconnects), and a paired peer running modified code that ignores the denylist (the accepted
partial-trust limit). Minting the tombstone requires the Host's signing key, so a purge run on a
non-Host device is refused rather than silently erasing only itself.

### A camp token is a bearer credential (T155)

`evaluateAuthenticate` binds a token to the `device_id` carried **inside** the token, **and** — as
of T162 — to the device's libp2p peer id on a trust-on-first-use basis. `bindOrVerifyPeerIdentity`
(defined in `electron/sync/automerge/peerIdentity.js`, called from `electron/auth/connectionAuth.js`)
records the PeerId the first time a device authenticates and
rejects a mismatch on later connections (`4405 peer_identity_mismatch`), so a valid token replayed
from a *different* machine is no longer admitted. Production wires this live:
`electron/sync/automerge/syncNode.js` passes the Noise-proven connection PeerId (`fromPeerId`) into
`evaluateAuthenticate`. Measured, not assumed:
`electron/sync/automerge/syncNodeAuthGate.test.js` pins both this and its counterweight — revocation
is re-checked on every authenticate, so a token also stops working the moment the device it names is
revoked.

_Prior: this section held that `devices.libp2p_peer_id` "cannot close this as it stands" because
libp2p generates a fresh peer id on every process start. That is no longer true — `device_identity_key`
(schema v67, `electron/auth/deviceIdentity.js`) persists a per-device libp2p identity, giving a
stable PeerId across restarts, which is exactly what made the TOFU binding above possible._

Obtaining the token in the first place means reaching a paired device's storage, and anyone who can
do that already has the camp document.

### Role enforcement is device-side under CRDT sync

**Accepted tradeoff, decided by the product owner on 2026-09-08** ("accept it and record it"), after
it was found by porting integration scenario 16 to libp2p. Full analysis and the options that were
weighed: `docs/work/evidence/2026-09-08-crdt-removes-host-side-authorization.md`.

Under the op-log, a Client submitted individual operations and the **Host** ran `authorize()` on
each one, re-reading the author's current role from its own database. The Host was the enforcement
point, and a device could be admitted to the network yet still refused an action above its role.

Under CRDT sync a Client does not submit operations. It writes into its own document and the two
documents merge. The Host merges what an **admitted** peer sends; nothing in the receive path
consults a role. `authorize()` is unchanged and still gates that device's own IPC calls — but the
second check, on receipt, is gone.

Measured, on two real nodes: a device whose user was demoted to `staff` **on the Host** wrote anyway,
and the Host accepted it.

**What this means in practice.** Everything that keeps a stranger out is unchanged: the camp code,
the director's per-device approval, PIN authentication, mutual authentication, and immediate eviction
on revocation. What changed is the trust placed in a device the director has already approved — it is
now trusted for whatever it writes. The realistic exposure is a staff member with a legitimately
paired device who bypasses the app itself, by editing the local database or running modified code, to
make a change their role forbids.

**Why it is accepted rather than fixed.** Validating a merged document per change means re-deriving
who wrote what and whether they were allowed to, on every merge — most of the way back to the central
authority the local-first design exists to remove. On a LAN of devices a director has personally
approved, role separation is a workflow control rather than an enforced boundary, and this document
should say so plainly rather than promise otherwise.

### Pre-revocation offline writes queue locally

On the **op-log** transport, a revoked Client that reconnects has its pending offline write queue
submitted to the Host and rejected via `authorize()`. The queued writes are not automatically
discarded on the Client.

Under **CRDT sync** there is no queue to submit and no per-write rejection: a revoked device is
refused admission (and, if it is still connected when the director revokes it, evicted from the
live admission set immediately — `transport.js`'s `revokePeer`), so nothing it wrote reaches
another device. What it wrote locally stays in its own copy. The enforcement point is admission,
not inspection of the writes.

### Distributed revocation/admin authority (T331)

The device revocation above describes the pre-existing, Host-local mechanism: one admin's own
`revokeDevice` call, enforced on that one device's live connections and local admission. T331
(`docs/adr/2026-10-02-distributed-revocation-authority.md`) adds a SEPARATE, fleet-wide mechanism
on top of it — the two cooperate; neither replaces the other.

**What it defends.** A device (ordinary or admin, including the founder) that any currently-valid
admin signs a removal for is refused: at the handshake (`connectionAuth.js`'s `evaluateAuthenticate`,
independent of `devices.revoked_at`), on the production sync-message path
(`syncNode.js`'s `handleSyncMessage`, the literal path a prior design (T329) missed), and by live
teardown of an already-open connection the moment any device projects the removal
(`projector.js`'s `upsertCampAuthorityLogEntity`). This is **convergent and fleet-wide**: every
device independently replays the same signed, append-only `camp_authority_log` collection and
reaches the same answer regardless of which device signed the removal or in what order changes
merge — there is no central authority to be offline or compromised. An ordinary device is removed
by any one currently-valid admin; an admin or the founder requires a quorum of the *other*
currently-valid admins (`floor((N-1)/2)+1`), so no single rogue admin can unilaterally remove a
peer admin.

**What it does NOT defend against.** A device that is about to be removed, or senses it, can
author entries **offline** citing a causal basis from before its removal propagated to it; those
entries are valid as authored and can drag a legitimate admin down with it (symmetric
mutual-destruction, not a silent win — every entry is permanently visible in the audit trail and
counter-revocable). The owner accepted this residual as bounded for v1, given this project's small,
in-person-vetted device fleets and full auditability; it is not closed by a quorum requirement or a
wall-clock grace window, both of which this project has separately ruled out for device trust
decisions.

**Scope, stated plainly.** This mechanism's admin set is a NEW, device-scoped authority concept —
it is deliberately kept separate from the existing `users.role = 'admin'` credential (a Host-signed,
per-user field governing in-app permissions via `authorize()`) for v1. In practice a camp's director
is usually both, but unifying the two is a larger decision this ADR does not make
(tracked as a follow-up). Signing uses each device's own `device_identity_key` (already generated
on first sync-node start), never `host_signing_key` — this is the whole point: no single device's
key material is a single point of failure for revoking another device.

---

## Explicitly NOT for

- **Public internet hosting** — no TLS, no rate limiting on the WS port beyond login lockout,
  no protection against unauthenticated port scanning.
- **Open or shared Wi-Fi** — raw PINs and all sync traffic are readable on the LAN.
- **Enterprise identity** — no SSO, no LDAP/AD, no MFA, no federated identity.
- **High-risk PII or regulated data** — Shoresh is a scheduling tool for camp staff; it is
  not designed to hold medical records, financial data, or any data subject to compliance
  frameworks (HIPAA, PCI, FERPA, etc.).
- **Multi-tenant hosting** — one SQLite file per device, one camp per file; no tenant
  isolation beyond that.

---

## How to report a security issue

Open a GitHub issue at **https://github.com/gfeitel1-maker/Scheduling-Project-**

Please include a description of the issue and, if applicable, steps to reproduce. For
sensitive findings (e.g. token forgery, remote code execution), describe the class of issue
in the issue title and request a private channel before sharing full details.
