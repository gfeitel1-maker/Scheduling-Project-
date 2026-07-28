> **ARCHIVED — historical record, not current authority.**
> Completed design spec. Records a decision as made at its date, not the current system.
> Current law: [`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md)

# §6.4 Sensitive logging audit

## Problem

No secret — raw PINs, PIN hashes/salts, `camps.signing_secret`, session tokens, device
secrets — should ever appear in any log. The `73906b7` LoginScreen fix added a new
`console.error('[login] onSubmit rejected:', err)` call and nothing had audited the
existing call sites since.

## Method

Enumerated every `console.log`/`console.error`/`console.warn` call across `electron/`
and `src/` (excluding test files):

```
grep -rn "console\.\(log\|error\|warn\)" electron/ src/ --include="*.js" --include="*.jsx" | grep -v "\.test\."
```

17 call sites found. For each, traced the logged value (or, for `Error` objects, the
originating throw site) back to its source, with particular attention to the
PIN/session-token surface: `electron/auth/localAuth.js` (`attemptLogin`,
`issueSessionToken`/`verifySessionToken`), the WS `login` message handler in
`electron/sync/syncServer.js`, and the IPC `login` handler in `electron/main.js`.

Independently re-run by a dedicated Security agent dispatch (foreground), which
re-derived the same 17 call sites from a fresh grep and traced each one itself rather
than trusting the initial summary.

## Findings

**PASS — no leaks found.** Full breakdown:

- `electron/auth/localAuth.js` has zero `console.*` calls. `attemptLogin` /
  `verifyPin` / `hashPin` never throw errors that embed the raw pin, hash, or salt —
  the only thrown error (`assertValidPin`) has a static message. `signing_secret` is
  only read in `getSigningSecret()`/`sign()`, never logged or included in a thrown
  message.
- `electron/main.js`'s `login()` IPC handler passes `{ name, pin }` straight into
  `attemptLogin`/`loginRemote` without logging it; its own thrown errors are static
  strings (`'name and pin are required'`).
- `electron/sync/syncServer.js` / `syncClient.js` have no `console.*` calls at all;
  the WS `login` handler sends the token over the socket (not to a log).
- `electron/main.js:501` (`console.error('PRELOAD ERROR', preloadPath, error)`) fires
  on Electron's `preload-error` event — unrelated to auth.
- `electron/auth/authorize.js:42,63` logs `action`/`role`/`reason`/`err.message` from
  the authorization gate — no secrets.
- `electron/ops/projections.js:252` logs entity/field/value for a `camp_id` mismatch
  rejection — a camp id, not a secret.
- The 12 UI screen call sites (`TimeBlocksScreen`, `LoginScreen`, `DaysScreen`,
  `ScheduleScreen`, `GroupsScreen`, `DayOverridesScreen`) all log CRUD/import/save
  failure `err` objects from IPC calls unrelated to the PIN, or — for
  `LoginScreen.jsx:47`'s `console.error('[login] onSubmit rejected:', err)` — from
  `useDeviceMode.js`'s `login()` callback, whose only failure mode is
  `localClient.login(name, pin)` rejecting with an IPC/network-level `Error` that
  does not embed the pin string.

## Outcome

No code changes required. This audit is the deliverable: it establishes (as of
commit `947c545`) that the sensitive-logging invariant already holds across the
codebase, and gives future PRs a concrete checklist (grep command above + the
PIN/token trace path) to re-run when new logging is added near auth/sync code.

## Non-goals

- Did not add lint rules or CI enforcement to prevent future leaks — flagged as a
  possible follow-up, not in scope for this pass.
- Did not audit log *storage* (e.g. Electron's own crash-reporter, OS-level stdout
  capture) — scope was application-level `console.*` call sites only, per the backlog
  item's wording.
