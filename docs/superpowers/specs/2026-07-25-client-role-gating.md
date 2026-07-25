# Client-side role gating for admin-only controls

## Problem

`docs/superpowers/specs/2026-07-25-role-enforcement-audit.md` found server-side
enforcement (`electron/auth/authorize.js` + `permissions.js`) sound, but the renderer
never persists the logged-in user's role and never conditionally renders admin-only
controls. 9 screens instead regex-match the IPC rejection string
(`/admin role required/i`) after a staff user clicks a button that will always fail:
`ActivitiesScreen.jsx`, `AnchorsScreen.jsx`, `DaysScreen.jsx`, `GroupsScreen.jsx`,
`TiersScreen.jsx`, `TimeBlocksScreen.jsx`, `DayOverridesScreen.jsx`,
`ScheduleScreen.jsx` (3 sites: delete/bulk-replace/regenerate).

This is a UX/maintainability fix, not a security fix — server-side `authorize()`
already fully covers the security property. Client-side role must never be trusted
for actual enforcement; it only decides what's rendered/enabled.

## Success predicate

- `role` is returned already by `login`/`verifySession` IPC (confirmed:
  `electron/main.js` login/verifySession, `electron/auth/localAuth.js` attemptLogin,
  `electron/sync/syncClient.js` loginRemote all already include `role` in their
  response payload — no backend change needed).
- `useDeviceMode.js` captures `role` from `login()`'s result and `verifySession()`'s
  result on the pre-login token-restore path, persists it (mirroring how `token` is
  persisted to localStorage — role can be re-derived via verifySession on reload, or
  cached the same way `token` is; Maker's call which, document reasoning), and
  exposes it in the returned object.
- `App.jsx` threads `device.role` into `AppShell` and down through `SCREENS` props
  the same way `campId` already flows (see `AppShell`'s `commonProps`/screen prop
  spread).
- All 9 admin-only control sites (8 files, `ScheduleScreen.jsx` has 3) render the
  control disabled (not hidden — keeps layout stable, allows a tooltip/title
  explaining why) when `role !== 'admin'`, using a shared disabled-button style
  token from `src/styles/shared.js` (add one if none exists).
- The regex-based `/admin role required/i` catch-block branches are replaced with a
  generic-but-real error message for the rare race/bug case (role changed
  mid-session, or a bug lets a disabled control still fire) — NOT deleted outright,
  NOT still doing string-matching as the primary path.
- `npm run test` and `npm run lint` pass.
- No change to `electron/**` (server-side) files.

## Non-goals

- Does not touch `electron/auth/authorize.js` / `permissions.js` (already correct
  per the audit).
- Does not add new IPC/WS payload fields (role already present).
- Does not hide controls entirely (disable, for layout stability and discoverability
  of the admin-only nature of the action) — Maker may deviate with reasoning if a
  specific control genuinely reads better hidden (e.g. an admin-only nav item), but
  default is disabled+tooltip.

## Plan

**Task 1 (plumbing):** `src/hooks/useDeviceMode.js` role capture + `src/App.jsx`
threading + `src/styles/shared.js` disabled-button token (if missing). Small,
reviewable independently.

**Task 2 (screens):** apply the pattern across all 9 sites. Batched as one Maker
round since the pattern is identical per audit doc line refs; if diff proves too
large/inconsistent, split by screen in a follow-up round.

Both tasks reviewed together in one Tester/Security/RedHat/CodeReviewer pass since
Task 2 depends entirely on Task 1's shape and reviewing them separately would just
mean re-reading Task 1 twice.
