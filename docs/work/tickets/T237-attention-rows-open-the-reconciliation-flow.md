---
title: T237-attention-rows-open-the-reconciliation-flow
document_type: ticket
status: open
created: 2026-09-23
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md, docs/adr/2026-08-28-persisted-reconciliation-decisions.md]
related_tickets: [docs/work/tickets/T236-roots-attention-list-below-the-fold.md]
archive_when: An attention row in the Roots rail opens the reconciliation working-through flow, the rail caps at what fits the viewport with an overflow affordance that navigates to that same flow, a test pins "no page scroll at N rows" at more than one viewport height, and the change has merged to main.
---

# T237 — The Roots attention rows are inert; they should open the reconciliation flow, and the rail should cap at what fits

**Depends on:** T236 (the right-hand rail) landing first. T236 is the measured layout fix and stands on
its own; this is the behaviour behind it.

**Owner decisions, 2026-09-23.** Recorded verbatim because each one closes a question the
implementation would otherwise have to guess at:

> "the attention rows should live in the reconciliation flow. the roots screen can open a right modal
> that has a few of them and then cap it at a point where clicking in there moves you to the
> reconciliation"

> on ordering: "it truly doesn't matter. you can do it by alphabet if you want."

> on a second entry point: "put it into a second path that opens the same thing. that is the correct idea."

## What is wrong

Two separate things, which is why they are one ticket.

**1. The rows are inert.** `src/screens/RootsHomeScreen.jsx` renders each attention row as a plain
`<div>` with `onMouseEnter`/`onMouseLeave` hover styling and **no `onClick` and no `onNavigate`**.
Verified: the only navigations anywhere on the Roots screen are `onNavigate('schedule')` (the
`ScheduleDoor`) and `onNavigate('import')` (the footer button). A row lights up under the cursor and
then does nothing — the hover accent promises an affordance the row does not have.

**2. The list has no cap, and Roots is the wrong place to work through it.** Measured during T236:
31 attention rows produce a 2486px rail beside a 386px bento, on a page 2647px tall. T236 stopped
that from burying the footer actions, but as the owner framed it, the tall rail is not a layout
problem to mitigate — it is a symptom of Roots trying to be a place where work gets done. Roots is
the calm setup home (locked IA, 2026-08-22). A preview that hands off is consistent with that IA; a
full working list on Roots never was.

## What exists already, verified

- `src/components/reconciliation/rootMapNav.js` resolves a node to the screen a director edits that
  data on (`screenForNode(domainKey, childKey)`), with `rootMapNav.test.js` catching a dangling
  target. Its `DOMAIN_SCREEN` keys are exactly `Structure | Scheduling | Time | Facility`.
- `src/ingest/attentionList.js` already stamps every row with a `domainTag` drawn from the same
  vocabulary (`buildStructureIssues` emits `'Structure'`, `'Time'`, `'Scheduling'`; the
  reconciliation half uses `domain.label`) **and** a `sourceKind` of `'reconciliation' | 'structure'`.
  So a row already carries enough to resolve a destination. This is mapping, not new machinery.
- `ReconciliationScreen` is rendered from inside `src/screens/ImportScreen.jsx`, in `mode="import"`.
  **It is not in `App.jsx`'s `SCREENS` map** — `App.jsx` imports the symbol but the routed key is
  `import: ImportScreen`. The working-through flow therefore exists and works, but today the only
  door into it is "Import last year", which expects a file.

**The honest consequence:** the two halves of the attention list have different natural destinations.
A structure row ("No activities are eligible for this group") is fixed on a setup screen, which
`rootMapNav` already resolves. A reconciliation row is worked through in `ReconciliationScreen`,
which currently requires an import to reach. Do not paper over that difference with one destination
for both.

## Scope — build to these decisions

**In:**

1. **A second door into the same reconciliation destination.** Authorized by the owner directly. The
   existing door is `Import last year → ReconciliationScreen mode="import"` and needs a file; the new
   door opens that **same** flow pointed at open decisions, with no file import. If entering without a
   file needs a new mode or an entry parameter, that is in scope. **Two code paths converging on one
   screen is the goal; two screens that look alike is the failure.** Reuse the existing screen and
   its machinery.
2. **Rows become interactive.** A row resolves to its destination — reconciliation rows to the flow
   above, structure rows via `rootMapNav`'s existing resolution. Only then is the hover accent honest.
3. **The rail caps at what fits.** Not a constant. The rail shows as many rows as fit the viewport
   **without introducing page scroll**, and the overflow affordance takes the rest. T236's measured
   property is the target to preserve: `scrollHeight === clientHeight` at 1280x720. Because the cap is
   derived from available height it must also behave at other viewport heights and on resize.
4. **The overflow affordance navigates**, it does not expand in place. It lands in the reconciliation
   flow, ideally showing the remaining items rather than a generic entry.
5. **Ordering is ALPHABETICAL by row name.** The owner explicitly does not care. Alphabetical is
   chosen because it is stable, obvious to a director, and — importantly — **not accidentally a
   priority claim**. `buildAttentionList`'s current order (reconciliation rows, then structure rows)
   was never designed as a ranking and must not be presented as one now that only some rows are shown.
   **A later reader should not mistake this for a tuned severity order, and should not "improve" it
   into one without asking the owner.**

**Out:**

- No modal / overlay. The owner said "a right modal", but the sticky right rail from T236 already
  delivers that outcome, is built, measured and reviewed, and this app has no modal pattern for this.
  Building an overlay would be new machinery for an identical result. (Coordinator decision, 2026-09-23.)
- No banner.
- No change to what an attention row *means* — `src/ingest/attentionList.js`'s row shape and the
  checks that produce rows are not this ticket.

## Note on the overflow affordance's visual treatment

`RootsHomeScreen.jsx` already has a cap-and-overflow pattern in the same file: `CHIP_CAP` / `ChipRow`'s
`"+N more"`. **Read its comment before reusing the look.** It records that `"+106 more"` was *rejected*
for chips because the card's own heading already answered how many rows there were. That reasoning
does **not** apply here — an attention overflow has a real destination now, so the count is an
invitation rather than a restatement — but the precedent for the visual treatment does. Do not
contradict that comment by accident; if the treatments diverge, say why in a comment next to it.

## Success predicate

Clicking an attention row opens the surface where that item is worked through. The rail renders only
as many rows as fit without page scroll at 1280x720 **and** at a shorter viewport, pinned by a test
asserting the no-page-scroll property rather than a hardcoded row count. The overflow affordance
navigates into the reconciliation flow. Reaching that flow does not require importing a file.
