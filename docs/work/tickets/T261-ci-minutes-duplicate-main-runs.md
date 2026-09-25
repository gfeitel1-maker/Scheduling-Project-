---
title: "CI minutes: stop re-verifying a tree that already went green"
document_type: ticket
status: open
created: 2026-09-25
task_class: test-infrastructure
archive_when: "the gate no longer runs on push to main, a daily scheduled run on main exists, node_modules is restored from a lockfile-keyed cache on an exact hit, and a week of run history shows roughly half the previous run count with no loss of PR coverage"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
---

# T261 — CI minutes: stop re-verifying a tree that already went green

## Why

T191 moved the gate off the developer's laptop for a good reason and that reason still holds. But
the workflow as written bills roughly twice what the work costs.

Measured over the last 100 runs (~3 days, 2026-09-22 → 2026-09-25):

| | runs | wall min |
|---|---|---|
| `pull_request` | 56 | 535 |
| `push` to `main` | 44 | 459 |
| — of those, re-verifying a tree already green on a PR run | **27** | **255** |

The 27 is a floor, not an estimate: it counts only main runs whose tree hash matched a *successful*
PR run inside the same 100-run window. The other 17 main runs are very likely the same case with
their PR partner just outside the window.

The mechanism is not subtle. Merges here are rebased on `main` before merging, so a squash merge
produces the **same tree** as the PR head that was just verified. Confirmed by hand: main commit
`8bfa5a84` and PR head `97f2338b` (`claude/t245-move-lock-ipc`) both have tree `d1703b4175`. The
post-merge run re-ran an 11-minute gate on a byte-identical checkout.

Projected burn is ~9,900 min/month. The account is on GitHub **Free**, which allows **2,000**
Actions minutes/month for private repositories — confirmed by the branch-protection endpoint
returning `403 Upgrade to GitHub Pro or make this repository public`.

## Where the 660s of a single run goes

| | |
|---|---|
| checkout + setup-node + zsh | 22s |
| `npm ci` | 117s |
| `npm run verify` | 521s |
| — of which `vitest run` | 473s (529 files, 6976 tests) |

So per-run cost is dominated by the test suite, which is the actual work. The saving is in running
fewer runs, not in making a run cheaper.

## What this ticket does

1. **Remove the `push: branches: [main]` trigger.** This is the 46%.
2. **Add one daily scheduled run on `main`.** This is the net that makes (1) safe — see below.
3. **Cache `node_modules`, keyed on `.nvmrc` + the lockfile.** Removes the 117s `npm ci` on an
   exact cache hit (~18% of what remains).

   The scoping rule is worth stating rather than discovering: an Actions cache written on a branch is
   readable from that branch and from the **default** branch's caches — never from a **sibling**
   branch. Two consequences, and they are different:

   - A branch's **second and later** runs read the cache its own first run wrote. A PR that gets
     several pushes pays `npm ci` once, not once per push. Observed on this change: run 1 missed and
     installed (117s), run 2 hit and **skipped** `Install`.
   - A cache written by one PR does nothing for a **different** PR. The entry a PR's *first* run
     reads is one written by a run on `main` — after change (1), the daily scheduled run.

   So a brand-new branch misses until `main` has run once (the schedule, or a `workflow_dispatch` to
   prime it), and any PR that changes the lockfile misses. On a miss `npm ci` runs exactly as before.

   _Prior: an earlier draft of this ticket and of the workflow comment claimed this step "misses for
   every PR until main has run once". That is true across branches and **false** for repeat runs on
   one branch, which is the common case for a PR under review. Corrected rather than narrowed._

## Non-goals — what was considered and deliberately rejected

- **Weakening the gate.** No step is removed, reordered, or made conditional. `scripts/verify.js`
  is untouched. The same eight steps run on every PR.
- **Speeding up the test suite.** T188 §6/F3 already did this work, and its own comments record a
  carve-out that made one test file silently stop running. That is rigor, not waste. Left alone.
- **A self-hosted runner, or a local Forgejo/Gitea.** Both put the gate back on the developer's
  4-core machine, which is precisely what T191 removed after observing load 267 and four tests
  reported FAILING that passed in 5.8s in isolation. This converts a money cost into manufactured
  reds. Not a solution to the stated problem.
- **Splitting the gate into parallel jobs.** Reduces wall time, *increases* billed minutes, which
  are charged per job-minute. The wrong direction.
- **`paths-ignore` for docs-only changes.** `check:governance` and the status-drift gate exist
  specifically to check docs. Ignoring doc paths would skip the checks that those paths need most.
- **Making the repository public** (which would make minutes free and unlimited). Blocked by
  **T120**: git history still contains a real camp's identity, which is why the repository is
  private today. Tracked there, not here.
- **A precise tree-hash skip** — keep `push: main` but exit in ~15s when this tree already has a
  green run. Better on paper: it is *derived* from committed state rather than assuming rebase
  discipline, and it self-corrects when a merge is not a clean rebase. Rejected on cost/benefit:
  Actions caches written on a feature branch are **not readable from the default branch**, so the
  cheap mechanism does not work and it needs `actions: read`, an API query over recent runs, and
  `fetch-depth: 0` to compute historical trees. ~30 lines and a new failure mode for two points
  over a three-line change. Recorded here so the next reader does not re-derive it.

## The merge window — the precise version of the safety argument

Observed while merging #543 on 2026-09-25, and it refines this ticket's central claim. #543 was
verified green against `main` at `950d54c7`; by the time it merged, `main` had moved to `9d8b19f1`
(#544 landed in between). GitHub still reported `MERGEABLE`/`CLEAN` and the squash succeeded.

So the claim "the PR head tree equals the merge tree" is **not** guaranteed by rebasing alone — main
can move between the green and the merge. In that instance it was genuinely safe, verified rather
than assumed: #544 touched only `electron/db/headlessDbKey.e2e.test.js` and `T175`'s ticket, #543
touched `electron/ops/**`, and the intersection of the two file lists was **empty**.

The honest form of the safety argument is therefore: **check overlap at merge time, not base equality.**

```bash
comm -12 <(git diff --name-only <tested-base> origin/main | sort) \
         <(git diff --name-only <tested-base> <pr-head> | sort)
```

Empty output means the PR's green still describes its content. Non-empty means rebase and re-run
before merging. `MERGEABLE`/`CLEAN` answers a narrower question — "do these apply without textual
conflict" — and a non-conflicting merge can still be semantically wrong.

Without `push: main`, a mistake here is caught by the daily run rather than in ~11 minutes. That is
the real residual risk this ticket takes on, and the one-line check above is what keeps it small.

## Why dropping `push: main` is safe, and what it costs

The claim is *not* "main is always identical to the PR head". It is:

- **Normally** identical, because the branch is rebased on `main` and rechecked before merge.
- **When it is not** — a merge that was not a clean rebase, or a direct push to `main` — the daily
  scheduled run catches it within 24 hours.
- The scheduled run **also** catches something the old `push: main` run caught only incidentally:
  drift in external truth. `npm audit` reads a live vulnerability database, so a tree that was
  green yesterday can legitimately be red today with no commit in between. A daily run on `main` is
  a *better* instrument for that than a run triggered by merges.

The honest cost: a bad direct push to `main` is now visible in up to 24 hours instead of ~11
minutes. There is no branch protection on this repository (Free plan), so this is a discipline
boundary either way, and direct pushes to `main` are not the practice.

## Success predicate

- `.github/workflows/gate.yml` has no `push` trigger on `main` and has a `schedule` trigger.
- The `node_modules` cache step declares **no** `restore-keys`, so it is an exact hit or a miss;
  a near-miss cannot silently stand in for an install. `npm ci` is skipped **only** when
  `cache-hit == 'true'`.
- After `main` has run once, a PR that does not touch `package-lock.json` reports a cache hit and
  skips `npm ci`. Verified by reading the run log's step list, not inferred from the wall time.
- Every PR still runs the full `npm run verify` with all eight steps.
- One week on, `gh run list` shows roughly half the run count for the same amount of merged work.

## Out of scope, recorded for the owner

Getting under 2,000 min/month needs more than this ticket delivers (~4,400 projected after it).
The only routes to genuinely free are **T120 → public repository** or a paid plan. Owner decision,
not a thing to solve here.
