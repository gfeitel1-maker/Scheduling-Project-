---
title: "History rewrite: purge real camp identity and personal paths from public git history"
document_type: ticket
status: open
created: 2026-09-05
task_class: documentation-governance
archive_when: "the rewrite has landed, the remote reflects it, and GitHub's cached objects for the affected SHAs are confirmed unreachable"
---

# T120 — History rewrite: purge real camp identity and personal paths

## Why

`4a7ef13` removed a real camp's identity from the working tree, but **git history still
contains all of it**, and the repository is **public**. Removal from the tip reduces casual
discovery; it does not remove the material.

The owner has explicitly asked for a history rewrite and "complete removal of any potentially
sensitive material from any public space" (2026-09-05).

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
