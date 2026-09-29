---
title: "A branch created from another session's branch pushes into their PR"
document_type: ticket
status: completed
created: 2026-09-29
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORKING_COPY_STANDARD.md]
related_adrs: []
related_tickets: [docs/work/tickets/T307-a-directors-column-correction-is-honoured.md]
archive_when: "WORKING_COPY_STANDARD.md carries a normative rule that a branch created from anything other than its eventual push target has its upstream cleared, with the 2026-09-29 T307 incident as its Why, and the rule names both the create case and the re-point case"
---

# T310 — A branch created from another session's branch pushes into their PR

Found during [T307](T307-a-directors-column-correction-is-honoured.md), 2026-09-29. Caught before any
push, by a peer session reading the tracking ref rather than by any check. Nothing in the repository
records it.

## What happens

T307 had to change `confirmMapping` in `src/screens/elective/assignment/AssignmentPanel.jsx`, and
[T305](T305-a-whole-sheet-planner-grid-imports-through-the-panel.md) was in flight changing that same
function's signature. Branching from T305's branch rather than from `main` was the right call — it is
the only way to build on an unmerged change without editing the same function concurrently.

```
git checkout -b claude/T307-… origin/claude/elegant-hugle-bd9d3d
```

That sets the new branch's upstream **to T305's branch**. A bare `git push` from there does not open
anything and does not warn: it pushes the commits onto the branch backing **PR #620**, silently
adding one session's work to another session's open pull request. It would have been discovered as
"why does #620 contain changes nobody wrote", after review had already passed over it.

**The same trap fires a second time, on the way out.** Once T305 merged, re-pointing at main with

```
git checkout -B claude/T307-… origin/main
```

sets the upstream to **`origin/main`**. A bare `git push` now aims at the trunk directly.

## Why it is not visible

The Working Copy Standard's own premise is that these incidents share one cause: *"the state that
mattered was invisible to the signals anyone was watching."* This is that shape exactly, and the
detail is sharper than "someone should have looked".

Verified by execution on 2026-09-29:

| Command | Shows the tracking ref? |
|---|---|
| `git status` | yes — *"Your branch is up to date with 'origin/main'"* |
| `git status --porcelain` | **no — the branch header is absent entirely** |
| `git status --porcelain=v2 --branch` | yes — `# branch.upstream origin/main` |

`--porcelain` is the form an agent reaches for, because it is the parseable one. The fact that would
have prevented this is missing from precisely the output the actor is looking at, and present in the
two they are not.

## Proposed rule

A new normative rule in
[`docs/governance/standards/WORKING_COPY_STANDARD.md`](../../governance/standards/WORKING_COPY_STANDARD.md)
§2, in the house form — rule, then a **Why** naming the verified incident. Draft text:

> ### R8 — A branch's upstream must be the branch it will be pushed to, or nothing
>
> Creating a branch from anywhere other than its eventual push target sets the upstream to that other
> place. Clear it in the same breath: `git branch --unset-upstream`. Push the first time with an
> explicit `git push -u origin <branch>`, never a bare `git push`. This applies again on every
> re-point — rebasing onto `origin/main` sets the upstream to `main` itself.
>
> **Why:** on 2026-09-29 a T307 branch was created from T305's branch, which was correct (T307 had to
> build on an unmerged signature change in the same function). Its upstream was therefore
> `origin/claude/elegant-hugle-bd9d3d`, and a bare push would have added T307's commits to the branch
> backing PR #620. Caught by a peer session, not by a check. `git status --porcelain` — the form an
> agent parses — omits the tracking ref that plain `git status` prints.

## Non-goals

- **Not** discouraging branching from another session's branch. It is the correct move when the work
  must not conflict with something unmerged; only the upstream it leaves behind is the hazard.
- **Not** a gate or a hook. This is a standing rule about a two-command habit; a check that ran on
  every branch creation would fire constantly on the normal case.
- **Not** a change to `scripts/integration.sh` or the morning report. The trap is at branch-creation
  time, in a session, not in unattended automation — R7's territory is untouched.

## Note on where this did not go

This rule was deliberately kept out of [T307](T307-a-directors-column-correction-is-honoured.md)'s
pull request even though that is where the incident happened. A standard outranks the code it
governs, so a standards edit riding inside a feature diff gets reviewed as part of the feature and
usually is not reviewed at all. It earns its own diff and its own argument.

## What shipped

R8 landed in `docs/governance/standards/WORKING_COPY_STANDARD.md` §2, in the house form, with the
2026-09-29 T307 incident as its **Why** and both the create case and the re-point case named.

Two departures from the draft above, neither substantive:

- The heading reads "A branch's upstream **is** the branch it will be pushed to, or nothing" rather
  than "must be" — the other seven rules are written as statements of fact, not obligations.
- The rule opens by affirming that branching from another session's branch stays correct. The draft
  carried that only as a non-goal, where a reader following the rule would never see it.

A check was added to §5 rather than a gate, matching this ticket's non-goals:
`git rev-parse --abbrev-ref --symbolic-full-name @{u}` must **error** in a session's own branch
before its first push.

`last_reviewed` in the frontmatter was deliberately **not** bumped. Across all five standards that
field has only ever been set at creation and never moved on amendment — `TESTING_STANDARD.md` still
reads `2026-07-28` after four later edits — so it records the last full review, and bumping it for a
single added rule would assert a review that did not happen.
