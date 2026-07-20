# Shoresh Local-First Desktop Architecture — Design

**Date:** 2026-07-19
**Status:** Approved (design phase) — implementation plan not yet written

## Context

Shoresh is currently a React 19 + Vite frontend backed by hosted/local-Docker Supabase (Postgres + RLS + auth). The strategic goal is to reposition Shoresh as a downloadable, persistent desktop application — competitive with Camptivities/Campanion — that a camp installs and runs on its own hardware, similar in distribution model to TurboTax or Word: install once, data lives locally, and multiple staff on the camp's own network can access and update the same schedule.

This is a **full replacement** of the hosted Supabase architecture, not an additional deployment mode. There is no existing customer data on the hosted version that needs migration — this is a clean-slate rebuild of the data layer. The existing schedule engine (`buildSchedule.js`) and UI are reused as-is; only the data/auth/sync layer changes.

This spec covers the foundational architecture only. Feature-level competitive work (closing gaps vs. Camptivities/Campanion) is a separate, later sub-project that will build on top of this foundation.

## Decisions Locked In

- **Distribution:** Electron desktop app (single codebase, reuses existing React UI).
- **Roles:** Every install can run as **Host** or **Client**. One machine per camp acts as Host and holds the authoritative SQLite database; other staff devices on the same LAN run as Clients.
- **Discovery:** Host is discovered on the LAN automatically (mDNS/Bonjour) — no manual IP entry.
- **Storage:** SQLite (local file), no Docker/Postgres dependency, no cloud dependency.
- **Auth:** Local named accounts + PIN. Host maintains the user list (name, PIN hash, role: admin/staff). Clients authenticate against the Host when connected; per-user attribution is preserved for all edits.
- **Conflict model:** Hybrid.
  - **Online:** Host grants a per-record lock before an edit is accepted — true conflicts cannot occur while connected.
  - **Offline:** edits queue locally as an operation log. On reconnect, if two devices produced conflicting ops on the same field since their last common sync point, both are materialized as named versions (e.g. "Sarah's version" / "Tom's version") and surfaced in a merge UI for a human to resolve — never silently auto-merged or overwritten.
- **Sync engine:** Operation-log based (Option A from design discussion), not whole-file snapshot diffing and not lock-only-no-offline-editing. Every edit is an appended, attributable, timestamped operation, not just a row overwrite. This is what makes the online-lock / offline-branch-and-merge behavior above actually implementable, and gives a full audit trail for free.

## Components

| Component | Responsibility |
|---|---|
| `local-db` | SQLite schema mirroring current tables (camps, groups, tiers, template_slots, activities, anchors, snapshots, overlays) plus new tables: `operations`, `users`, `devices`, `locks`. |
| `sync-server` | Runs inside the Host's Electron main process. Accepts client connections, applies/broadcasts ops, grants/releases locks, advertises itself via mDNS. |
| `sync-client` | Runs in every instance (including the Host, talking to itself locally). Sole interface the app uses to read/write data. Queues ops when offline; replays and reconciles on reconnect. |
| `auth-local` | Replaces `useSession()`. Host maintains the user list and issues a per-device session token after PIN check. No internet required. |
| `merge-ui` | New screen, shown only when sync-client detects conflicting offline ops on the same field. Displays both named versions side by side; user picks or hand-merges. |
| `engine` (`buildSchedule.js`) | Unchanged — pure function, only its data source changes. |

## Data Flow

1. UI action → `sync-client.write(op)`.
2. If online: request lock from Host → Host grants/denies → on grant, op appends to Host's `operations` table → Host broadcasts op to all connected clients → each client applies the op to its local SQLite → UI updates via existing React state (optimistic already reflected locally).
3. If offline: op appends to the local queue immediately (optimistic UI) and syncs when the client reconnects to the Host.
4. New device joining mid-season: full initial snapshot transfer, then switches to incremental op-log sync.

## Error Handling & Edge Cases

- **Host goes offline/quits mid-session:** clients keep working locally (queue ops); reconnect and sync automatically when Host returns. No data loss, no crash.
- **Conflicting offline edits:** detected via common-ancestor op comparison at sync time; surfaced in `merge-ui`, never silently dropped or overwritten.
- **Lock requested but Host unreachable:** client falls back to the offline-queue code path automatically; UI shows a subtle "working offline" indicator rather than blocking the user.
- **PIN auth failure:** standard retry/lockout; no cloud dependency to fail.

## Testing Strategy

- `buildSchedule.js` unit tests carry over unchanged.
- New unit tests for op-log apply/merge logic (pure functions — deterministic and easy to test) and for lock acquisition/release.
- Multi-device sync tested via an in-process harness spinning up 2–3 SQLite instances simulating Host + Clients (no real network needed for CI).
- Manual LAN testing on real machines specifically for mDNS discovery, since that can't be simulated in-process.

## Out of Scope (for this spec)

- Feature-level competitive parity work (vs. Camptivities/Campanion) — separate future sub-project.
- Any data migration/import tooling — not needed, no existing hosted-version customer data.
- Update/patch delivery mechanism for the Electron app itself (auto-update) — to be addressed when we get closer to distribution.
