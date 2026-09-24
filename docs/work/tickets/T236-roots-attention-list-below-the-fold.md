---
title: T236-roots-attention-list-below-the-fold
document_type: ticket
status: open
created: 2026-09-23
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md]
resolved_by: [src/screens/RootsHomeScreen.jsx, src/styles/shared.js]
archive_when: >
  RootsHomeScreen renders "Needs your attention" in a right-hand rail above the
  fold at 1280x720, RootsHomeScreen.test.jsx asserts the rail landmark and the
  narrow-viewport stacked order, and the change has merged to main.
---

# T236 — The Roots attention list sits below the fold and reads as a footnote

**Reported:** 2026-09-23, by the product owner, in these words:

> "i think the roots action items might need to be pulled up in a right bar instead of the
> bottom - right now, you can't really see it."

## What is wrong

`src/screens/RootsHomeScreen.jsx` stacks its sections in one 920px-wide column:

    h1 "Roots" → ScheduleDoor → "What has taken root" (5-row bento) → "Needs your attention" → bottom actions

"Needs your attention" is therefore always last, underneath the tallest element on the screen.

**Measured** on the browser mock at `:5200` with a realistically-sized camp (15 activities,
11 groups, 3 age divisions, 8 locations, 25 anchors, 2 attention rows):

| Viewport | `<main>` scrollHeight / clientHeight | "Needs your attention" label top | Result |
|---|---|---|---|
| 1280×720 (13" laptop) | 823 / 668 | y = 606 | Label + top half of row 1 visible. Row 2 and both bottom actions cut off. |
| 1440×900 | fits | — | Visible, but still last in the hierarchy, below a heavy bento. Reads as a footnote. |

So the defect has two independent halves: a literal below-the-fold failure on a laptop, and a
bottom-of-hierarchy failure at every size. Both get worse as a camp's setup grows — the bento is
the element that grows, and it grows above the attention list.

## Why it matters

"Needs your attention" is the only part of the Roots home that asks the director to *do* something.
Everything above it is reassurance ("what has taken root") or navigation (the Schedule door). Putting
the one actionable region last inverts the screen's own priority, and on the most common camp-office
laptop it hides it entirely.

## Scope

**In:**
- A right-hand rail on wide viewports holding "Needs your attention" wholesale (section label, rows,
  and empty state), sticky so it stays with the director while the bento scrolls.
- An attention-row shape that reads at rail width without wrapping badly.
- A stacked layout below the breakpoint that puts attention *above* the bento — never back at the
  bottom, which is the defect itself.
- A `useNarrowViewport` hook in `src/styles/shared.js` (inline styles only; no stylesheet — the one
  scoped CSS exception is `src/components/schedule/scheduleGrid.css` and does not extend here).
- `<aside>` landmark with an accessible name.

**Out:**
- Any change to what an attention row *is* (`src/ingest/attentionList.js` is untouched) or to how the
  list is computed. This is a placement defect, not a content defect.
- Any banner. Banners are a standing owner rejection ("SaaS nonsense").
- Any dashboard vocabulary on the rail — no counts-of-counts, no progress meter, no urgency colour,
  no badge on the rail heading. Roots-as-hub (locked 2026-08-22) is the calm setup home.

## Success predicate

At 1280×720 with a realistic camp, every attention row is visible without scrolling. At a window
narrower than the breakpoint, "Needs your attention" renders between the Schedule door and the bento.
Tests assert both, and the existing Roots tests still pass.
