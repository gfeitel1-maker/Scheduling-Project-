---
title: "M3 Locations — design spec (setup screen, activity picker, first-run migration review)"
document_type: spec
status: draft
created: 2026-08-15
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_runs: [docs/work/runs/2026-08-15-locations-m3-design.md]
prototype: docs/work/specs/m3-mockup.html
archive_when: superseded by the M3 implementation run records (M3a/b/c), or the design is rejected
---

# M3 Locations — Design Spec

This spec is a **hard constraint on Maker**. It resolves every aesthetic decision so the M3a/M3b/M3c
sub-slices carry no open design questions. It answers to
[`DESIGN_STANDARD.md`](../../governance/standards/DESIGN_STANDARD.md) and to the M3 row of
[the locations ADR](../../adr/2026-08-15-camp-locations-entity.md). The visual reference the owner
reacts to is [`m3-mockup.html`](m3-mockup.html) — open it in a browser; token values, fonts, and
motion are the real Shoresh ones.

**Personality anchor (DESIGN_STANDARD §1):** Professional. Grounded. Warm. Quiet. Precise. Never
playful. Colour means something; nothing here decorates. **Locations are optional** — every state
must make an empty locations list read as *fine*, never as an incomplete task nagging the director.
The director must never feel they have become a facilities-data administrator.

The three things are **one experience**: the picker (part 2) is where most directors ever touch a
location; the setup screen (part 1) is where the few who want a managed list go; the reconciliation
(part 3) runs once, on the first upgrade, and then never again.

---

## Data this design renders (ground truth — do not re-derive)

Confirmed against `electron/db/localDb.js` (`backfillLocations`) and
`electron/db/locations.migration.test.js`.

- **`locations`**: `{ id, camp_id, name, capacity INTEGER NOT NULL DEFAULT 1, notes, sort_order, map_geometry }`.
  `capacity` = "how many groups fit here at once". `map_geometry` is M6 — **ignore it entirely in M3**.
- **`activities.location_id`**: nullable, no DB FK. The picker sets it. `null` = no place (valid).
- **`location_migration_reviews`** (host-local, **never replicated**, may not exist / may be empty on
  a given device): `{ id, camp_id, location_id, name, kind, detail (JSON string), created_at }`.
  Three `kind`s:
  - `capacity_disagreement` — one row per place. `detail = {declaredCaps:[1,3], seededCapacity:3}`.
    `name` = the place ("Pool"). **The journal does not store which activities disagreed** — only the
    numbers. Copy must be renderable from `declaredCaps` + `seededCapacity` alone (see §3.4 fork D-2).
  - `was_unlimited` — one row per place. `detail = {seededCapacity:1}`. `name` = the place.
  - `near_duplicate` — **two rows per pair** (one per spelling), each `detail = {variants:["Pool","pool"]}`.
    Group rows into one merge decision by their (sorted) `variants` array. A group may hold >2 variants.

**Critical:** the journal has **no `resolved` column**. Resolution state must be persisted by Maker
(M3a/M3c) so a handled review never reappears on the next open — the design assumes resolved items do
not come back. See §5 Implementation Notes.

---

## Part 1 — Locations setup screen

### Layout

An 8th setup screen, structurally identical to `DaysScreen.jsx`/`GroupsScreen.jsx`. Component
`LocationsScreen({ campId, role, onNavigate })`, rendered from the `SCREENS` map in `App.jsx`, reached
from a new **optional** sidebar row (`navSections.js`).

Top to bottom:
1. `<ScreenIntro screen="locations" />` — copy in §1 Copy.
2. `S.errorBanner` slot (inline recoverable error, DESIGN_STANDARD §5c).
3. **First-run review region** (Part 3) — renders *only* when the journal has unresolved rows; absent
   otherwise. Sits above the toolbar.
4. **Toolbar row** (`S`-style): left = count eyebrow (`"4 places"` / `"No places yet"`), right =
   actions. Actions in M3 are **`Delete All` only** (admin-gated, `S.btnDanger` + `S.buttonDisabled`).
   **No Import / Download Template buttons** — location import is M4. Do not ship disabled or
   "coming soon" import controls (`feedback_no_coming_soon_controls`); simply omit them.
5. **Table card** (`background var(--surface)`, `1px var(--border)`, `borderRadius 12`, overflow
   hidden). Columns: **Name · Groups at once · Notes · Actions**. Header uses `S.th`. Rows use `S.td`,
   `borderBottom 1px var(--border)`, hover `background var(--bg)` (matching Days).
   - Name: `fontWeight 500`.
   - Groups at once: plain-language cell — `"1 group"` / `"3 groups"` (singular/plural), tabular
     numerals. Not "capacity", not a raw int.
   - Notes: `var(--text-secondary)`, `fontSize 12`; `"—"` when empty.
   - Actions (right-aligned): `Edit` (`S.btnSecondary`), `Delete` (`S.btnDanger`, admin-gated).
6. **Add-Place card** (`S`-style add card, matches Days' "Add Day"): title "Add Place"; a
   `rowfields` row — **Name** (`S.input`, flex-grow), **Groups at once** (stepper, default 1, min 1),
   **Notes (optional)** (`S.input`, flex-grow), `+ Add` (`S.btnPrimary`).
7. **Next row**: `borderTop`, right-aligned `Next: Fixed Events →` (`S.btnPrimary`), left `← Back to
   Activities` ghost link. See fork **D-1** on sidebar/Next placement.

### Empty state (never set up)

Use the **calm, no-card** empty block from DESIGN_STANDARD §5a — *not* the in-table `colSpan` row Days
uses, and *not* Activities' bordered card. Rationale: locations are optional, so their emptiness must
feel deliberately fine, not boxed as a gap. `padding: 60px 16px`, centered:
- Outline map-pin icon, ~40px, `stroke-width 1.5`, `var(--text-secondary)`.
- Title (IBM Plex Sans 600, 15px, `var(--text)`): **"No places yet"**.
- Body (13px, `var(--text-secondary)`, ≤60ch): **"Add a place below and say how many groups fit at
  once. Or skip this — the schedule works fine without it, and you can add places any time."**
- One primary CTA `S.btnPrimary` **"Add your first place"** → focuses the Name input in the Add card.
- The Add-Place card still renders below the empty block.
- Motion: on mount **Fade + Lift** (opacity 0→1, translateY 8px→0, `--motion-base`, `--ease-out`),
  via the existing `useEnterTransition('liftFade')`. No stagger.

### The capacity control (a named component: `CapacityStepper`)

Capacity is the load-bearing number (the engine enforces it in M2), so it gets a deliberate control,
not a bare `<input type=number>`. A segmented stepper: `[ – | n | + ]`, `1.5px var(--border)`,
`borderRadius 7`, `var(--surface)` body, `var(--surface-elevated)` value cell, tabular numerals,
min = 1 (never 0 — 0 meant "unlimited" and is the exact defect the ADR removes; the control cannot
express it). Used in the add card, the inline edit row, and both migration-review controls, so the
director learns one affordance once. It is still keyboard-typeable in the middle cell.

### States

- **Default row / hover:** hover `background var(--bg)` (Days parity).
- **Inline edit** (triggered by `Edit`, same pattern as `DayRow`/`GroupRow`): the row swaps to
  `background var(--surface-elevated)` with Name `S.input`, a `CapacityStepper`, Notes `S.input`, and
  `Save` (`S.btnPrimary`) / `Cancel` (`S.btnSecondary`). Enter saves; Cancel restores. No modal.
- **Adding:** `+ Add` disabled until Name is non-empty; label → `"Adding…"` while in flight.
- **Delete:** routes through the existing `localClient.previewDelete('locations', id)` →
  `DeleteRecordDialog` flow (count-first, restorable from Trash), exactly as Days/Activities. A place
  bound by activities must warn with the count, never silently orphan.
- **Loading:** `S.stateLoading` ("Loading…") — parity with the family; a skeleton is not required to
  match the other setup screens.
- **Error:** `S.errorBanner` inline, with the recoverable-action copy the family already uses.

### Copy (Part 1)

- `screenIntroText.locations`: **"Places at your camp and how many groups fit in each — the Pool, the
  Gym, the Beit Midrash. Optional: add them only if you want the schedule to keep two groups out of the
  same room."**
- Column header: **"Groups at once"** (not "Capacity").
- Add-card field labels: **"Name"**, **"Groups at once"**, **"Notes (optional)"**.
- `ENTITY_LABEL.locations` (Trash/history, `recordLabels.js`): **"Place"** (singular, director's word).

---

## Part 2 — The place picker (inside the Activity modal)

Replaces the free-text `<input>` at `ActivitiesScreen.jsx` ~line 122–124 (the "Location" field). A new
component `LocationPicker({ value /* location_id|null */, locations, onChange, onCreate })` — a
combobox with typeahead + inline create. Selecting sets `activities.location_id`; this completes the
D5 freeze (the app stops writing free-text `activities.location`).

### Layout & states

- **Field (empty / cleared):** an input framed like `S.input`, with an outline map-pin (15px,
  `stroke-width 1.6`, `var(--text-secondary)`) inset left. Placeholder **"Search or add a place…"**.
  `focus-within` → border `var(--primary)`. `location_id = null` is valid and needs no warning.
- **Typeahead popover (open):** anchored below the field, `var(--surface-elevated)`, `1px var(--border)`,
  `borderRadius 8`, shadow `0 2px 16px color-mix(in srgb, var(--text) 12%, transparent)`, `z-index 30`.
  Each option: place **name** (`fontWeight 500`) + right-aligned capacity meta in mono
  (`"3 groups"`, `var(--text-secondary)`). Filter = case-insensitive substring on name. Active/hover
  row tinted `color-mix(in srgb, var(--primary) 8%, var(--surface-elevated))`.
- **Create-new row:** when the typed text is non-empty and does not *exactly* match an existing place,
  the **last** option is a create row, set off by a `1px var(--border)` top hairline, text
  `var(--secondary)` (forest) with a `+` glyph (`stroke-width 1.8`) — forest signals "this makes
  something new," distinct from the navy selection tint. Label: **`Create "Beit Am" as a new place`**.
  A right mono tag `NEW`. Choosing it calls `onCreate(name)` → creates a `locations` row (capacity
  default 1, notes null) and immediately binds it. **The director never leaves the modal.**
- **Empty catalog:** if the camp has zero locations, an open+empty field shows only the create row once
  the director types; before typing, a non-interactive hint row `"Type a place, or add a new one…"`.
- **Selected:** the field collapses to a bound token: forest map-pin + name (`fontWeight 600`) +
  capacity meta (`"· 3 groups at once"`, mono, `var(--text-secondary)`) + a clear `×` (right,
  `var(--text-secondary)`, hover `background var(--bg)`). Below it, an 11px hint:
  **"The schedule will keep this activity to 3 groups here."** — the reassurance that the binding took
  and a reminder of the number the engine now holds this activity to.
- **Cleared:** `×` returns to the empty field, `location_id = null`.

### Interaction

- Type → filter live. `↑`/`↓` move the active option (create row included in the cycle); `Enter`
  selects the active option, or creates when the text matches nothing; `Esc` closes the popover
  (keeps any existing selection); blur closes after a short delay so a click on an option still lands.
- Selecting closes the popover and shows the selected token. Quiet — no celebratory motion.

### Animation (Part 2)

- Popover: **popFade** — `scale(0.97)→1` + opacity `0→1`, **180ms**, `--ease-out`, `transform-origin`
  top-left. Use the existing `useEnterTransition('popFade')` in `shared.js` — do not hand-roll.
- Selection / clear: instant (no transform). Precision over flourish.
- `prefers-reduced-motion`: popover crossfades only (the shared helper already drops the transform).

### Copy (Part 2)

- Field label (in the modal): **"Location"** (unchanged).
- Placeholder: **"Search or add a place…"**.
- Create row: **`Create "<typed>" as a new place`**.
- Selected hint: **"The schedule will keep this activity to N group(s) here."**

---

## Part 3 — First-run migration review

Runs the first time Locations opens after the v32 upgrade, **only** when the host-local journal has
unresolved rows. It resolves the three kinds together without feeling like a wall of alerts:
**the dangerous case is a gate; the rest is a quiet advisory.**

Two tiers, in this order:
1. **`near_duplicate` → an un-missable, blocking first-run GATE** (hard requirement).
2. **`capacity_disagreement` + `was_unlimited` → a dismissible advisory strip** on the screen.

### 3.1 The near-duplicate merge GATE (M3c — the hard requirement)

Because `TRIM`-only dedupe leaves "Pool" and "pool" as two rows with independent capacity pools, and
capacity is now a *trusted* number the engine under-enforces across the split, the merge **must be
impossible to miss and presented before first real use** (ADR migration §c + Red Hat). It is **not** a
dismissible banner.

**Presentation:** a **blocking modal overlay** shown on first open when unresolved `near_duplicate`
groups exist. Full scrim over the Locations content using the on-brand deep-navy scrim
(`color-mix(in srgb, var(--primary-dark) 50%, transparent)` / rgba(15,42,71,.42)). One card
(`S.modalSm`-scale, `var(--surface-elevated)`, `borderRadius 12`). A banner can scroll off; a modal
cannot — this is what "impossible to miss" requires, and it matches the family's modal treatment.
The screen behind is not usable until every group is decided.

**Card content (one group per step; "1 of N" progress eyebrow in `var(--accent)`):**
- Eyebrow: outline list icon + **"Before you start"** + right-aligned **"1 of N"**.
- Title (IBM Plex Sans 700, 19px): **"These look like the same place"**.
- Lede: **"Your old schedule used "Pool" and "pool". Shoresh kept them separate so it wouldn't change
  your data without asking — but that splits how many groups fit. Merge them into one place, or say
  they're genuinely different."**
- **Variant chooser** — one selectable row per spelling in `variants` (radio semantics): the spelling
  (`fontWeight 600`) + a mono meta line `"3 groups at once / 4 activities here"`. Selected row:
  `border-color var(--primary)`, faint navy tint, filled radio. Default selection = the spelling with
  the most activities (Maker computes activity counts by `location_id`); ties → the higher-capacity
  spelling. This picks the *surviving* row.
- **Resulting capacity** — an inline `CapacityStepper`, defaulted to the **max** of the merged
  capacities (the migration's own permissive rule; capacity never silently tightens). Line reads:
  **"Room for [ 3 ] groups at once after merging."** Editable because capacity is now trusted.
- **Actions (stacked, full width):**
  - Primary `S.btnPrimary` **"Merge into one place"**.
  - Secondary (`S.btnSecondary`/outline) **"No — these are different places"** — an explicit,
    considered decision (the camp really may have two pools), **not** a dismiss. It resolves the group.
  - Sub-line (11.5px, `var(--text-secondary)`): **"You can undo this. The merged place stays in Trash
    if you change your mind."**

**What "Merge" does** (spec for Maker; the write itself is M3c + Red Hat): re-point every activity on
the losing spelling(s) to the surviving `location_id`, set the survivor's `capacity` to the chosen
number, and delete the losing `locations` row(s) through the normal delete path (restorable from
Trash). These are **ordinary replicated ops** (locations are not host-local). Mark the group's journal
rows resolved locally. Reversible via Trash restore + an immediate Undo affordance.

**Multi-pair:** step through pairs one at a time; a decided pair settles closed and the next fades in;
after the last, the modal closes and the screen (with the advisory strip, if any) is revealed. If the
director closes the app mid-gate, unresolved pairs re-present next open (nothing is silently applied).

**Animation (gate):** scrim fade `--motion-base`; card **Fade + Settle** in (translateY 12→0,
`--motion-settle`, `--ease-out`, per §5d). On decide: the card's content collapses via
`max-height`+`opacity` `--motion-settle` (reuse the `S.mergeCard` transition), then the next pair
Fades in. Modal dismiss: Fade out `--motion-fast`. No bounce. `prefers-reduced-motion` → instant swap.

### 3.2 The capacity advisory strip (softer — M3c)

After the gate clears (or immediately, if there were no near-duplicates), remaining
`capacity_disagreement` and `was_unlimited` reviews appear as **one calm strip at the top of the
Locations screen** — advisory, dismissible, **bronze not red** (DESIGN_STANDARD §4: `--accent` is the
caution/attention hue; red stays reserved for destructive/error).

- Container: `1px solid color-mix(in srgb, var(--accent) 32%, var(--border))`,
  `background color-mix(in srgb, var(--accent) 7%, var(--surface))`, `borderRadius 10`,
  `padding 14px 16px`.
- Header row: outline info icon (`var(--accent)`) + title **"Shoresh set a few capacities from your
  old schedule"** (IBM Plex Sans 600, `color-mix(in srgb, var(--accent) 55%, var(--text))`) + right
  count **"2 to look at"**.
- One item per review, separated by a `color-mix(in srgb, var(--accent) 22%, var(--border))` hairline:
  - Body text (left) stating exactly what happened.
  - Controls (right): a `CapacityStepper` (pre-filled to `seededCapacity`, edits `locations.capacity`)
    + **"Looks right"** (`S.btnSecondary`) to accept and dismiss that item.
- When an item is resolved it collapses (`max-height`+`opacity`, `--motion-settle`); when the last is
  gone the whole strip fades out (`--motion-fast`). Nothing here blocks.

### 3.3 Empty-journal case (required)

When the journal is absent or has no unresolved rows — a fresh camp, or a tablet that paired into an
already-v32 camp — **no review region renders at all.** No gate, no strip, no "nothing to review"
placeholder. The screen is exactly the ordinary Locations list. This is a correctness requirement, not
a nicety (the journal is host-local and frequently empty).

### 3.4 Copy (Part 3), renderable from journal data alone

- Gate title: **"These look like the same place"**; variant meta: **"N groups at once / M activities
  here"**; result line: **"Room for [ n ] groups at once after merging."**
- `capacity_disagreement` (floor copy, numbers only — the journal has no activity names):
  **"Pool — activities here asked for different limits (1 and 3 groups at once). Shoresh kept the most
  room: 3."** Render `declaredCaps` as a natural list, `seededCapacity` as the kept value.
- `was_unlimited`: **"The Gym had no limit set and is now one group at a time. That may change a
  generated week or two — take a look before you regenerate."**

---

## Design forks for the owner (with recommendations)

- **D-1 — Where Locations sits in the setup path.** *Recommendation:* add it to `navSections.js`
  **directly after Activities**, marked `optional: true` (like Fixed Events), and give the screen a
  `Next: Fixed Events →` button. Leave Activities' own Next pointing at Fixed Events **unchanged** so
  the *required* walk is untouched — an optional screen should not insert itself into the mandatory
  chain. Confidence: high. (Alternative: place it after Fixed Events; weaker, because the picker that
  feeds it lives on Activities, so the two read better adjacent.)
- **D-2 — How rich the `capacity_disagreement` copy is.** The journal stores only the numbers, not
  which activities disagreed. *Recommendation:* ship the **numbers-only** copy (§3.4) as the floor, and
  — since the Locations screen already needs the activity list to count activities-per-place for the
  gate — **enrich it when cheap** to *"Swim Lessons said 1, Free Swim said 3"* by joining activities on
  `location_id` and their `max_groups_per_slot`. If the join adds meaningful complexity in M3c, the
  numbers-only copy is honest and sufficient. Confidence: medium; defer the final call to M3c cost.
- **D-3 — Gate as a blocking modal vs. a pinned non-dismissible inline card.** *Recommendation:*
  **modal.** It is the only treatment that literally cannot be scrolled past, which is the ADR's bar.
  A pinned inline card is lighter but a long list can still push it out of view. Confidence: high.

---

## Implementation Notes for Maker

- **Setup screen plumbing:** `LocationsScreen` is the 8th consumer of `setupCrudRepository`. Per the
  M3 ticket, verify whether `useCrudScreen` fits or repository-only is right (unproven for an 8th
  screen) — Days uses the hook; this screen's first-run review region may push it to repository-only.
  Register in the nine registries per the ADR's checklist (already landed in M1 for the entities; M3
  adds the **screen**, `SCREENS` map, `navSections`, `ENTITY_LABEL`, `screenIntroText`).
- **Capacity control:** build `CapacityStepper` once and reuse it in the add card, the edit row, and
  both migration controls. Min 1, hard — the UI must be unable to express 0/unlimited.
- **Picker replaces free-text — D5 freeze:** once `LocationPicker` replaces the `location` `<input>`,
  add the app-wide test asserting **no** code path writes `activities.location` (pinned from M1). The
  picker writes `location_id`; `onCreate` creates a `locations` row via the normal op path.
- **Migration journal read path (M3a):** the journal has **no read IPC/repository method yet** — add
  one. It is host-local and non-replicated; guard for the table being absent/empty and render nothing
  (§3.3). Decide/record whether a `null`-vs-declared cap is surfaced as `capacity_disagreement` or
  `was_unlimited` — M1 records `[null,3]` as disagreement `[1,3]` (Code Reviewer follow-up); the copy
  above assumes the recorded `declaredCaps` values verbatim.
- **Resolution persistence:** the journal has no `resolved` column. Persist resolution (a
  host-local `resolved_at`/marker, or delete the row) so handled reviews never reappear. The merge's
  *data* changes are ordinary replicated ops; the journal bookkeeping is host-local.
- **Merge is a stored-data operation → Red Hat is mandatory on M3c** (re-pointing `activities.location_id`,
  capacity write, deleting a `locations` row, resolved-marking). Use the existing delete/Trash path so
  the merge is restorable; do not hand-roll a destructive delete.
- **`locationFull` re-key (carried from M2):** re-key `useSlotMutations.js` `locationFull` by
  `location_id` and align the `max_groups_per_slot` `!= null` vs `> 0` sentinel with the engine, closing
  the generated-route drag-into-over-capacity blind spot. (Engine, not this design — noted so M3b
  doesn't lose it.)
- **Readiness promotion:** move `location` from `FORWARD_AREAS` to `OPTIONAL_AREAS` with a
  `COLLECTION_FOR` binding, **never `REQUIRED_AREAS`** — fixes the dead Review button (gap 14) without
  making locations mandatory.
- **No map anywhere in M3.** `map_geometry` is untouched; nothing here presumes or precludes M6.
- **Motion is all token-driven** (`--motion-*`, `--ease-out`) and every animated element ships a
  `prefers-reduced-motion` fallback. Reuse `useEnterTransition` (`liftFade`/`popFade`) and the
  `S.mergeCard` collapse transition rather than new keyframes.

---

## Prototype

[`docs/work/specs/m3-mockup.html`](m3-mockup.html) — self-contained, real Shoresh tokens/fonts/motion.
Covers: Locations empty + populated (with an inline-edit row), the activity picker (a **live** typeahead
you can type into, plus the four states spelled out), the un-missable near-duplicate **merge gate**
(launchable overlay with variant choice + result capacity), the softer bronze capacity strip, and the
empty-journal "perfectly normal screen" case. Open it in a browser.
