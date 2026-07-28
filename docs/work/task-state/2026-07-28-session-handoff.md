---
task: session-handoff-2026-07-28
document_type: task-state
status: completed
created: 2026-07-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: superseded by a later handoff, or 30 days
---

# Session handoff — 2026-07-28

Deliberately short. Most of what a new session needs is now *in the repo* — start at
[`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md), which resolves
what governs a given task. This file records only what the repo cannot tell you.

## State

`main` is green: 678 unit tests, 17/17 integration, lint 0 errors, build clean.
Tickets T6–T13 are all closed. No open PRs. No known defects.

The installed app at `/Applications/Shoresh.app` is commit `655e57a` — identical to `main`.
Its sidebar footer shows `v0.1.0 · 655e57a · 2026-07-28`, so this is checkable at a glance
rather than by extracting files from the bundle.

## The one real gap

**Five changes are proven at the data layer and have never been seen rendered.** Screen
access was denied for the whole session, so no UI was visually verified:

| Change | Where to look |
|---|---|
| Snapshot "Empty" labels (T8) | Schedule → Versions dropdown |
| DEV badge (T9) | Sidebar footer — absent on a packaged build, present under `electron:dev` |
| Day tab holds after a drop (T10) | Day View — drop on Tuesday, stay on Tuesday |
| Device Manager list (T11) | Device Manager, under `npm run dev` |
| Build stamp (T13) | Sidebar footer |

Drag-and-drop was confirmed working by the product owner. The rest were not checked.

If a future session is granted screen access, closing this out is roughly a minute of
looking and would retire the largest standing uncertainty in the project.

## What was learned, that isn't obvious from the diffs

**Doing beat reading, consistently.** Every significant defect this session came from
running the real thing, not from reading about it:

- T12 (drag-and-drop dead) — found by reading `operations.js` out of the *installed bundle*.
  It was a stale build, not a code defect. Two full days of plausible suspects were wrong.
- T9's directory bug — the fix passed unit tests and then crashed the app on launch, because
  `app.setPath()` does not create the directory. Only running it caught that.
- Two tools (vitest, eslint) silently scanning `release/` — only visible after packaging.
- T8's dead snapshots and T12's dead drag-and-drop were **the same bug** (`af6a9d8`), wearing
  different symptoms months apart.

**Corollary: resist adding governance in response to problems that looking would have caught.**
The standards are good at preventing false claims. They do not find bugs.

## Judgement calls made here, worth revisiting if they chafe

- **Dev and packaged use separate databases** (ADR 2026-07-28), against T9's own suggestion to
  unify. Rationale: this app runs a real camp; a dev session against operational data is
  unrecoverable, a testing gap costs a re-test.
- **Dead snapshots are hidden, not deleted** (T8). A delete affordance exists instead of a
  migration, because those rows carry names a director chose.
- **The dev mock is stateful, not stubbed** (T11) — a screen that renders while proving
  nothing is worse than one that does not render.

## Known non-issues

- 11 ESLint warnings on `main` are pre-existing (`react-hooks/exhaustive-deps`), not new.
- `backup/wip-2026-07-27` is an intentional backup branch; leave it.
- After `npm run electron:build`, `better-sqlite3` is left on Electron's ABI. Run
  `npm rebuild better-sqlite3` before `npm test`. `scripts/install-macos.sh` prints this too.
