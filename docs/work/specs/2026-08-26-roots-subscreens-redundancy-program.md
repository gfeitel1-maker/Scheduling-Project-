---
title: "Roots sub-screens: redundancy & minimalism program"
document_type: spec
status: active
created: 2026-08-26
archive_when: W1–W3 implementation ships (merged/deferred) or this program is superseded by a new owner decision
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-roots-as-hub-setup-ia.md]
---

# Roots sub-screens: redundancy & minimalism program

Status: **Active — W1 shared-shell shipped; W1b/W2/W3 gated**
Date: 2026-08-26
Owner-approved decisions embedded (2026-08-26 session). Author: Governor (peer session, worktree `priceless-germain-a67641`).
Related: `docs/adr/2026-08-22-roots-as-hub-setup-ia.md` (LOCKED), `docs/work/specs/2026-08-22-roots-as-hub-setup-ia-slices.md`, memory `project_roots_as_hub_setup_ia`.

## Problem

The Roots setup sub-screens (Age Divisions, Groups, Days, Time Blocks, Activities, Recurring Events; Locations is peer-owned) read as redundant. An `/impeccable critique` (dual-agent, 2026-08-26) scored the collection **25/40** with Consistency (#4) and Aesthetic/Minimalist (#8) as the weak axes — matching the owner's instinct. The redundancy is **mechanical and locatable**, not a vibe.

Independent Red Hat / Architect / Tester review then found that two of the four originally-proposed workstreams hide **data-model decisions** behind "cosmetic" framing, and one reverses a locked ADR. This spec reflects the de-risked program after those findings and the owner's rulings.

## Success predicate (observable)

- The six setup screens render their toolbar / import modal / add-row / `Next:` footer from **shared components**, not six hand-typed copies. Grep shows one definition of each, not six.
- Per-screen chrome is **config-driven**: a small screen (Days) does not display the same heavyweight `Delete All` / `Import` affordance with equal weight as a bulk-entry screen (Activities).
- `Field`, `WeekToggle`, `DOW`, and the `serialize/parse` helpers exist once in shared modules, not duplicated across Activities/Anchors.
- Location create + capacity-update logic exists once (in `LocationPicker`), **and inline capacity editing still works** from the Activity and Anchor modals (no new forced navigation).
- Director-facing text carries no internal nouns (`anchors_template.xlsx`, "Co-schedule").
- **No existing behavior regresses**: the write-failure/delete-recovery messaging, the stale-load request-id guards, the atomic name-first create ordering, and every current test's intent are preserved.

## Non-goals / owner rulings

- **No screen merges.** Owner ruled 2026-08-26: do **not** merge Days+TimeBlocks, do **not** merge Tiers+Groups. (Tester: merging erases the "shape of the week" revelation and fuses structural vs operational decisions.) The redundancy win comes from the shared *shell*, with screens kept separate.
- **No new visual materials.** Owner: stay inside the locked app design. Bento (W3) means *structure using existing tokens*, not Glass/Neo/Clay/etc. The style-trend list (skeuomorphism…spatial UI) is explicitly declined for the core Operate UI; only Minimalism-as-discipline and Bento-as-layout are adopted.
- **No explainers / help text / onboarding as a fix.** Owner: if the UI needs explaining, that is a design failure. Every guidance concern is solved by affordance (visual weight, obvious next action), never by words-on-screen.
- **Bento augments, never replaces.** Owner ruled 2026-08-26: the Bento hub sits **above** the collapsible entity list; the list stays reachable. Consistent with the locked roots-as-hub ADR.

## Findings reconciliation (audit ∪ blindspots)

Every finding from the `/impeccable critique` and from the Red Hat / Architect / Tester blindspot pass, mapped to where it lands. Nothing is silently dropped; parked items name the reason (per the "fix all findings, no triage" discipline).

| # | Finding | Source | Lands in |
|---|---------|--------|----------|
| 1 | Toolbar / import modal / add-card / `Next:` footer copy-pasted 6× | Audit A | **W1** |
| 2 | `Field` defined twice (`ActivitiesScreen.jsx:435`, `AnchorsScreen.jsx:220`); `WeekToggle`/`DOW`/serialize helpers duplicated | Audit A | **W1** |
| 3 | `#FFF8E7/#F5A623` warning hex pasted per screen; token exists | Audit A | **W1** |
| 4 | Uniform chrome burdens simple screens; `Delete All` lurking on Days reads as danger | Audit + Tester | **W1** (config-driven chrome) |
| 5 | Location create/capacity triplicated across Activities/Anchors/Locations | Audit B | **W1** (dedup into `LocationPicker`) |
| 6 | Inline capacity edit is a fast path, not redundancy — must survive dedup | Tester HIGH | **W1** (keep inline) |
| 7 | Import modals `position:fixed`, no focus management on open (a11y) | Audit (Sam) | **W1** (fix in shared `ImportModal`) |
| 8 | CohortPicker present on some screens, absent on others — reads arbitrary | Audit + Alex persona | **W1** (make the scoping difference legible; cohort-scoped screens are **Tiers, Time Blocks, Anchors** — verified via `CohortPicker`/`cohort_id` usage; Groups/Days/Activities are not — do not add pickers to the latter) |
| 9 | `max-height` layout animation (`ActivitiesScreen.jsx:378`); already reduced-motion-guarded | Detector | **W1** (P3 — migrate to `grid-template-rows` if trivial, else leave) |
| 10 | Two week-scoping models (exclusion-set vs single `schedule_week_id`) | Audit B + Red Hat HIGH | **W1b** (data-model, design-gated) |
| 11 | Tier↔Group round-trip invisible: pick tiers, DB stores group_ids (`AnchorsScreen.jsx:107`) | Audit B | **W1b** (same eligibility/scoping design pass — legibility of the tier→group resolution) |
| 12 | "Sort Order" as director-facing input on Tiers/Days/TimeBlocks | Audit C | **W2-field-retirement** (data-model, gated) |
| 13 | `day_of_week` exposed; load-bearing for `prefer_before_day` | Audit C + Red Hat HIGH | **W2-field-retirement** (keep stored, hide input) |
| 14 | Internal nouns: `anchors_template.xlsx`, "Co-schedule" | Audit C/2 | **W2 renames** (copy-only, ship now) |
| 15 | Provenance dot: elaborate surface on the heaviest screen | Audit C/D | **Parked** — recently shipped (Slice D/E, owner-approved); not redundancy. Revisit only if it reads heavy after W1 lands. |
| 16 | Days+TimeBlocks / Tiers+Groups could merge | Audit E | **Rejected** by owner (2026-08-26) — see Non-goals. |
| 17 | Dependency order (divisions→groups) surfaced only as after-the-fact warnings | Audit (recognition #6) | **W3** (the Bento hub's incomplete-area tile is the obvious next action by affordance — the design-level answer to "what next", no explainer) |

Strengths to protect through every refactor (do **not** flatten): the write-failure/delete-recovery messaging, the stale-load request-id guards + re-fetch-before-delete, the atomic name-first create ordering.

## Workstreams

Order by leverage-per-risk. Each is its own PR, off `main` (0d36e35). W1 is the only one buildable immediately; the rest are gated as noted.

### W1 — Presentational shell extraction *(safe slice, build first)*

Scope — **presentation and de-duplication only, zero schema, zero data-model change**:

1. Extract `SetupScreenShell` — count eyebrow + toolbar + table frame + `Next:` footer — as a presentational component. Adopted by all six screens.
2. Extract `ImportModal` (preview table + "N ready / M warnings" + Import Complete panel) as one shared component; tokenize the hardcoded `#FFF8E7/#F5A623` warning-row hex (a token already exists — reuse it).
3. **Config-driven chrome**: the shell takes per-screen config for which toolbar actions appear and at what prominence. Small/fixed-content screens (Days) recede or hide `Delete All`/`Import` rather than presenting the full bulk-entry bar. This is the audit's "recede when populated" applied per-screen.
4. Hoist duplicated helpers (`Field` — defined identically at `ActivitiesScreen.jsx:435` and `AnchorsScreen.jsx:220`; `WeekToggle`; `DOW`; `serializeFieldValue`/`parseIdList`) into shared modules.
5. Accessibility: the shared `ImportModal` gets real focus management on open (focus-trap + Escape + initial focus) — the current per-screen `position:fixed` overlays have none. Match the pattern already used by the provenance popover.
6. Legibility of cohort-scoping: the CohortPicker's presence/absence currently reads as arbitrary. Verified cohort-scoped set = **Tiers, Time Blocks, Anchors** (`CohortPicker` + `cohort_id`); **Groups, Days, Activities** are not. Make the difference legible via consistent placement/affordance on the three that are scoped — do **not** add pickers to the three that aren't.
7. `max-height` collapse animation at `ActivitiesScreen.jsx:378` (P3): migrate to `grid-template-rows: 0fr/1fr` if trivial within the shell work; otherwise leave (already reduced-motion-guarded).
8. Location dedup — **shared helper, not a state-ownership change** (Red Hat/Code-Reviewer): extract the copy-pasted `createLocation`/`updateLocationCapacity` bodies (`ActivitiesScreen.jsx:619`, `AnchorsScreen.jsx:398`) into a shared utility module (e.g. `src/lib/locationDedup.js`) that each screen calls from its existing `onCreate`/`onUpdateCapacity` handler. `LocationPicker` **stays presentational and prop-driven exactly as today** — it does not gain repository/`campId` access or own the `locations` array; each screen keeps its own `setLocations` write-back. This is pure code motion, which is what keeps W1 "zero data-flow-ownership change." **Keep inline capacity editing** in both modals (Tester HIGH: it's a fast path, not redundancy). Preserve the case-insensitive dedup + name-first op ordering exactly; do **not** treat centralization as closing the known cross-device dedup race (leave a one-line note that it remains an accepted gap).

**Architect constraint (respect the opt-outs):** the presentational shell is safe to share and no opt-out comment objects to it. Do **not** force Tiers/TimeBlocks/Anchors onto `useCrudScreen`'s single-entity/no-race-guard/no-fan-out contract — the opt-out comments at the top of those three files are three independently-reasoned decisions (they reference the setup-crud shared-persistence-seam work, not three separate ADRs), each landing on the same boundary. If a shared *data* seam is wanted, it is the split of `useCrudScreen` into `useScopedQuery` (compound key + stale-response guard) + `useFannedWrite` (multi-table create + per-row rollback), which Days composes trivially and the holdouts compose honestly. Treat that hook split as **optional within W1, or its own follow-up** — it is not required for the presentational win and must not be rushed.

**Gates the plan must honor (were unnamed):**
- `electron/uniqueFirstFieldRegistryParity.test.js` — if any write-order for `locations`/`activities` shifts, `UNIQUE_FIRST_FIELD` (renderer) and `UNIQUE_FIELD_ENTITIES` (`electron/ops/operations.js`) must stay in lockstep.
- Test rewrite cost is real: `TiersScreen.test.jsx`, `TimeBlocksScreen.test.jsx`, `AnchorsScreen.test.jsx`, `DaysScreen.test.jsx`, `useCrudScreen.test.js` encode current structure. Budgeted as W1 work, test-first at the seam.

### W1b — Week-scoping consistency *(own ticket, design-gated — NOT in W1)*

The critique's "converge two week-scoping models" is a **data-model decision**, not a control swap. Anchors store one `schedule_week_id` (all-weeks or exactly-one; `buildSchedule.js:111`, `AnchorsScreen.jsx:384`); Groups/Activities store an exclusion *set* (any subset; `GroupsScreen.jsx:17`). Converging silently narrows anchors or widens groups, and touches **both schedule routes**. Options to design: (a) leave the data models distinct but make the two controls *visually* consistent; (b) genuinely unify on the exclusion-set model with a migration. Requires a small before/after design + Red Hat pass before any code. Deferred out of the safe slice.

### W2 — Cut director-facing homework

- **Ship now (copy-only, safe):** rename `anchors_template.xlsx` → `recurring_events_template.xlsx` (verified: import matches on column header, not filename — `AnchorsScreen.jsx:489`); "Co-schedule" header → "Multiple groups" (verified: header string literal only, not a persisted enum). Add a one-line release note for returning directors' saved files.
- **Gated (data-model, own ticket):** hide `sort_order` and `day_of_week` as *inputs* — **keep the fields stored**, never delete. `day_of_week` is load-bearing for `prefer_before_day` engine placement (`buildSchedule.js:446,560,646`) — it is a weekday identity, not display order. `sort_order` is persisted authoritative sequence for re-import (`exportWorkbook.js:164`). Design: auto-assign on create, derive display order (TimeBlocks from `start_time`, a better signal already on the row; Days from `day_of_week`), migration guard in the `>= N-1 && < N` form, and register any new write shape in the undo/snapshot registries. Needs a design note before code.

### W3 — Roots hub → Bento (augment) *(owned; ADR amendment gated)*

Owned by this session (owner assigned 2026-08-26; peer confirmed the split and keeps Locations).

Give the census tiles a considered Bento-grid structure **above** the existing collapsible entity list (owner: augment, not replace), existing tokens only. Guidance-by-affordance: the incomplete-area tile is visually the obvious next action (weight, not words) — no checklist, no explainer.

Gates: (1) **amendment** to `docs/adr/2026-08-22-roots-as-hub-setup-ia.md` (the "entity screens KEPT as collapsible list" clause), not a fresh ADR. (2) CSS boundary: per CLAUDE.md the single scoped-stylesheet exception is bounded to `src/components/schedule/`; Bento per-tile hover/pseudo-states must stay inline/data-attribute driven — do **not** add a second stylesheet. (3) Rebase around the peer's incoming Locations/Day-Map removal (see Coordination) — confirm no census tile or readiness rollup references the Locations "map"/Day-Map concept before building.

### W2-UX — Setup-screen interaction polish *(owner-requested 2026-08-26, after W1 shell lands)*

Small, high-value interaction wins across the setup screens. Do after W1's shell so they land once in the shared surface, not six times.

1. **Enter-to-save on add.** Pressing Enter in an add-row field (e.g. adding an activity) commits the add — no reach for the mouse. Applies to every setup screen's add-card. Guard against submitting an empty/invalid row.
2. **Stepper (+/−) for capacity numbers.** Group min/max and any capacity/count field gets +/− affordances around the number (a `CapacityStepper` already exists on Activities — reuse/generalize it, don't reinvent). Keep direct typing too.
3. **One-line edit/save/delete row.** When a row is pulled up for editing, the edit / save / delete controls sit on a single line, compact — not a stacked or wrapping cluster.

These are presentational/interaction only; no schema. Fold into the shared shell + add-card components so each fix is written once.

## Sequencing

1. **W1** (presentational, no schema) — build now, own branch, non-Locations only.
2. **W2 copy-only renames** — can ride with or just after W1.
3. **W1b, W2 field-retirement** — each its own design-gated ticket (data-model); scheduled after the safe slice lands.
4. **W3** — after peer ownership resolved + ADR amendment; independent of the above, lowest-risk to slot last.

Rationale for pulling merges and holding data changes: the Architect showed W1-before-W4 would have Maker fighting a fresh abstraction; with merges dropped that risk is gone, but the discipline of keeping data-model changes out of presentational tickets stands.

## Coordination

Peer session `camp-setup-ingestion-0ce0e1-ee` owns `LocationsScreen.jsx` + `src/screens/locations/*`. This program touches **none** of those in W1/W2.

**Incoming peer change (2026-08-26):** the peer's owner reversed direction — instead of adding a Locations Canvas, they are **removing the spatial layer entirely**: the Locations Map tab + all map-pair UI, and the **Day Map** schedule route (sidebar `schedule:map` item, `DayMapScreen`, `deriveOccupancy`). LocationsScreen will shrink. Watch items for our W3: (1) if any census tile or readiness rollup references the Locations "map"/Day-Map concept, it disappears; (2) the sidebar loses "Day Map". Our Bento pulls nothing from `DayMapScreen`/`deriveOccupancy`, so no logic dependency — but W3 must rebase on the peer's diff (they will send it before merge). No W1/W2 dependency.
