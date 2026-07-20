# Fresh-client first-login design

## Problem

A live two-device smoke test (Host + Client, each a real Electron process with its own SQLite file) found that a genuinely fresh Client device can never join a camp.

`login({name, pin})` (in `electron/main.js`) only creates the `syncClient` connection *after* a successful **local** PIN check against the Client's own `users` table. But a fresh Client has no local `users`/`camps` rows at all — so the local check always fails, `login()` returns `null`, and `syncClient` is never created.

The Host's `handleAuthenticate` (in `electron/sync/syncServer.js`) requires a valid session token to accept a WebSocket connection, and that token is only ever issued by a successful `login()`. The full-sync mechanism (`sendFullSyncIfFirstPairing`, built in Sync-Task 4) is supposed to populate the Client's first `users`/`camps` data — but it only fires *after* authentication succeeds.

This is a hard circular dependency: there is no path for a brand-new device to obtain its first session token. Verified directly: calling `login()` on a fresh Client instance with the Host's real, valid admin credentials returns `null`. The original design spec (`2026-07-19-users-camps-sync-design.md`) has this same gap baked in — "Client connects → sends `authenticate` → Host verifies token" assumes the token already exists — which is why it slipped through 13 review rounds: nothing exercised a truly zero-state device.

## Solution

Add a second, unauthenticated way for a Client to obtain its first session token: send its login attempt (name + PIN) directly to the Host over the WebSocket connection, and have the Host verify it using the exact same PIN-check-and-lockout logic it already uses for local login.

### Shared verification logic

Extract the login-verification logic currently inline inside `main.js`'s `login()` closure (PIN check via `verifyPin`, lockout tracking via `attemptsRow`/`saveAttempts`/`clearAttempts` and the `LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCKOUT_MS` constants, token issuance via `issueSessionToken`) into a single shared function:

```js
// electron/auth/localAuth.js
export function attemptLogin(db, { name, pin, deviceId }) { ... }
```

Return shape matches what `login()` already returns today:
- `{ token, userId, role }` on success
- `{ locked: true, retryAfterMs }` if locked out
- `null` on bad credentials

Both call sites use this one function, so lockout/verification behavior can never drift between the two paths:

1. **`main.js`'s existing IPC `login` handler** — used for the Host's own login, and for a Client's offline fallback (see below). Becomes a thin wrapper calling `attemptLogin(db, { name, pin, deviceId })`.
2. **A new unauthenticated WebSocket message type** in `syncServer.js`, handled alongside `authenticate` (i.e., before the `ws.deviceId` gate, since the connection isn't authenticated yet):
   - Client → Host: `{ type: 'login', device_id, name, pin }`
   - Host → Client on success: `{ type: 'login_ok', token, userId, role }`
   - Host → Client on failure: `{ type: 'login_failed', locked, retryAfterMs }` (fields present only when locked out; otherwise just a generic failure)

   The Host calls `attemptLogin(db, { name, pin, deviceId: msg.device_id })` — note the token is issued for the *requesting Client's* `device_id`, not the Host's own. Every device already has a locally-generated, persisted `device_id` from Task 1's `getOrCreateDeviceId`, independent of any camp/login state, so this is available even on a totally fresh install with an empty database.

### Client-side flow

Today, `chooseMode({mode:'client', host, port})` only stores `pendingServerUrl`; the actual `syncClient`/WebSocket connection is created lazily inside `login()`'s success branch. This changes:

1. **`chooseMode`** for client mode now opens the WebSocket connection immediately (unauthenticated) instead of deferring it.
2. **`login({name, pin})`** for client mode:
   - If the connection is live: send `{ type: 'login', device_id, name, pin }` and await `login_ok` / `login_failed`. On `login_ok`, immediately follow with the existing `authenticate` message using the returned token — this triggers the existing `handleAuthenticate` → self-register device row → `sendFullSyncIfFirstPairing` → `sendMissedOps` path, entirely unchanged. On `login_failed` (with `locked`), surface the same `{ locked, retryAfterMs }` shape the renderer already knows how to display.
   - If the connection is **not** live (offline): fall back to `attemptLogin` against the local `users` table — this only succeeds for a *returning* device that has synced before and has local data. A genuinely fresh device that's offline gets a distinct, clear error ("Connect to the camp network to sign in for the first time") rather than the generic invalid-credentials message, so it's not confused with a wrong PIN.
3. This remote-verify path is used for **every** login while the connection is live, not only the very first one. There is one code path for "first ever login" and "routine online login" — no separate "is this actually the first login" branch to maintain — and a PIN change on the Host takes effect for Client logins immediately rather than waiting for the next full-sync-style replication. Only an offline Client falls back to its (possibly stale) local copy.

### Host-side behavior for the new message

Handled in `syncServer.js`'s existing `ws.on('message', ...)` dispatch, in the same unauthenticated branch as `authenticate`:

- Validate `msg.device_id`, `msg.name`, `msg.pin` are non-empty strings (mirroring the existing `validateAcquireLockMsg`/`validateSubmitOpMsg` pattern) before calling `attemptLogin`.
- Malformed messages are silently ignored (matches existing behavior for malformed `authenticate`/`acquire_lock`/`submit_op` messages — no new error-message shape needed for the "not even shaped right" case).
- No change to the connection's `ws.deviceId`/`ws.userId` — those are only set by a subsequent, successful `authenticate` message, exactly as today.

## Security tradeoff (explicitly accepted, not silently introduced)

This requires sending the **raw PIN** (not a hash) from Client to Host over the LAN WebSocket connection, so the Host can run its own `scryptSync` comparison. This is different from all other traffic today, which only ever carries opaque `pin_hash`/`pin_salt` values as part of user-creation operations — never a raw PIN.

This is consistent with the project's existing threat model: all sync traffic already flows over plain `ws://` on a trusted LAN, and this app has no TLS/certificate story anywhere (Host and Client discover each other via mDNS and connect directly). But it is a real, meaningfully different exposure — a LAN sniffer could previously see only a salted hash; it can now see a device's raw PIN attempt during login.

**Decision:** accept this as consistent with the existing "trusted camp LAN" threat model rather than introduce TLS here, which is a much larger scope than this fix. Not revisited as part of this change; flagged here for future hardening if the threat model ever changes (e.g., camps on shared/public WiFi rather than a private network).

## Testing plan

1. **Unit tests for `attemptLogin`** (extracted from `login()`): PIN match/mismatch, lockout after `LOGIN_MAX_ATTEMPTS`, lockout expiry, unlock-on-success clearing attempt count — these are a mechanical relocation of `login()`'s existing test coverage, should require minimal new assertions beyond confirming the extraction didn't change behavior.
2. **Integration tests for the new WebSocket message** (using this project's existing real-`ws`-server test pattern, e.g. as used in `syncServer.test.js`/`syncClient.test.js`): a client sends `login` with valid credentials and receives `login_ok` with a token that then successfully authenticates; invalid PIN receives `login_failed`; repeated invalid attempts trigger `login_failed` with `locked: true` and the same lockout window as local login; malformed `login` messages are ignored, not crashing the connection (consistent with existing malformed-message handling elsewhere in this file).
3. **The end-to-end regression test that would have caught the original bug**: a fresh `syncClient`/db (no local `users`/`camps` rows at all) connects to a real `syncServer`, sends `login` with the Host's real admin credentials, and the test asserts: (a) a token is received, (b) the subsequent `authenticate` succeeds, (c) `full_sync` fires and the Client's local `users`/`camps` tables are populated, (d) a normal op-log write from the Client succeeds afterward. This exact scenario — genuinely zero local state — was never exercised by any existing test in the 13-round sync sub-plan, which is why it slipped through; this test closes that specific gap.
4. **Offline-fresh-device edge case**: a fresh Client (no local data) with no live connection calls `login()` — assert it returns a distinct "connect to the network" error, not the generic invalid-credentials response.
