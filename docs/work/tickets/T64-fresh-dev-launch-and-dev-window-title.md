---
title: T64-fresh-dev-launch-and-dev-window-title
document_type: ticket
status: open
created: 2026-08-07
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-explicit-userdata-directory.md]
related_tickets: []
archive_when: electron:dev:fresh exists and the dev window title reads Shoresh [DEV]
---

# T64 — Fresh dev launch script and a `[DEV]` window title

**Risk:** Low, mechanical. **Task class:** architecture (tooling only, no product surface).

---

## Problem

Two small friction points in the development loop, both of which have caused real confusion:

1. **`npm run electron:dev` fights a lingering Electron process** from the previous session. The old
   process still holds the dev SQLite database, so the new run produces DB lock errors, and the
   developer ends up with two Electron processes in an ambiguous state.
2. **Dev and production windows are indistinguishable.** Both title bars read "Shoresh". The only
   distinguisher today is the DEV badge in the sidebar footer, which is not visible until after
   login — precisely the window in which a mistake about which database you are looking at is most
   likely.

The databases are deliberately separate (`shoresh-dev` vs `shoresh`; see the ADR), which is what
makes mistaking one window for the other consequential rather than merely untidy.

## Scope

**In:**

1. **`package.json`** — add:
   ```json
   "electron:dev:fresh": "pkill -x Electron; sleep 1 && npm run electron:dev"
   ```
   Note the `;` after `pkill` is intentional: `pkill` exits non-zero when nothing matched, which is
   the normal case, and must not abort the chain.

2. **`electron/main.js`** — after `mainWindow` is created (line ~1343) and before `loadURL`, set the
   window title to `Shoresh [DEV]` when not packaged. **Use `app.isPackaged`** — that is already
   this file's convention for the distinction (lines 1096, 1104), so do not introduce a
   `NODE_ENV` check alongside it. The production title is unchanged.

**Out:**

- Any change to `userDataPath.js` or to which database either build opens.
- Changing or removing the sidebar DEV badge.
- Any renderer change.

## Known limitation — accepted, record it

`pkill -x Electron` kills **every** Electron process owned by the user, not just this project's. A
developer running another Electron app's dev server will have it killed without warning. The
packaged Shoresh app is unaffected (its process is named `Shoresh`, not `Electron`).

This is accepted for a convenience script that a developer opts into by name. **Do not silently
broaden it** (no `pkill -f`, no killing by port). Note the limitation in a comment or in
`CLAUDE.md`'s Commands section so the next person is not surprised.

## Testing

No unit tests required.

## Acceptance

- [ ] `npm run electron:dev:fresh` starts cleanly with a stale Electron process running
- [ ] The dev window title bar reads `Shoresh [DEV]`
- [ ] A packaged build's title is still `Shoresh` — verified by reading the guard, since building
      the installer is out of scope
- [ ] `npm run lint` passes
