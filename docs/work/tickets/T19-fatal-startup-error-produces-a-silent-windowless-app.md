---
title: T19-fatal-startup-error-produces-a-silent-windowless-app
document_type: ticket
status: completed
created: 2026-07-29
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T20-install-reports-success-for-an-app-that-cannot-start.md, docs/work/tickets/T12-drag-and-drop-dead.md]
archive_when: resolved
---

> **RESOLVED 2026-07-29.** The startup block in `main.js` is wrapped; a fatal error is now
> reported on three channels — a modal dialog for the director, `startup-error.log` in the
> userData directory for whoever helps them, and stderr plus `app.exit(1)` for a terminal
> launch. Wording lives in `electron/startupFailure.js` so it is testable without Electron.
>
> **Verified against a deliberately broken packaged build**, as this ticket's evidence required:
> the installed app's native module was replaced with garbage, and the app showed
> "Shoresh could not start — Shoresh could not open this camp's schedule file", named the log
> path, and kept the technical detail last. Restoring the module returned it to a clean launch
> with no error log written. Ten unit tests cover the wording and the malformed-error paths.
>
> One behaviour worth knowing: `dialog.showErrorBox` is modal, so a terminal launch now blocks
> until the dialog is dismissed rather than exiting immediately. That is correct for the
> director and surprising for a script.

# T19 — A fatal startup error produces a silent, windowless app

**Risk:** High for diagnosis, not for data. Nothing is corrupted; the app simply does nothing
and says nothing. This is the most expensive failure shape this project has, and it has now
occurred twice from two unrelated causes.
**Found:** 2026-07-29, while installing the T15 build. Observed on a real installed app.

---

## What a user sees

The app is launched. The Dock icon appears, the menu bar says **Shoresh**, and the process
stays alive. There is **no window**. There is no error dialog, nothing on stderr, no entry in
the unified system log, and no crash report in `~/Library/Logs/DiagnosticReports`.

Every ordinary diagnostic returns nothing. The app looks like it is running fine.

## Why it happens

[`electron/main.js:691`](../../../electron/main.js) opens the database at module top level,
inside the `isElectronEntryPoint()` block:

```js
let db = openLocalDb(dbPath)
let deviceId = getOrCreateDeviceId(db)
...
app.whenReady().then(createWindow)     // <- never reached if the above throws
```

`openLocalDb` throwing aborts the rest of the module body, so `createWindow` is never
registered. Electron has nothing to display and no reason to exit, so it sits there. The
rejection is an unhandled top-level ESM error, which Electron does not surface to the user in
a packaged build.

Evidence, obtained by instrumenting the *installed* bundle — the fault was invisible until then:

```
PROBE: main.js loaded
PROBE gate: VITEST=undefined appType=object whenReady=function => true
PROBE THREW: Error: Failed to open local database at
  /Users/…/Application Support/shoresh/shoresh.sqlite: The module
  '…/better_sqlite3.node' was compiled against a different Node.js version using
  NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 148.
    at openLocalDb (…/electron/db/localDb.js:1130:11)
    at …/electron/main.js:691:12
```

That specific cause is [T20](T20-install-reports-success-for-an-app-that-cannot-start.md).
**This ticket is about the silence, not the ABI.** Any future startup failure — a corrupt
database, a missing file, a permissions error, a migration that throws — will present
identically: an app that launches and does nothing.

## Why this is worth fixing rather than tolerating

`scripts/install-macos.sh` already carries a header warning about a *different* cause of
"the app launches, shows no window, logs nothing" (duplicate LaunchServices registration).
That the same symptom now has two independent causes is the point: the symptom is
uninformative, and the project keeps paying to rediscover what is behind it.

The precedent is T12, where a stale build cost two days of investigating plausible-but-wrong
suspects. The lesson recorded in the 2026-07-28 handoff — *doing beat reading, consistently* —
only works if doing it produces a signal. Here it produces none.

A camp director hitting this has no path forward at all. They cannot read a stack trace, and
there is nothing on screen to read.

## Proposal

Confirm the approach before implementing.

1. Wrap the startup block so a throw is caught rather than escaping. On failure, still call
   `app.whenReady()` and show something — either an Electron `dialog.showErrorBox` or a minimal
   error window — naming what failed in director language, with the technical detail available
   but secondary.
2. Never leave the process alive with no window and no message. Either show the error or exit
   with a non-zero code, so a terminal launch reports *something*.
3. Log the failure somewhere durable on disk, so a director can be asked to send a file rather
   than reproduce a silent failure over the phone.
4. Consider whether database opening belongs at module top level at all. Moving it inside
   `whenReady` would let the window exist before the risky work happens, which is what makes a
   visible error possible in the first place.

Note the constraint this must respect: the app runs a real camp, and a startup failure is
exactly when a director is most stuck. Article V — the director is not a software operator —
governs the wording of whatever is shown.

## Completion evidence

1. With a deliberately broken database or native module, launching the app shows a visible,
   plain-language error rather than nothing.
2. Launching the binary from a terminal in that state prints a diagnosable message and exits
   non-zero, rather than hanging silently.
3. A durable log file records the failure.
4. A test covers the failure path — a startup error that is only ever verified by hand will
   regress, as this one did.
5. Verified by deliberately breaking a **packaged** build, not only a dev run. The silence is
   specific to packaging: in dev the same throw is visible in the terminal.
