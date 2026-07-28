# T9 — Dev and packaged builds read different databases

**Risk:** Low for users, HIGH for trust in our own testing.
**Found:** 2026-07-27, while verifying drag-and-drop.
**Status:** CONFIRMED by process inspection.

---

## The defect

| How it is run | userData directory | Contents on 2026-07-27 |
|---|---|---|
| `npm run electron:dev` | `~/Library/Application Support/Electron` | 290 ops |
| `/Applications/Shoresh.app` | `~/Library/Application Support/shoresh` | 293 ops |

The dev process is launched as `electron electron/main.js`, so Electron resolves `--app-path` to the `electron/` subdirectory. There is no `package.json` there, so it cannot read the app name and falls back to its built-in default, `Electron`. The packaged app reads `name` from the real `package.json` and correctly uses `shoresh`.

Confirmed in the running process arguments:

```
--user-data-dir=/Users/gregfeitel/Library/Application Support/Electron
--app-path=/Users/gregfeitel/dev/shoresh-verify/electron
```

## Why it matters

Verifying a fix in dev exercises a **stale copy** of the data. "It works in dev" is not evidence that the installed app works, and nobody reading a test report would guess that. This is a silent gap between what we test and what ships — the same shape of problem as the projection registry silently no-oping.

It cuts the other way too: dev testing cannot corrupt real camp data, which is genuinely useful. Whatever is decided, it should be **deliberate and documented**, not an accident of argv.

## Observable completion evidence

1. `npm run electron:dev` and the packaged app resolve the same userData directory — or they deliberately differ, with the split documented in `CLAUDE.md` and an obvious in-app indicator of which database is loaded.
2. The footer already shows `shoresh.sqlite`. It should show enough to distinguish the two.

## Files expected to change

- `electron/main.js` — set the app name explicitly via `app.setName()` / `app.setPath('userData', …)` rather than relying on argv-derived defaults.
- `CLAUDE.md` — document the resulting behavior under Commands.
