# Centralized authorization layer: `authorize()` + named permission matrix

**Status:** accepted

## Context

Today `users.role` (`'admin'|'staff'`) is enforced ad hoc: `createUserHandler` checks `sessionUser.role !== 'admin'` inline, `write()` re-queries the role twice more for the `DELETE_FIELD` sentinel and `camps.name`, and `bulkReplace()` does it again — four separate inline `db.prepare('SELECT role FROM users WHERE id = ?')` + string-comparison blocks in `electron/main.js`, each hand-written, each a place a future entity/action could be added and the check simply forgotten. No WebSocket handler in `electron/sync/syncServer.js` checks role at all. Every other privileged action (schedule generation, conflict resolution, tier/group/activity/timeblock/anchor/cohort/day-override writes) has no server-side role check whatsoever — it only "looks" gated because the renderer disables a button, which `contextBridge` does not actually prevent a script from bypassing.

This is a new contract every future IPC/WS handler will be written against, and it changes where the source of truth for "is this action allowed" lives (from scattered inline checks to one matrix). That meets the ADR bar: it's a decision other modules will depend on and isn't obviously reversible once handlers are wired against named actions instead of inline checks (undoing it means re-scattering the checks).

## Decision

Add `electron/auth/authorize.js` exporting a single function:

```js
export function authorize({ db, token, action, resourceId }) {
  // returns { allowed: true, userId, deviceId, role }
  //      or { allowed: false, reason }
  // never throws on malformed/missing input
}
```

Algorithm (all 6 steps from the design doc, no shortcuts):

1. Verify token shape/signature via `verifySessionToken(db, token)` (existing function, unchanged). `null`/malformed token → `{ allowed: false, reason: 'invalid_token' }`.
2. Re-query `users` by `session.userId` (`SELECT id, role FROM users WHERE id = ?`). No row → `{ allowed: false, reason: 'user_not_found' }`. This is the step that makes a role change or a deleted user take effect on the very next call — role is never read from the token payload, which only ever contained `{ userId, deviceId }` (see `issueSessionToken`) and never carried role in the first place, so there is nothing to accidentally trust there; the discipline this ADR fixes is inline callers re-querying it correctly but inconsistently, which `authorize()` now does exactly once, centrally.
3. Re-query `devices` by `session.deviceId` (`SELECT id FROM devices WHERE id = ?`). No row → `{ allowed: false, reason: 'device_not_found' }`. Written as its own isolated step (a single `if` block) specifically so a future revocation check (`authorized_at`/`revoked_at`, Phase 3, deferred) is a one-line addition to this block, not a redesign.
4. Resolve `role` from the step-2 row (never from `session`/token payload).
5. Look up `PERMISSIONS[role]` in the matrix from `permissions.js`; if the role itself is unrecognized, or the matrix entry doesn't include `action` (and doesn't include `'*'`), → `{ allowed: false, reason: 'forbidden' }`. Unrecognized `action` strings default-deny the same way (there is no "action not found in matrix, so allow" branch anywhere in this function).
6. Otherwise → `{ allowed: true, userId: session.userId, deviceId: session.deviceId, role }`.

`resourceId` is accepted in the signature (per the design doc) but unused by any check in this phase — there is no per-resource ownership model yet, only role-based matrix lookup. It's there so Task 2/3 call sites and any future per-resource rule don't require an `authorize()` signature change.

A single `console.warn`-level log line on the `allowed: false` path (action + role + reason, no PIN/token material) is acceptable per the design doc's "cheap optional log line" allowance; no audit-event table, no structured log pipeline — that's explicitly deferred.

Add `electron/auth/permissions.js` exporting `PERMISSIONS`, a plain object keyed by role, valued by an array of action-name strings (`'*'` for admin as shorthand for "every action"). Default-deny is enforced in `authorize()`'s lookup, not by listing every action for every role.

### Action-naming scheme

`<resource>.<verb>`, all lowercase, resource names match the entity/table names already used elsewhere in this codebase (`DIRECT_CAMP_ENTITIES`, `PARENT_SCOPED_ENTITIES`, WS message payload shapes) wherever such a name already exists, so Task 2/3 don't have to invent a mapping — they look one up.

Verbs used: `read`, `write` (create+update, matches the existing `write()` handler's ungated default path), `delete` (matches the existing `DELETE_FIELD`-gated path — kept distinct from `write` because today's admin-only delete gate must not be weakened, and folding delete into `write` would either weaken it for staff or wrongly admin-gate ordinary field edits), plus a small number of verbs for actions that aren't CRUD (`generate`, `lock`, `snapshot`, `resolve`, `discover`, `bootstrap`, `login`).

Full action list, mapped against every handler named in the task brief:

**IPC (`electron/main.js`)**
| Handler | Action(s) |
|---|---|
| `shoresh:choose-mode` | `mode.choose` |
| `shoresh:discover-hosts` | `hosts.discover` |
| `shoresh:login` | *(not wrapped — obtains a token)* |
| `shoresh:create-user` | `users.create` (admin-only) |
| `shoresh:bootstrap-camp` | `camp.bootstrap` (no existing session yet — Task 2 must decide how a pre-auth handler fits `authorize()`'s token-required shape; noted below as an open question, not solved here) |
| `shoresh:write` | `<entity>.write` for ordinary fields, `<entity>.delete` when `field === DELETE_FIELD`, `camps.rename` when `entity === 'camps' && field === 'name'` — three distinct actions dispatched from one handler, matching the three distinct inline checks that exist today |
| `shoresh:bulk-replace` | `<entity>.bulk_replace` (admin-only for every entity, matching today's whole-handler admin gate) |
| `shoresh:verify-session` | *(not wrapped — token validation itself, same category as login)* |
| `shoresh:get-camp` | `camp.read` |
| `shoresh:list-users` | `users.read` |
| `shoresh:list` (per entity) | `<entity>.read`, one per allowlisted entity in `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES` |
| `shoresh:get-device-id` | `devices.read` |
| `shoresh:resolve-conflict` | `conflicts.resolve` |
| `shoresh:list-conflicts` | `conflicts.read` |

**WS (`electron/sync/syncServer.js`)**
| Message type | Action(s) |
|---|---|
| `authenticate` | *(not wrapped)* |
| `login` | *(not wrapped)* |
| `acquire_lock` | `<entity>.write` (a lock is acquired as a precondition to a write on that entity/field — reuses the entity's existing write action rather than inventing a `locks.*` namespace, since a staff member who can write an entity must also be able to acquire its lock, and there is no independent "locking" privilege concept in the product today) |
| `submit_op` | `<entity>.write` / `<entity>.delete` — same dispatch as `shoresh:write` above, since `submit_op`'s `msg.op` carries the same `{entity, field, ...}` shape |
| `submit_bulk_replace_op` | `<entity>.bulk_replace` — same as `shoresh:bulk-replace` |

Concrete per-entity `<entity>.write`/`<entity>.delete`/`<entity>.bulk_replace`/`<entity>.read` actions, generated mechanically from `DIRECT_CAMP_ENTITIES` ∪ `PARENT_SCOPED_ENTITIES` ∪ `{users, camps, devices, conflicts}`: `groups`, `tiers`, `activities`, `cohorts`, `days_of_operation`, `time_blocks`, `anchor_activities`, `schedule_templates`, `day_override_templates`, `template_slots`, `template_overlays`, `schedule_snapshots`, `day_override_template_slots`. (`schedule.*`/`conflicts.*` actions named in the design doc's illustrative matrix map onto `schedule_templates.*`/`schedule_snapshots.*`/`conflicts.*` here, using this repo's actual table names instead of the doc's shorthand — Task 2's Maker should use the table-name form above, not the doc's `schedule.generate`/`schedule.lock` shorthand literally, since `schedule_templates`/`schedule_snapshots`/`template_slots` are the real write surfaces for schedule generation/locking/snapshotting in this codebase.)

### Matrix content (staff/admin split)

- `users.create`, `users.update`, `users.disable` (the last two don't exist as handlers yet, named per the design doc for forward-completeness only) — **admin-only**. Matches `createUserHandler`'s existing gate; do not weaken.
- `<entity>.delete` for every entity, `<entity>.bulk_replace` for every entity, `camps.rename` — **admin-only**. Matches the three existing inline gates in `write()`/`bulkReplace()` exactly (delete, camps.name, whole bulk-replace handler are all admin-only today, confirmed by reading `electron/main.js` lines 222-329 and the `admin role required` error-string checks throughout `src/screens/*.jsx`, which exist precisely because staff already hits this gate today for deletes and bulk-replace/schedule-generation).
- `<entity>.write` (ordinary field create/update, non-delete) for every entity, `<entity>.read` for every entity, `users.read`, `camp.read`, `devices.read`, `hosts.discover`, `conflicts.read`, `conflicts.resolve`, `mode.choose` — **staff + admin**. Matches `write()`'s existing ungated default path (only `DELETE_FIELD` and `camps.name` are gated; every other field write is reachable by both roles today) and matches there being no existing role check anywhere on `list`/`getCamp`/`listUsers`/`getDeviceId`/`resolveConflict`/`listPendingConflicts`/`discoverHosts` — staff can call all of these today, so this phase's default-deny-then-explicitly-grant must explicitly grant them to staff, not accidentally admin-gate something staff currently uses (the design doc's testing-plan item 4 exists specifically to catch this class of regression).
- `camp.bootstrap` — pre-auth by nature (no user/camp exists yet); see open question below.

`PERMISSIONS.admin = ['*']` (shorthand meaning every action, per the design doc's suggestion) so the admin row never needs updating when a new entity/action is added — only the staff array needs a deliberate per-action decision, which keeps "should staff get this new action" a visible one-line code-review question instead of a silent default.

## Consequences

- New files: `electron/auth/authorize.js`, `electron/auth/permissions.js`. No existing file changes in this task (Task 1 only — wiring is Task 2/3).
- Establishes the action-naming contract Task 2/3 must use verbatim; a Task 2/3 Maker inventing a different name for the same handler (e.g. `schedule.generate` instead of `schedule_templates.bulk_replace`) would fragment the matrix — this ADR is the canonical mapping.
- Does not implement token expiry, device revocation, or audit-event storage — `authorize()`'s device-check is deliberately isolated to a single step so those can be added later without touching the rest of the function (see design doc, out-of-scope section).
- `bootstrap-camp`'s fit into a token-required `authorize()` call is left as an open question for Governor/Task 2 (see below) rather than decided here, since it's a product/flow question (should bootstrap remain wholly outside `authorize()`, like `login`, or does a not-yet-existing-camp need a different check shape) not a technical one this task can resolve unilaterally.
