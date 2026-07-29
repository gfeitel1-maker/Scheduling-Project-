---
title: T20-install-reports-success-for-an-app-that-cannot-start
document_type: ticket
status: open
created: 2026-07-29
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T19-fatal-startup-error-produces-a-silent-windowless-app.md]
archive_when: resolved
---

# T20 — `install:mac` reports success for an app that cannot start

**Risk:** High. The failure mode is "shipped a broken app and was told it worked", and the
person it reaches is a camp director with no way to diagnose it.
**Found:** 2026-07-29, installing the T15 build onto a real machine.

---

## What happened

`npm run install:mac` completed and printed:

```
==> Installing to /Applications/Shoresh.app (ditto, not cp -R)
Installed: /Applications/Shoresh.app
Launch with:  open "/Applications/Shoresh.app"
```

The installed app could not open its database and never drew a window. The bundle shipped the
**Node** build of `better-sqlite3` where Electron requires its own:

```
better_sqlite3.node was compiled against NODE_MODULE_VERSION 141.
This version of Node.js requires NODE_MODULE_VERSION 148.
```

Node in this project is ABI 141; Electron 43 is ABI 148. The bundled module was the Node one.

## How the wrong module got in

The project already documents this hazard — `CLAUDE.md` and the header of
`scripts/install-macos.sh` both explain that `better-sqlite3` must be rebuilt when switching
between Node (Vitest) and Electron. What is *not* handled is the interaction with packaging:

1. `npm rebuild better-sqlite3` was run to execute a migration check under Node — a normal,
   documented thing to do.
2. `npm run install:mac` was run immediately after. Its `electron-builder` step reported
   `preparing moduleName=better-sqlite3` / `finished` / `completed installing native
   dependencies`, but the artifact that reached the bundle was the Node build.
3. The script printed success.

The fix on the day was `npx electron-rebuild -f -w better-sqlite3` followed by a reinstall,
after which the app started and migrated correctly. So the recovery is trivial **once you know**
— the cost is entirely in not knowing, which is [T19](T19-fatal-startup-error-produces-a-silent-windowless-app.md).

Whether `electron-builder`'s rebuild pass silently no-ops when it believes the module is
current, or whether its output does not land in the packaged copy, is not yet established.
**Determine that before choosing a fix** — a guard that papers over a broken rebuild step is
worth less than fixing the step.

## Why the script's existing care did not catch it

`scripts/install-macos.sh` is unusually well-considered: it uses `ditto` rather than `cp -R`,
clears quarantine, repairs LaunchServices registration, and prints the ABI-flip reminder for
*afterwards*. Every one of those guards addresses a failure someone already hit.

But it verifies nothing about the artifact it just produced. It checks that the build output
directory exists, and nothing else. An install script that cannot tell a working app from a
broken one is the gap.

## Proposal

Confirm before implementing.

1. **Verify the bundled native module's ABI before declaring success.** The expected value is
   derivable from the Electron version in `package.json`; the actual is readable from the built
   `.node`. Mismatch must fail the script loudly and non-zero.
2. **Better: smoke-test the built app.** Launch it headlessly against a scratch userData
   directory and assert it opens a database and creates a window, then exit. This catches the
   whole class rather than one member of it, and it is the only check that would have caught
   this without knowing the cause in advance.
3. Establish why `electron-builder`'s rebuild produced the wrong artifact, and fix that rather
   than only guarding against its output.
4. Consider making the ABI state explicit rather than ambient — the current design requires a
   human to remember which of two mutually exclusive states the working tree is in, and that
   memory failed here even with the reminder printed.

## Completion evidence

1. Running `npm rebuild better-sqlite3` (Node ABI) and then `npm run install:mac` produces
   either a working app or a loud failure — never a silent success.
2. The script exits non-zero when the bundled module cannot load under Electron.
3. A freshly installed app is demonstrated to open its database and draw a window as part of
   the install, not by hand afterwards.
4. Verified by deliberately poisoning the ABI and confirming the install refuses.
