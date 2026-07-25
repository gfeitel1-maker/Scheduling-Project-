# §11 Audit event log — core mechanism (first slice)

## Problem

`PLATFORM_STATE.md`/the hardening backlog called for a durable, append-only audit
event table capturing (to start) login success/failure, user creation/disable/
role-change, and privileged-action denials, hooked into the already-built
`authorize()` module as the natural interception point rather than a parallel
logging mechanism.

## Design

Full rationale: `docs/adr/2026-07-25-append-only-audit-event-log.md`.

- New table `audit_events` (schema v19, `electron/db/localDb.js`): id, camp_id,
  actor_user_id, device_id, action, target_type, target_id, occurred_at, outcome
  (`allow`/`deny` CHECK), reason, metadata. No foreign keys — denials often
  reference a row that doesn't exist or can't be resolved (`user_not_found`,
  `device_not_found`). Local-only: does not flow through `electron/ops/
  operations.js`/the sync op-log, so remote devices cannot write, forge, or
  replay audit rows.
- New module `electron/audit/auditLog.js`:
  - `recordAuditEvent(db, {...})` — single writer. Never throws (wrapped in
    try/catch, `console.warn`s on failure) so an audit-log write failure can
    never block or corrupt the real authorization decision it's recording.
    Recursively scrubs a fixed secret-key list (`pin`, `pin_hash`, `pin_salt`,
    `signing_secret`, `token`, case-insensitive, plus their camelCase
    variants) from `metadata` before storing, including nested plain objects
    — hardened mid-review after Security flagged the original top-level-only
    scrub as a latent gap.
  - `listAuditEvents(db, {...})` — one parameterized, indexed `SELECT`. No IPC
    handler, no UI screen consumes it yet, per scope.
- Hooked into `electron/auth/authorize.js`: every `deny()` path logs an
  outcome-'deny' row; the final allow return logs only when the action starts
  with `users.` (create/disable/role-change).
- Hooked into `electron/auth/localAuth.js`'s `attemptLogin`: logs
  `action: 'auth.login'` on every branch (locked_out, no_camp, invalid_pin,
  user_not_found, success) since login precedes token issuance and can't
  route through `authorize()`.

## Review findings (all non-blocking, addressed or explicitly deferred)

- **Security (score 4/5, addressed):** metadata scrub was top-level-only and
  didn't guard against arrays/Buffers being treated as key/value bags — fixed
  by making the scrub recursive and gating on `constructor === Object`. SQL
  injection, error-propagation into callers, and sync/op-log tamper vectors
  all confirmed clean.
- **Red Hat (deferred, documented as deliberate non-goals of this slice):**
  no retention/pruning policy (unbounded growth under a sustained deny-flood
  is a real but out-of-scope-for-"core mechanism" risk); local-only history
  means a wiped/replaced device loses its own audit trail with no
  cross-device copy; silent failure mode (a `console.warn` on write failure
  produces no admin-visible alert). Flagged for a future slice, not this one.
- **Code Reviewer (non-blocking style nits):** the v19 migration uses a bare
  `db.exec()` instead of `db.transaction()` like the v17/v18 migrations
  immediately above it (self-healing today via `IF NOT EXISTS`, but a style
  inconsistency for the next person to copy); `deny()` grew to 6 positional
  args with no protection against a future transposed `actorUserId`/
  `deviceId` swap. Both left as-is — real defects, not this slice's fix.

## Testing

`electron/audit/auditLog.test.js` (new): writer field correctness, camp_id
derivation, metadata scrubbing (top-level and nested), non-plain-object
metadata handled safely, non-throwing on a closed/broken db, reader filter
combinations (individual + combined) and limit. `electron/db/
localDb.migrations.test.js`: new "schema v19: audit_events table" block
(table/index creation, CHECK constraint, idempotent re-run, guarded
CREATE-path on a pre-migration db) plus a bulk rename of 21 pre-existing
assertions from `toBe(18)` to `toBe(19)` (see Outcome below).
`electron/auth/authorize.test.js`/`localAuth.test.js`: audit-side-effect
assertions added alongside existing behavioral tests (deny → row exists;
`users.*` allow → row exists, non-`users.*` allow → no row; login
success/failure → row exists with correct reason).

## Outcome

Landed at commit `975f6ff`. Verifier: PASS — full suite 472/472, lint
introduces zero new errors vs. a clean-HEAD baseline (repo has 62 pre-existing
lint problems unrelated to this task, confirmed via `git stash` comparison),
build clean.

A regression surfaced during verification: Maker's schema-version bump to 19
broke 21 pre-existing test assertions across `electron/db/
localDb.migrations.test.js` that hardcoded schema version 18 as "the current
version." Fixed directly (mechanical bulk rename, verified each occurrence
was a "current version" assertion unaffected by the purely-additive
`audit_events` table) rather than looping back through a full Maker round,
since it was a single well-understood mechanical fix with an obvious correct
answer, not a design or logic defect.

## Non-goals (this slice)

- No IPC handler or UI screen to view audit events — the writer/table/query
  mechanism is the full scope; consuming it is a follow-up.
- No audit hooks for features that don't exist yet (device pairing, merge).
- No retention/pruning policy.
- Does not log every allowed action — only denials, `users.*` allows, and
  login events, per the ADR's forensics-not-compliance framing.
