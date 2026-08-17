---
title: T85-devices-table-never-synced-cross-device-op-drop
document_type: ticket
status: completed
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T86-device-management-handlers-not-host-gated-on-client.md, docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md]
related_adrs: [docs/adr/2026-08-16-locations-optional-map.md, docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md]
related_runs: [docs/work/runs/2026-08-16-locations-m6-map.md]
archive_when: "a device reliably receives and APPLIES ops authored by any other paired device (live over broadcast AND on reconnect catch-up), proven by a multi-device integration test that does NOT use the test-only registerDevice() workaround; and the fix is merged with owner sign-off"
---

# T85 — The `devices` table is never synced between peers → cross-device ops silently dropped

> **RESOLVED 2026-08-16 — fixed via [docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md](../../adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md), merged with owner sign-off.**
> `applyRemoteOp` now stub-seeds a secret-free `devices` row from the op's own `device_id` (FK always
> satisfiable), a new `op_applied_ack` gates the `sendMissedOps` watermark on genuine receiver-apply (a
> dropped op can no longer be marked delivered), and the Host's own local writes now broadcast to connected
> Clients. All six `archive_when` conditions proven by integration **scenario 24**
> (`test/integration/scenarios/24-device-fk-seeding-and-watermark.js`) — live broadcast, reconnect catch-up
> with a mid-batch apply failure, Host-local broadcast, and a wire-capture negative security check — all
> through the real pairing flow, and the 8 scenarios that relied on the test-only `registerDevice()`
> workaround now pair for real. Adversarial panel (Security 5/5, Red Hat, Code Reviewer) + Grader (PASS).
> Red Hat's Risk 1 (re-auth concurrency) and Risk 3a (phantom stub rows in the device list) were fixed in
> the same change; **T87** (returning Client may not re-authenticate after restart — different subsystem) and
> **T86** (device-management handlers not Host-gated on a Client — the FK-stub seeding *arms* it; already
> merged) were owner-deferred as separate tickets.

**Severity: HIGH — platform-level, pre-existing, app-wide (affects ALL synced data, not just the map).**
**NOT caused by M6.** Surfaced by Red Hat while adversarially reviewing M6 (the optional map), whose Q7
promise ("staff see the map on their tablets") depends on cross-device delivery working. Owner decision
(2026-08-16): **land M6 now, investigate this separately as its own high-priority effort.** This is a core
sync-architecture defect and needs its own Architect design + ADR + Red Hat, not an M6 add-on.

## The defect (verified empirically by Red Hat with 5 real probes against `syncClient.js`/`syncServer.js`, and independently spot-confirmed by Governor)

`operations.device_id TEXT NOT NULL REFERENCES devices(id)` (`electron/db/schema.sql:173`) with
`PRAGMA foreign_keys = ON` (`electron/db/localDb.js:1807`). But the `devices` table is **never replicated**:
- Not in `DOMAIN_SNAPSHOT_TABLES` / `DOMAIN_TABLE_COLUMNS` (`electron/sync/syncClient.js:33-48`), so
  `applyFullSync` (`:371-427`) never ships peer device rows.
- No production code inserts another device's row into a receiver's local `devices` table (exhaustive grep
  of `electron/` for `INTO devices` — the only `devices` writes in `syncClient.js` are the LOCAL device's
  own pairing-status update at `:587` and a self-lookup at `:870`).
- `applyRemoteOp` (`syncClient.js:444-524`) inserts into `operations` with no ambient FK-repair; the insert
  failure is **swallowed** at the message-handler level (`:686-697`, `opError` captured, nothing surfaced,
  no retry).
- The server advances the permanent delivery watermark on **transport-level send-ack** regardless of whether
  the client actually applied the op (`sendWithAck` / `UPDATE devices SET last_synced_seq`,
  `syncServer.js:274-319`) — so a dropped op is marked delivered and **never resent**.

**Net effect:** a device silently fails to apply any op authored by a device whose `devices` row it doesn't
already hold — **live broadcast AND reconnect catch-up (`sendMissedOps`) both affected.** Only a fresh full
RE-PAIRING (`applyFullSync`, which writes materialized rows bypassing the `operations` FK) delivers the data.

## Proof it's real, not a harness artifact (Red Hat's probes)
- Probe 1: staff Client connected, admin uploads locally on Host → staff receives nothing (`delivered=false`).
- Probe 2: staff Client reconnects (real `sendMissedOps` catch-up) → still undefined **permanently** (watermark advanced).
- Probe 3: same, but Host's device row pre-registered on the Client → **succeeds** (isolates the exact cause).
- Probe 4: the "recommended" topology (admin uploads from a Client) → reaches Host, broadcasts to staff Client → **still never lands** (staff drops it — doesn't know the authoring Client's device).
- **The tell:** 7 multi-device integration scenarios (`04, 11, 13, 18, 20, 22, 23`) each call a **test-only
  `harness.js:425 registerDevice()`** to hand-insert peer device rows before their cross-device assertions —
  the suite cannot test cross-device delivery without a workaround production doesn't have.

## Consequence (what a director/staff would experience)
On a camp with 3+ devices (Host + 2+ Clients — the ordinary deployment), a change made on one device can
fail to reach the others until a full re-pair. Not just the map — any location/activity/schedule/exclusion
edit. On 1–2 devices, or for the device that authored the change (or the Host, which learns every Client at
pairing), it works. This may have stayed latent because small camps, Host-centric editing, or frequent
re-pairing mask it.

## Success predicate
- A receiver device reliably APPLIES ops authored by any other paired device — live over broadcast AND on
  reconnect catch-up — without the `registerDevice()` test workaround. Likely requires: replicating (a
  bounded projection of) the `devices` table across peers, OR relaxing/repairing the `operations.device_id`
  FK on apply, OR seeding the author's device row on op receipt. Architect chooses.
- The watermark must NOT advance for an op the receiver failed to apply (else the retry path can never heal).
- A multi-device integration test proves delivery WITHOUT `registerDevice()`.

## Gate notes
Architect required (core sync/op-log/FK architecture — ADR-worthy, blast radius across every synced entity).
Red Hat mandatory. Consider whether a `devices`-projection introduces PII/security surface (device names,
secrets — the `device_secret_identifier` must NEVER replicate; only the minimal FK-satisfying identity).
Governor should sequence this as its own initiative; it is more important than any single feature slice.

## Provenance
Red Hat report on M6 (2026-08-16), Priority 1 #1. Probe scripts:
`/private/tmp/.../scratchpad/redhat-broadcast-probe{,2,3,4}.js`. Also independently flagged by the Maker and
Code Reviewer (the narrower "Host-local writes don't broadcast" half). Supersedes no existing ticket.
