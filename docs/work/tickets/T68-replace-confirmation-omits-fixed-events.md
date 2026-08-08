---
title: T68-replace-confirmation-omits-fixed-events
document_type: ticket
status: completed
created: 2026-08-07
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T61-replace-ingest-atomic-transaction.md]
related_specs: [docs/work/specs/S-replace-ingest-atomic-transaction.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: the Replace confirmation names every category of director-authored content it destroys, and the one irreversible consequence is visually distinct from the recoverable ones
---

# T68 — Replace confirmation destroys Fixed Events without saying so

**Raised:** 2026-08-07 by Red Hat, during the T61 round-3 review. T61 shipped without it;
this is the residue, recorded rather than folded in silently.

## The problem

T61 added a pre-confirm warning that Replace clears both schedule routes
("Both your Manual Build and Generated Schedule will be cleared (X slots)"), plus warnings
about saved versions and Day Override templates.

**Fixed Events are still not mentioned anywhere before the director commits.**

`replaceScope` (`electron/ops/ingest.js`, step 6) deletes every `anchor_activities` row for
the camp — it must, because step 8 deletes `days_of_operation` and the anchors reference it.
Fixed Events are director-authored content with their own nav screen: Color War, Visiting
Day, evening programs pinned to a day and block. They are neither `template_slots` nor one
of the five entities the Replace sentence names.

The count *is* returned from `commitIngest` and folded into the post-commit banner's
aggregate — so the director learns about it only after it has happened, and only as part of
an unlabelled total.

## Why it matters

A director reads "Manual Build and Generated Schedule will be cleared (42 slots)" as the
complete schedule-impact disclosure, because it is phrased as the flagship warning. Fixed
Events are gone too. This is recoverable from Trash — an ordinary `__deleted__` op, unlike
saved versions — but the director has no way to know pre-confirm that Fixed Events were in
scope at all.

This is the same failure class T61 rounds 2 and 3 closed for slots, in the one dependent
category the fix did not reach.

## What to build

1. A line in the same pre-confirm warning block naming Fixed Events with a live count, in
   the pattern the other three warnings already use — e.g. *"Your N Fixed Events will be
   cleared."* Say that they are recoverable from Trash, since they are.
2. **Visually distinguish the one irreversible consequence.** The block currently stacks
   four peer paragraphs with three different Trash outcomes (restorable / not restorable /
   emptied-but-named). Saved versions are the only permanently unrecoverable item and it
   does not stand out. A tired director skimming absorbs "Trash, fine" and misses it.
3. Consider whether `week_activity_exclusions` / `week_group_exclusions` warrant a mention.
   Red Hat's assessment, which I share: lower priority — they are generation constraints,
   not director-authored content in the same visible sense. Deciding *not* to name them is
   a legitimate outcome of this ticket.

## Notes

- `src/screens/ImportScreen.jsx` — `slotCount` / `snapshotCount` / `dayOverrideCount` are
  fetched together in `readFiles`; an anchor count follows the same pattern.
- Code Reviewer flagged a related threshold: the warning block's pairwise `marginTop`
  conditionals are fine at three items and get hard to verify by eye at four. Adding this
  warning **is** the fourth. Extract the block to a rendered array as part of this work.
- Copy is product judgement under `CONSTITUTION.md` Article V — the director must never
  need to know what `anchor_activities` is.
