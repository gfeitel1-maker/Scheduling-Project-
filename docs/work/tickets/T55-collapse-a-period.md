---
title: T55-collapse-a-period
document_type: ticket
status: closed
created: 2026-08-06
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T54-group-view-css-grid-conversion.md, docs/work/tickets/T53-grid-track-and-placement-modules.md]
archive_when: a period can be collapsed and re-expanded in group view with no cell overflowing and no cell leaving the accessibility tree
---

# T55 — Collapse a period

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §2 (the whole
section) plus §4 and §7. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §5.
**Risk:** Medium. This is the one behaviour the product owner flagged as unresolved in the original
design, and the reason the spec exists.

---

## Problem

A director scanning a week wants to fold away quiet periods — Lunch, rest hour — without losing
the ability to see what is in them. Collapse does not exist today.

The first CSS Grid mockup implemented collapse and it looked broken. **The diagnosis is the
substance of this ticket.** Collapse is two concerns, not one:

| Concern | Owner | Mechanism |
|---|---|---|
| **Track geometry** — how tall is the row | the grid container | the `--grid-rows` track list |
| **Content presentation** — what the cell shows at that height | the cell | a `collapsed` state on the cell |

The HTML table conflated them because table cells are content-sized: shrinking the content shrank
the row, so one rule appeared to do both. The mockup changed only the **track** (row set to 14px)
while the cell kept `padding: 9px 11px` and 12px type — 12px content in a 14px box. That is the
entire bug. **It is not a CSS Grid limitation; it is one missing half of a two-part contract.**
Separating the two is *better* — it is why collapse costs one custom-property write (3.9 ms)
instead of a full table re-render (7.1 ms) — but the collapsed content state must be authored
explicitly rather than falling out for free.

---

## Scope

**In — group view only.**

### 1. Collapse state

A set of collapsed block ids held in route state (`src/screens/schedule/useRouteState.js`). No
collapse or density state exists in the app today — this ticket introduces it. Whether it persists
across a reload is a judgement call for the implementer; state it in the closure note either way.

### 2. Track geometry

Feed `collapsedBlockIds` into `buildRowTracks` (T53) and write the result to `--grid-rows` on the
container. A collapsed block's track is the fixed `COLLAPSED_TRACK`. **Never `auto`** — `auto`
would let content re-expand the row and defeat the collapse.

### 3. Content presentation

Each cell carries `data-collapsed` **when its head block is collapsed**, and
`scheduleGrid.css` (from T54) re-presents it. Resolved values, do not re-derive them:

```
COLLAPSED_TRACK   = 20px
collapsed label   : 11px / weight 500 / var(--text-secondary) / opacity 1
                    letter-spacing .02em / nowrap + ellipsis / vertically centred
collapsed extras  : identity dot, per-cell flags, expand handle -> display: none
                    ONE row-level flag dot (6px) if any cell in the row is flagged
row header        : collapses too -- time hidden, name 11px var(--text-secondary)
```

The row header collapses too. The table mockup left it out and it read as misaligned.

**Dim with the token, never with `opacity`.** The label is `var(--text-secondary)` at **full
opacity**; the recessed strip fill, smaller size, and weight 500 carry the quiet read. This is
measured, not stylistic — `--text-secondary #5C6670` on `--bg #F4F3EF` measures **2.51:1 at the
mockup's 0.62 opacity**, below even the 3:1 large-text threshold, at the smallest type in the app.
No opacity value reaches 4.5:1; only full opacity (5.27:1) does. **Do not reintroduce an opacity
value on this label.**

`COLLAPSED_TRACK` is `20px`, not the mockup's `14px`: at full opacity the label can be 11px, and
11px × 1.4 line-height + 1px borders = 17.4px, which 14px cannot hold. Cost is +6px against the
~56px a collapse saves.

### 4. Row-level flag dot

If **any** cell in a collapsed row is flagged, show one 6px dot at the strip's right edge:
`var(--danger)` for UNFILLABLE, `var(--accent)` for advisory.

*Why this and not a summary line:* a collapsed row that can hide a conflict turns a scanning aid
into a scanning hazard. This is the one piece of aggregate information that changes the answer to
the director's actual question ("is my week done"). **Derive it in the render pass that already
visits every cell — `cells.some(c => c.flags?.length)` — never store it. It has no sync surface
and must not acquire one.** Activity counts are deliberately not carried: the director already
knows what is in Lunch.

### 5. Rules that fall out and must be honoured

- **Only the span *head*'s block determines collapsed presentation.** A cell spanning blocks 4–6
  where block 5 is collapsed keeps **normal** presentation and simply gets shorter — grid sums the
  tracks it covers plus the gaps automatically. This is correct: the activity is not "in" the
  collapsed period exclusively. **Do not apply `data-collapsed` to it.**
- **Collapsed content is single-line and ellipsized.** The normal cell uses `overflow-wrap:
  anywhere` and wraps; the collapsed cell switches to `nowrap` + ellipsis. This is a deliberate,
  scoped exception to the no-clipping rule — a fixed-height box is the one place truncation is
  accepted.
- **Collapse must never change what is in the DOM.** The whole gain is that collapse is a style
  write, not a re-render. Collapsed cells stay mounted, keep their handlers, keep their accessible
  names, and remain focusable and drop-targetable.
- **No animation.** Collapse is an instant track-height change (spec §5.4, DESIGN_STANDARD §8).

### 6. Accessibility and the accepted deviation

A collapsed row is **visually condensed, never hidden**. Do not set `aria-hidden`. Do not remove it
from the tab order. The row-header toggle carries `aria-expanded`.

> **Accepted deviation — WCAG 2.2 SC 2.5.8 (target size), recorded here deliberately.**
> A 20px strip is under the 24×24 minimum. The product owner accepted the Designer's
> recommendation on 2026-08-06 on two grounds: the **entire strip** is the re-expand target
> (approx. 1000 × 20px, so the shortfall is height-only), and the **keyboard path** —
> `aria-expanded` on the focused row header, activated with Enter/Space — is the equivalent
> mechanism the exception requires. `24px` was the strictly-conformant alternative and was not
> chosen. **This is a known, deliberate deviation, not an oversight.** The keyboard path is
> therefore load-bearing for the deviation's validity and must ship in this ticket, not be
> deferred to T59.

**Out:**

- Collapse in `ScheduleDayView`, `ScheduleActivityView`, `ManualBuildView` — those views are still
  tables until T56. Collapse follows them there.
- **The density toggle.** `buildRowTracks` takes a `density` parameter and
  `ROW_FLOOR_NORMAL`/`ROW_FLOOR_COMPACT` exist from T53, but **no ticket in this migration ships a
  user-facing density control** and this one does not either. Pass `'normal'`. If the product
  owner wants the toggle, it is its own ticket.
- **Fog-of-row dimming.** Deferred by product owner decision — the product owner wants to test
  without it first. **Do not implement it speculatively.**
- Any change to `gridGeometry.js` or `buildSchedule.js`.

---

## Acceptance

- [ ] Toggling a period collapsed writes **one custom property** (`--grid-rows` on the container)
      and **one attribute** (`data-collapsed` on that row's cells). It does not re-render the grid
      and does not change DOM membership
- [ ] **Zero cells with `scrollHeight > clientHeight` in the collapsed state**, at every period,
      in group view
- [ ] **Acceptance fixture the mockups did not cover — the non-merged collapse case.** Every
      mockup collapses Block 5, a single merged `Lunch` spanning all five days, which is **not
      representative**. Collapse **Block 2** (five *different* activities, five separate strips):
      all five names centred, 0 of 5 overflowing horizontally or vertically. This case must be
      exercised, not assumed
- [ ] A cell spanning **across** a collapsed block shortens by exactly the track delta and keeps
      **normal** presentation — it does not get `data-collapsed` and does not ellipsize
- [ ] A collapsed row containing at least one flagged cell shows exactly **one** 6px dot in the
      correct token colour; a collapsed row with no flagged cells shows none. The flag state is
      derived at render — grep confirms nothing new is written to the DB, the op-log, or
      `PROJECTIONS`
- [ ] The collapsed label uses `var(--text-secondary)` at **opacity 1**. Grep the stylesheet: no
      `opacity` value is applied to `.cell-name` or `.block-name` in the collapsed state
- [ ] The row header collapses in step with its cells — time hidden, name at 11px — and is not
      left at full height
- [ ] Collapsed cells remain focusable, remain in the tab order, keep their accessible names, and
      are still valid drop targets. Nothing is `aria-hidden`
- [ ] The row-header toggle carries `aria-expanded` and is operable with Enter and Space from the
      keyboard. **This is the WCAG 2.5.8 equivalent mechanism — it is not optional**
- [ ] The WCAG 2.2 SC 2.5.8 deviation is recorded in the closure note as accepted, with its date
      and rationale
- [ ] No collapse animation
- [ ] `gridGeometry.test.js` untouched and green
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

- **T53** — `buildRowTracks`, `COLLAPSED_TRACK`.
- **T54** — the converted group view and `scheduleGrid.css` to hold the `[data-collapsed]` rules.
