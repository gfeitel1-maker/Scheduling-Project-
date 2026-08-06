---
title: T59-schedule-grid-keyboard-navigation
document_type: ticket
status: open
created: 2026-08-06
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T56-convert-remaining-schedule-views.md, docs/work/tickets/T55-collapse-a-period.md]
archive_when: the schedule grid is navigable by arrow keys with a roving tabindex and every cell announces its span extent
---

# T59 — Keyboard grid navigation and accessible cell names

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §0 predicate 6,
§8. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §7.
**Risk:** Low to ship, but it is a stated success predicate of the parent spec.

---

## Problem

**This work is named in the spec's §8 as "in scope, not deferred" and appears in the §0 success
predicate — but it has no step in the spec's §10 migration path.** It would fall through the gaps
between T54 and T60 unless ticketed. That is why this ticket exists; it is not a scope addition.

The spec commits to three keyboard/screen-reader behaviours beyond the ARIA structure T54 and T56
establish:

- **Keyboard grid navigation** — arrow keys move focus between cells, with a roving `tabindex`.
  Without it, a `role="grid"` is a promise the widget does not keep: assistive-technology users
  expect grid navigation from the role.
- **An accessible name per cell that includes its span extent** — e.g. *"Swimming, blocks 4 to 5,
  Tuesday."* Spec §0 predicate 6: *"screen-reader navigation reports row/column position and the
  span extent of merged cells."* `aria-rowspan`/`aria-colspan` (landed in T54) give the machine
  the extent; the accessible name gives the human it.
- **Collapsed rows stay reachable.** A collapsed row is visually condensed, never `aria-hidden`,
  never out of the tab order (T55 establishes this; this ticket must not undo it).

---

## Scope

**In:**

1. **Roving `tabindex` across the grid.** The grid is one tab stop. Within it, exactly one cell has
   `tabindex="0"` and the rest `tabindex="-1"`; arrow keys move focus and move the `0`.
   - Arrow Up/Down/Left/Right move by one cell.
   - Decide and document the behaviour when focus moves **into** a spanning cell from the side, and
     **out** of it — a cell spanning blocks 4–6 occupies three logical rows. State the rule in the
     closure note; do not leave it emergent.
   - Home/End and PageUp/PageDown are optional; if implemented, say so.
2. **Accessible name per cell including span extent.** Composed from data the view already has —
   activity name, block range, day (or group, in day view). No new data fetch, no new state.
3. **Empty and unavailable cells announce as such**, not as blank cells.
4. Apply to all four views.
5. Verify collapsed rows remain focusable and correctly announced, with the row-header toggle's
   `aria-expanded` reflecting state.

**Out:**

- **Keyboard drag** — that is @dnd-kit's keyboard sensor plus `aria-live` announcements, and it
  ships in **T58**. This ticket is focus movement, not slot movement. They are separate because
  they are separate mechanisms.
- Any visual change. Focus rings come from `:focus-visible` in `scheduleGrid.css` (T54); if the
  ring needs adjusting, that is a stylesheet edit, not a layout change.
- Any change to `gridGeometry.js`, the hooks, or data.
- Screen-reader certification against a specific product. Verify with the Chromium DevTools
  *Accessibility* pane and at least one real screen reader (VoiceOver on macOS is what this team
  has); name which was used.

---

## Acceptance

- [ ] The schedule grid is **one** tab stop; Tab moves into and out of it, not cell by cell
- [ ] Arrow keys move focus between cells in all four views; exactly one cell has `tabindex="0"`
      at any moment
- [ ] Focus entering and leaving a spanning cell behaves according to a rule that is **written
      down in the closure note**, and a test asserts it
- [ ] Every cell's accessible name includes the activity (or empty/unavailable state), the block
      range, and the day or group — e.g. *"Swimming, blocks 4 to 5, Tuesday"*
- [ ] `aria-rowspan`/`aria-colspan` values match the rendered spans (regression check on T54/T56)
- [ ] A **collapsed** row's cells are still focusable, still in the tab order, still announce their
      names, and are not `aria-hidden`. The row-header toggle announces its `aria-expanded` state
- [ ] Verified against the Chromium DevTools *Accessibility* pane **and** one real screen reader;
      the closure note names which
- [ ] No visual change to any view
- [ ] `gridGeometry.test.js` untouched and green
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

- **T56** — all four views converted and carrying the ARIA structure.
- **T55** — the collapsed-row focus contract this ticket must preserve.

May be worked in parallel with T57/T58 (they touch drag, not focus), but if both land close
together, re-verify tab order once.
