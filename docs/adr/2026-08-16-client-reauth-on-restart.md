---
title: "ADR: A returning Client must hand its verified token to syncClient and re-authenticate on startup, without silently trusting an unauthenticated socket"
document_type: adr
status: accepted
authority: normative
implementation_state: in-progress
date: 2026-08-16
deciders: [product-owner]
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: []
related_tickets: [docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md, docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md]
related_adrs: [docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md, docs/adr/2026-07-25-device-trust-revocation.md]
supersedes: []
affects: []
---

# ADR: A returning Client must hand its verified token to syncClient and re-authenticate on startup, without silently trusting an unauthenticated socket

**Status: ACCEPTED (2026-08-16) — premise confirmed against real code; owner chose Option A (silent
auto-reauth) on 2026-08-16; design below is Option A. Parts 3 (rejected-token clearing) and 4 (status
signal) are required regardless and were owner-implied by choosing A.** Fixes T87
(`docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md`), the reachability
companion to T85's op-log fix, surfaced by Red Hat during the T85 panel, 2026-08-16.

## Context

**The defect is real, confirmed end-to-end from source, not just plausible.** Trace of the exact call
chain on a fresh Electron process start for a previously-paired Client with a still-valid stored token:

1. `src/hooks/useDeviceMode.js`'s `init()` effect calls `localClient.chooseMode({ mode: 'client', host,
   port })` (line 55) **before** it ever reads the stored token (line 65) — the token read and the
   `chooseMode` call are already sequenced in the wrong order for a handoff to be possible without
   restructuring.
2. `electron/main.js`'s `chooseMode` client branch (lines 463–476) builds `createSyncClient(db, {
   device_id, author_user_id, serverUrl, device_name })` — no `token` field, even though
   `createSyncClient`'s own signature (`electron/sync/syncClient.js:121–136`) already accepts one
   (`token: initialToken`).
3. `connect()`'s `ws.on('open')` handler (`syncClient.js:570–586`) branches on the closure-local `token`
   variable: `if (token) { send authenticate }`, `else if (device_name) { send pairing_request }`. Since
   `token` is `undefined` at this call site, every startup reconnect for an already-paired device sends
   `pairing_request`, never `authenticate`.
4. The Host's `pairing_approved` reply (idempotent for an already-authorized device,
   `syncServer.js`/`main.js`'s `onPairingApproved`) carries no session token and triggers no
   `authenticate` send on the Client — `wirePairingCallbacks()` (`main.js:230–249`) only forwards a
   renderer notification.
5. `verifySession` (`main.js:725–731`) is confirmed to be a pure local check — `verifySessionToken(db,
   token)` plus a `users` lookup — it never references `syncClient` at all. Its result only ever writes
   to `useDeviceMode.js`'s React state (`role`), never to the socket.
6. `useDeviceMode.js`'s `phase` computation (line 194) falls through to `'session'` whenever `token` (React
   state, seeded synchronously from `localStorage` at mount, line 26) is truthy — independent of whether
   `verifySession` has even resolved yet, and entirely independent of `ws.deviceId`. The Login screen,
   whose `login()` → `syncClient.loginRemote()` (`main.js:516`, `syncClient.js:1449–1466`) is the **only**
   other code path that ever sends `authenticate`, is never rendered for this device.

**Net effect, confirmed:** `ws.deviceId` is never set on this connection. `broadcastOps` and
`sendMissedOps` (both gated on `ws.deviceId`, per the T85 ADR) never fire for it. The app shell renders
normally, the sidebar's `client-connected` badge (`src/components/layout/sidebarState.js:120`, currently
keyed only on transport `connected`, not authentication) reads "linked" in success-green. The device is
fully live-looking and fully silent, until the stored token's 24h expiry finally forces a real
`verifySession` failure and a real login. This reproduces on every ordinary app relaunch or tablet reboot
for a Client that logged in more than zero seconds ago and less than 24h ago — the common case, not an
edge case.

**Why the integration suite didn't catch it:** `test/integration/harness.js`'s `Client.reconnect()`
(lines 292–304, 382–385) constructs its `syncClient` with `token: this.token || undefined`, where
`this.token` is an in-memory JS field on the harness object that trivially survives a `reconnect()` call
within the same test process. The harness proves `syncClient` itself does the right thing when handed a
token; it has never exercised `electron/main.js`'s actual `chooseMode`, which is the thing that fails to
hand one over.

## Divergent exploration

Per this project's `adhd` protocol, five isolated cognitive frames (regulator, competitor/attacker,
3am-on-call, inversion, ant-colony) independently generated candidate mechanisms for "how does a
returning Client re-authenticate" and "how is 'connected but not authenticated' ever surfaced." The
material convergences, and the one gap none of the frames' obvious answers closed, are summarized here.

**Strong independent convergence (3 of 5 frames):** hand the token to the transport layer itself rather
than keeping it login-flow-local, so connect-and-authenticate collapse into one atomic step instead of two
independently-triggerable ones. The inversion frame named this most directly ("move the token out of
login-flow-local state into a WS-client-owned session store that the socket layer reads from directly on
every connect/reconnect"); the ant-colony frame reached the same place from "connection and authentication
become one atomic local reflex, not two steps one of which was skipped"; the attacker frame reached it
while inverting "keep the token reachable only by the PIN-login code path — that's the actual current
failure." **This is what this ADR adopts** — and it requires zero new architecture, because
`createSyncClient`'s `token: initialToken` parameter and `connect()`'s `if (token) → authenticate` branch
**already implement exactly this mechanism**. The bug is that `chooseMode` never uses the entry point
that already exists, not that the entry point is missing.

**A real gap none of the frames' top answers closed on their own, but two independently flagged from
different angles — closing it is required, not optional, for this design to be safe:** what happens when
the Host authoritatively **rejects** the handed-off token (revoked device, tampered/garbage token,
mismatched `device_id` — `syncServer.js`'s `handleAuthenticate`, closing with 4401/4402/4403/4404)? The
regulator frame named it as an accountability gap ("a client that gets a 4403 rejection... can be walked
back into a false-authenticated UI state... if the fix doesn't make WS rejection authoritative over local
token validity"); the attacker frame named the identical mechanism as an exploit path (same quote,
independently). **Read literally, today's `connect()`/close-handler pair would reintroduce a
different-shaped silent failure under the naive version of this fix:** the closure `token` is never
cleared on any close code, so a rejected token gets silently re-sent forever on every auto-reconnect
(`syncClient.js:823–846`), each attempt optimistically flipping the client-local `authenticated` flag
`true` before the Host closes it again moments later. This is real, was not caught by casual reading, and
is exactly the class of thing two independent adversarial-shaped frames converging on the same finding is
meant to catch. **Decision: close-code-aware token clearing (Part 2, below) is a required part of this
fix, not a nice-to-have.**

**Considered and rejected: a positive `authenticate_ok` server ack, so the Client never has to guess.**
The inversion frame proposed "fail-closed: require positive ack ... rather than assuming success once the
frame is sent." Real and directionally correct, but **the server currently sends no ack for `authenticate`
at all** (`syncClient.js:303–310`'s own comment: "an accepted, documented tradeoff") — every successful
authentication today, including the normal post-login path, already relies on the client-optimistic
`authenticated = true` flag with no positive confirmation. Adding one is a genuinely new wire message,
which the ticket explicitly asks this fix to avoid inventing unless truly needed, and it is not needed:
the existing **negative** signal (a 4401–4404 close) already gives an authoritative answer whenever the
Host actually processes the frame and rejects it; the only case a positive ack would additionally close is
a Host that accepts silently *or hangs* mid-handshake — a pre-existing, already-documented, and
out-of-band-from-T87 gap (see Non-goals). **Rejected as disproportionate to this ticket**, flagged as a
possible future hardening.

**Considered and rejected: a generic bounded retry cap ("N failed attempts, then force visible
re-login"), applied to all reconnect failures.** The inversion frame proposed this as a general safety
valve. It is the wrong tool for the specific gap identified above: a Host that is merely offline (LAN
drop, Host machine asleep) is **already** visible today via `connected: false` / the existing "alone" sidebar
state — retrying that case indefinitely is a feature (LAN tolerance), not the bug. Capping retries
generically would degrade that working case for no benefit. The actual gap is narrower and better-targeted
by clearing the specific rejected token on the specific close codes that mean "this token is bad," not by
rate-limiting connection attempts in general. **Rejected as over-broad for what this defect needs** — the
`karpathy` bar for the smallest responsible fix.

**Considered and rejected (for this ticket): Host-side authentication-attempt observability (metrics/logs
of connections that never complete `authenticate`).** The 3am-on-call frame proposed instrumenting this
from the Host's side too. Real value, but it is Host-side observability infrastructure, independent of and
larger than the Client-side reachability bug this ticket exists to close. **Deferred, not rejected** — flagged
as a candidate follow-up ticket, not folded in here.

## Decision

**Part 0 — the product question this ADR cannot answer on its own (human-approval gate per the
constitution, Article IV: "a product-judgement question... what 'done' means to a director").** Two
options for what a returning, still-valid-token Client should do on startup:

- **Option A — silent auto-reauth (recommended).** The Client hands its locally-verified token straight
  to `syncClient` and authenticates without the user seeing anything, exactly mirroring what already
  happens for a still-connected socket across an ordinary mid-session network blip today. Consistent with
  the 24h token lifetime already being the trust boundary the rest of the system relies on (nothing about
  authenticate vs. re-authenticate changes *who* is trusted — the Host still re-verifies signature,
  expiry, authorization, and revocation on every `authenticate`, exactly as it already does).
- **Option B — explicit re-login on every restart.** `useDeviceMode.js` stops computing `phase='session'`
  from a bare local-token check for a Client and instead waits for the socket to report `authenticated`
  before leaving the Login screen. Materially more friction (every app relaunch/tablet reboot demands a
  PIN, even seconds after the last one), for a security property (never silently trust a stored token
  across a process boundary) that Option A does not actually weaken, since the Host is still the sole
  authority on whether the token is honored.

**Recommendation: Option A.** Confidence: high that it is the smaller, more correct change and does not
weaken any existing trust boundary (see Security, below); the only real cost is UX-invisible-by-design,
which is exactly what a director restarting a tablet mid-camp-day wants. This ADR's Decision below is
written for Option A; Part 3 sketches the smaller Option B diff for completeness, so Maker is not blocked
either way once the owner decides.

---

**Part 1 (Option A) — Reorder `useDeviceMode.js`'s startup effect so `verifySession` runs before
`chooseMode`, and thread its verified token into the client branch's `chooseMode` call.**

`src/hooks/useDeviceMode.js`, `init()` (lines 45–92): move the token-read-and-verify block (currently
lines 65–78, running *after* `chooseMode`) to run first, deriving a local `verifiedToken` from
`localClient.verifySession(storedToken)`'s result — same cleanup-on-invalid behavior as today (clear
`localStorage`, clear React `token`/`role` state). Then:

```js
} else if (mode === 'client' && joinHost) {
  await localClient.chooseMode({
    mode: 'client', host: joinHost.host, port: joinHost.port,
    token: verifiedToken || undefined,
  })
  ...
}
```

Only a **locally-verified** token is handed over — not the raw `localStorage` value — so a token this
device's own signature/expiry check already knows is dead is never even attempted on the wire. This is
defense-in-depth, not the sole gate: the Host re-verifies independently regardless (see Security).

**Part 2 (Option A) — `electron/main.js`'s `chooseMode` client branch passes `token` through to
`createSyncClient`.**

`electron/main.js`, lines 463–476: destructure `token` from `args` and add it to the existing
`createSyncClient(db, { device_id, author_user_id, serverUrl, device_name: deviceNameForPairing, token })`
call. **No other change needed here** — `connect()`'s existing `if (token) { authenticate } else if
(device_name) { pairing_request }` branch (`syncClient.js:570–586`) already does the right thing once
`token` is non-empty; token takes priority over `device_name` when both are present, which is correct (an
already-paired device with a valid token should authenticate, not re-request pairing).

**Part 3 — Close the reconnect-loop-with-a-dead-token gap identified in Divergent exploration. Required
regardless of which product option the owner picks**, since it is reachable the moment any code path ever
hands a token to `connect()` on a fresh process start — which both Option A and, for a mid-session drop,
today's already-shipped code do.

`electron/sync/syncClient.js`:

- `ws.on('close', () => {...})` (line 823) → capture the close code: `ws.on('close', (code) => {...})`.
- Immediately after the existing `authenticated = false; announceConnection()` (lines 824–826), add:
  ```js
  if (code === 4401 || code === 4402 || code === 4403 || code === 4404) {
    token = null
    for (const cb of authRejectedListeners) cb(code)
  }
  ```
  Clearing `token` means the *next* auto-reconnect (already scheduled unconditionally below, unchanged)
  takes the `else if (device_name)` branch and sends `pairing_request` instead of silently re-attempting
  `authenticate` with a token the Host has already, authoritatively, rejected. This reuses the exact
  already-idempotent `pairing_request` → `pairing_approved` path the Host already runs for a re-pairing
  already-authorized device (per the existing close-handler comment at line 838–840) — no new Host-side
  behavior required.
- New `authRejectedListeners` array (alongside `pairingDeniedListeners` etc., line 148) and a new
  `onAuthRejected(callback)` method on the returned object (alongside `onPairingDenied`, line 1470–1472),
  same shape, same convention.

`electron/main.js`:
- `wirePairingCallbacks()` (lines 230–249): add an `onAuthRejected` forward, mirroring `onPairingDenied`'s
  existing block exactly — `w.webContents.send('shoresh:auth-rejected', { code })`.

`electron/preload.js`: add `onAuthRejected: (cb) => ipcRenderer.on('shoresh:auth-rejected', (_e, payload)
=> cb(payload))`, mirroring `onPairingDenied`'s existing line exactly.

`src/hooks/useDeviceMode.js`: register a listener for `onAuthRejected` alongside the existing
`onPairingApproved`/`onPairingDenied`/`onTokenRenewed` block (lines 99–117). On receipt, run the **same**
cleanup already used when a local `verifySession` check fails (`localStorage.removeItem(TOKEN_KEY)`,
`removeItem(ROLE_KEY)`, `setToken(null)`, `setRole(null)`) — this forces `phase` back to `'login'`, the
"honest UI reflecting the not-yet-authenticated state" outcome the ticket requires regardless of which
Part-0 option is chosen. **This piece of the design is shared machinery, not Option-A-specific** — Option
B needs the identical reaction to a rejected token.

**Part 4 — the "never silent again" status signal.** `syncClient` already tracks and announces both
`connected` and `authenticated` together on every relevant transition (`announceConnection`'s existing
`cb({ connected, authenticated })` payload, line 288, already fires from `connect()`'s open handler, the
close handler, and — after Part 3 — the auth-rejection branch too). The gap is that nothing downstream of
`announceConnection` currently reads the `authenticated` half.

- `syncClient.js`: add `isAuthenticated()` to the returned object (line ~1220, mirroring `isConnected()`
  exactly: `isAuthenticated() { return authenticated }`).
- `electron/main.js`'s `getSyncStatus()` (lines 409–414): in the `mode === 'client'` branch, also read
  `syncClient.isAuthenticated()` and compute a third state:
  ```js
  const connected = ...
  const authed = typeof syncClient?.isAuthenticated === 'function' ? syncClient.isAuthenticated() : false
  const state = !connected ? 'client-disconnected' : (authed ? 'client-connected' : 'client-connecting')
  return { mode: 'client', connected, authenticated: authed, state }
  ```
  `wireSyncStatus()` needs no change — it already re-fetches `getSyncStatus()` fresh on every
  `onConnectionChange` firing, and Part 3's new `announceConnection()` call on auth-rejection already
  triggers that firing.
- `src/components/layout/sidebarState.js`: add one new `SYNC_STATUS_COPY` entry,
  `'client-connecting': { text: 'connecting', tone: 'secondary', title: 'Talking to the main computer —
  not yet confirmed.' }`, matching the existing three-entry convention exactly (lines 118–123). No other
  UI change — the existing `syncStatusLabel()` dispatch already handles an unrecognized/new key
  gracefully by falling back to `standalone`, so this is purely additive.
- **This redefines `'client-connected'`'s meaning from "transport open" to "transport open and
  authenticated"** — a deliberate, and more honest, tightening of what the existing green "linked" copy
  already claims to promise the director ("Connected to the main computer" implies you can actually talk
  to it). This is the concrete fix for the ticket's "never again silent" requirement: post this ADR, the
  gap this whole ticket exists to close (open-but-not-authenticated) has its own visible, distinct,
  camp-language sidebar state, for any future instance of this failure shape — including residual ones
  this ADR does not close (see Non-goals).

---

**Part 3 (Option B) sketch, for completeness — not adopted, included so Maker is unblocked either way.**
If the owner picks explicit re-login instead: skip Parts 1–2 above; instead, in `useDeviceMode.js`'s
`phase` computation (line 193–194), change `else if (!token) phase = 'login'` to also require
`syncStatus?.authenticated` (sourced the same way `useSetupCounts.js` already consumes
`onSyncStatusChanged`/`getSyncStatus`, `src/hooks/useSetupCounts.js:61–64`) for the `mode === 'client'`
case specifically — a Host has no such requirement, it never authenticates over its own loopback. Parts 3
and 4 above (the rejected-token clearing and the status signal) are required unchanged under this option
too.

## Files/modules affected

| File | Change |
|---|---|
| `src/hooks/useDeviceMode.js` | Reorder `init()`: verify token before `chooseMode`; pass verified token into the client branch's `chooseMode` call (Part 1, Option A only). New `onAuthRejected` listener registration, shared cleanup with the existing invalid-token path (Part 3, both options). Option B alternative: `phase` computation gains an `authenticated` condition instead (Part 3 sketch). |
| `electron/main.js` | `chooseMode` client branch: destructure and forward `token` into `createSyncClient` (Part 2, Option A only). `wirePairingCallbacks()`: forward `onAuthRejected` (Part 3). `getSyncStatus()`: read `isAuthenticated()`, add `authenticated` field and `'client-connecting'` state (Part 4). |
| `electron/sync/syncClient.js` | `ws.on('close', ...)`: capture close code, clear `token` and notify on 4401–4404 (Part 3). New `authRejectedListeners` array, `onAuthRejected` method, `isAuthenticated()` method (Parts 3–4). No change to `createSyncClient`'s signature — `token: initialToken` already exists. |
| `electron/preload.js` | New `onAuthRejected` IPC forward, mirrors `onPairingDenied` (Part 3). |
| `src/components/layout/sidebarState.js` | New `'client-connecting'` entry in `SYNC_STATUS_COPY` (Part 4). |
| `electron/db/schema.sql` | **No change.** |
| `test/integration/harness.js` | No change required to the file itself. A new test should exercise `electron/main.js`'s real `makeHandlers`/`chooseMode` path directly (see Test strategy) — not the harness `Client` class, whose `reconnect()` already does the correct thing this ADR is fixing in production. |

## Reused vs. new

**Reused, unchanged:** the `authenticate` WS message type and the Host's existing
`handleAuthenticate`/close-code semantics (4401–4404) — zero new protocol messages. `createSyncClient`'s
existing `token: initialToken` parameter and `connect()`'s existing `if (token) → authenticate` branch —
already correct, just never fed a value from this call site. The `pairing_request` → `pairing_approved`
idempotent-for-already-authorized-devices path (unchanged, just reused as the fallback once a rejected
token is cleared). The `onPairingDenied`/`pairingDeniedListeners` listener convention, copied exactly for
`onAuthRejected`. The `announceConnection`/`onConnectionChange`/`getSyncStatus`/`onSyncStatusChanged`
status-push pipeline (T27, already fully wired end-to-end) — extended with one new boolean and one new
state string, no new plumbing. The `SYNC_STATUS_COPY` dispatch pattern in `sidebarState.js` — one new
entry, same shape as the existing three.

**New:** one new WS-close-code branch inside `syncClient.js`'s existing close handler (not a new message).
One new listener array/method pair (`onAuthRejected`), matching an existing convention exactly. One new
accessor (`isAuthenticated()`), matching an existing convention (`isConnected()`) exactly. One new sidebar
copy entry. No new table, no new column, no new IPC channel beyond one new push event
(`shoresh:auth-rejected`) following the exact shape of the three that already exist
(`pairing-approved`/`pairing-denied`/`token-renewed`).

## Security

**Does handing a locally-verified token to `syncClient` at `chooseMode` time create a new trust
boundary?** No — verified, not assumed. The Host's `handleAuthenticate` (`syncServer.js:376–480`)
independently re-verifies signature, token type (`camp` vs `local` — a `local` token is already rejected
outright, 4402), expiry, `authorized_at`, and `revoked_at` on **every** `authenticate` message it ever
receives, regardless of when or how the Client came to send one. This design changes *when* the Client
sends `authenticate` (on startup, using a token from its own prior session, instead of only right after a
fresh PIN check) — it does not change what the Host accepts as proof. A revoked device is rejected exactly
as it is today; the difference is that this design plus Part 3 makes that rejection *visibly* end the
stale session (clears local storage, forces `'login'` phase) instead of leaving a silently-dead connection
retrying forever.

**Does clearing `token` on 4401–4404 and falling back to `pairing_request` create a bypass of the
PIN/lockout path?** No. `pairing_request` for an already-authorized device only ever re-confirms existing
authorization (idempotent `pairing_approved`, no new grant, no token issued) — it is not a login path and
cannot mint a session. The only way this device gets a new, valid token after a rejection is the existing
`login()`/`loginRemote()` PIN-check path (`attemptLogin`, `scryptSync` + `timingSafeEqual`, 5-attempt/30s
lockout), unchanged by this ADR.

**Reconnect storms.** The `RECONNECT_DELAY_MS` backoff between auto-reconnect attempts is unchanged by
this design; Part 3 does not add a tighter retry loop, it removes a *wasted* one (repeatedly sending a
token already known to be rejected). No new load is placed on the Host beyond what an ordinary
`pairing_request`-based reconnect already produces today for any not-yet-token-holding device.

**Interaction with T85's `isReauthenticate` guard.** `handleAuthenticate`'s `isReauthenticate = !!ws.deviceId`
check (`syncServer.js:464`) is unaffected: a startup `authenticate` on a fresh WS connection has
`ws.deviceId` unset (a brand-new `ws` object per `connect()` call), so it is treated as a first
authentication on this connection, correctly running `sendFullSyncIfFirstPairing`/`sendMissedOps` exactly
once — the same as it does for the existing post-login `authenticate` today. This design does not
introduce any new re-authenticate-on-the-same-socket case beyond what T85 already handles (a genuine PIN
re-login mid-session, e.g. a shift change, still uses `loginRemote` on the already-open, already-connected
socket, unchanged).

**Token never logged.** No part of this design logs the token value itself; the one new listener payload
(`onAuthRejected`) carries only a numeric close code, matching `op_applied_ack`'s "carries only an id
already known to both sides" precedent from the T85 ADR.

## Migration

**No schema change.** No new table, no new column. The one new IPC push event
(`shoresh:auth-rejected`) and the one new field on `getSyncStatus()`'s return shape (`authenticated:
boolean`) are both additive — an old renderer against a new main process simply never listens for the new
event and ignores the new field; a new renderer against an old main process (pre-fix) never receives the
new event and `authenticated` is `undefined`, which the proposed `sidebarState.js` logic should treat as
falsy/unauthenticated-unknown rather than crash (Maker: guard with `authed = status?.authenticated ??
false` at the read site, not just at `getSyncStatus()`'s construction site, in case of a stale cached
status object).

## Non-goals

- **A positive `authenticate_ok` server ack.** Considered and rejected in Divergent exploration — the
  existing negative signal (4401–4404 close) is sufficient for the case this ticket needs to close; a
  Host that silently hangs mid-authenticate (never acks, never closes) is a pre-existing, already-documented
  gap this ADR does not claim to fix.
- **Host-side authentication-attempt observability/metrics.** Real value, independently proposed by the
  3am-on-call frame, but Host-side infrastructure larger than and independent of this Client-side
  reachability bug. Flagged as a candidate follow-up, not folded in here.
- **A generic bounded-retry-then-force-visible-failure cap on all reconnect attempts.** Considered and
  rejected — over-broad; would degrade the working "Host merely offline" case for no benefit over the
  narrower, already-adopted close-code-specific token clearing (Part 3).
- **Per-connection multi-tab/multi-process session accounting.** The attacker frame flagged a theoretical
  multi-socket-per-device-id race under a forced-crash-loop attack. Not evaluated as reachable in this
  app's actual process model (single Electron renderer, single main process per device, `modeChosen`
  already guards double-`chooseMode` within one process) — flagged for Security's review, not designed
  against here, since no evidence was found that it is reachable in practice.
- **Local-storage-token-to-local-audit-trail logging of connection status changes.** The regulator frame
  proposed treating every "connected but not authenticated" transition as its own audited event alongside
  `device.approve`/`device.revoke`. Real observability idea, deferred as a nicety beyond what this ticket's
  `archive_when` requires (a reliable status signal in the UI, not a durable audit log of transport
  states).

## Test strategy

Per `docs/governance/GOVERNANCE_INDEX.md`, this touches auth + LAN protocol reachability (Security
recommended) and reconnect/session semantics (Red Hat recommended); it is also a constitution-level
human-approval gate (auth/session-state change) independent of the ADR-acceptance gate itself.

1. **The load-bearing regression test — exercise the real `electron/main.js` path, not the harness
   `Client`.** Using `makeHandlers` (`electron/main.js:178`, already exported and already used by
   `electron/main.test.js`) against a real `syncServer`: bootstrap a Host, pair and log in a Client
   (through the real `chooseMode`/`login`/`loginRemote` flow, obtaining a real token), then **construct a
   second, fresh `makeHandlers` instance against the same on-disk Client db** (simulating the Electron
   process restart the ticket describes — new in-memory state, same persisted `devices`/`sessions` rows)
   and drive it through the same startup sequence a real renderer would (`chooseMode` then `verifySession`
   with the previously-obtained token, in the corrected order). Pre-fix, assert `ws.deviceId` is never set
   on the Host's side for this connection within a bounded wait. Post-fix, assert it is set, and that a
   `broadcastOps`/`sendMissedOps`-delivered op actually reaches this "restarted" Client.
2. **Rejected-token cleanup:** simulate the Host closing with each of 4401/4402/4403/4404 on a fresh
   connect; assert the Client's closure `token` is cleared (no further `authenticate` sent on the next
   auto-reconnect — assert the next outbound message is `pairing_request`, not a repeated `authenticate`),
   and assert `onAuthRejected`'s callback fires with the correct code.
3. **Status signal:** assert `getSyncStatus()` returns `state: 'client-connecting'` in the window between
   transport-open and authenticate-success/rejection, and `'client-connected'` only once
   `isAuthenticated()` is true; assert the existing `'client-disconnected'`/`'host'`/`'standalone'` cases
   are unchanged (regression guard on `sidebarState.js`'s existing three entries).
4. **Negative security test:** assert the `shoresh:auth-rejected` push payload and every wire message sent
   during scenario 1 never contains the token's raw string value in any log line this design adds (there
   should be none — no new logging is introduced by this design at all).
5. **Regression:** the existing mid-session reconnect/re-login paths (`loginRemote` post-login
   `authenticate`, a shift-change re-authenticate on an already-open socket, T85's `isReauthenticate`
   guard) must continue to pass unmodified — this design touches `connect()`'s close handler and
   `chooseMode`'s call site, not `loginRemote` or `handleAuthenticate` themselves.

## Consequences

- **Positive:** the everyday "tablet restarts overnight, or the app is relaunched mid-day" scenario — the
  scenario T85's own fix exists to serve — actually reaches an authenticated connection again, closing the
  reachability gap in front of T85's op-log correctness fix. A structurally silent failure mode
  (open-but-unauthenticated) gets its own honest, camp-language status state for the first time, closing
  the door on this whole *class* of invisible failure, not just this one instance of it.
- **Costs/risks:** one new IPC push event and one new `getSyncStatus()` field — small, additive protocol
  surface, but real, and it changes the *meaning* of the existing `'client-connected'` sidebar state (from
  "transport open" to "transport open and authenticated"), which is a deliberate, disclosed behavior
  change to existing UI copy, not silent. If the owner picks Option B instead of the recommended Option A,
  Parts 1–2 change to the Option B sketch above and the friction cost (PIN re-entry on every restart) is
  real and ongoing, not one-time.
- **Explicitly not built here:** a positive authenticate ack; Host-side auth-attempt observability; a
  generic retry cap; multi-tab/multi-process session accounting; local audit-trail logging of transport
  status transitions. All flagged, none silently dropped.

## Confidence

**High** that the defect is real and precisely as traced — every link in the call chain (Part 1's
five-item trace) was read directly from current source on `main` (`815f4f7`), not inferred or assumed, and
the harness gap that explains why T85's own suite didn't catch it was independently confirmed by reading
`test/integration/harness.js` directly. **High** that Parts 2 and 4 are correct and minimal —
`createSyncClient`'s `token` parameter and `connect()`'s branch already exist and are unit-testable in
isolation; Part 4 reuses a status pipeline (T27) that is already fully wired end-to-end for every other
consumer. **Medium-high** on Part 3 (the close-code-clearing gap) — the mechanism is straightforward and
directly modeled on the existing `pairing_denied` handling in the same close-message dispatcher, but it is
the one genuinely new branch of behavior in this design and was found only via divergent ideation, not the
initial straight-line trace, so it is the piece Maker should most carefully re-verify against the exact
current `ws.on('close', ...)` control flow before implementing. **The Part 0 product decision is not
mine to resolve with confidence** — that is the explicit human-approval gate this ADR is proposed, not
accepted, pending.

**Evidence behind this confidence:** direct reading of `src/hooks/useDeviceMode.js`,
`electron/main.js`, `electron/sync/syncClient.js`, `electron/sync/syncServer.js`,
`electron/preload.js`, `src/components/layout/sidebarState.js`, `test/integration/harness.js`, and
`docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md` — line-cited throughout this document —
plus five isolated, parallel `adhd` ideation passes whose independent convergence (and one independently
double-flagged gap) is reported above, not asserted from memory alone.

## Post-implementation review note (2026-08-17)

Built as Option A. Full review panel ran on the implementation: Security **5/5** (Host auth logic
byte-identical, only a locally-verified token ever handed to the transport, token never logged), Code
Reviewer **Ready** (faithful, convention-mirroring execution; the load-bearing `main.reauth.test.js`
drives two real `makeHandlers` instances against one on-disk db to prove a live Host op reaches the
restarted connection), Red Hat **Resilience 4/5**, Tester UX 3/5 · Visual 5/5. No blocking findings.

**Two residual gaps worth recording honestly:**

1. **Part 4's `client-connecting` state is near-dead for the token-present reconnect path** (Red Hat
   RISK 2). As already disclosed above (the optimistic-flag discussion under Part 3's rationale and the
   "residual ones this ADR does not close" caveat under Part 4), `authenticated` flips `true` the instant
   the `authenticate` frame is *sent* in `connect()`'s open handler, not on a Host confirmation — there is
   no positive ack. So for a returning client the `'client-connecting'` window is only the sub-round-trip
   gap before the socket opens; a device the Host is about to *reject* shows green "linked" for a few event
   loop ticks before Part 3's close-driven cleanup forces it to login. This self-corrects (it is not the
   silent-forever failure this ticket closed) and closing it fully requires the positive-ack wire message
   this ADR deliberately did not build (see Non-goals). Left as a known, disclosed limitation; the
   `'client-connecting'` state still earns its place for the genuine open-but-unauthenticated window and as
   honest plumbing for any future positive-ack work.

2. **A rejected/revoked device dropped to the login screen with no explanation** (Tester MEDIUM + the
   user-facing substance of RISK 2). Closed in a follow-up fix round on this same branch: `onAuthRejected`
   now threads the numeric close code through `useDeviceMode` into a non-technical `sessionEndedReason`,
   rendered as an informational (not error) notice on `LoginScreen` — a director-action message for
   `4403`/`4404` (device no longer approved / revoked → ask an admin to re-approve), a benign
   "session ended, please sign in again" for everything else. The reason is cleared on a successful login
   and on manual logout. Same round: extracted a shared `clearSessionState()` helper so the verify-fail and
   auth-rejected cleanup paths can no longer drift, and refreshed a stale `syncServer.js` close-code comment
   that predated this sub-task.

**Deferred (pre-existing, not introduced by T87):** `syncClient.test.js` hardcodes `PORT = 8237`, which
under heavy concurrent same-host test load can let a client reach an unrelated server instance and report
the wrong close code (Red Hat RISK 4). Tracked as a separate low-risk follow-up to migrate that file's
fixed ports to the harness's existing `getFreePort()`; not blocking, and orthogonal to T87's own logic.
