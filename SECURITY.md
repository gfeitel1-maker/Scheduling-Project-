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
`deriveBulkReplaceAction`) are used identically on both the IPC and WebSocket paths, so
there is no way to bypass IPC-level restrictions by connecting directly to the WebSocket.

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

### Pre-revocation offline writes queue locally

If a revoked Client reconnects, its pending offline write queue is submitted to the Host and
rejected via `authorize()`. The queued writes are not automatically discarded on the Client.

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
