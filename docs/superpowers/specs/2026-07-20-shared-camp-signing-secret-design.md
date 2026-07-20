# Shared per-camp session-token signing secret

## Problem

A live two-Electron-process re-verification (Host + a genuinely fresh Client) of the fresh-client-first-login fix found a critical, previously-undetected bug: a token issued to a Client via the new `loginRemote` flow cannot be used for anything on that Client.

Root cause: `electron/auth/localAuth.js` generates its HMAC-SHA256 signing secret once per process, at module load time:

```js
const sessionSecret = randomBytes(32)
```

`issueSessionToken`/`verifySessionToken` both close over this module-level constant. Every Electron process (Host, and each Client) gets its own independent random secret. When a Client obtains a token from the Host over the wire (via the `login`/`login_ok` WebSocket exchange built in the fresh-client-first-login plan), that token is HMAC-signed with the *Host's* secret — but every subsequent local IPC call on the Client (`write`, `verifySession`, `createUser`) verifies tokens using the *Client's own*, separately-generated secret. The signatures can never match.

Confirmed live: a fresh Client that successfully logs in via `loginRemote` (receives a real, well-formed token) immediately gets `verifySession({token}) → {valid: false}` and `write(...) → "invalid session"` from its own local IPC handlers, using the exact token it just received.

This was undetected across the entire fresh-client-first-login plan (5 tasks, multiple review rounds) because every automated test either mocked `syncClient` entirely (`main.test.js`) or exercised the wire protocol within a single test process (`syncServer.test.js`/`syncClient.test.js`), never routing a Host-issued token through a *second, separate process's* independent `verifySessionToken` call. Only a real two-Electron-instance test surfaces it.

## Solution

Make the signing secret a persistent, per-camp value shared by every device in that camp, instead of an ephemeral per-process random value.

### Storage

Add a `signing_secret` column to the `camps` table (schema v9, following the project's established versioned-migration pattern — `schema_migrations` table, `PRAGMA table_info()` existence guard before `ALTER TABLE`):

```sql
ALTER TABLE camps ADD COLUMN signing_secret TEXT
```

Stored as a hex-encoded string, generated via `randomBytes(32).toString('hex')` — same encoding convention already used for `users.pin_salt` elsewhere in this codebase.

### Generation

`bootstrapCamp()` (in `electron/main.js`) generates the secret once, at camp creation, and includes it in the `INSERT INTO camps` statement — this is the only place a camp is ever created in this app, so there's exactly one generation point.

### Lookup, not closure capture

`issueSessionToken`/`verifySessionToken` change signature from `(userId, deviceId)` / `(token)` to `(db, userId, deviceId)` / `(db, token)`. Each call looks up the current camp's `signing_secret` via `db.prepare('SELECT signing_secret FROM camps LIMIT 1').get()` — mirroring the existing single-camp-per-db assumption already used elsewhere (e.g. `login()`'s `SELECT id FROM camps LIMIT 1`). The module-level `const sessionSecret = randomBytes(32)` is removed entirely. Every call site that currently calls these two functions (`attemptLogin`, `main.js`'s `write`/`verifySession`/`bootstrapCamp`/`createUserHandler`, `syncServer.js`'s `handleAuthenticate`) already has `db` in scope, so this is a mechanical signature change, not a new dependency.

### Distribution to Clients

The existing full-sync mechanism (built in the earlier users/camps sync sub-plan, fires once on a device's first successful pairing) already replicates `camps` rows to a Client — but its current query is an explicit column list, not `SELECT *`:

```js
// electron/sync/syncServer.js, current
const camps = db.prepare('SELECT id, name FROM camps').all()
```

This needs `signing_secret` added to the selected columns, and the Client's corresponding `applyFullSync` validation/insert (`electron/sync/syncClient.js`'s `isValidFullSyncCamp`/`INSERT OR REPLACE INTO camps`) needs to validate and carry the new column through. Once a Client has synced, it has the same secret as the Host and can issue/verify tokens fully locally and offline from then on — this preserves the app's local-first, offline-capable design; it does not require a Client to ask the Host to verify every token.

### Migration for existing rows

Since this app has not shipped (no real production camp data), a genuinely orphaned camp row without a `signing_secret` shouldn't occur in practice — but the migration itself should still handle it correctly for dev/test databases that already have camp rows: after adding the column, backfill any row where `signing_secret IS NULL` with a freshly generated value, in the same migration block.

## Security tradeoff (explicitly accepted, not silently introduced)

This makes the signing secret shared across every device in a camp, rather than independent per-device. Previously, a compromised device's forged tokens were only ever accepted by that same device's own process (since each had an unrelated random secret) — practically a non-issue, since the compromised device already trusts itself. With a shared secret, a compromised device can forge a session token that every *other* device in the camp will accept as valid, for any `userId`/`deviceId` pair.

This is a real, meaningfully different exposure. It is being accepted here, consistent with the project's already-established "trusted camp LAN" threat model (this is the same reasoning already applied to raw PINs traveling over the LAN via `loginRemote`, and to all sync traffic running over plain `ws://` with no TLS) — the alternative (Clients unable to verify tokens locally at all) breaks the app's core local-first/offline design goal. Not revisited as part of this fix; flagged here for future hardening if the threat model ever changes (e.g., camps sharing a network with untrusted devices).

## Testing plan

1. **Unit tests for `issueSessionToken`/`verifySessionToken`'s new `(db, ...)` signatures** in `localAuth.test.js`: a token issued against one camp's `signing_secret` verifies correctly against that same db; a token issued for one camp does NOT verify against a different db with a different camp/secret (proves the lookup, not a leftover module-level constant, drives verification).
2. **Update every existing call site's tests** wherever tokens are issued/verified — `main.test.js`, `syncServer.test.js`, `syncClient.test.js` — for the new signatures. This should be mechanical (add a `db`/`hostDb` argument) since none of these call sites need new logic, just the new parameter.
3. **Full-sync carries the secret**: extend the existing full-sync test coverage to assert a Client's local `camps` row has a non-null `signing_secret` matching the Host's after full-sync completes.
4. **The exact regression this fix targets**: extend (or add alongside) the fresh-client-first-login plan's Task 5 end-to-end test — after a fresh Client's `loginRemote` succeeds and full-sync completes, call that Client's own local `verifySessionToken(db, token)` directly (or via the `write`/`verifySession` IPC path) and assert it succeeds. This is the exact case that was broken and undetected until live two-process testing; this test closes that gap permanently.
5. **Live re-verification**: after implementation, re-run the same live two-Electron-instance check that found this bug (Host bootstraps a camp, a genuinely fresh Client logs in via `loginRemote`, then successfully calls `write()` using the token it received) to confirm the fix holds in the real app, not just the test suite.
