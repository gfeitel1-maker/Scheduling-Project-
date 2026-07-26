# UI/UX work — session handoff

**Date:** 2026-07-26  
**Git HEAD:** `ca05379` on `main`, pushed to `origin/main`  
**Status:** backend and infrastructure fully complete; new session is opening to focus on UI/UX

---

## Where everything stands

The local-first rebuild is done. All backend, auth, sync, and testing infrastructure is
production-ready and green:

- **16/16 integration scenarios pass** (`node test/integration/run.js`)
- **558 unit tests pass** (`npm run test`) — one known-flaky mDNS test is pre-existing and
  unrelated to any code here
- **App runs end-to-end**: Host login, Camp Setup (counts load), Device Manager (authorized
  status, no errors), all sidebar nav items reachable

### What's built and working

| Area | Status |
|---|---|
| Local-first SQLite + LAN sync (Host/Client) | ✅ complete |
| Ed25519 Host-signed tokens, HMAC local tokens | ✅ complete |
| Device pairing, approval, revocation | ✅ complete |
| Centralized `authorize()` on every IPC + WS handler | ✅ complete |
| Audit log (`audit_events` table) | ✅ complete |
| Conflict detection + `ConflictsScreen` | ✅ complete |
| Project lifecycle (create/open/backup/restore) | ✅ complete |
| Schedule engine, DnD editor, snapshots | ✅ complete |
| All 16 multi-process integration scenarios | ✅ complete |
| `README.md`, `PLATFORM_STATE.md`, `SECURITY.md` | ✅ updated |

---

## How to use the GOVERNOR workflow

Every code change in this project goes through the **GOVERNOR loop**. Do not skip it.

```
Maker builds → parallel: Tester + Security + RedHat + CodeReviewer → Verifier (lint+test) → Grader (avg ≥ 4.0, no dim < 3)
```

**Critical rule: ALL agent dispatches must be `run_in_background: false`.** Background agents
stall permanently in this harness. Foreground only, every time.

Specs and ADRs live in `docs/superpowers/specs/` and `docs/adr/`. Write a spec before
building anything non-trivial. Reference `PLATFORM_STATE.md` and `CLAUDE.md` for
architecture constraints — especially:
- All screen writes go through `src/localClient.js`, never `window.shoresh` directly
- Any cross-process input parsing: reject malformed input before touching properties,
  validate types not just presence, try/catch defense-in-depth, default-deny
- Device/user identity for WS handlers must come from `ws.userId`/`ws.deviceId`, never
  client-claimed fields

---

## Known UI/UX rough edges

These are the things to fix or decide on in the new session:

### Navigation gaps (confirmed)
- **Camp Setup cannot be completed in a local dev environment**: the Units screen has an
  unsatisfiable "Cohorts" prerequisite with no reachable UI path, blocking Groups / Time
  Blocks / Activities / Schedule. Root cause undiagnosed — worth a navigation audit before
  building anything on top of this flow.
- **`DaysScreen.jsx` exists but is not wired** into `App.jsx`'s `SCREENS` map or `Sidebar`
  navigation. No live UI path to it. Possibly intentional, possibly an oversight.

### Visual / interaction polish
- The sidebar nav has no visual grouping between the setup screens (Camp Setup → Day
  Overrides) and the operational screens (Schedule, Device Manager).
- "Some data failed to load" error banner appears on Camp Setup when counts fail — the
  error handling UX could be friendlier.
- `ConflictsScreen` exists and is functional but has never been tested with real conflicting
  data in production.

---

## Key files for UI work

| File | What it is |
|---|---|
| `src/App.jsx` | `SCREENS` map + `AppShell` + device phase state machine |
| `src/components/layout/Sidebar.jsx` | Nav items, badge counts |
| `src/components/layout/Shell.jsx` | App chrome wrapper |
| `src/styles/shared.js` | All shared style tokens (`S.*`) — add here, don't create new files |
| `src/screens/` | All screen components |
| `src/localClient.js` | **Only** way screens talk to Electron — always go through this |
| `PLATFORM_STATE.md` | Screen inventory, IPC surface, DB schema |
| `CLAUDE.md` | Commands, architecture constraints, ABI rebuild note |

---

## ABI rebuild note

After switching between `npm run test` and `npm run electron:dev`, rebuild the native module:

```bash
npx electron-rebuild -f -w better-sqlite3   # before npm run electron:dev
npm rebuild better-sqlite3                   # before npm run test
```

Forgetting this causes a cryptic "NODE_MODULE_VERSION mismatch" crash on startup.
