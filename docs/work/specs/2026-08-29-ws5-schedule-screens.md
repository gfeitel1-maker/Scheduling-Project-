---
title: "WS5 — the schedule screens (the Plants surface)"
document_type: spec
status: active
created: 2026-08-29
archive_when: the WS5 ADRs (sidebar-rows, palette, chrome-slim, activity-view-as-specialist-export) all ship or are deferred, or a new owner decision supersedes this direction
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
parent_spec: [docs/work/specs/2026-08-28-lifecycle-ia-program.md]
---

# WS5 — the schedule screens

Status: **Active — owner-approved direction (2026-08-29 session). Decomposes into per-slice ADRs before code.**
Author: Governor (session, worktree `hungry-sammet-51f990`). Owner: the product owner (the craftsman).

This records the owner's decisions for the Plants (schedule) surface after three divergent explorations. It is the durable capture; each slice below still gets its own ADR / Maker brief before code. Nothing here authorizes code.

The overriding constraint remains **[the non-canonical rule](../../adr/2026-07-28-plural-candidate-schedules-per-camp.md)**: nothing may designate Manual or Generated as the active/real/current schedule, or pick one on the director's behalf. Where exactly one is required (export), the director chooses at that moment and the choice is not remembered.

---

## 1. What was explored, and what the owner decided

Three explorations were run: an activity-palette divergence (6 directions), a sidebar redesign, and a screen-chrome pass. The owner's reactions **reversed two of the three** and confirmed the palette. The net direction:

### 1a. Route legibility lives in the sidebar — not a pill, not an ask-screen
- **Rejected: the two-tier segmented sidebar.** Over-built. The ask was literal: the *current* sidebar should **show** each section's rows instead of hiding them behind a collapsed header.
- **Rejected: the top route pill.** "Which schedule am I in" is answered by the **highlighted active row in the sidebar**, full stop.
- **Rejected: the route-choice / route-ask screen.** Owner: "trash — copy for the sake of copy — get rid of it." The sidebar's visible rows + highlight do the job; no interstitial ask.
- **Switching routes is deliberate and sidebar-only.** "Switching should be harder because it's a choice." The four Plants rows (Generated Schedule, Manual Build, Special Schedules, Elective Schedules) are **always visible** so you can see which one you're in; you switch by clicking, not by a top-chrome flip.

### 1b. The `Schedule →` door on Roots routes to **Generated**
- Owner's first preference was an ask-once-remembered door (pick Manual/Generated once via cards; remembered; only re-asked on schedule re-import).
- **Decided against remembering it.** A remembered per-camp door target is a soft "this is your real schedule" — it collides with the non-canonical rule (§ADR: the choice "is not remembered"). Owner accepted the simpler fallback they themselves offered: **door → Generated, always.** Manual is one deliberate sidebar click away. Owner: "this is for me, i am mostly willing to trust the system i built."
- If this is ever revisited toward the remembered-once door, it must go back through the Architect to reconcile with the non-canonical ADR first.

### 1c. Activity palette → **Ledger + Filter** (open to Context-Shifting)
- The drag-source rail combines the **Ledger** direction (needed / placed grouping — on a blank week the palette *is* the to-do list) with the **Filter** direction (a search field to narrow a long catalog).
- **Context-Shifting stays open and is likely warranted** — see §1e: the three views are genuinely different jobs, so the rail adapting per view is coherent, not gratuitous.

### 1d. Toolbar slims; **Field Trips leaves the main schedule**
- **Field Trips control is removed from the main (Generated/Manual) schedule screen.** A field trip is a *special event* in the current model → it belongs in the **Special Schedules** surface, not the main grid toolbar.
- **Implementation finding (2026-08-29):** the toolbar "Field Trips" button is the *only* entry point to the **overlay/stamp subsystem** — `handleStampClick` (`useOverlayFillStamp.js`) is the sole creator of `overlays` rows; the fill-drag only extends an existing overlay, and `OverlayCell` exists solely to render stamped overlays. Weather Mode is independent (a visual grid toggle). So "field trips out" splits: **S2a** removes the toolbar entry point (overlay code left dormant — with no live camp data nothing can create one anyway); **S2b** retires the subsystem and re-homes field trips as first-class **Events** (which Special Schedules already authors). S2b touches a stored table → its own ADR + Red Hat + migration; it must not ride in the S2a toolbar PR.
- Weather Mode, Versions, Export, Rebuild recede into a `⋯` overflow; the front-of-toolbar keeps only what's used mid-build (Week, View, Undo/Redo). No route pill (see §1a).
- **Special / elective grids need no canonical-warning.** Owner: "anyone who reads the bar knows it isn't your 'canonical' schedule. no one looks at it and thinks 'maybe this is where i do all of my scheduling.'" The label suffices.

### 1e. Activity view is the **specialists' view + an export** — a distinct job, not just a re-slice
This is the load-bearing domain truth from the session, worth stating plainly:
- Group / Day / Activity are three slices of one schedule model. **But Activity view is not symmetric with the other two.**
- **Activity view is what a specialist who *teaches* an activity sees** — their own schedule first, not the camp's day-to-day. It's also where you place kids when something goes awry.
- **Activity view is an export function.** When the director hands specialists their schedules, the Activity slice is the deliverable — the specialist cares about their view, not Day view.
- Design consequence: Activity view is designed *toward the specialist and the export*, and this is the strongest argument for the palette/panel context-shifting in §1c.

### 1f. Saved / labelled schedule variants — an owned, not-yet-scheduled concept
- Earlier concept the owner wants preserved: **save/lock a schedule design and label the variants** — "week 1," "week 2 with field trip," "week 2 plain," etc. Relates to the existing Versions/snapshots machinery and to `schedule_weeks` (v-migration; `is_archived`).
- Field-trip placement interacts with this ("week 2 with field trip" is a labelled variant). Since field trips now live in Special Schedules (§1d), the variant-labelling and the field-trip surface must be designed together.
- **Not scheduled here.** Flagged as an owned concept for a later WS5 slice / ADR, not part of the immediate converged build.

---

## 2. Slices and sequencing

Converged, low-risk first (each still gets a Maker brief; UI-significant ones get a Designer spec; anything touching stored shape gets an ADR + migration + Red Hat):

| # | Slice | Risk | Gate emphasis |
|---|-------|------|---------------|
| S1 | Sidebar shows the Plants rows (stop hiding them); active route highlighted | Low (nav-only) | Designer + code-review; no data |
| S2a | Toolbar slim: remove the Field Trips *entry point*; Weather/Versions/Export/Rebuild → `⋯` overflow; keep Week/route-label/View/Undo-Redo; no pill | Low–med | code-review + live-render |
| S2b | **Retire the overlay/stamp subsystem** and re-home field trips as Events | High (stored shape) | Own ADR + migration + Red Hat |
| S3 | Activity palette → Ledger + Filter | Med (UI-significant) | Designer spec is a hard constraint; live-render |
| S4 | Activity view as specialist view + export | Med–high (product) | Own ADR; export format is a deliverable |
| S5 | Saved/labelled schedule variants (+ field-trip variant) | High (stored shape) | Own ADR + migration + Red Hat; **not now** |

Non-canonical rule is a standing check on every slice, most sharply S1 (highlight ≠ designation) and S5 (a labelled variant must not become "the" schedule).

---

## 3. Open / owner-gated

- S1–S3 are ready to brief. S4 and S5 need their own ADRs before code.
- Iconography for the sidebar rows is a known-off detail the owner deferred ("we can fix that after these are wired in properly") — fold into S1's Designer pass, not a separate slice.
- Color/animation polish of the schedule screen as a whole is a later pass, consistent with how Roots (WS4) was polished after it was wired.
