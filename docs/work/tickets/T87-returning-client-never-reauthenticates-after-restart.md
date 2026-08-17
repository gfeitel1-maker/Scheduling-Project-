---
title: T87-returning-client-never-reauthenticates-after-restart
document_type: ticket
status: completed
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md]
related_adrs: [docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md]
related_specs: []
related_runs: []
archive_when: "A Client device that was previously paired and holds a still-valid session token, after a full Electron process restart (app relaunch / tablet reboot / crash-recover), reliably reaches an AUTHENTICATED WebSocket state with the Host (ws.deviceId set, receiving live broadcastOps and sendMissedOps catch-up) WITHOUT the user being forced to re-enter their PIN — OR, if forcing re-login is the chosen product behavior, the UI honestly reflects the not-yet-authenticated state instead of showing a stale 'session' phase. Proven by a test exercising the real electron/main.js chooseMode client path (not the harness Client), and merged with owner sign-off."
---

# T87 — A returning Client may never re-authenticate after an app restart (silent no-live-sync)

> **Renumbered from T86 → T87 on 2026-08-16**: a concurrent session merged a different T86
> (device-management IPC handlers not Host-gated on a Client, PR #80) to main first. This ticket took
> the next free id.

**Severity: HIGH (silent — a returning Client can stop receiving live ops for up to the 24h token life).**
Surfaced by Red Hat during the T85 panel, 2026-08-16. **Pre-existing** and in a **different subsystem**
than T85 (client reconnect/re-auth + device-session phase logic, not the op-log). Owner decision
(2026-08-16): file as a companion to T85 and do **not** block T85's landing. This is that companion.

## The defect (premise verified 2026-08-16; full end-to-end impact needs a live repro)

The Client branch of `chooseMode` constructs its `syncClient` with **no `token` field**
(`electron/main.js:467-472`) — deliberately, because `chooseMode` runs before `verifySession`
(`main.js:251-259`). `verifySession` (`main.js:715-721`) is a pure local token check and never touches
`syncClient`. Grep found no `authenticateRemote`/`reAuthenticate`/"resend token to the existing
syncClient after verifySession" mechanism anywhere.

**Consequence traced by Red Hat (CONFIRMED premise, not yet exercised by a live repro):**
- On a fresh process start the closure-local `token` in `createSyncClient` is `undefined`, so
  `connect()`'s `ws.on('open')` takes the `else if (device_name)` branch and sends `pairing_request`,
  **never `authenticate`** (`electron/sync/syncClient.js:527-539`), even for a long-paired device.
- The Host answers `pairing_request` idempotently with `pairing_approved`, which carries no session token
  and triggers no auto-login on the Client (`main.js` `onPairingApproved` only pushes a renderer
  notification).
- `src/hooks/useDeviceMode.js` computes `phase = 'session'` directly from a still-valid `localStorage`
  token, so the **Login screen is skipped** and `login()`/`loginRemote()` — the only path that ever sends
  `authenticate` — is never invoked either.

Net: a Client whose stored token is still valid (≤24h) but whose Electron process restarted (app
relaunch, tablet reboot, crash-recover — all routine on camp hardware) reconnects with a socket that
**never becomes authenticated** (`ws.deviceId` never set). Since `broadcastOps` and `sendMissedOps`
both key on `ws.deviceId`, that device gets **zero live broadcasts and zero catch-up** until the stored
token finally expires and the user is forced to re-enter their PIN.

## Why this matters for T85

T85's fix (device-FK stub-seed + apply-ack watermark + Host-local broadcast) is correct **only for a
connection that reaches `handleAuthenticate`**. If Risk 2 holds, the everyday "3+ device camp, tablets
restart overnight" scenario T85 exists to serve can still silently fail to deliver ops — via a *different*
mechanism than the FK-drop T85 patches. T85 closes the op-log defect it was scoped for; this ticket
closes the reachability gap in front of it. There is also no UI signal today distinguishing "transport
open" from "authenticated," so the failure is invisible.

## First steps (for whoever picks this up)

1. **Verify with a real repro** against `electron/main.js`'s actual `chooseMode` client path (NOT the
   integration harness `Client`, whose `reconnect()` at `test/integration/harness.js:296-304,382-385`
   already seeds `token: this.token || undefined` and therefore does the *correct* thing the production
   path omits — which is exactly why the T85 suite didn't catch this).
2. Decide the product behavior with the owner: silent auto-reauth from the stored token vs. an explicit
   re-login prompt. If auto-reauth: the Client needs a path that hands its verified token to the existing
   `syncClient` and sends `authenticate` (mirroring `loginRemote`'s post-login `authenticate` send) once
   `verifySession` succeeds on startup.
3. Add a genuine test over the real path, and a LAN-status/authenticated signal so this can never again be
   silent.

## Gates

Touches auth + the LAN protocol reachability → Security review recommended; sync/reconnect semantics →
Red Hat recommended; human-approval gate per the constitution for auth/session-state changes.
