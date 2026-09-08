# Shoresh — Security Model

_Last updated: 2026-07-26_

---

## Deployment boundary

Shoresh is designed for a **trusted private LAN** — a small, known group of collaborators
(camp directors, scheduling staff) on a network they control: a camp office router, a direct
switch, or equivalent. It is not hardened for the public internet.

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

---

## Known limitations

### No TLS on the sync connection

The WebSocket sync protocol uses `ws://`, not `wss://`. All sync traffic — including the raw
PIN sent in the `login` message when a Client logs in for the first time — is transmitted in
plaintext on the LAN. This is an explicit accepted tradeoff under the trusted-LAN threat
model, not a bug. If your LAN is shared with untrusted devices, this is a meaningful
exposure.

**Do not port-forward the Host's WebSocket port to the internet.**

### Raw PIN sent over the network for initial login

A Client verifies its PIN against the Host by sending it in plaintext in the `login` WebSocket
message. The Host runs `scryptSync` on the received PIN. This is necessary for the lockout
mechanism to work correctly and so the Host can issue the token. Under a trusted-LAN model
this is accepted; it is a risk on a shared or monitored network.

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
