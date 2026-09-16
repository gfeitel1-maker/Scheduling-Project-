# Licensing, Attribution, and the Application Menu

Date: 2026-09-15
Status: approved (owner), not yet implemented

## Goal

Shoresh is going open source under **Apache-2.0**. This spec covers the licensing
artifacts, the third-party attribution that open-sourcing obliges, and the
application menu that surfaces About and Licenses to someone running the
packaged app.

## Success predicate

All of the following are true:

1. `LICENSE` holds verbatim Apache-2.0 text; `NOTICE` holds the copyright line;
   `package.json` declares `"license": "Apache-2.0"`.
2. A packaged Shoresh build exposes a menu bar containing **About Shoresh** and
   **Licenses**, and the standard editing shortcuts (Cmd/Ctrl+C, V, A, Z,
   Minimize, Close, Quit) all still work.
3. **Licenses** opens a window listing every production dependency with its
   version, SPDX identifier, and full license text.
4. That list is generated from `node_modules`, and `npm run verify` fails if the
   committed list is stale relative to the dependency tree.
5. **About** reports the same build identity as the sidebar footer, from one
   source of truth (`electron/buildInfo.js`).
6. Licenses and About are reachable at **every** device phase, including
   `mode-select` and `login`.

## Non-goals

- **Guide content.** No user guide exists and none is written here. A `Guides`
  menu item backed by nothing would violate the standing no-coming-soon-controls
  rule. Guides is a separate brainstorm, queued.
- **Git history purge** (T120). Known to the owner, tracked separately.
- **EULA, license keys, entitlement checks.** Not applicable to an open-source
  release.
- **Per-file Apache license headers.** See Decisions below.

## Context: the dependency survey

A walk of `node_modules` at the time of writing found **610** transitive
packages, all permissive:

| Count | License |
|-------|---------|
| 443 | MIT |
| 58 | Apache-2.0 OR MIT |
| 36 | ISC |
| 27 | Apache-2.0 |
| 29 | BSD-2-Clause / BSD-3-Clause |
| ~8 | 0BSD, BlueOak-1.0.0, MIT-0, CC0-1.0, WTFPL |

No GPL, AGPL, LGPL, or SSPL anywhere. The only two non-permissive entries —
`lightningcss` (MPL-2.0) and `caniuse-lite` (CC-BY-4.0) — are build-time
devDependencies and are not shipped. **No dependency constrains the license
choice.**

## Decisions

### D1 — Apache-2.0 over MIT

Chosen for three properties MIT lacks:

- an **explicit patent grant** with a retaliation clause (MIT is silent on
  patents);
- an **explicit trademark non-grant**, so a fork cannot be called "Shoresh";
- a **`NOTICE` file convention**, which is the mechanism the attribution
  requirement needs anyway.

Compatible in both directions with every dependency. AGPL-3.0 was considered and
rejected deliberately: Shoresh is a local-first desktop app that never runs as a
network service, so the network clause barely applies, while the adoption cost
would be real.

### D2 — `NOTICE` plus a generated in-app list, not one or the other

Two artifacts with different audiences. `NOTICE` is what a developer or lawyer
looks for in the repo. The in-app list is what discharges attribution to the
person running the **binary**, who never sees the repository. Neither
substitutes for the other.

### D3 — Generated, never hand-maintained

A hand-written list of 610 packages is wrong after the next `npm install`. An
attribution file that is quietly incomplete is worse than none, because it looks
discharged. Generation is the only form that stays true.

### D4 — No per-file license headers

Apache-2.0 recommends but does not require them. The license is unambiguous from
`LICENSE`. Adding a 13-line banner across ~270 test files plus all of `src/` and
`electron/` produces a large noisy diff that buries the file-level explanatory
comments this codebase uses deliberately. Reversible if convention is later
preferred.

### D5 — Standard menu placement, not the File menu

About belongs in the app menu and Help is where a future guide will go; File is
for document actions and is where Import/Export belong later. Consolidating everything under Help was
considered (better for a non-technical director) and rejected in favour of
platform convention.

### D6 — Licenses is a separate BrowserWindow, not an AppShell screen

`AppShell` renders only at `phase === 'session'`. A menu item that is dead at
`mode-select`, `login`, `bootstrap`, `join`, and `pairing_pending` is a bug. A
standalone window is phase-independent, and needs no preload or node access.

### D7 — Copyright line

`Copyright 2026 Gregory Feitel and contributors`. Copyright attaches
automatically on fixation; no registration is required for the license to
operate. "and contributors" accommodates outside contributions, which
Apache-2.0 §5 places under the same license by default.

## Components

### C1 — Repo licensing artifacts

- `LICENSE` — verbatim Apache-2.0.
- `NOTICE` — copyright line, product name, pointer to the full third-party list.
  Deliberately short and stable; it does not enumerate dependencies.
- `package.json` — add `"license": "Apache-2.0"`.
- `README.md` — a `## License` section.

### C2 — `scripts/generate-licenses.js`

Input: the **production** dependency closure (devDependencies excluded — they
are not shipped).

Per package, collects: `name`, `version`, SPDX `license` identifier, `homepage`,
and the verbatim text of its `LICENSE`/`LICENCE`/`COPYING` file.

Outputs:
- `electron/third-party-licenses.json` — the data.
- `electron/third-party-licenses.html` — the rendered view loaded by C5.

**Committed to git**, deliberately unlike the gitignored `electron/build-info.json`.
That file churns on every build; this one changes only when dependencies change,
and committing it makes a dependency's license change visible in code review.

**Failure behavior (load-bearing):** if a package cannot be resolved, or carries
a license that cannot be classified, the script **exits non-zero** and fails the
build. It never emits a partial list. A generator that degrades to an empty or
truncated list while exiting 0 is the "ships green while recording nothing"
failure class this project has already been bitten by.

### C3 — Staleness gate

`npm run verify` (via `scripts/verify.js`) regenerates to a temp path, diffs
against the committed artifacts, and fails on any difference. Adding a
dependency without regenerating is then a red gate rather than a silent
omission.

### C4 — `electron/menu.js`

Split so the decision logic is testable without Electron:

- `buildMenuTemplate({ isMac, onShowLicenses })` — **pure**, returns the
  template array.
- `installMenu(...)` — thin Electron-touching wrapper calling
  `Menu.buildFromTemplate` / `Menu.setApplicationMenu`.

Structure:

| Menu | Items |
|------|-------|
| **Shoresh** (mac) | About Shoresh · Licenses · —— · Services, Hide, Hide Others, Show All · —— · Quit |
| **Edit** | Undo, Redo · Cut, Copy, Paste, Select All |
| **View** | Reload, Toggle DevTools · Zoom In/Out/Reset · Toggle Fullscreen |
| **Window** | Minimize, Zoom, Close |
| **Help** | Shoresh on GitHub · Report an Issue |

On non-mac, About and Licenses move into **Help**, and Quit into **File**, per
platform convention.

**The hazard this component exists to manage:** Shoresh currently sets *no*
application menu and inherits Electron's default. `Menu.setApplicationMenu()`
replaces that default wholesale. A template declaring only the new items
silently destroys Cmd+C/Cmd+V/Cmd+Q — and ships looking correct, because the
new item is what gets tested and paste is not.

### C5 — About

`app.setAboutPanelOptions()` plus the built-in `role: 'about'`, fed from the
existing `readAppVersion()`, `readBuildInfo()`, and `formatBuildLabel()` in
`electron/buildInfo.js` — so About and the sidebar footer report the same build
from one definition.

**To verify before implementing, not assume:** platform support for
`role: 'about'` and `setAboutPanelOptions` on **Electron 43.1.1**, since the
project ships an NSIS Windows target. If Windows is unsupported, About there
falls back to `dialog.showMessageBox` carrying the identical build label.

### C6 — Licenses window

A `BrowserWindow` loading `electron/third-party-licenses.html` from C2, with
`nodeIntegration: false` and no preload — it is static text and needs no
privilege. Reuses the existing window if already open rather than stacking
duplicates.

## Testing

| Target | Assertion |
|--------|-----------|
| `buildMenuTemplate` | standard roles `undo`/`redo`/`cut`/`copy`/`paste`/`selectAll`/`minimize`/`close`/`quit` are all present |
| `buildMenuTemplate` | About and Licenses present, correctly placed, mac and non-mac shapes |
| `generate-licenses` | fixture tree produces the expected entries, with license text |
| `generate-licenses` | **throws** on an unresolvable package and on an unclassifiable license (the negative case is the one that matters) |
| About string | correct build label for dev, packaged, and corrupt-stamp inputs |

Full `npm run verify` — lint, agents:check, test, test:integration, security,
check:governance — before the work is called done.

## Open risks

- **Electron 43 About-panel platform support** is unverified (C5). Resolve
  against the installed version's docs before coding.
- **`asar: false`** in the build config means the packaged tree is readable on
  disk; the generated HTML ships as a plain file. No security consequence — it
  is public text by definition.
- **electron-builder already ships Electron's and Chromium's own license files**
  into packaged output. The generated list covers the npm layer above that; the
  two should not be duplicated.
