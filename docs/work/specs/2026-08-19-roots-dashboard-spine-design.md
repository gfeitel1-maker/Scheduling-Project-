---
title: "Roots as the dashboard / spine — design"
document_type: spec
status: draft
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_docs:
  - docs/work/specs/2026-08-19-ingest-flow-audit.md
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
  - docs/adr/2026-08-19-roots-census-and-persistent-inspector.md
archive_when: the design ships (its slices land) and PLATFORM_STATE reflects Roots-as-home, or the direction is rejected
---

# Roots as the dashboard / spine — design

Validated through a brainstorming session with the owner (layout confirmed via visual companion,
mockups persisted in `.superpowers/brainstorm/`). This spec is the input to `writing-plans`.

## Goal (observable success predicate)

A director opening the app lands on **Roots** and sees, in one surface: their camp's name, an honest
"you can / cannot build a week yet" verdict, everything Shoresh understands (the census, quiet), and
the handful of things that still need them — and can, from that same surface, **bring data in**
(import last year, facility map), **drill into any area to manage it**, and **go build the schedule**.
After importing, they are returned to that same surface, not dropped on the import screen.

Concretely, the design is **done** when:
- The `roots` route is the default landing screen (`App.jsx`), replacing `readiness`.
- Clicking a root/child node selects it and the panel shows that area's census **plus a prominent
  "Manage {Area} →"** and clickable rows that navigate to the correct setup screen (fixes the
  current "nodes go nowhere").
- Roots carries the readiness verdict banner, computed **once** from `getReadiness` (no second
  compute), plus the worksheet download and an "Import last year" entry point.
- A successful import routes the director back to Roots ("Imported N — here's your camp → Go to
  Schedule"), not to the ImportScreen banner.
- The old `readiness` route redirects to `roots`; ReadinessHub is retired.

## Non-goals (explicitly out of scope for this increment)

- **Absorbing the setup CRUD into Roots.** The north star (edit units/activities in-place on the
  nodes) is *designed toward*, not built. Setup screens remain the edit surfaces, reached via
  "Manage →".
- **Rebuilding the import antechamber or the facility map.** Both are wired from Roots as-is.
- **Changing the build-a-week gate.** `getSetupGaps` stays the single blocking truth the generation
  gate calls; Roots *displays* the verdict, never *becomes* the gate.
- **Header/heading copy.** Parked as a follow-up (owner's language skill) — the structure does not
  depend on the exact words. The current strings stay until then.

## The design

### Layout A — canvas hero, panel drawer

Top-to-bottom / left-to-right:
1. **Banner** — camp name; the readiness verdict ("N things need you before you can build a week" /
   "Ready to build a week"); **Import last year**; **Download worksheet**; the facility-map entry
   (see below). The import/worksheet/map "bring data in" actions are most prominent when the camp is
   new/empty (same posture ReadinessHub's brand-new "Import last year" CTA has today).
2. **State tiles** — Understood / Needs you / Changed / Not set up (the existing `RootMap` tiles).
3. **Hero root illustration** — the existing `RootMap` canvas with domain + child nodes, as the
   visual centrepiece.
4. **Panel drawer** — the existing `RootMapPanel`, sliding in on node-select (the crossfade already
   tuned in the polish batch), showing the census roster + **Manage {Area} →** + clickable rows.

### One shell, two moments

The `roots` route and the import reconciliation are **the same component** (`ReconciliationScreen`,
`mode: 'inspect' | 'import'`) — this is already true today. This design leans into it:

- **Home / dashboard (`mode: 'inspect'`)** — banner shows the readiness verdict + bring-data-in
  actions; the drawer shows the **census** + Manage navigation.
- **Post-import (`mode: 'import'`)** — banner shows "Imported N records — here's your camp" + a
  **Go to Schedule** CTA; the drawer shows the **decisions** needing the director. On commit, the
  flow **routes to `roots`** rather than tearing down to the ImportScreen banner.

### Node interaction (fixes "nodes go nowhere")

Click = select (unchanged mechanic) → the panel becomes the loud navigation surface: a primary
**"Manage {Area} →"** button (promoted from today's quieter "Open in {screen} →") and roster rows
that navigate on click. Deep-links resolve through the existing `rootMapNav.js` (`screenForNode` /
per-row `targetScreen`). No node performs a bare navigate-on-click — selection + census preview is
preserved, navigation is just made obvious.

### Readiness absorption (kills the double-compute)

Audit finding: ReadinessHub's `missing` and Roots' `not_set_up` are the same set computed twice
(counts vs rows). Resolution:
- The Roots banner renders the readiness verdict from `getReadiness` / `describeReadiness` (the same
  functions ReadinessHub uses) — one computation, surfaced once.
- ReadinessHub's unique assets — the **worksheet download** and the **"Import last year" CTA** —
  move onto the Roots banner.
- The `readiness` `SCREENS` route redirects to `roots`; `ReadinessHub.jsx` is retired (removed, or a
  thin redirect kept only if a slice needs a transitional step).
- `getSetupGaps` is untouched and remains the blocking gate the generation flow calls directly.

### Facility map

- **To start:** a banner "bring data in" action, grouped with Import — prominent when the camp is
  new. Wires the existing Locations map screen.
- **Persistent home (once updating):** the Facility/Resources node's panel offers **"Open facility
  map →"** alongside Locations. Same target screen; contextual rather than a chrome action.
- Not rebuilt; both are navigation into the existing `locations` map surface.

### Landing

`App.jsx`'s default `screen` state flips `'readiness'` → `'roots'`. The sidebar's `roots` entry
becomes the top/home item; the `readiness` entry is removed (route redirects).

## Architecture toward the north star (no rework later)

The **node → panel → Manage** pattern is the deliberate seam. Today "Manage" *navigates* to a setup
screen; the north-star step is to let that panel *host* the setup editing in-place. Because the panel
(`RootMapPanel`) is already selection-scoped and mode-aware, absorbing a setup editor later means
rendering it in the panel for a selected node — not restructuring Roots. This design adds no state or
routing that would have to be undone to get there.

## Components / data changes

- **`src/App.jsx`** — default `screen` → `'roots'`; `readiness` route redirects to `roots` (or is
  removed); sidebar ordering.
- **`src/components/layout/navSections.js`** — `roots` becomes the home item; remove `readiness`.
- **`src/screens/ReconciliationScreen.jsx`** — inspect mode gains the **banner** (readiness verdict
  via `getReadiness` + bring-data-in actions: Import, Worksheet, Facility map). The banner is
  mode-aware (verdict+actions in inspect; "Imported N → Go to Schedule" in the post-import result
  state).
- **`src/components/reconciliation/RootMapPanel.jsx`** — promote the node's navigation to a primary
  **"Manage {Area} →"** affordance; ensure rows navigate (already wired via `onRowClick`).
- **Post-commit routing** — `ImportScreen`'s `handleReconciliationCommitted` (or the commit success
  path) routes to `roots` with the "Imported N → Go to Schedule" banner state, instead of rendering
  the ephemeral ImportScreen receipt. The grace-window undo rides along to Roots (it currently dies
  on navigation — moving the receipt to Roots is what lets it survive).
- **`src/screens/ReadinessHub.jsx`** — retired; its worksheet-download + import-CTA logic moves to
  the Roots banner (reuse `getReadiness`/`describeReadiness`/`describeOptionalGaps`, the worksheet
  export).
- **Facility map wiring** — a banner action + a Facility/Resources panel link, both `onNavigate` to
  the existing `locations` map route.

No schema change. No engine change. No new model — the `buildRootMapModel` + `getReadiness` spine is
reused.

## Error handling / edge states

- Inspect-mode read failures already surface the subtle "couldn't read part of your setup" notice
  (shipped in Slice 4) — the banner verdict must degrade gracefully when a required-area read fails
  (do not show a false "ready").
- Empty/brand-new camp: the banner leads with "Import last year" (the brand-new posture), the tiles
  read `not_set_up`, and the census is empty-with-honest-copy (shipped).
- Post-import held-conflict path is unchanged (the reconcile mode already handles it).

## Testing seams

- `App.jsx` default landing renders `roots`; the `readiness` route redirects to `roots`.
- Clicking a node → panel shows "Manage {Area} →" → navigates to the correct setup screen key.
- The Roots banner verdict string equals `describeReadiness(getReadiness(...))` — one source.
- A successful import routes to `roots` and shows the "Imported N → Go to Schedule" banner (not the
  ImportScreen receipt); the grace-window undo is reachable on Roots.
- Retiring ReadinessHub does not drop the worksheet download or the import CTA (they exist on the
  Roots banner).
- Reduced-motion + read-failure degradation on the banner.

## Bounded slices (for writing-plans)

1. **Node navigation prominence** — promote "Manage {Area} →" + confirm row navigation. Small,
   independently shippable; directly fixes "nodes go nowhere."
2. **Roots banner (readiness verdict + bring-data-in actions)** — add the mode-aware banner reading
   `getReadiness`; Import + Worksheet + Facility-map (banner) + Facility-map (node panel) entry
   points.
3. **Landing swap + ReadinessHub retirement** — default screen → `roots`; `readiness` redirects;
   move worksheet/CTA off ReadinessHub; remove it. (Depends on slice 2 so nothing is lost.)
4. **Post-import routing to Roots** — commit success routes to `roots` with the post-import banner
   state + surviving grace-window undo.

Each slice is test-first at its seam and independently reversible; 3 and 4 hit the landing/redirect
and the commit-flow seams and warrant the closer review.

## Parked follow-ups

- Header/heading copy (owner's language skill).
- The audit's deferred items (field-level diff, UNKNOWN detection, etc.) and T93 (host-gate) are
  independent.
