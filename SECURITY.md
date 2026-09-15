# Shoresh — Security Model

_Last updated: 2026-09-14_

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

**This boundary is an assumption with an expiry, not a permanent fact.** The current transport is
loopback + mDNS-discovered LAN peers only (verified: no relay, DHT, or non-loopback listen). Any
move to an internet-reachable transport dissolves the assumptions the rest of this document rests
on and requires a full re-assessment first — enforced by
[docs/adr/2026-09-14-internet-transport-security-gate.md](docs/adr/2026-09-14-internet-transport-security-gate.md)
and its build-failing guard.

---

## What is hardened

### Device pairing gate

Every new device must be explicitly approved by an admin before it can sync or authenticate.
A Client sends a `pairing_request` WebSocket message; it sits in `pairing_pending` phase
until an admin approves or denies it in the Device Manager screen. Approved devices receive
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

Token lifetime is 24 hours. The Host re-checks revocation status before issuing a renewal
(`renew_token` WS message).

### Host-signed user credentials (`auth_sig`)

User credential fields — `role`, `pin_hash`, `pin_salt` — replicate to every approved device like
any other data, so they cannot be protected by a check on the write path alone: they arrive by
**merge**, which is not `authorize()`-gated (see "Role enforcement is device-side under CRDT sync"
below). They are protected cryptographically instead.

Each `users` row carries `auth_sig` (`electron/auth/authSignature.js`): an Ed25519 signature, made
with the same Host-only private key that mints camp tokens, over
`{id, role, pin_hash, pin_salt, cred_version}`. `cred_version` is a monotonic per-user counter
(`createUser` = 1, `promoteToAdmin` = previous + 1). Only two call sites mint a signature —
`createUser` and `electron/ops/promoteToAdmin.js` — and the generic `write()` path refuses
`users.role`/`pin_hash`/`pin_salt` outright, which makes that a closed set.

On the merge path, `projector.js`'s `upsertUsersEntity` applies a credential **change** only if:

1. the signature verifies against `camps.signing_public_key`, **and**
2. its `cred_version` is not older than the local row's — which is what defeats a **replay** of a
   genuinely-signed older tuple (an attacker re-sending a previous signed state to demote an admin
   or roll a PIN back to one they know).

Unchanged values always apply, so this never blocks ordinary sync. A device that holds no verifying
key — a rebuilt or restored device before `camps` has projected — **skips** an unverifiable
credential change rather than accepting it, so a forgery can never be applied during that window;
a legitimate value still lands once the key is present (`camps` projects before `users`).

**What this closes.** A compromised *paired* device cannot forge a role, escalate itself to admin,
overwrite the director's PIN camp-wide, or replay an old credential state. Independent
`security-assessment` and `red-hat` review confirmed the primary escalation and overwrite attack
closed; the two MEDIUM residuals that review found (replay, and permanence of a forgery accepted
during the key-less window) are also fixed. Schema **v61** — read `CURRENT_SCHEMA_VERSION` in
`electron/db/localDb.js` rather than trusting this number. Background:
`docs/work/security/2026-09-14-Q1-crdt-merge-blast-radius-assessment.md` and
`docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md`.

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

### A camp token is a bearer credential (T155)

`evaluateAuthenticate` binds a token to the `device_id` carried **inside** the token. Nothing binds
it to the libp2p peer id presenting it, so a valid token replayed from a different machine is
admitted. Measured, not assumed: `electron/sync/automerge/syncNodeAuthGate.test.js` pins both this
and its counterweight — revocation is re-checked on every authenticate, so a replayed token stops
working the moment the device it names is revoked.

`devices.libp2p_peer_id` cannot close this as it stands: libp2p generates a fresh peer id on every
process start, which is exactly why that column is documented as a routing convenience and never a
trust signal. Binding a token to a peer would reject every ordinary reconnect. Closing it properly
means persisting a libp2p identity per device and binding tokens to it — a design decision with its
own key-management consequences.

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

**Credentials specifically are NOT left to this.** The general tradeoff above is about ordinary
domain writes. The one class where a device-side-only check would have been camp-wide privilege
escalation — a peer forging `role`/`pin_hash`/`pin_salt` through a merge — is closed
cryptographically by Host-signed credentials; see "Host-signed user credentials (`auth_sig`)" above.
Read this section as scoped to domain data, not to accounts.

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
