---
title: Working Copy Standard
document_type: standard
authority: normative
status: active
applies_to: [workflow, agents, operations]
supersedes: []
last_reviewed: 2026-09-05
review_trigger: any change to the worktree layout, the morning integration routine, or the trunk-promotion rule
---

# Working Copy Standard

**Rules for branches, working folders, and cleanup.** Section 1 is written for the product owner
and assumes no git knowledge. Sections 2 onward are normative for every agent.

This standard exists because of a specific, verified incident. On 2026-09-02 the `main` ref was
force-moved while checked out in the main checkout. That advances the ref without touching the
worktree's files or index, so `git status` reported a 41-file staged changeset that was pure
artifact — no human had edited anything. The morning routine correctly refused to fast-forward a
"dirty" tree, and `main` sat 33 commits behind for four days while the report said `⏸️` every
morning. Separately, and more seriously, 41 files of the future-architecture exploration were found
existing **only as untracked files in one worktree** — on no branch, no remote, and in no stash,
three weeks after they were written.

Both failures share one cause: **the state that mattered was invisible to the signals anyone was
watching.**

---

## 1. What these things are, in plain language

You have **one main folder** (`~/dev/shoresh`) and **several side folders** (under
`.claude/worktrees/`, plus a few named `~/dev/shoresh-*`). They are all views of the same project at
different points in its history. Agents work in side folders so they never collide with each other.

Three ideas are worth holding:

- **Committed** work is written into the project's permanent history. It is recoverable, it can be
  pushed off this machine, and it survives any cleanup.
- **Uncommitted** work exists only as files in one folder on one laptop. It is invisible to nearly
  every tool. Deleting the folder destroys it with nothing to recover from.
- A **branch** is just a bookmark pointing at a commit. A branch being "already merged" says
  something about the bookmark. **It says nothing about whether the folder holds unsaved work.**

That last distinction is the whole standard. On 2026-09-05, the folder holding the future-architecture
work reported *branch fully merged · zero commits of its own · untouched for three weeks* — every
signal a tidy-up would read said "safe to delete" — while containing 41 files that existed nowhere
else on earth.

**What you actually have to do:** read the 06:30 integration report, and act on anything red. That
is the entire owner-facing obligation. Everything else below is the agents' job.

---

## 2. The rules

### R1 — The main checkout is a reference copy, not a workspace

No agent edits files, runs generators, or leaves scratch output in `~/dev/shoresh`. All work happens
in a worktree on its own branch. Reading, inspecting, and running read-only git commands there are
fine.

**Why:** the main checkout holds the `main` ref. Anything that dirties it disarms the automatic
fast-forward, and `main` silently falls behind — exactly the four-day drift of 2026-09-02.

### R2 — A working folder is judged by what is unsaved inside it, never by its branch

Before proposing that any folder or branch be removed, check `git status` **inside that folder**. A
merged branch with zero commits ahead may still hold uncommitted work; on 2026-09-05 two folders did.

Never treat "merged", "0 commits ahead", or "idle for N days" as sufficient grounds for deletion.
They are necessary at most, never sufficient.

### R3 — Nothing is deleted automatically, and nothing destructive runs unattended

Automation may **fast-forward** a clean checkout (a pointer advance) and may **report** anything it
finds. It may not reset, clean, force, rebase, merge, or delete. Repair of a damaged working copy is
a human action.

**Why:** an earlier draft of the morning routine auto-repaired the phantom state. Adversarial review
reproduced a case where a deliberate staged revert (`git checkout <old> -- . && git add -A`) is
*byte-identical* to the phantom, and the automation silently discarded the real work while reporting
that it had "healed" it. Tree equality cannot distinguish intent. The routine therefore diagnoses and
prints the fix; a human runs it.

### R4 — Uncommitted work is not work yet; commit at the end of every session

An agent that stops with uncommitted changes in its worktree has produced nothing durable. Before
finishing, either commit (a WIP commit is fine and preferred over nothing) or state explicitly in the
handoff that the work is unsaved and where it lives.

**Why:** three weeks of architecture work survived on luck — the prune guard happens to refuse dirty
folders. Luck is not a retention policy.

### R5 — Never move a branch ref that is checked out somewhere else

Do not run `git branch -f`, `git update-ref`, or `git push --force` against a branch that another
worktree has checked out. To advance `main`, let the integration routine fetch it, or run
`git merge --ff-only origin/main` inside the folder that holds it.

**Why:** this is the exact mechanism that produced the 2026-09-02 phantom. The ref moves; the files
do not; git then reports a large changeset nobody made.

### R6 — A stuck state must not look like a routine one

Any automation that declines to act must escalate when the same condition persists. The morning
routine reports `🔴` once `main` is five or more commits behind, on every non-advancing path.

**Why:** the routine diagnosed the 2026-09-02 problem on day one and reported it four times. Day one
and day four rendered identically, so nothing prompted a human to look.

### R7 — Automation that can modify a working copy lives in this repo

Any script with permission to change the repository is tracked here, reviewed like any other change,
and its history is visible. It does not live in an untracked directory outside version control.

**Why:** `scripts/integration.sh` ran unattended against the main checkout for months from
`~/.claude/projects/…`, where no review, history, or backup applied to it.

---

## 3. What the 06:30 routine does and does not do

`scripts/integration.sh`, run by `com.shoresh.integration-report` (launchd, 06:30 daily). Report
written to `~/.claude/projects/<slug>/_integration/reports/integration-<date>.md`.

| It does | It does not |
|---|---|
| Fast-forward `main` when its folder is **clean** | Touch a folder holding any uncommitted change |
| Remove worktrees that are merged, **clean**, and idle ≥ 2 days | Remove anything dirty (`git worktree remove` refuses) |
| Diagnose the phantom-index state and print the human fix | Run that fix, or any reset/clean/force |
| List branches ready to merge, and escalate `🔴` at 5+ behind | Merge, rebase, or promote to trunk — ever |

Trunk promotion is a human decision (`CONSTITUTION.md`). A fast-forward is a pointer advance, not a
merge, and is the one exception.

---

## 4. Reading the morning report

| Marker | Meaning | Action |
|---|---|---|
| ✅ | Done, nothing needed | none |
| ⬆️ | A branch is ready for **your** merge decision | yours, when you want it |
| ⏸️ | Skipped once because a folder was in use | none — expect ✅ tomorrow |
| 🩹 / ℹ️ | Informational | none |
| 🔴 | **Stuck, or needs a human** | act, or ask an agent to |
| ⚠️ | Something failed | ask an agent to read the log |

A `⏸️` on two consecutive mornings for the same folder is a `🔴` in waiting — say so rather than
letting it repeat.

---

## 5. Checks

- `npm run check:governance` — this document is linked from `GOVERNANCE_INDEX.md`.
- `zsh -n scripts/integration.sh` — the routine parses.
- `grep -n 'reset --hard' scripts/integration.sh` — every hit must be inside a comment or an
  advisory string that is printed, never executed (R3).
