---
title: "Roots W2-UX — setup-screen interaction polish"
document_type: plan
status: active
created: 2026-08-27
governing_docs: [docs/work/specs/2026-08-26-roots-subscreens-redundancy-program.md]
---

# Roots W2-UX — setup-screen interaction polish

Three owner-requested (2026-08-26) interaction wins on the six Roots setup screens, on top of the merged W1 shared shell. Presentational/interaction only — no schema, no data-model change. Each task is behavior-additive and test-first.

**Survey ground truth (already checked):**
- Enter-to-add already fires from the PRIMARY add-row field on all six screens (`addDay`/`addTier`/`addGroup`/`addBlock`/`addActivityQuick`, and Anchors via modal name). The gap is secondary add-row fields.
- `CapacityStepper` is exported from `src/screens/LocationsScreen.jsx:39` and already imported by `src/components/LocationPicker.jsx:3`. Reuse via the same import path — do NOT edit LocationsScreen (peer-owned, now list-only).
- Inline-edit rows already do Enter→save / Escape→cancel (e.g. `TiersScreen.jsx:53`).

## Task 1 — Enter commits from anywhere in the add-row

Today Enter only commits from the primary field. Make Enter commit the add from any field in the add-row, guarding the same validity the add button already checks (empty/invalid → no-op, exactly as the button's `disabled` predicate).

- TimeBlocksScreen add-row: the start (`newStart`), end (`newEnd`), and order (`newSort`) inputs — add `onKeyDown={e => e.key === 'Enter' && addBlock()}` (addBlock already guards `!newName.trim() || !newStart || !newEnd || !activeCohort`).
- DaysScreen add-row: the day-of-week `<select>` and order input — Enter → `addDay` (guarded).
- Any other screen whose add-row has a secondary field lacking the handler (audit each; single-field add-rows already covered).
- Do NOT change the guard logic; Enter routes to the SAME add function the button calls.
- Test: for TimeBlocks and Days, simulate Enter keydown on a secondary field with a valid row → the add handler runs (row added); with an invalid row → no add.

## Task 2 — CapacityStepper on capacity numbers in the Activities modal

Replace the bare `<input type="number">` for **min_per_week** and **max_per_week** (`ActivitiesScreen.jsx:318,321`) with `<CapacityStepper>` (+/− plus direct typing). Consider `max_groups_per_slot` (:304) and `span_blocks` (:324) — apply the stepper where it reads as a "how many" count; leave `prefer_before_day_min` and `priority` as-is if they don't read as capacity.

- Import `CapacityStepper` from `../screens/LocationsScreen` (existing precedent — LocationPicker does exactly this). Do NOT move or edit the component.
- CapacityStepper's `onChange` gives a number; keep the existing `Number(...)` coercion at save (`:251`) intact. Preserve `min` bounds (min_per_week ≥ 0, max_groups ≥ 2, span ≥ 1) — pass through the stepper if it supports a floor, else clamp in onChange as the inputs do today.
- Do NOT touch the `sort_order` number inputs on Days/TimeBlocks/Tiers — those are slated to be hidden in W2-field-retirement; adding steppers there is wasted work.
- Test: the stepper renders for min/max-per-week; +/− adjusts the value; save writes the adjusted number.

## Task 3 — One-line edit/save/delete controls in edit mode

When a row is pulled up for editing, its controls (Save / Cancel, and Delete where present) must sit on a single line — no wrap/stack. Audit each screen's Row component's actions cell in edit state; apply `display:flex; flexWrap:nowrap; gap` (and `whiteSpace:nowrap` on buttons) so the cluster stays on one line at the screen's normal width.

- Screens with inline-edit Row components: Tiers, Groups, Days, TimeBlocks, Activities (Anchors edits via modal — confirm; if modal, no change needed).
- Purely a layout fix — no handler/logic change.
- Test/verify: visual (the built-in row tests already assert the buttons exist); add an assertion only if a screen's test can check the actions container's flex-nowrap without brittleness — otherwise rely on the visual pass.

## Task 4 — Row-click to edit (owner-confirmed 2026-08-27, supersedes the Edit button)

Unify row interaction: **clicking a row edits it**, and the visible "Edit" button disappears everywhere.

- **Simple table screens (Tiers, Groups, Days, Time Blocks):** clicking a non-editing row enters inline edit immediately (fields go live, focus lands in the first field). **Enter saves** (already wired) and returns the row to rest; **Escape** cancels. The **Edit** button is removed. **Delete** stays in the row as a control.
- **Activities & Anchors (modal editors):** clicking a row (not on a control) opens its edit **modal** — the same modal the Edit button opened. The **Edit** button is removed. **Duplicate**, the **toggle**, and any other per-row control stay and keep working — every interactive control in a row calls `stopPropagation` so clicking it does its own action, never a stray row-edit.
- **Accessibility (required — do not regress):** since the row is now the affordance, each row gets `role="button"`, `tabIndex={0}`, an `aria-label` naming the record, `cursor: pointer`, and an `onKeyDown` so **Enter/Space** on a focused row triggers edit (inline or modal). Editing-state rows and control buttons keep their own focus/semantics.
- **Selection highlight:** a hovered/focused row shows a clear affordance via existing tokens (`--bg`/hover), so it reads as clickable.
- No data-model change; handlers are the same ones the Edit button called.

**Test impact:** existing tests that do `getByText('Edit').click()` to enter edit mode must switch to clicking the row (and, for Activities/Anchors, asserting the modal opens on row click). Update those; do not delete coverage.

## Verification
Per-file focused tests (`npm run test -- --no-file-parallelism <path>`), then the full gate + a visual pass (dev server + mock) before the PR. Machine under load: background long runs with real exit-code capture; never `| tail`.
