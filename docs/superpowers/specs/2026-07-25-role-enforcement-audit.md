# Full role-based server-side enforcement audit

## Problem

`PLATFORM_STATE.md` flagged role-based enforcement as "not exhaustively audited."
`authorize()` (`electron/auth/authorize.js`) and the permission matrix
(`electron/auth/permissions.js`) exist and are wired into IPC/WS handlers, but no one
had verified the server-side matrix actually mirrors what the renderer's own
admin-vs-staff gating implies — the risk being a renderer-hidden admin-only button
backed by a staff-permitted server action.

## Method

1. Read `electron/auth/permissions.js` in full — every action and its allowed roles.
2. Traced `authorize()` call sites across `electron/main.js` (IPC handlers) and
   `electron/sync/syncServer.js` (WS handlers) to build the action → handler mapping.
3. Grepped every file in `src/screens/*.jsx` for client-side role gating (`role ===`,
   `isAdmin`, `'admin'`, `role.toLowerCase`, conditional rendering keyed on role).
4. For anything found, traced whether the corresponding IPC/WS action goes through
   `authorize()` and whether the required role matches the renderer's implication.

## Findings

**Server-side enforcement: sound.** Every admin-only action (`*.delete`,
`*.bulk_replace`, `users.create`, `camps.rename`) defaults to admin-only via
deny-by-default; every other write is `staff`+`admin`. Every mutating handler in
`main.js` and `syncServer.js` calls `authorize()` — no ungated mutating handler
found. The only unauthenticated routes (`login`, `discoverHosts`, `bootstrapCamp`,
etc.) are pre-session by design.

**Client-side: there is no role-based UI gating at all.** Zero hits for
`role ===`/`isAdmin`/`'admin'`/`role.toLowerCase` across all 15 screen files. The
renderer never persists the logged-in user's role after login. Admin-only buttons
(delete, bulk_replace, regenerate schedule, create user, etc.) render identically for
staff and admin; the only "gating" is reactive — each screen catches the IPC
rejection afterward and regexes the error message (`/admin role required/i`) to show
a friendlier toast. Confirmed at: `ActivitiesScreen.jsx:351-352`,
`AnchorsScreen.jsx:351-352`, `DaysScreen.jsx:157-158`, `GroupsScreen.jsx:188-189`,
`TiersScreen.jsx:228-229`, `TimeBlocksScreen.jsx:229-230`,
`DayOverridesScreen.jsx:337-338`, `ScheduleScreen.jsx:221-222,451-452,526-527`.

**Consequence:** because there is no hidden-button UI gate to compare against, the
"staff bypasses a renderer-hidden admin button via devtools" scenario this audit set
out to catch is moot — there is nothing to bypass. A staff user clicking a visible
button or calling the IPC/WS channel directly from devtools hits the identical
`authorize()` rejection either way, since the renderer never conditionally hides
anything. **0 security gaps found. 0 reverse UI-bugs (server stricter than UI
implies, but UI still correctly surfaces the resulting rejection) found.**

## Outcome

No code changes required — the security property this audit exists to guarantee
(server-side enforcement can't be bypassed by a client that hides its own controls)
already holds, trivially, because the client doesn't hide controls at all.

## Follow-up (out of scope for this task, flagged not actioned)

Staff currently see and can click admin-only buttons that will always fail server-side.
The 9 screens' "friendly error" mapping depends on regex-matching the literal string
thrown by `authorize()`'s rejection path — if that string changes, all 9 silently
degrade to a generic error with no test coverage linking them together. A follow-up
ticket (add a persisted client-side role check + conditional rendering of admin-only
controls) would improve UX and reduce this string-coupling fragility, but is a UX/
maintainability improvement, not a security fix — this run's mandate explicitly scoped
role audit to server-side-matrix-vs-UI-implication verification, not UI redesign.

## Non-goals

- Not adding persisted client-side role state or conditional rendering — flagged
  above as a follow-up, not executed this run.
- Not re-auditing `authorize()`'s own internal logic (deny-by-default, db-error
  handling) — that was covered by the Phase 2 authorization-layer work
  (`docs/superpowers/specs/2026-07-21-phase2-authorization-layer-design.md`).
