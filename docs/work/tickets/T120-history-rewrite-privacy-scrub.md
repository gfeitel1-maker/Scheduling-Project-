---
title: "History rewrite: purge real camp identity and personal paths from public git history"
document_type: ticket
status: open
created: 2026-09-05
task_class: documentation-governance
archive_when: "the owner has ruled on the 2026-09-25 re-scope below — either (a) the rewrite has landed, the remote reflects it, and GitHub's cached objects are confirmed unreachable, or (b) the rewrite is recorded here as declined on the measured evidence and the forward-looking guard has shipped"
governing_docs: [docs/governance/constitution/CONSTITUTION.md]
---

# T120 — History rewrite: purge real camp identity and personal paths

## Why

A working-tree scrub removed a real camp's identity from the tip, but **git history still
contains all of it**. Removal from the tip reduces casual discovery; it does not remove the material.

The owner has explicitly asked for a history rewrite and "complete removal of any potentially
sensitive material from any public space" (2026-09-05).

> **Two premises in the text below are stale — read the 2026-09-25 re-scope at the bottom first.**
> _Prior: this ticket said "the repository is **public**". It is **private** as of some point after
> 2026-09-05, which is currently the whole mitigation._ _Prior: it cited commit `4a7ef13` as the
> tip scrub; that SHA no longer resolves in this repository._ And the rewrite is **not** ~841
> commits from `6b14293` — the camp name is present in the **initial commit** (`08a0aa89`,
> 2026-04-21), so a rewrite is the entire history.

## Scope — what the rewrite must cover

Two independent categories, deliberately bundled so history is rewritten **once**:

**1. Real camp identity**
- `docs/work/specs/samples/campA-bunk-schedules.txt` and `campB-<campname>-by-day.txt` — real
  camp, division, and bunk names. Introduced in `6b14293` (2026-07-30), ~841 commits back.
  `docs/work/specs/samples/INGESTION_SAMPLES.md` stated outright that the names were real.
- The **filename** itself carried the camp's name.
- `src/screens/CampBootstrapScreen.jsx` shipped a hardcoded `placeholder` naming a real camp — the name was
  **in the product**, on the camp-creation screen. Also `src/localClient.mock.js`'s demo host.
- The name appeared as a worked example in 10 committed docs (ADRs, specs, archives).

**2. Personal filesystem paths**
- 14 commits contain the developer's absolute home path. The tip was scrubbed in #248; the history rewrite
  was deferred at that time and is still outstanding. Fold it in here.

## Known constraints and traps

- **A rewrite does not fully erase on GitHub.** Rewritten commits stay reachable by direct SHA
  until GitHub garbage-collects. Complete removal requires asking GitHub Support to purge the
  cached objects, or deleting and re-pushing the repository. The repo currently has **0 forks**,
  which makes the delete/re-push option genuinely viable and the most complete.
- **Blast radius.** Rewriting from `6b14293` changes every SHA since (~841 commits). Every
  active worktree and every peer session branch based on old SHAs is orphaned. Before starting:
  confirm `git worktree list` is clear of in-flight work and tell any concurrent sessions.
- Consider whether to make the repo private for the duration rather than under time pressure.
  The owner declined this on 2026-09-05, judging the exposure low ("if it says camp a and camp b
  that's not worth flipping") — revisit only if scope grows.
- `.ingest-incoming/` (including `shemesh-2025.txt`) is **not** in scope: gitignored, never
  committed, and Shemesh is a fabricated camp the owner drafted. Do not spend effort there.

## Sequencing

Queued behind the four branches in flight as of 2026-09-05 (`anchor-contention`,
`ingest-location-approval-gate`, `T119-location-capacity-provenance`, `synthetic-sample-data`).
None of them rewrite history; all are ordinary commits on `0cea17b`. Do the rewrite only once
they have merged and their worktrees are removed.

## Done when

- No commit in history contains the real camp name (in content, path, or product string).
- No commit in history contains the developer home path.
- The remote reflects the rewritten history.
- The GitHub-side cached-object question is resolved deliberately — either purged via Support,
  or the repo deleted and re-pushed, or consciously accepted and recorded here as accepted.


---

## 2026-09-25 re-scope — measured, and the conclusion is not the one this ticket assumed

Re-opened because T261 (CI minutes) surfaced a second, unrelated reason to want the repo public:
**a public repository gets free unlimited GitHub Actions minutes.** That made it worth measuring
what is actually in the history rather than continuing to reason from this ticket's 2026-09-05
prose. Everything below is measured on the repository as it stands today.

### Cost of the rewrite, measured

| | |
|---|---|
| Commits rewritten | **1,466** on `main` (1,705 across all refs) — the camp name is in the initial commit, so all of them |
| Local worktrees orphaned | **32** |
| Remote branches to force-push | 42 |
| PRs whose history breaks | 542 |
| Forks / stars | **0 / 0** — no evidence anyone copied it |
| Camp name | **0 files at tip**, 30 commits in history, 1 committed filename (`docs/work/specs/samples/campB-achva-by-day.txt`, deleted from tip) |
| Developer home path | **11 files at tip** (not 0 — see regression), 29 commits in history (not 14) |

### What is actually in the history — full sweep

Scanned **every unique text blob in all of history** (9,101 blobs, 257 MB of text) for PII and
secret patterns. Results:

| pattern | unique hits | what they are |
|---|---|---|
| phone numbers | **0** | — |
| SSN-shaped | **0** | — |
| date-of-birth-shaped | **0** | — |
| JWTs, Slack / Google / Stripe keys, Supabase URLs | **0** | — |
| PEM private key | 1 | `scripts/security-gate.test.js` — a fixture proving the secret detector fires |
| AWS access key | 1 | `AKIAIOSFODNN7EXAMPLE` — the canonical AWS *documentation example*, same file |
| GitHub token | 1 | `ghp_0123456789…` — an obvious placeholder, same file |
| email-shaped | 17 | **all** npm package authors (from the lockfile), `git@github.com`, `you@example.com`, `noreply@anthropic.com`, two `*-pkg@1.0.0.json` filenames, and 5 fuzz-generated strings |

**There are no real personal emails, no phone numbers, no dates of birth, no identifiers, and no
live secrets anywhere in this repository's history.** The three secret-shaped hits are all in the
test file for the secret detector itself.

The two non-synthetic sample files were characterised directly: both are **schedule grids, not
rosters** — columns are cohort names (`Yeladim`, `Tzofim`, `Chalutzim`, `Adom 4's`, generic Hebrew
age-group words common to many Jewish camps), cells are activity names. **No camper names, no
contact details.** The two camper-preference CSVs are named `fabricated-*` and are exactly that.

So the residual material is: **a real camp's name, a set of cohort labels, some activity names, and
the developer's macOS username** — which is already public as his GitHub handle.

### The finding that actually matters: the scrub regressed, and nothing guards it

PR #248 scrubbed the developer home path and the record states "verified 0 occurrences remain in
the tree." **It is back in 11 tracked files at `HEAD`** — `scripts/gateLock.test.js`,
`scripts/observeRun.js`, `scripts/memoryProject.{js,sh}`, `scripts/consolidation/{gather,run}.sh`,
`docs/adr/2026-09-15-opinion-report-dispatch-provenance.md`, three tickets, and a gate report.
There is **no gate** preventing re-introduction.

This reframes the whole ticket. A one-time history rewrite cleans the past; it does nothing about
the fact that the tip re-accumulates this material on its own. **Once the repository is public,
every future commit publishes live** — and agent sessions write local paths, sample data and ingest
evidence into `docs/` continuously. The ongoing risk is strictly larger than the historical one,
and it is the only part a rewrite does not address.

### Recommendation

**The guard is the valuable work. The rewrite is probably not worth its blast radius.**

1. **Build the forward-looking guard first** — a gate step that fails on the real camp name, the
   developer home path, and PII/secret patterns in tracked files. Small, cheap, and it is the thing
   that makes public safe *going forward*. It should have existed since #248.
2. **Then the owner rules on the rewrite itself**, with the evidence above rather than the
   2026-09-05 assumption. The measured case against it: 1,466 commits, 32 orphaned worktrees, 42
   force-pushed branches, 542 broken PRs, plus a GitHub Support purge or a delete-and-recreate — to
   remove a camp name and a username, with 0 forks and no PII or secrets found.
3. **Do not let CI cost drive this.** After T261 the overage is ~2,400 min/month, which at GitHub's
   $0.008/min Linux rate is roughly **$19/month**. That is the cheap fix for the cost problem, and
   it removes the one genuinely dangerous temptation here: flipping to public *before* the purge is
   verified, to save money. Confirm the rate in billing rather than taking this number on trust.

### Sequencing, corrected

_Prior: this ticket was queued behind four branches from 2026-09-05; those are long merged._ If the
rewrite is ever approved it must run with the fleet quiesced — **32 worktrees** and both peer
sessions would be orphaned — from a fresh clone, never from a worktree (shared `.git`).

### Owner decision needed

- Ship the guard? (recommended, independent of everything else)
- Rewrite history, or record the rewrite as declined on this evidence?
- Go public for free CI, or pay the ~$19/month and stay private?
- ~~**Provenance question:** is `campA-bunk-schedules.txt` real?~~ **RESOLVED 2026-09-25 — the owner
  confirms campA is NOT a real camp.** Independently corroborated: PR #285's own description records
  that the campA/campB samples were "replaced with a fabricated, length-preserving mapping." So
  **no real-camp material ships at the tip.**

### GitHub metadata — the surface the history sweep did not cover, now measured

Going public also publishes PR descriptions, review comments and Actions logs, which live in GitHub's
metadata rather than in git objects. Scanned all **542 PRs** (titles + bodies, 1.32 MB): **0 emails,
0 phone numbers**, and exactly **three** hits — the camp name twice in **PR #285** and the home path
once in **PR #248**, which are the scrub PRs *describing the removal*.

PR bodies are **editable in place**, so this is three edits rather than anything structural. Not done
unilaterally — it is a change to published descriptions and is the owner's call. Actions logs were
not scanned (they expire on their own retention schedule).

### Next action

[T263](T263-privacy-guard-before-public.md) builds the forward-looking guard, which is the
precondition for going public. The rewrite remains an open owner decision, and the evidence above
argues against it.
