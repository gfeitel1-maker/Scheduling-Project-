---
title: "Project-lifecycle IPC handlers: trusted local-device operations exempt from camp session authorization"
document_type: adr
authority: normative
status: accepted
date: 2026-08-04
supersedes: []
implementation_state: existing — retroactively documented
affects: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
---

# Project-lifecycle IPC handlers: trusted local-device operations exempt from camp session authorization

**Status:** accepted

## Context

`electron/main.js` registers two categories of IPC handlers. The first category — domain-data handlers (`write`, `list`, `bulk-replace`, `delete-record`, `duplicate-week`, etc.) — calls `authorize()` before acting. Each pre-session exemption in that category (`choose-mode`, `bootstrap-camp`, `discover-hosts`, `login`, `get-camp`) carries an inline comment explaining why no token can exist yet.

A second category — project-file lifecycle handlers (`get-current-project`, `create-project`, `open-project`, `export-project`, `backup-project`, `restore-project`, `list-recent-projects`, `open-recent-project`) — also calls no `authorize()` and carries no equivalent justification. The 2026-08-04 architecture audit flagged this as a missing decision record (BOUNDARY_AUDIT §electron/main.js; TARGET_ARCHITECTURE §2.6 roadmap R2). The audit correctly noted this may be intentional; the finding is the absent record, not a confirmed vulnerability.

This ADR records the human decision.

## Decision

Project-file lifecycle operations (`get-current-project`, `create-project`, `open-project`, `export-project`, `backup-project`, `restore-project`, `list-recent-projects`, `open-recent-project`) are **trusted local-device operations**. They are exempt from camp session authorization.

These operations manage which SQLite file the Electron process has open. They run before a camp session is established, and in some cases — specifically `restore-project` and `open-project` — their purpose is to *reconstitute* the database from which a session token would be validated. Requiring authentication against the currently-open camp database creates a circular recovery dependency: a corrupted or inaccessible database cannot issue a token, so a token requirement would make recovery impossible from within the app.

The authorization model for this class of operations is the local OS: a user who can launch this Electron app can perform file-level operations on their own machine. That is consistent with the app's local-first, single-user-per-device design.

## What this exemption covers and does not cover

**Covered:** reading project metadata, creating a new empty project file, switching which project is open, exporting or backing up the file to another location, restoring from a backup, listing recent files.

**Not covered:** anything below the database-file level. Once a project file is open, every domain mutation — writing groups, activities, schedule slots, user records — must pass `authorize()` as before. This exemption does not extend to any handler that touches camp data or calls `appendOp`.

## Constraints

1. **The OS file picker is the gate, not a security boundary.** Do not describe the file dialog as strong security. It deters accidents, not adversarial use.

2. **`restore-project` requires explicit local confirmation and must preserve the pre-restore backup.** Before overwriting, the restore handler calls `writeUserBackup` (`electron/db/projectManager.js:103`, invoked from `electron/main.js:1187`), which copies the current database to a timestamped file at `{userData}/backups/shoresh-{timestamp}.db`, chmods it to `0600`, and rotates the directory to at most `MAX_BACKUPS` files. Note this is a dated, rotated backup in a separate directory — **not** a `.bak` sibling of the original; do not grep for `.bak` expecting to find this safeguard. That behavior must be retained in any future refactor of this block. A restore that silently destroys the prior file without a local confirmation dialog would be a regression.

3. **This exemption must never be broadened to domain mutations.** Any new handler that reads or writes camp-scoped data through the op-log must call `authorize()`, regardless of where in `main.js` it is registered.

4. **Inline comment required in code.** Each handler in the project-lifecycle block must carry a comment in the form used by the pre-session exemptions, so a future reader cannot mistake absence of `authorize()` for an oversight:

```js
// Project lifecycle — trusted local-device operation, exempt from camp session auth.
// See ADR 2026-08-04-project-lifecycle-authorization-exemption.md.
```

## Consequences

- The architecture audit finding R2 (missing decision record) is closed by this document.
- `ARCHITECTURE_STANDARD.md` §4 is amended to name project-lifecycle handlers as a second documented exemption category alongside the pre-session handlers.
- The IPC surface parity work (roadmap R2 / Phase B) may wrap these methods in `localClient.js` without adding `authorize()` calls.
