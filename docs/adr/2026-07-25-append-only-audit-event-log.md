# Append-only audit event log, hooked into authorize()

**Status:** proposed

## Context

§11 of the hardening backlog asks for a durable audit trail of security-relevant
events: who was allowed or denied what, and login success/failure. This app has
no such record today — `authorize()` (`electron/auth/authorize.js`) only
`console.warn`s a denial, which is lost on the next log rotation/restart and is
not queryable.

This app is local-first, single-tenant-per-device-db, with per-device SQLite
(`better-sqlite3`) and a separate `operations` table that op-log-syncs domain
data across devices (see `docs/adr/2026-07-24-centralized-authorization-layer.md`
for the authorize()/permissions design this builds on).

## Decision

1. **New table `audit_events`**, local-only — it does **not** flow through the
   `operations` table or `syncClient`/`syncServer`. Each device accumulates its
   own view of the events it personally witnessed (its own logins, its own
   authorize() calls). Rationale: an audit record of "who was denied what"
   is valuable per-device forensic data on its own, but making it sync
   introduces a trust/tamper problem this slice doesn't need to solve — a
   compromised or buggy client could inject fabricated audit rows into every
   other device's log with no signing or provenance model to catch it. Local-
   only defers that problem instead of building a false sense of integrity
   around synced audit data. This can be revisited in a later slice if
   camp-wide (not just per-device) audit visibility becomes a real
   requirement — that would need its own ADR (append-only guarantees over a
   multi-writer sync channel are a materially different design problem than
   this single-writer local table).

2. **Single writer function**, `recordAuditEvent(db, {...})` in a new module
   `electron/audit/auditLog.js`. It never throws — every failure (bad db
   handle, constraint violation, disk error) is caught internally and
   `console.warn`'d, exactly like `authorize()`'s own existing db-error
   handling. This makes it safe to call from inside `authorize()`'s hot path
   without risk of an audit-log failure corrupting or blocking the actual
   authorization decision it's describing.

3. **`authorize()` is the first real call site.** After `authorize()` has
   already computed its `allowed`/`deny` result via its existing, unchanged
   logic, it calls `recordAuditEvent(...)` once, right before returning, for:
   every denial (any action, any reason), and every allow whose action's
   resource is `users` (i.e. `users.create`/`users.write`/`users.delete` —
   the action-naming convention from the permissions ADR already encodes
   `<resource>.<verb>`, so "is this a user-lifecycle action" is a string
   check, not a new special case). Ordinary allowed reads/writes on
   schedule-domain entities (`groups.write`, `activities.read`, etc.) are
   **not** logged — that would make every UI click loggable noise with no
   forensic value, and is explicitly out of scope for this slice.

   Login success/failure happens in `attemptLogin()`
   (`electron/auth/localAuth.js`), which runs *before* a session token
   exists and therefore cannot be routed through `authorize()` (which
   requires one) by construction. `attemptLogin()` becomes the second call
   site to the same `recordAuditEvent` writer — not a second logging
   mechanism, the same table and function, called from the one other place
   in the codebase where a security-relevant decision is made outside
   `authorize()`'s reach.

4. **Metadata is scrubbed at the writer, not trusted from the caller.**
   `recordAuditEvent` JSON-stringifies a caller-supplied `metadata` object
   into a `TEXT` column, but first strips any key matching a fixed denylist
   (`pin`, `pin_hash`, `pin_salt`, `signing_secret`, `token`) as defense in
   depth — callers must not pass secrets in, but the writer does not trust
   that they won't.

5. **No foreign keys** on `actor_user_id`/`device_id` — a `user_not_found`/
   `device_not_found` denial is exactly the case where the referenced row
   may not exist, and the audit row must still be writable.

6. **Query mechanism is minimal**: a single `listAuditEvents(db, {limit,
   actorUserId, action, outcome})` reader doing a plain indexed `SELECT ...
   ORDER BY id DESC LIMIT ?`. No IPC handler or UI screen is added in this
   slice — nothing consumes it yet (see Open Questions).

## Consequences

- Audit data does not survive a device being wiped/replaced, and two devices'
  audit logs cannot be merged into one camp-wide timeline without a follow-up
  design. This is a deliberate, disclosed limitation, not an oversight.
- `occurred_at` is each device's local wall clock (`new Date().toISOString()`),
  same trust level as every other unsynced local timestamp in this app — good
  enough for per-device forensics, not a tamper-evident or cross-device-
  orderable clock.
- Adding a new logged action later is a one-line change at the `authorize()`
  call site's action-prefix check, not a schema change.
