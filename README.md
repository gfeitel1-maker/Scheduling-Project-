# Shoresh

Shoresh helps camps control, adapt, and own their scheduling logic.

It's the adaptive scheduling layer for camps that outgrow spreadsheets but don't want to surrender their operational judgment to a black-box platform.

---

## The problem

Camp scheduling is a constraint satisfaction problem dressed up as a logistics problem. A typical week involves groups with different availability windows, activities with location capacity and eligibility rules, anchors that can't move, frequency goals, and preferences like “swimming should happen before Wednesday.”

Spreadsheets break down fast. Black-box tools make decisions you can't see or override. Shoresh sits in between — it handles the constraints and surfaces the conflicts, but you stay in control.

## What it does

You define the rules: groups, tiers, time blocks, activities, anchors, and constraints. The engine builds a schedule that respects all of them, then flags what it couldn't satisfy. From there you adjust, lock, drag, and iterate — the schedule is yours to own.

- **Schedule engine** — deterministic, constraint-aware, runs in milliseconds
- **Drag-and-drop editing** — swap slots between groups directly on the grid
- **Flag system** — surfaces unfillable slots, underserved activities, weather risk, and distribution gaps
- **Locking** — protect decisions that shouldn't change across regenerations
- **Snapshots** — named versions with auto-save before every regeneration
- **Local-first** — each camp's data lives in its own on-device SQLite database, isolated by design

## Architecture

Shoresh is a local-first desktop app built on Electron and SQLite. Each device runs its own
SQLite database. One device acts as the LAN "Host" — it runs a WebSocket server and is the
authoritative source of truth. Other devices are "Clients" that discover the Host via mDNS
and sync over the local network (`ws://`). There is no cloud backend, no Postgres, no
Supabase — everything lives on-device.

Device access is gated by a pairing flow: a new Client sends a `pairing_request` over the
WebSocket; an admin approves it in the Device Manager screen; the Host mints a
`device_secret_identifier` for that device. After pairing, a Client's offline sessions are
backed by a local HMAC token; online sessions use a Host-minted Ed25519 camp token.

See [`PLATFORM_STATE.md`](PLATFORM_STATE.md) for the full architecture, screen inventory,
and database schema. See [`SECURITY.md`](SECURITY.md) for the security model and known
limitations.

## Security model

Shoresh is designed for a **trusted private LAN** — a known group of collaborators on a
network they control (camp office Wi-Fi, a direct switch, etc.).

- **Device pairing gate**: every new device must be explicitly approved by an admin before
  it can sync or log in.
- **Ed25519 camp tokens**: session tokens for network use are signed exclusively by the
  Host's private key (Ed25519). Clients can verify but never mint them.
- **Device-scoped local tokens**: offline Client sessions use a per-device HMAC secret
  (`device_secret_identifier`) minted at pairing time.
- **Centralized `authorize()`**: every mutating IPC and WebSocket handler calls a single
  authorization primitive that re-derives the user's role from the database on every call.
- **Audit log**: auth events and denied calls are written to the `audit_events` table.

**This system is not designed for public internet hosting, open Wi-Fi, or enterprise
identity requirements.** See `SECURITY.md` for explicit limitations and things that are
deliberately out of scope.

## Status

Active development. Used internally at Shoresh camp.

Self-hosting guide and contributing guidelines coming with the first stable release.

## Tech

React 19 · Vite · Electron · better-sqlite3 · @dnd-kit · Vitest
