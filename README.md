# Shoresh

Shoresh helps camps control, adapt, and own their scheduling logic.

It's the adaptive scheduling layer for camps that outgrow spreadsheets but don't want to surrender their operational judgment to a black-box platform.

---

## The problem

Camp scheduling is a constraint satisfaction problem dressed up as a logistics problem. A typical week involves groups with different availability windows, activities with location capacity and eligibility rules, anchors that can't move, frequency goals, and preferences like "swimming should happen before Wednesday."

Spreadsheets break down fast. Black-box tools make decisions you can't see or override. Shoresh sits in between — it handles the constraints and surfaces the conflicts, but you stay in control.

## What it does

You define the rules: groups, tiers, time blocks, activities, anchors, and constraints. The engine builds a schedule that respects all of them, then flags what it couldn't satisfy. From there you adjust, lock, drag, and iterate — the schedule is yours to own.

- **Schedule engine** — deterministic, constraint-aware, runs in milliseconds
- **Drag-and-drop editing** — swap slots between groups directly on the grid
- **Flag system** — surfaces unfillable slots, underserved activities, weather risk, and distribution gaps
- **Locking** — protect decisions that shouldn't change across regenerations
- **Snapshots** — named versions with auto-save before every regeneration
- **Conflict resolution** — when two devices edit the same field offline, a dedicated screen surfaces the conflict and lets a director choose which version to keep
- **Local-first** — each camp's data lives in its own on-device SQLite database, isolated by design

## Architecture

Shoresh is a local-first desktop app built on Electron and SQLite. Each device runs its own SQLite database. One device acts as the LAN "Host" — it runs a WebSocket server and is the authoritative source of truth. Other devices are "Clients" that discover the Host via mDNS and sync over the local network (`ws://`). There is no cloud backend — everything lives on-device.

**Device access is gated by a pairing flow:** a new Client sends a `pairing_request` over the WebSocket; an admin approves it in the Device Manager screen; the Host mints a per-device secret for that device. After pairing, a Client's offline sessions use a local HMAC token; online sessions use a Host-minted Ed25519 camp token that Clients can verify but never forge.

All mutations flow through an op-log — every write is recorded as an operation row, synced and replayed across devices. When two devices edit the same field while offline, the conflict is recorded explicitly and surfaced in the Conflicts screen for a human to resolve. Nothing is silently dropped.

See [`docs/current/PLATFORM_STATE.md`](docs/current/PLATFORM_STATE.md) for the full architecture, screen inventory, and database schema. See [`SECURITY.md`](SECURITY.md) for the security model and known limitations.

## Security model

Shoresh is designed for a **trusted private LAN** — a known group of collaborators on a network they control (camp office Wi-Fi, a direct switch, etc.).

- **Device pairing gate** — every new device must be explicitly approved by an admin before it can sync or log in.
- **Ed25519 camp tokens** — session tokens for network use are signed exclusively by the Host's private key. Clients can verify but never mint them.
- **Device revocation** — an admin can revoke a device in Device Manager; the live connection is closed immediately and all future requests from that device are denied.
- **Centralized `authorize()`** — every mutating IPC and WebSocket handler re-derives the user's role from the database on every call, so a role change or revocation takes effect immediately.
- **Audit log** — auth events and denied calls are written to the `audit_events` table.

**This system is not designed for public internet hosting, open Wi-Fi, or enterprise identity requirements.** See [`SECURITY.md`](SECURITY.md) for explicit limitations.

## Running locally

```bash
npm install
npx electron-rebuild -f -w better-sqlite3   # required before first electron:dev run
npm run electron:dev                          # Vite + Electron together
```

After switching between `npm run test` (Node) and `npm run electron:dev` (Electron), rebuild the native module for the target:

```bash
npx electron-rebuild -f -w better-sqlite3   # before electron:dev
npm rebuild better-sqlite3                   # before npm run test
```

## Local deploy

`npm run deploy:local` rebuilds the app and updates an already-installed
`/Applications/Shoresh.app` in place, so a source change appears in the
installed app with one command. Before replacing anything it moves the
current install aside to `Shoresh.app.bak`, then proves the new build good
(native module ABI check, a launch smoke test, and a build-stamp check
against `git rev-parse HEAD`) before deleting the backup. The launch smoke
test runs the build against a fresh, throwaway data directory — never the
machine's real operational database — so it verifies the build boots
regardless of whatever schema version the machine's live database happens to
be at, and waits (up to 40s) for a nonce-stamped startup heartbeat — a marker
the app writes only after its window finishes loading, tied to this specific
run — rather than just checking the process is still alive, so a
main-process crash that Electron keeps alive behind its own error dialog now
correctly fails the deploy instead of silently passing. If any check fails, it automatically restores
`Shoresh.app.bak` back to `Shoresh.app` and exits non-zero — the machine is
always left with a working installed app. For a first-time install, use
`npm run install:mac` instead.

If `better-sqlite3`'s native build gets into a bad state from a concurrent
rebuild (a rare, self-resolving race — not a broken environment), recover with:

```bash
rm -rf node_modules/better-sqlite3/build && npm rebuild better-sqlite3
```

## Tests

```bash
npm run test                          # Vitest unit tests (292 files; case count not re-verified in the latest doc pass)
node test/integration/run.js          # 27 multi-process integration scenarios
npm run lint                          # ESLint
```

The integration harness spawns real child processes to cover cross-process behavior (pairing, revocation, token renewal, conflict detection, clock skew, role changes) that Vitest's single-process model cannot verify.

## Status

Active development, pre-production. Being built for Shoresh camp; not yet running with live camp data.

Self-hosting guide and contributing guidelines coming with the first stable release.

## Tech

React 19 · Vite · Electron · better-sqlite3 · @dnd-kit · Vitest
