---
title: "The findings copy guardrail scans a hardcoded SOURCES list, so a new home for finding text escapes it silently"
document_type: ticket
status: completed
created: 2026-09-24
archive_when: findingsLanguage.test.js no longer depends on a hand-maintained four-file list to decide what it scans — either it discovers candidate sources mechanically, or an explicit registry exists whose omission fails a test — and a non-vacuity check proves a banned word planted in a NEW finding-text home is caught
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
related_tickets: [docs/work/tickets/T244-finalize-elective-run-ipc.md, docs/work/tickets/T250-draft-and-final-director-ui.md]
---

# T254 — Findings copy guardrail scans a hardcoded SOURCES list

## Why

`src/engine/findingsLanguage.test.js` enforces Product Premise §3 ("explain the software, not the
camp"): user-facing finding and flag text may state mechanism, never merit. It enforces this by
scanning source files for message string literals — but the set of files it scans is a hardcoded
literal:

```js
const SOURCES = [
  'src/engine/buildSchedule.js',
  'src/utils/computeOverlaps.js',
  'src/utils/computeWeekClosures.js',
  'src/components/schedule/slotCellConstants.js',
]
```

Its own header comment claims it catches "a brand-new finding kind added later". That is true only
for a new finding kind authored **inside one of those four files**. Any new home for director-facing
finding-like text is outside the guardrail from the moment it is created, and nothing fails — the
test still passes, green, while covering less than it says it does. A guard whose coverage silently
shrinks as the codebase grows is the failure mode this ticket exists to close.

This was found while amending the 2026-09-23 elective-run ADR (whose T244/T250 slices introduce
run-level director-facing state that is *not* schedule findings, and so would land outside the
list). It is **not** part of that amendment and was deliberately not fixed there: the amendment is
docs-only and this is a test change with its own design question.

## Scope (not yet designed — needs a decision first)

The open question is which of these the repo wants, and that choice should be made deliberately
rather than by whoever gets here first:

- **Mechanical discovery** — scan a directory glob for files matching the message patterns, so a new
  file is covered by existing. Broadest coverage; risks false positives on non-user-facing strings.
- **Explicit registry** — a single exported list that finding-text modules must join, with a second
  test that fails when a module authors matching message literals and is absent from it. Narrower,
  but the omission is detected rather than invisible.

Either way the acceptance bar is the same and is stated in `archive_when`: a **non-vacuity** check
that plants a banned word in a *new* text home the current list does not name, and proves the guard
catches it. Planting the defect the guard already covers proves nothing.

## Non-goals

Changing any existing finding copy. Changing the banned-word list. Anything about the elective run
lifecycle itself.
