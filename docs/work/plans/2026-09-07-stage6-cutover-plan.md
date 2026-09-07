---
title: Stage 6 — op-log cutover plan
document_type: plan
status: active
created: 2026-09-07
task: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
---

# Stage 6 — retiring the op-log

**Goal.** Automerge + libp2p becomes the only sync path. Retire the `operations` and `conflicts`
tables and the WebSocket sync layer. SQLite stays, as a projection.

**Authorization.** Owner is all-in (2026-09-07). Pre-production, no live users, no real camp data on
this engine. Prefer clean cutover over back-compat.

## Prerequisites — all CLOSED

| Prerequisite | Evidence |
|---|---|
| Entity coverage | 26 modeled, 0 deferred (#322, #323); all project from the doc with `operations` empty |
| Real-hardware convergence | Mac ↔ Windows, both directions, all five checks (#315–#318) |
| Sync protocol | Automerge `initSyncState`/`generateSyncMessage` (#318); converges on connect |
| Packaged build | Automerge WASM + all-ESM libp2p load; ABI fixed (#320) |
| Windows target | Per-user NSIS (#321) |

## Blast radius (measured, not estimated)

107 files reference the op-log or WS sync. **31 are not tests**: 13 production files and
**18 integration scenarios**.

- Core: `electron/ops/operations.js` (673), `electron/sync/syncServer.js` (857),
  `electron/sync/syncClient.js` (1654) — ~3,200 lines.
- Also: `main.js`, `catchup.js`, `projectionRepair.js`, `deriveWriteAction.js`, `trash.js`,
  `restore.js`, `deleteRecord.js`, `deleteWeek.js`, `ingest.js`, `projections.js`,
  `campScopedEntities.js`.

## The thing the ADR does not say, and it drives the sequence

**All 27 integration scenarios run over WebSocket.** They are the only end-to-end safety net —
pairing, catch-up, crash-mid-sync, idempotency, restore queues, full-sync manifests. Deleting WS
first would delete that net at the exact moment it is most needed, leaving unit tests alone to cover
an irreversible change.

**Therefore: port the harness before removing anything.**

## Sequence

**6a — Port the integration harness to libp2p.** `test/integration/harness.js` swaps its transport
for `startSyncNode`; scenarios keep their assertions. Scenarios that test WS-specific mechanics
(catch-up watermarks, WS close codes, the full-sync manifest) either map onto a libp2p equivalent or
are explicitly retired with a stated reason — retiring a scenario is a decision to record, never a
silent deletion. **Exit: 27/27 green on libp2p, with WS still present.** This is the slice that makes
everything after it safe, and it is reversible.

**6b — Flip the default.** `SHORESH_SYNC_ENGINE` defaults to `automerge`; `oplog` stays selectable
for one slice. Full gate + a two-machine run. Still reversible.

**6c — Remove the WS layer.** Delete `syncServer.js`, `syncClient.js`, `catchup.js`, and their
wiring in `main.js`. IPC surface (`window.shoresh.*`) must not change — `ipcSurfaceParity.test.js` is
the gate; the renderer's 36 importers should not notice.

**6d — Remove the op-log.** Delete `appendOp`/`appendBulkReplaceOp` write paths, drop `operations`
and `conflicts` (schema bump), remove the flag entirely. `ensureExists`'s `operations` fallback goes
away — the `knownRow` path (#323) becomes the only path.

**6e — Conflict UI.** `resolveConflict`/`listPendingConflicts` have no CRDT analogue; Automerge
converges deterministically. Decide: remove the UI, or repurpose it to surface `A.getConflicts` (the
concurrent-regenerate case from #322 genuinely produces one). **Product decision — ask the owner.**

## Rules for myself

- One slice per PR, full `npm run verify` green before each merge.
- 6a before anything is deleted. If 6a cannot reach 27/27, stop and report — that is a real signal
  the engine is not ready, not a reason to lower the bar.
- Nothing is deleted while it is still the only thing testing a behavior.
- Do not "fix" a red by deleting the test that found it.
- Expect fixture errors when writing doc-path tests (I made three in one sitting): parents must be in
  the DOCUMENT not just SQLite; some paths need a `devices` row; check the entity's real field names
  in `PROJECTIONS` before asserting a defect.

## Not in scope

Stage 7 (WAN: DHT, dcutr, circuit relay). Windows installer built on Windows. Firewall automation.
