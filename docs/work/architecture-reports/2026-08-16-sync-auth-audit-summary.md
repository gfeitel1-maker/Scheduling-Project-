---
title: Sync+auth architecture audit 2026-08-16
document_type: architecture-report
authority: descriptive
status: active
date: 2026-08-16
---

F4 follow-up: dedicated deep-read of `electron/sync/*` and `electron/auth/*` at HEAD `b693e98`. Full analysis in `2026-08-16-sync-auth-audit.html`. Ranked by leverage; T87 overlap tagged.

- **C1 (high) · Extract the reliable-delivery + catch-up watermark sub-module from `syncServer.js`** — ~330 lines (`send`/`sendWithAck`/`waitForFullSyncAck`/`waitForApplyAck`/`sendMissedOps`/`sendFullSyncIfFirstPairing`, lines 40–374) carry their own no-gaps-watermark invariant and are already exported just for testing; they belong in an `opDelivery.js`/`catchup.js` module. MAY OVERLAP ACTIVE T87 WORK (the clobber hazard forces the reauth guard).
- **C2 (high) · Single-source the full_sync snapshot manifest** — the camp-scoped snapshot table set + apply order is hand-maintained twice (`syncServer.js:33` vs `syncClient.js:34–76`) and has already drifted (`week_location_exclusions` shipped by the server, dropped by first-pairing Clients); a shared `snapshotManifest.js` makes the drift impossible. Low T87 overlap.
- **C3 (medium) · Collapse the device-trust gate into one predicate** — the `authorized_at`/`revoked_at` check is re-queried by hand in `authorize.js` plus three places in `syncServer.js` (authenticate, login, renew_token); a single `deviceTrustStatus()` removes four copies. MAY OVERLAP ACTIVE T87 WORK.
- **C4 (medium) · Replace ws-stashed single ack-resolvers with a keyed registry** — the server stashes one resolver per kind on the socket (`ws.pendingFullSyncAckResolve`, `ws.pendingCatchupAck*`), whose clobber hazard is the sole reason for the `isReauthenticate` guard; mirror `syncClient`'s keyed `keyedResolverMaps` pattern. MAY OVERLAP ACTIVE T87 WORK (companion to C1).
- **C5 (low) · Name the two identities of `createSyncClient`** — the no-`serverUrl` Host-local branch (`syncClient.js:179–279`) is effectively a second class behind one factory; a `createHostLocalClient` vs `createRemoteClient` split aids readability. No T87 overlap.

Honest verdict: the sync/auth layer is structurally healthier than its ~2,700 combined lines suggest — domain logic lives in `ops/*`, the renderer is fully IPC-insulated, and `authorize.js` is a benchmark deep module. It has real debt (two un-extracted internal seams and a duplicated device-trust check) worth deepening, but it does not need a rewrite.
