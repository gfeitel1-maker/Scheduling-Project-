---
title: T60-schedule-grid-cleanup-and-doc-correction
document_type: ticket
status: open
created: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T56-convert-remaining-schedule-views.md, docs/work/tickets/T58-drag-fsm-cutover.md]
archive_when: no dead style constants remain and CLAUDE.md and TARGET_ARCHITECTURE.md state the actual styling convention
---

# T60 — Retire the table-era style constants and correct the styling convention in the docs

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §6, §9,
migration Step 6. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §8.
**Risk:** Low. Closing ticket of the T50 migration.

---

## Problem

Two loose ends remain after the CSS Grid migration, and one of them is a correctness problem in the
project's own governing documents.

### 1. Dead table-era style constants

`src/components/schedule/slotCellConstants.js` exports `cellTd` and `emptyTd` — inline style objects
named for the `<td>` they used to style. After T56 no `<td>` exists under
`src/components/schedule/`. Their static structural styling (padding, radius, border, name/flag/dot
layout) moved into `scheduleGrid.css`. T54 and T56 deliberately left them in place so their diffs
stayed readable; deleting them is this ticket's job.

### 2. `CLAUDE.md` and `TARGET_ARCHITECTURE.md` state a rule that is false

The "inline styles only, no CSS files" rule **has no recorded rationale and was already false
before this migration started**:

- Its earliest appearance is a tech-stack line in the archived, superseded plan
  `docs/archive/completed-plans/2026-05-23-shoresh-ui-redesign.md` (historical origin only) —
  "React 19, Vite 8, inline styles, src/styles/shared.js for shared tokens." A starting choice,
  never argued.
- `CLAUDE.md` states it as fact with no justification.
- `docs/work/architecture-reports/TARGET_ARCHITECTURE.md:39` promotes it to **"load-bearing"**
  alongside genuinely load-bearing decisions (op-log-everything, pure engine, hard IPC seam), with
  no supporting argument.
- `src/index.css` (44 lines) and `src/App.css` (184 lines) already exist, and `src/index.css`
  defines `--primary` and the entire design token set. The constitution itself refers to "the app's
  live stylesheet."

**This matters beyond tidiness.** A styling convention with no recorded rationale was, in the
previous revision of this spec, about to justify building a `<canvas>` ambient layer with a
`requestAnimationFrame` paint loop — because inline styles have no `:hover` and no attribute
selectors, so hover was paid for with React state and re-renders. The rule was corrected before it
cost that. Leaving the docs asserting the false version invites the same reasoning again.

The product owner approved the narrow relaxation on 2026-08-06. **The docs must now state what is
actually true**, and Step 6 of the spec names this explicitly.

---

## Scope

**In:**

1. Delete `cellTd`, `emptyTd`, and any other style constant left dead by the migration from
   `src/components/schedule/slotCellConstants.js`. Verify by grep that nothing imports them.
2. Delete any other dead export left behind across `src/components/schedule/` and
   `src/screens/schedule/` by T54–T58 — including props that were threaded through views purely
   for the old drag flags.
3. **Correct `CLAUDE.md`.** Replace the "ALL styles are inline React style objects. No CSS files.
   No className for styling" claim with the actual convention:
   - Global design tokens live in CSS (`src/index.css`).
   - Component styles are inline style objects, with `src/styles/shared.js` as the shared-token
     module.
   - **One scoped exception:** `src/components/schedule/scheduleGrid.css`, covering the schedule
     grid container, cell interaction pseudo-states, and cell data-attribute states. State the
     reason in one line (pseudo-classes and attribute selectors do not exist in inline styles, and
     their absence is otherwise paid for with React state on a dense repeated element) and the
     boundary (**this does not extend beyond `src/components/schedule/`**).
   - Per-cell computed geometry (`gridRow`, `gridColumn`) and data-derived colours stay inline.
4. **Correct `docs/work/architecture-reports/TARGET_ARCHITECTURE.md:39`** the same way, and remove
   the "load-bearing" framing from the styling rule specifically — it was never argued and does not
   belong beside op-log-everything, the pure engine, and the IPC seam.
5. Note in both docs that a *new* ephemeral cell state is added as a data attribute plus a rule in
   `scheduleGrid.css`, not as React state (ADR "Future constraints").

**Out:**

- **Adding any further stylesheet, or converting any other component to CSS.** The relaxation is
  one file, one directory, one stated reason. Widening it here would be exactly the drift the ADR
  guards against.
- `ACTIVITY_COLORS` tokenization — **T52**. It is the only remaining hardcoded colour under
  `src/components/schedule/` (`ANCHOR_COLOR` and `FLAG_COLORS` are already token-backed, verified
  2026-08-06) and it has its own ticket for a reason.
- Any behavioural or visual change whatsoever.
- Retheming to the design-system spec. Out of scope, and this migration must not have regressed it.

---

## Acceptance

- [ ] `grep -rn "cellTd\|emptyTd" src/` returns nothing
- [ ] No dead exports remain in `src/components/schedule/` or `src/screens/schedule/` — verified by
      grep per export, not by inspection
- [ ] `CLAUDE.md` describes the actual styling convention, including the single scoped stylesheet,
      its reason, and its boundary
- [ ] `docs/work/architecture-reports/TARGET_ARCHITECTURE.md:39` matches, and no longer calls the
      styling rule load-bearing
- [ ] Exactly **one** stylesheet exists under `src/components/`, at
      `src/components/schedule/scheduleGrid.css`
- [ ] Zero visual change — the app renders identically before and after
- [ ] `src/screens/schedule/gridGeometry.test.js` untouched and green
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

- **T56** — no `<td>` remains, so `cellTd`/`emptyTd` are genuinely dead.
- **T58** — the drag flags and their threaded props are gone.
- **T59** — should land first if it is going to land at all, so this sweep catches anything it
  leaves behind.
