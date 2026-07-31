---
task: session-handoff-2026-07-28
document_type: handoff
status: superseded
created: 2026-07-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T14-dev-run-reports-as-packaged-build.md]
archive_when: superseded by a later handoff, or 30 days
---

> **Migrated 2026-07-30** from `docs/work/task-state/` to `docs/work/handoffs/`.
> `document_type` was `task-state`, which no longer exists. It was **not** re-typed as `run` — a
> handoff is not a routed task and has no agents, gates, or verdict. `handoff` was added to the
> `document_type` enum in `WORK_RECORD_STANDARD.md` instead, per that standard's own rule that a
> value which does not fit an enum is a finding about the enum.
>
> `status: completed` → `superseded`: this handoff described `main` as of 2026-07-28 and the repo
> is now at v26. **Read it as history, not as current state.**

# Session handoff — 2026-07-28

Deliberately short. Most of what a new session needs is now *in the repo* — start at
[`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md), which resolves
what governs a given task. This file records only what the repo cannot tell you.

## State

`main` is green: 678 unit tests, 17/17 integration, lint 0 errors, build clean.
Tickets T6–T13 are all closed. No open PRs. **T14 is open** — a development run reports
itself as a packaged build; see below.

The installed app at `/Applications/Shoresh.app` is commit `655e57a` — identical to `main`.
Its sidebar footer shows `v0.1.0 · 655e57a · 2026-07-28`, so this is checkable at a glance
rather than by extracting files from the bundle.

## The one real gap — FULLY CLOSED 2026-07-29, and it found a defect

Screen access was granted in a later session on the same day and all five were looked at
under `npm run electron:dev`:

| Change | Result |
|---|---|
| Snapshot "Empty" labels (T8) | **Confirmed** — greyed, disabled, delete affordance retained |
| DEV badge (T9) | **Confirmed** — orange pill beside the database name |
| Day tab holds after a drop (T10) | **Confirmed** — dropped on Tuesday, stayed on Tuesday |
| Device Manager list (T11) | **Confirmed** — real IPC path, not the `:5200` mock |
| Build stamp (T13) | **Confirmed on the packaged app** 2026-07-29. Misreports a *dev* run — see T14 |

Two things came free: drag-and-drop works (T12 again), and new snapshots write a real
payload, so the `af6a9d8` fix holds.

**T13 is now verified on the packaged app — 2026-07-29, by the product owner.** The footer
renders the build stamp in the installed build. With that, **every item in this gap is closed**:
T8, T9, T10 and T11 were confirmed under `electron:dev` on 2026-07-29 (and their tickets marked
completed the same day), and T13 on the packaged build.

The stamp does still misreport a *development* run as a packaged one — that is
[T14](../tickets/T14-dev-run-reports-as-packaged-build.md), a separate open defect, not part of
this gap.

**The estimate in the previous version of this file was wrong,** and the reason is worth
keeping. "Roughly a minute of looking" holds only for a dev database that already has data.
The dev database was empty — schema present, zero camps — so the check first required
bootstrapping a camp, groups, a time block and activities before the Schedule screen existed
at all. Budget for the fixture, not just the glance.

Two fixtures were needed and neither is reachable by ordinary use:

- **T8's "Empty" label cannot occur naturally in a fresh camp.** It keys off `slots` being
  NULL, which only legacy pre-`af6a9d8` rows have. It was reproduced by saving a version and
  NULLing `slots`/`overlays` in the dev database.
- A throwaway "Dev Verify Camp" now lives in `~/Library/Application Support/shoresh-dev`
  (PIN 1234 — a local test fixture, not a credential). Real camp data was never opened,
  copied, or modified.

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

T14 is the fifth entry in that list and was found the same way. It sat behind a green suite —
its unit tests are correct and pass, because both causes live outside the pure functions those
tests cover. The only thing that surfaced it was running the app and reading the footer.

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
