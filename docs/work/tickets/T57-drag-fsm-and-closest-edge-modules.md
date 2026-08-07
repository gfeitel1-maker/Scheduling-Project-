---
title: T57-drag-fsm-and-closest-edge-modules
document_type: ticket
status: closed
created: 2026-08-06
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_tickets: [docs/work/tickets/T58-drag-fsm-cutover.md, docs/work/tickets/T50-schedule-canvas-rebuild.md]
archive_when: dragFSM.js and closestEdge.js exist, are pure, are exhaustively tested, and the app is unchanged at runtime
---

# T57 — `dragFSM.js` and `closestEdge.js` — pure modules, exhaustively tested

**Parent:** T50. **Spec:** `docs/work/specs/2026-08-06-schedule-canvas-redesign.md` §5.2, §5.5, §9,
migration Step 1. **ADR:** `docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §6.
**Risk:** Very low. Nothing imports these modules when this ticket closes.

---

## Problem

Click-vs-drag ambiguity in the schedule grid is currently implicit — it lives in @dnd-kit's
`distance: 8` activation constraint plus a set of scattered boolean flags in `ScheduleScreen.jsx`
(`isExpandDragActive`, `isGroupExpandDragActive`, `isDayExpandDragActive`) and ad-hoc `fillState`
checks. There is no single place that says what state a drag is in.

The ADR's decision is one explicit finite state machine. The spec is emphatic that **the machine's
state × event table is exhaustively unit tested before any component consumes it** — which is why
this is its own ticket, separate from the cutover (T58).

Two supporting facts, so the Maker does not relitigate them:

- **No data grid surveyed uses an FSM.** AG Grid, Handsontable, RevoGrid, and Glide all use ad-hoc
  nullable flags scattered across files. Calendars do use one: FullCalendar splits three ways
  (`PointerDragging` / `FeaturefulElementDragging` / `HitDragging`), Toast UI has a `DraggingState`
  enum. We adopt one machine, not three — three is more structure than four drag kinds need.
- **`Pointing` is the point of the exercise.** Naming the undecided state is the deliverable.

---

## Scope

**In — two new pure files under `src/screens/schedule/`:**

### `dragFSM.js`

```js
transition(state, event) -> { nextState, sideEffects }
```

States: `Idle → Pointing → Dragging → Resolving → Idle`.

- **`Pointing`** — the formal home of click-vs-drag ambiguity. This is tldraw's
  `Idle → Pointing → Dragging`.
- **`Resolving`** — pointer released over a valid target, mutation **not yet committed**. It exists
  because our commits are op-log writes that can fail, and the UI needs one place to express "in
  flight." It must be able to return to `Idle` on both success and failure.
- The machine covers **all four existing drag kinds**: slot move, palette drop, expand/extend drag,
  and overlay fill drag. Carry the kind in the context payload; do not create four machines.
- Adopt FullCalendar's **hit vocabulary** in the context payload — `initialHit`, `movingHit`,
  `finalHit` — but keep one machine.
- `sideEffects` are **described, not performed**. This module touches no DOM and imports nothing
  from React or @dnd-kit. T58 is what executes the effects.

### `closestEdge.js`

```js
closestEdge(rect, point) -> 'top' | 'bottom'
```

Atlassian's named pattern (`@atlaskit/pragmatic-drag-and-drop-hitbox`). Given a resolved cell's
rect and the pointer position within it, decide which edge the drop attaches to. **This is what
makes "insert above block 4" distinguishable from "replace block 4" without a modifier key.**
Pure, no DOM reads — the caller supplies the rect.

**Out:**

- **Any consumption of these modules.** No component, hook, or handler imports them at close.
  `useDragFSM.js`, the removal of per-cell `useDroppable`, drop indicators, the drag preview, and
  the deletion of the boolean flags are all **T58**.
- Any change to `dragHandlers.js` or `ScheduleScreen.jsx`.
- Any rendering change.
- Reconsidering the activation distance. Spec §5.6 notes `distance: 8` is on the deliberate end
  (Windows 4px, Unity 5px, dnd-kit default 5px, **zero constraint on an explicit handle**) and
  recommends reviewing down to 5px with zero constraint on the expand handle. That is a T58 tuning
  decision, explicitly "low stakes, easily reversed; not a blocker."
- **Replacing @dnd-kit.** It is retained. Its keyboard sensor is load-bearing for the
  accessibility commitment, and raw `setPointerCapture` would mean reimplementing it. Rejected in
  the ADR as risk without benefit at this scale.

---

## Acceptance

- [ ] `src/screens/schedule/dragFSM.js` exists and is pure — no DOM, no React, no @dnd-kit import,
      no `localClient`
- [ ] `src/screens/schedule/closestEdge.js` exists and is pure
- [ ] **The state × event table is exhaustive.** `dragFSM.test.js` asserts the outcome for **every**
      (state, event) pair, including every invalid pair — an unexpected event in a given state must
      have a defined, tested outcome (ignore or reset), not undefined behaviour
- [ ] All four drag kinds are represented in the tests: slot move, palette drop, expand/extend
      drag, overlay fill drag
- [ ] `Pointing → Dragging` and `Pointing → Idle` (a click, not a drag) are both tested explicitly
- [ ] `Resolving → Idle` is tested on **both** commit success and commit failure
- [ ] `closestEdge.test.js` covers: point above midline, below midline, exactly on the midline
      (state which way it resolves and test it), and points at the rect's extreme edges
- [ ] **The app is unchanged at runtime.** No existing file imports either module at close;
      `dragHandlers.js` and `ScheduleScreen.jsx` are untouched
- [ ] `npm run test`, `npm run lint`, `npm run build` pass

## Dependencies

None. This can be worked in parallel with T53–T56.

## Blocks

T58.
