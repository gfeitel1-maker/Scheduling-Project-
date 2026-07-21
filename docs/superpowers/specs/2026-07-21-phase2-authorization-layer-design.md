# Phase 2 — Centralized authorization layer

Source: `SHORESH_LOCAL_FIRST_HARDENING.md` §4 (Phase 2 of the hardening plan). Depends on Phase 1 having landed (Supabase path removed/lint-banned) so this work is unambiguously the only auth model in the codebase. Device pairing/revocation (hardening plan §5, "Phase 3") is explicitly deferred — this phase does NOT add device-authorization state, pairing flows, or token-lifetime/expiry changes. It only closes the gap that privileged actions are currently authorized by client-side role checks instead of being independently re-checked at the trust boundary.

## Problem

Today, `users.role` (`'admin'|'staff'`) is the only role concept, and it is enforced in exactly one place server-side: `createUserHandler` in `electron/main.js` (confirmed admin-gated). Every other privileged-feeling action — camp/tier/group/activity/timeblock/anchor/cohort/dayoverride writes, schedule generation, conflict resolution — has no confirmed server-side role check. A `staff` role in the renderer could, in principle, invoke any IPC method directly (bypassing a disabled button — Electron's `contextBridge` API surface is available to any script running in the renderer, not gated by what buttons are visible) and have it succeed.

This is the same class of "trust the client" problem this project has already fixed once, differently: `verifySessionToken` proves *who you are*, but nothing today re-derives *what you're currently allowed to do* from the database at the moment of the call. A role change (staff → disabled, or admin → staff) does not take effect until some future action independently re-checks it — and right now nothing does, for anything but user creation.

## Solution

### Central permission-check module

New file: `electron/auth/authorize.js`.

```js
export function authorize({ db, token, action, resourceId }) {
  // 1. verify token signature + shape (reuse verifySessionToken(db, token))
  // 2. verify user still exists (re-query users table by decoded userId — do not trust userId from a cached/passed-in value)
  // 3. verify device still exists (re-query devices table by decoded deviceId)
  // 4. resolve the user's CURRENT role from the users table (never from the token payload)
  // 5. look up action in the permission matrix for that role
  // 6. return { allowed: true, userId, deviceId, role } or { allowed: false, reason }
}
```

Deliberately scoped down from the hardening doc's full 8-point list for this phase:
- Token expiration (point 2 in the hardening doc's §4.1) is NOT implemented here — tokens remain non-expiring in this phase, consistent with there being no token-lifetime work until the deferred device-trust phase. `authorize()` should be written so that adding an expiry check later is a small addition (check an `exp`/`issued_at` field if present), not a redesign — but do not add the field or the check now.
- Device-authorization-state check (hardening doc's point 4, "verify device is still authorized") is scoped down to "verify device still exists in the `devices` table" — there is no `authorized_at`/`revoked_at` concept yet (that's Phase 3/deferred). Structure the check as its own step so it's a one-line change to add real revocation later without touching the rest of `authorize()`.

This keeps the module honest about what it actually guarantees today versus what's deferred — do not let it silently claim revocation support it doesn't have.

### Named permission matrix

A plain object/module, not a database table (matches the size of this problem — small, fixed, changes rarely, and needs no dynamic admin UI in this phase):

```js
// electron/auth/permissions.js
export const PERMISSIONS = {
  admin: ['*'],  // or explicit list — Maker's call, but must be auditable (see acceptance criteria)
  staff: [
    'camp.read', 'users.read',
    'tiers.read','tiers.write', 'groups.read','groups.write',
    'timeblocks.read','timeblocks.write', 'activities.read','activities.write',
    'anchors.read','anchors.write', 'cohorts.read','cohorts.write',
    'dayoverrides.read','dayoverrides.write',
    'schedule.read','schedule.write','schedule.generate','schedule.lock','schedule.snapshot',
    'conflicts.read','conflicts.resolve',
  ],
}
```

Exact staff/admin split for each named action is a genuine product decision the Maker should surface rather than silently invent, EXCEPT for the two already-decided cases: `users.create`/`users.update`/`users.disable` remain admin-only (matches existing `createUserHandler` behavior — do not weaken it), and everything currently reachable by both roles in the live app today (schedule editing, conflict resolution) must remain reachable by both roles after this change — this phase is about adding enforcement, not changing who can currently do what. If the Maker is unsure whether an existing screen is admin-only or shared today, check `src/screens/*.jsx` and `src/hooks/useDeviceMode.js` for any existing client-side role gating before guessing.

Use named actions, not scattered `role === 'admin'` string checks, exactly as the hardening doc specifies in §4.2 — this makes a future permission change a one-line matrix edit instead of a grep-and-patch across handlers.

### Enforcement at every write boundary

Audit and wrap:
- Every Electron IPC handler in `electron/main.js` that mutates data (`write`, `createUser`, `resolveConflict` — confirm the full list by reading the file, do not assume this list is exhaustive).
- Every WebSocket message handler in `electron/sync/syncServer.js` that mutates data (`submit_op`, `acquire_lock` — again, confirm against the actual file).
- The existing `login`/`authenticate` message handlers do NOT get wrapped in `authorize()` — they are how a token is obtained/validated in the first place, not an action requiring a pre-existing token. Read-only handlers (`getCamp`, `listUsers`, `listPendingConflicts`) should still call `authorize()` with a `*.read` action rather than being left unchecked, since the hardening doc's acceptance criteria requires unknown actions/resources to be denied by default — an unaudited handler is exactly the gap this phase closes.

**Critical constraint carried over from this project's own history (see memory: all synced-entity writes must route through `syncClient.write`, never call `appendOp` directly):** `authorize()` must be called at the actual mutation entry point (the IPC/WS handler), not duplicated inside `syncClient.write`/`appendOp` — those are lower-level primitives shared across many entity types and don't have "action" context. Getting this placement wrong (e.g. trying to authorize inside `appendOp`) was exactly the kind of layering mistake that took 3 rounds to fix for the `createUser`-bypasses-sync bug earlier in this project; don't repeat that shape of error in the authz layer itself.

### Renderer role checks stay, but are relabeled as UX-only

No renderer code needs to be removed — disabling/hiding a button for `staff` is legitimate usability behavior. The design intent is only that the renderer's checks must never be the ONLY thing standing between a `staff` token and a privileged write. Maker should not spend effort auditing/rewriting renderer-side role checks in this phase; that's explicitly out of scope.

## Out of scope for this phase

- Device pairing, approval, revocation, `authorized_at`/`revoked_at` fields (hardening doc §5) — deferred to a later phase.
- Token expiration/lifetime, token renewal (hardening doc §5.4) — deferred.
- Any change to the shared-camp-signing-secret token-minting model (hardening doc's "Preferred cryptographic direction," §5) — deferred; this phase does not touch how tokens are issued, only how they're checked against current DB state before a privileged action.
- Raw PIN transmission (§6.3) — untouched, per the same scoping decision as Phase 1.
- Audit-event logging (hardening doc §11) — a natural follow-on to this phase (an `authorize()` call is the natural place to hang an audit-log write later) but not built here. If it's cheap/obvious to add a single structured log line inside `authorize()` for denied attempts without building the full audit-event-stream infrastructure, Maker may do so — but the full `audit_events` table/export flow is a separate future phase, not this one.

## Testing plan

1. **Unit tests for `authorize()`:** valid admin token + admin-only action → allowed; valid staff token + admin-only action → denied; valid token but user row deleted since token issued → denied; valid token but device row deleted → denied; unknown action string → denied (default-deny, not default-allow); malformed/missing token → denied without throwing.
2. **Per-handler authorization tests:** for every wrapped IPC handler and every wrapped WS message handler, a test proving a `staff`-role token is rejected for an admin-only action, and accepted for a staff-permitted action. This should cover every handler in the audited list from the design doc's "Enforcement at every write boundary" section — a missing test here is a real gap, not a formality (mirrors the hardening doc's acceptance criterion "authorization tests cover every registered write handler").
3. **Role-change-takes-effect test:** issue a token for an admin user, then flip that user's `role` to `staff` directly in the DB (simulating an admin having been disabled elsewhere), then confirm the SAME still-valid token is now denied for an admin-only action on the very next call — proving `authorize()` re-reads role from the DB rather than trusting anything cached in the token payload. This is the single most important test in this phase; it's the concrete proof of the problem statement's core claim.
4. **Existing-behavior-preserved test:** every action currently reachable by both `admin` and `staff` in the live app (schedule read/write, conflict read/resolve) remains reachable by both after this change — a regression here (accidentally admin-gating something staff currently uses) is a real product break, not just a security nitpick, and should be checked explicitly, not assumed from the permission matrix reading correctly.
