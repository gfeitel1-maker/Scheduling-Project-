---
title: T86-device-management-handlers-not-host-gated-on-client
document_type: ticket
status: open
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, SECURITY.md]
related_tickets: []
related_adrs: [docs/adr/2026-07-25-device-trust-revocation.md]
related_specs: []
related_reports: []
archive_when: "the four mutating device handlers (approveDevice/denyDevice/revokeDevice, and the reads if the product decision includes them) refuse to run in client mode the way ingestCommit/confirmAliasHandler already do, a Client-mode admin can no longer reach a device-management surface that writes to the local devices table, a test pins the client-mode refusal, and this ticket is merged with owner sign-off"
---

# T86 — Device-management IPC handlers are not Host-gated; a Client admin writes to the local, never-synced `devices` table

**Task class:** auth / IPC boundary (device trust). **Risk:** medium — no data-shape change, but it
touches the device-trust surface described in [SECURITY.md](../../../SECURITY.md) and can present a
false "device removed" outcome to a director. **Sequencing:** independent of, but interacts with, the
T85 sync-delivery fix (see "Interaction with T85" below) — flag that ticket's ADR Non-goals as noted
there; this ticket does not block on it and it does not block this.

Origin: discovery/triage during the T85 device-FK-seeding ADR design (2026-08-16). This is a separate
seam from T85 — T85 is about ops being dropped in delivery; this is about a mode gate missing on the
device-management IPC handlers.

## Problem

`listDevices`, `approveDevice`, `denyDevice`, and `revokeDevice`
([electron/main.js:642-713](../../../electron/main.js)) are gated **only** by
`requireAuthorized(db, { token, action: 'devices.read'|'devices.approve'|'devices.revoke' })` against
the **calling device's own local SQLite db**. They have **no `mode === 'client'` guard**.

Their direct-SQL siblings do. `ingestCommit` ([electron/main.js:283](../../../electron/main.js)) and
`confirmAliasHandler` ([electron/main.js:376](../../../electron/main.js)) both `throw` in client mode,
for a documented reason: they write straight to this device's SQLite outside the op-log, so running
them on a Client silently forks the camp. `approveDevice`/`denyDevice`/`revokeDevice` have the exact
same shape — direct `UPDATE devices ...` writes, never routed through `appendOp`/the op-log — but no
such guard. The `devices` table is not replicated at all (it is per-device; see the local-first model
in [CLAUDE.md](../../../CLAUDE.md) and the T85 investigation), so a write here can never reach the
Host, where device trust is actually enforced.

`authorize()` ([electron/auth/authorize.js](../../../electron/auth/authorize.js)) is pure role +
device-trust lookup against the local db — it has **no** Host/mode check — so an admin on an authorized
Client passes `devices.approve`/`devices.revoke` and the handler proceeds.

## Reachability (verified)

The Device Manager screen is fully reachable by an admin in **client** mode:

1. **Nav is not mode-gated.** `{ key: 'devices', label: 'LAN & Devices' }` is an `adminItems` entry
   ([src/components/layout/navSections.js:74-79](../../../src/components/layout/navSections.js)),
   rendered whenever `role === 'admin'`
   ([src/components/layout/Sidebar.jsx:76-79,152](../../../src/components/layout/Sidebar.jsx)). The only
   mode-aware thing on that row is a `syncStatusLabel` decoration — no host-only conditional.
2. **Screen renders on a Client.** `devices: DeviceManagerScreen`
   ([src/App.jsx:55](../../../src/App.jsx)); `role` is threaded into every screen's props
   ([src/App.jsx:147](../../../src/App.jsx)).
3. **Handlers are exposed and callable.** IPC registered
   ([electron/main.js:1320-1323](../../../electron/main.js)), whitelisted
   ([electron/main.js:1268-1271](../../../electron/main.js)), bridged
   ([electron/preload.js:60-63](../../../electron/preload.js)), wrapped
   ([src/localClient.js:97-101](../../../src/localClient.js)).
4. **No mode check in the handlers.** `mode` is in closure scope
   ([electron/main.js:188](../../../electron/main.js), set at
   [electron/main.js:478](../../../electron/main.js)) and *is* read by `ingestCommit`/`confirmAlias` —
   but not by the four device handlers. The `syncServer.*` notify calls are each guarded by
   `if (syncServer)`, which is simply skipped on a Client; the direct SQL write still runs and the
   handler returns success.

## What actually happens on a Client (the "inert vs error" answer)

A Client's local `devices` table is seeded only by `ensureDeviceRow` (its own row,
[electron/main.js:163-165](../../../electron/main.js)); pending peers self-register into the **Host's**
table over WebSocket ([electron/sync/syncServer.js:361-363](../../../electron/sync/syncServer.js)), not
the Client's. So today the reachable behavior is a mix — none of it reaches the Host:

| Handler | Client-mode behavior | Effect |
|---|---|---|
| `listDevices` / `listPendingPairingRequests` | succeed, no error | **Misleading partial roster** — shows only the Client's own row; pending/other peers are invisible, so a director "managing devices" from a Client sees a false picture and can act on it |
| `denyDevice(anyId)` | no existence check; writes `pairing_status='denied'` locally (0 rows if absent), returns `{denied:true}` | **Silent no-op success** |
| `revokeDevice(ownRowId)` | existence-checked; writes local `revoked_at` | **Admin soft-bricks their own local session** (next `authorize()` on this device denies `device_revoked`); Host trust untouched |
| `revokeDevice(otherId)` | `throw 'device not found'` | spurious error |
| `approveDevice(peerId)` | `throw 'device not found'` (peer pending row never reached the Client) | approve is effectively unreachable against a real peer; succeeds only against own id |

The unifying defect: every one of these reads/writes hits the **local, never-synced** `devices` table
and never reaches the Host — the same fork-the-camp hazard `ingestCommit` refuses outright.

## Interaction with T85 (why this worsens, not improves, as T85 lands)

T85's ADR Non-goals defer seeding **FK-stub `devices` rows into Clients' tables**. Once peer rows
appear there, `listDevices` on a Client shows *other* devices, and `revokeDevice` against a stub
becomes a **silent no-op presented to the director as "No longer allowed"** while that device keeps
syncing. The blast radius grows precisely as T85 fixes the sync path. **Action for the T85 owner:** add
one line to the T85 device-FK-seeding ADR's Non-goals section naming T86 as the downstream that
FK-stub seeding activates, so the two are not fixed in the wrong order. (Left as a cross-reference; not
a code dependency.)

## Severity

- **Today:** LOW–MEDIUM — capped by the local table being nearly empty (self-revoke soft-brick +
  misleading roster + silent deny no-op).
- **After T85:** MEDIUM — silent revoke no-ops on real peer devices, shown to the director as success.

## Success predicate (observable)

1. An admin session in **client** mode that calls `approveDevice`/`denyDevice`/`revokeDevice` gets a
   clear refusal ("… can only be done on the main computer"), and **no row in the local `devices`
   table is mutated** — verifiable by asserting the table is unchanged after the call, mirroring the
   `ingestCommit` client-mode test.
2. An admin in client mode does **not** land on a device-management surface that appears to let them
   approve/deny/revoke — either the nav item is hidden in client mode, or the screen renders a
   read-only "manage devices on the main computer" state (product decision, below).
3. Host-mode behavior is **byte-for-byte unchanged** — existing DeviceManagerScreen and pairing tests
   still pass.
4. A test pins the client-mode refusal at the handler layer (defense in depth: gate at the IPC handler,
   not only in the UI).

## Proposed approach (recommendation, confidence: high on the guard; medium on read policy)

Mirror the established `ingestCommit` precedent rather than inventing op-log routing for device
management:

- **Handler layer (required):** add `if (mode === 'client') throw new Error(...)` to `approveDevice`,
  `denyDevice`, and `revokeDevice`, with a director-legible message. This is the load-bearing fix and
  is defense-in-depth even if the UI is also gated.
- **UI layer (required):** hide the `devices` nav item in client mode, or route it to a read-only
  affordance — so a Client admin never reaches write controls.
- **Reads (open product question — for the spec):** decide whether `listDevices` /
  `listPendingPairingRequests` should also refuse in client mode, or remain visible **read-only** as a
  status view. The hazard with keeping them is exactly the misleading partial roster above; the
  argument for keeping them is a director wanting to *see* sync/pairing status from any device. This is
  the one genuinely open decision and should be resolved with the owner before code.

Rationale for **not** doing op-log routing (a Client→Host "request approve"): device management is
already described as happening "on the Host" in
[docs/adr/2026-07-25-device-trust-revocation.md](../../../docs/adr/2026-07-25-device-trust-revocation.md);
the Host-only guard makes the code match that stated model with the least surface. A Client→Host
approval-request flow would be its own ADR and is out of scope here.

## Non-goals

- **Not** fixing T85's op-drop / watermark issue — different seam.
- **Not** adding op-log replication of the `devices` table — it is deliberately per-device.
- **Not** building a Client→Host device-approval request protocol (would be a separate ADR if ever
  wanted).
- **Not** changing the auth/permission matrix — the gate is mode, not role.

## Evidence trail

Full reachability walk and behavior table established by static trace on 2026-08-16 across
`electron/main.js`, `electron/auth/authorize.js`, `electron/sync/syncServer.js`,
`src/App.jsx`, `src/components/layout/{Sidebar.jsx,navSections.js}`, `src/localClient.js`,
`src/screens/DeviceManagerScreen.jsx`, and `electron/preload.js`. No existing ticket covered this
(grep of `docs/work/tickets/`).
