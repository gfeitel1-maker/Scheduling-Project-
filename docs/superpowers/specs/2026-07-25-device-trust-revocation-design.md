# §5/§6.3 Device trust, pairing, and revocation — design

## Problem

`devices` rows are auto-created the moment any device completes a WS
`authenticate` (`electron/sync/syncServer.js`'s `handleAuthenticate`,
`INSERT OR IGNORE INTO devices`), with no approval step and no way to revoke
one. Combined with the shared per-camp HMAC signing secret
(`camps.signing_secret`, docs/superpowers/specs/2026-07-20-shared-camp-signing-secret-design.md),
any device that ever completes a PIN login is permanently, universally
trusted, and — because every device holds the same signing secret — a
compromised device can mint a session token for *any* user, not just itself.
Raw PINs also travel over the unauthenticated `login` WS message with no
gate on which devices may even attempt that exchange. Full design rationale
for the crypto direction: `docs/adr/2026-07-25-device-trust-revocation.md`.

## Design overview

Two trust axes, kept explicitly separate per the source doc's framing: PIN
login answers *who* is using an approved device; pairing answers *whether
this device belongs in the collaboration group at all*. A device must clear
the second before it can attempt the first.

```
fresh device --(mDNS discover)--> Host
fresh device --(pairing_request: device_id, device_name)--> Host   [unauth'd]
                                                    Host renderer: pending list
admin on Host approves device X
Host --(pairing_approved: device_secret_identifier)--> device X
device X stores device_secret_identifier locally
device X --(login: device_id, device_secret_identifier, name, pin)--> Host
Host: device_id authorized? secret matches? -> THEN attemptLogin (existing)
Host --(login_ok: token)--> device X            [token signed w/ Host Ed25519 key]
```

### Schema (sub-task 1)

`devices` (schema v20+):
```sql
ALTER TABLE devices ADD COLUMN authorized_at TEXT
ALTER TABLE devices ADD COLUMN authorized_by_user_id TEXT
ALTER TABLE devices ADD COLUMN revoked_at TEXT
ALTER TABLE devices ADD COLUMN revoked_by_user_id TEXT
ALTER TABLE devices ADD COLUMN revocation_reason TEXT
ALTER TABLE devices ADD COLUMN device_secret_identifier TEXT
ALTER TABLE devices ADD COLUMN pairing_status TEXT
  -- 'pending' | 'authorized' | 'denied' | 'revoked', default 'pending'
  -- for a freshly-inserted row (see handleAuthenticate change below)
```
Same `PRAGMA table_info` existence-guard + `ALTER TABLE` pattern as every
prior migration in `electron/db/localDb.js`. Plaintext `device_secret_identifier`
storage follows the existing precedent of `camps.signing_secret` (also
plaintext) — protected by the same disk/OS assumption, not by app-level
hashing (unlike PINs: the Host must hold the raw secret to compute/verify an
HMAC with it, hashing it would make verification impossible, same reasoning
`camps.signing_secret` already accepted).

New Host-only table, **never included in any full-sync SELECT and never sent
over the wire**:
```sql
CREATE TABLE IF NOT EXISTS host_signing_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton, one row
  public_key TEXT NOT NULL,               -- hex, synced via camps.signing_public_key
  private_key TEXT NOT NULL,              -- hex, Host-local only
  created_at TEXT NOT NULL
)
```
Generated once, at `bootstrapCamp()`, only on the device that becomes Host
(`crypto.generateKeyPairSync('ed25519')`). `camps.signing_secret` (HMAC,
schema v9) is replaced by `camps.signing_public_key` — same distribution
mechanism (full_sync's `camps` SELECT), different content. Existing tokens
issued under the old HMAC scheme stop verifying post-migration; acceptable
per the prior ADR's own note that this app predates production data.

### Token shape (sub-task 1 schema, sub-task 3 issuance/renewal)

Two token *types*, distinguished by a `type` field inside the signed payload
— not by a separate wire field, so a tampered/re-typed payload still fails
signature verification rather than merely misrouting:

```js
// type: 'camp' — network-trusted, Host-minted only
{ type: 'camp', userId, deviceId, campId, iat, exp, jti }
// signed with the Host's Ed25519 private key; verified by any device via
// camps.signing_public_key

// type: 'local' — this-device-only, never accepted over WS
{ type: 'local', userId, deviceId, campId, iat, exp, jti }
// signed via HMAC using THIS device's own device_secret_identifier;
// verifiable only by the same device, since only it (and the Host, who
// generated it at pairing) holds that secret
```
`verifySessionToken(db, token)` inspects the (still-untrusted, not-yet-verified)
`type` claim only to select which key material to attempt verification with,
then verifies the signature before trusting anything else in the payload —
same "validate before touching properties" pattern already used for the
existing `.` split in this function. `jti` (token id) is recorded on audit
events for traceability; this slice does not add a per-token revocation
list — device-level `revoked_at`, re-checked by `authorize()` on every call,
covers the acceptance criteria without needing token-level state (see
Non-goals).

`issueSessionToken` becomes `issueCampToken(db, userId, deviceId)` — throws
if this device has no `host_signing_key` row (i.e., isn't the Host) — plus a
new `issueLocalToken(db, userId, deviceId)` for offline logins on a
non-Host device. `electron/auth/localAuth.js`'s `attemptLogin` picks between
them: Host device (or Host process handling a remote WS login) → `issueCampToken`;
Client device doing its own local IPC login while offline → `issueLocalToken`.

### Revocation enforcement (sub-task 1)

`authorize()` (`electron/auth/authorize.js`) already isolates the device
lookup as a dedicated step with a comment naming this exact extension point.
Change:
```js
deviceRow = db.prepare(
  'SELECT id, authorized_at, revoked_at FROM devices WHERE id = ?'
).get(session.deviceId)
...
if (!deviceRow) return deny(db, action, userRow.role, 'device_not_found', ...)
if (!deviceRow.authorized_at) return deny(db, action, userRow.role, 'device_not_authorized', ...)
if (deviceRow.revoked_at) return deny(db, action, userRow.role, 'device_revoked', ...)
```
Every deny path already routes through `recordAuditEvent` (reusing
`electron/audit/auditLog.js`, no parallel logging mechanism) — revocation
denials get an audit trail for free. Because `authorize()` re-derives this
from the DB on every call (not from the token payload), a device revoked
mid-session is denied on its very next request — no per-token invalidation
list needed. `handleAuthenticate` (`syncServer.js`) gets the same check
before accepting a WS connection at all, so a revoked device's reconnect is
rejected at the socket level, not just at the first `authorize()`-gated
message.

`handleAuthenticate`'s current `INSERT OR IGNORE INTO devices (id, name)`
self-registration changes to insert with `pairing_status = 'pending'`
instead of implicitly-trusted — a device row existing is no longer
equivalent to a device being allowed to log in.

### Pairing protocol (sub-task 2)

New WS message types (`syncServer.js`/`syncClient.js`), validated with the
same `isNonEmptyString`/type-check-before-property-access pattern as every
existing handler:

- `pairing_request` (Client→Host, unauthenticated): `{device_id, device_name}`.
  Upserts the `devices` row as `pairing_status = 'pending'`, and — if the
  Host renderer has a live window — pushes a `pairing:new-request` event
  (same push-event convention as `onOpApplied`) so the pending-approval UI
  updates live. The Host keeps the requesting `ws` connection open and keyed
  by `device_id` so the eventual `pairing_approved`/`pairing_denied` reply can
  be pushed directly down it without the Client needing to poll — Client
  falls back to a bounded retry of `pairing_request` (sub-task 3's
  "waiting for approval" UX) if that connection drops before an admin acts.
- `pairing_approved` (Host→Client): `{device_secret_identifier}`. Sent once,
  immediately after an admin approves. Client persists it locally
  (mirrors how `device_identity` already persists this device's own ID).
- `pairing_denied` (Host→Client): `{reason}`.

New IPC surface for the Host-side approval UI (Designer's screen, not
designed here):
- `listPendingPairingRequests()` → devices where `pairing_status = 'pending'`.
- `approveDevice(deviceId)` → admin-only (`authorize` action `devices.approve`,
  new entry in `permissions.js`'s admin `'*'` set, staff excluded); generates
  `device_secret_identifier`, sets `authorized_at`/`authorized_by_user_id`,
  `pairing_status = 'authorized'`, sends `pairing_approved` if the pending
  connection is still open, records an audit event (`action: 'devices.approve'`).
- `denyDevice(deviceId, reason)` → same shape, `pairing_status = 'denied'`.
- `listDevices()` → all devices with pairing/revocation status, for the
  admin device-management screen.
- `revokeDevice(deviceId, reason)` → admin-only, sets `revoked_at`/
  `revoked_by_user_id`/`revocation_reason`, audit-logged
  (`action: 'devices.revoke'`). Does not touch that device's already-queued
  local operations — they remain on that device, unsynced, until an admin
  reverses the revocation (no silent auto-accept on reconnect, per
  acceptance criteria).

### Bounded PIN gate (sub-task 4, tied to sub-task 2's schema)

`validateLoginMsg`/`handleLogin` in `syncServer.js` gain a check *before*
`attemptLogin` is ever called:
```js
const device = db.prepare(
  'SELECT authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?'
).get(msg.device_id)
if (!device || !device.authorized_at || device.revoked_at) {
  // deny, audit-log 'device_not_authorized', do NOT touch login_attempts
  return
}
if (device.device_secret_identifier !== msg.device_secret_identifier) {
  // deny, audit-log 'device_secret_mismatch'
  return
}
```
This closes the "any device on the LAN can attempt PIN guesses" exposure:
an unpaired device has no valid `device_secret_identifier` and is rejected
before the PIN (or the per-name lockout counter) is ever touched. Raw PIN
and raw `device_secret_identifier` still travel unencrypted — accepted per
the ADR, consistent with this project's already-established LAN threat
model; TLS remains explicitly out of scope.

### Client-side UX (sub-task 3, lighter detail — Designer owns the screen)

- New `phase` in `useDeviceMode.js`'s state machine (or a sub-state of
  `join`): `pairing-pending`, entered after sending `pairing_request` and
  exited on receiving `pairing_approved`/`pairing_denied`, or falling back to
  bounded retry on disconnect.
- Token renewal: while a device holds a valid, non-expired `camp` token and
  remains authorized, it periodically (e.g. on each reconnect, and on a timer
  before expiry) sends a `renew_token` WS message; Host re-checks
  device/user status exactly like a fresh login and mints a fresh token with
  a new `iat`/`exp`/`jti` — never extends an already-expired token, never
  renews a revoked device's token (same `authorize()`-style re-derivation,
  not a payload extension).
- Suggested token lifetime: short enough to bound a stolen-token window,
  long enough not to nag a connected device — a concrete number (e.g. 24h)
  is a product/operational call for Governor, not fixed here.

## Reused vs. new

- **Reused:** `authorize()`'s device-lookup extension point (built for
  exactly this), `auditLog.js` (`recordAuditEvent`/no parallel logging
  mechanism), the full-sync distribution path (now carries
  `signing_public_key` instead of `signing_secret`), the existing
  malformed-input-rejects-before-touching-properties pattern in
  `syncServer.js`/`syncClient.js`, the existing versioned-migration pattern
  in `electron/db/localDb.js`, `device_secret_identifier` doing double duty
  as both the pairing bearer secret and the local-token HMAC key (no third
  key type invented).
- **New:** `pairing_status`/authorization/revocation columns on `devices`,
  the Host-only `host_signing_key` table and Ed25519 keypair, the `camp`/
  `local` token-type split and `issueCampToken`/`issueLocalToken` functions,
  the `pairing_request`/`pairing_approved`/`pairing_denied`/`renew_token` WS
  messages, the `devices.approve`/`devices.revoke` IPC surface and
  permission actions.

## Non-goals (this slice)

- No per-token revocation list — device-level `revoked_at`, re-checked on
  every `authorize()` call, satisfies the acceptance criteria without it.
  Flagged as a possible future addition if a narrower "kill just this one
  session, not the whole device" need ever arises.
- No TLS. Pairing narrows *who* can attempt the PIN/device-secret exchange;
  it does not encrypt it. Explicitly deferred per the ADR.
- No migration tooling for existing pre-pairing camps — this app has not
  shipped production camp data (same reasoning the shared-secret ADR used).
- No UI implementation — this doc specifies the IPC/WS surface the pairing-
  approval screen (Host) and waiting-for-approval state (Client) need;
  Designer owns the screens themselves.

## Sub-task breakdown (implementation order)

1. **Schema + revocation enforcement.** `devices` columns, `host_signing_key`
   table, `camps.signing_public_key`, `authorize()`'s revocation check,
   `handleAuthenticate`'s reject-at-socket-level check, `permissions.js`
   entries for `devices.approve`/`devices.revoke`. No pairing UI yet — a
   device can be manually authorized (e.g. via a temporary IPC call or direct
   DB row for testing) so this slice is independently verifiable before the
   pairing protocol exists.
2. **Pairing protocol + Host approval IPC surface.** `pairing_request`/
   `pairing_approved`/`pairing_denied`, `listPendingPairingRequests`/
   `approveDevice`/`denyDevice`/`listDevices`/`revokeDevice`, plus the
   Host-side approval screen (Designer).
3. **Client waiting-for-approval UX + token lifetime/renewal.**
   `pairing-pending` phase, `issueCampToken`/`issueLocalToken` split,
   `renew_token` message and expiry handling.
4. **PIN-transmission hardening.** The `handleLogin` pre-check against
   `authorized_at`/`revoked_at`/`device_secret_identifier`, tied to
   sub-task 1's schema and sub-task 2's `device_secret_identifier`
   distribution — cannot land before either.
