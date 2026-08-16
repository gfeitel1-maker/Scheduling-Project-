---
title: "M6 Camp Map — design spec (List|Map toggle, upload, drag/resize, unplaced tray, conflict thumbnails)"
document_type: spec
status: approved
created: 2026-08-16
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs: [docs/adr/2026-08-16-locations-optional-map.md, docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_specs: [docs/work/specs/2026-08-15-m3-locations-design.md]
related_runs: [docs/work/runs/2026-08-16-locations-m6-map.md]
prototype: docs/work/specs/m6-map-mockup.html
archive_when: superseded by the M6 implementation run record, or the design is rejected
---

# M6 Camp Map — Design Spec

This spec is a **hard constraint on Maker**. It answers to
[`DESIGN_STANDARD.md`](../../governance/standards/DESIGN_STANDARD.md) and to
[`docs/adr/2026-08-16-locations-optional-map.md`](../../adr/2026-08-16-locations-optional-map.md) (D8–D10
specifically). The visual reference is
[`m6-map-mockup.html`](m6-map-mockup.html) — open it in a browser; token values, fonts, and motion are the
real Shoresh ones, and the placed-location rectangle is a **live** drag + resize demo, not a screenshot.

**Personality anchor (DESIGN_STANDARD §1):** Professional. Grounded. Warm. Quiet. Precise. Never playful.
**The map is optional, exactly like the rest of Locations (M3).** A camp that never uploads an image is
unaffected everywhere else, and a staff device that only ever reads the map must never look broken,
disabled, or second-class — it is a legitimate, complete view, not a degraded admin view.

---

## Part 1 — The List | Map toggle

### Layout

A new controls row on `LocationsScreen.jsx`, directly under `<ScreenIntro screen="locations" />` (before the
error banner / migration review region), containing only the toggle — left-aligned, `marginBottom: 20`.

**Visual-idiom note (flagged, see "Design judgment calls" below):** the ADR cites ScheduleScreen's
Manual/Generated cards (`:736`, `:783`) as the toggle to mirror. Those lines render a **one-time
disambiguation screen** ("Which week do you want to open?"), not a persistent control — `ScheduleScreen.jsx`'s
own code comment at `:845-849` says explicitly that route selection lives in the **sidebar**, and this
choice screen is "a label, not a switch." The actual **persistent, live, two-way segmented toggle** already
shipping in this codebase is the Group/Day/Activity **View toggle** at `ScheduleScreen.jsx:861-865`. That is
mechanically what List|Map needs (two views of one screen, switched in place, no navigation), so this spec
uses **that** idiom, verbatim:

```js
// wrap
{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }
// each option button, `active` = tab === this option
{
  padding: '6px 14px', borderRadius: 6, border: 'none',
  borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent',
  cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 600,
  fontFamily: 'var(--font-sans)',
  background: active ? 'var(--surface)' : 'none',
  color: active ? 'var(--primary)' : 'var(--text-secondary)',
  boxShadow: active ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
  transition: 'color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)',
}
```

Two options: **List** (default, `tab === 'list'`) and **Map**. Switching tabs is instant (no route change, no
confirmation) — flip local `useState('list')`, nothing more. `List` renders the existing M3 body unchanged.

### What moves under the toggle, and what stays global

- **List-only** (inside `{tab === 'list' && (...)}`): `WeekContextBar`, `CapacityAdvisoryStrip`, the
  toolbar/table, the Add-Place card. These are capacity/week-availability concerns with no spatial meaning.
- **Global, unconditional** (outside the tab switch, same as today): the `S.errorBanner` slot, and — most
  importantly — the **near-duplicate migration GATE** (`NearDuplicateGate`, a fixed-position blocking modal).
  A director who lands on the Map tab before resolving an unresolved near-duplicate must still see the gate;
  it does not become skippable by switching tabs.
- **Both tabs**: the `← Back to Activities` / `Next: Fixed Events →` footer row stays at the bottom
  regardless of `tab`, unchanged.

---

## Part 2 — Map view, no image yet (empty state)

Uses the **calm, no-card** empty block from DESIGN_STANDARD §5a — the same block M3 already built for "No
places yet" (`emptyStyles` in `LocationsScreen.jsx`), reused, not reinvented. `padding: 60px 16px`, centered.

**Icon:** outline image/photo icon (not the map-pin used for "no places yet" — this is about the picture,
not the places), ~40px, `stroke-width: 1.5`, `var(--text-secondary)`.

### Admin

- Title (IBM Plex Sans 600, 15px, `var(--text)`): **"No map yet"**
- Body (13px, `var(--text-secondary)`, ≤60ch): **"Add a photo or drawing of your camp grounds, then drag
  each place onto it. Optional — the schedule works fine without a map."**
- One primary CTA `S.btnPrimary`: **"Upload a map image"** → opens the hidden file input (Part 5).
- Motion: **Fade + Lift**, `useEnterTransition('liftFade')`, on mount only — identical to the M3 empty state.

### Staff

- Same icon, same layout, same calm no-card treatment — **this must not read as a degraded or disabled
  admin view.**
- Title: **"No map yet"**
- Body: **"Your director hasn't added a camp map yet. Places still work everywhere else in Shoresh — check
  back later."**
- **No CTA.** Not a greyed-out button, not a disabled upload control with a tooltip — the button is simply
  absent, per the same "no coming-soon controls" discipline the rest of this codebase already follows.
- Motion: identical Fade + Lift.

---

## Part 3 — Map view, image uploaded (populated state)

### Layout

```
<div class="map-canvas">          {/* position: relative; aspect-ratio from image_width/image_height */}
  <img class="map-image" />        {/* the data: URL, width 100%, height 100%, object-fit: cover — see note */}
  {locations.filter(l => l.map_geometry).map(loc => <LocationMarker .../>)}
</div>
{unplaced.length > 0 && <UnplacedTray items={unplaced} />}
```

- `.map-canvas` gets an inline `aspect-ratio: ${image_width} / ${image_height}` the instant the row loads —
  **before** the `data:` URL has decoded — so the layout never shifts (ADR D10's stated requirement). Fallback
  background while decoding: `var(--bg)` (the app canvas token, not a stark placeholder color).
- The image itself renders at `width: 100%` inside that fixed-aspect box — never cropped, never distorted:
  `object-fit: contain`, not `cover` (a director's diagram/photo must display in full; cropping would hide a
  place they positioned near an edge).
- Admin-only toolbar sits **above** the canvas: `Replace image` (`S.btnSecondary`) + `Remove image` (styled
  like the existing `Delete` action — `S.btnDanger` ghost) — see Part 5 and Part 7. Staff see no toolbar row
  at all here (not a disabled one).

### Location markers (`.map-location`)

Each location with non-null `map_geometry` renders as a positioned rectangle:

```js
// per-location, computed — stays INLINE (ADR D9: computed geometry never moves to CSS)
{
  position: 'absolute',
  left: `${x * 100}%`, top: `${y * 100}%`,
  width: `${w * 100}%`, height: `${h * 100}%`,
}
```

**Color — reuses the six-color ACTIVITY_COLORS array verbatim** (import `ACTIVITY_COLORS` from
`src/components/schedule/slotCellConstants.js` — do not duplicate the hex values; see Implementation Notes),
assigned by `sort_order % 6` so it is stable across renders. Following the same "identity marker, not a
fill" discipline DESIGN_STANDARD §3 already established for the schedule grid (a saturated block would
fight the photo underneath and break "quiet"):

- **Border:** `2px solid {color}`.
- **Wash:** `background: color-mix(in srgb, {color} 10%, transparent)` — enough to read the claimed area
  against any photo, not enough to obscure it.
- **Selected/hover** (see §4 states): wash steps up to `16%`, border stays `2px` (weight doesn't change —
  only the color-mix ratio and the box-shadow below carry the state, per §4).

**Label — a chip, not bare text-on-photo.** A halo/text-shadow alone does not guarantee legibility across an
arbitrary photo (fails on a light sandy field, for instance); a solid-ish chip does:

```js
{
  position: 'absolute', top: -1, left: -1,   // sits just outside the box's own top-left corner
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '3px 7px',
  background: 'color-mix(in srgb, var(--surface-elevated) 90%, transparent)',
  border: `1px solid {color}`,
  borderRadius: 5,
  fontSize: 11.5, fontWeight: 600, color: 'var(--text)',
  whiteSpace: 'nowrap',
  boxShadow: '0 1px 4px color-mix(in srgb, var(--text) 18%, transparent)',
  zIndex: 2,  // must clear a neighboring rectangle's own box
}
```

- A small `identity-dot`-style circle (6px, `background: {color}`) sits inside the chip before the name,
  mirroring the schedule grid's own dot convention — the border color alone is a subtle cue; the dot makes
  the identity link explicit.
- The chip is allowed to overflow its rectangle's bounds (a small, resized-down place still gets a fully
  legible label) — `.map-canvas` does not clip (`overflow: visible`), matching the grid's own "label must
  never clip" precedent (T55/`.cell-name`'s `overflow-wrap: anywhere` rule, same intent).
- Long names: wrap is acceptable inside the chip up to ~22ch, then ellipsis — this is meta chrome, not the
  primary content the director came to read.

### The unplaced tray

Renders **only when at least one location has `map_geometry IS NULL`** (mirrors the M3 §3.3 "absent, not
empty" discipline exactly — no "nothing to place" placeholder when the tray would otherwise be empty).

Layout: a card below the canvas, same shape as the M3 Add-Place card (`background var(--surface)`,
`1px solid var(--border)`, `borderRadius 12`, `padding 14px 16px`):

- Header: **"Not yet placed"** + a right-aligned count, `(3)`.
- A wrapped row of chips, one per unplaced location:

```js
{
  display: 'inline-flex', alignItems: 'center', gap: 7,
  padding: '7px 11px',
  background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 8,
  cursor: 'grab', fontSize: 13,
}
```

  - A 6-dot grip glyph (`⠿`-style, or two columns of 3 dots as an inline SVG), `var(--text-secondary)`,
    signaling "this is draggable" without adding a new icon vocabulary.
  - Name (`fontWeight: 500`) + capacity meta in mono (`"3 groups"`, `var(--text-secondary)`, 11px) — same
    meta styling the M3 `LocationPicker` options already use.
  - Dragging a chip onto the canvas places it (see §4's move-gesture note).

---

## Part 4 — Drag + resize interaction

### The two gestures

Per ADR D8, one shared hook (`useLocationGeometryMutations`, D7) drives both:

1. **Move** — pointer/keyboard-drag anywhere on `.map-location`'s body (not the handle) changes `x`/`y`,
   `w`/`h` unchanged.
2. **Resize** — pointer/keyboard-drag on the **bottom-right corner handle** changes `w`/`h` (and, because
   the box's top-left corner is the anchor, `x`/`y` stay fixed during a resize).

**Design judgment call (flagged — not in the ADR, needs a decision):** this spec recommends **one resize
handle (bottom-right corner) only**, not four/eight edge-and-corner handles. Rationale: the existing
in-codebase resize precedent (`scheduleGrid.css`'s `.overlay-fill-handle`) is also a single corner/edge
handle, not a full 8-handle resize rig; a director roughly sizing a rectangle over a photo does not need
precision edge-by-edge control, and one handle keeps the interaction, the FSM, and the touch target surface
small. If the owner wants top/left-anchored resizing too, that is a straightforward but real interaction
addition — flagging rather than silently deciding.

### Visual states (`locationMap.css`, cited under DESIGN_STANDARD's §8 rationale — ADR D9)

Data-attribute convention mirrors `scheduleGrid.css`'s own `[data-drag-over][data-drag-kind='expand-drag']`
pattern directly — same shape, new surface:

| Attribute | On | Meaning |
|---|---|---|
| `.map-location:hover` | pseudo-class | reveals the resize handle (opacity 0→1, `--motion-fast`) |
| `.map-location[data-selected]` | `.map-location` | keyboard-focused or clicked; persistent highlight so a keyboard user can see the active box before pressing Enter to grab it |
| `.map-location:focus-visible` | pseudo-class | 2px solid `var(--primary)` outline, offset -2 — identical to `.cell:focus-visible` |
| `.map-location[data-dragging][data-drag-kind="move"]` | `.map-location` | live move in progress |
| `.map-location[data-dragging][data-drag-kind="resize"]` | `.map-location` | live resize in progress |
| `.map-location-handle[data-resize-handle]` | the handle element | static marker (not a state) — identifies the resize-handle child for styling/testing |
| `.map-tray-chip[data-dragging]` | tray chip | live drag-to-place from the unplaced tray |

**Dragging visual (either kind):** regardless of the location's own identity color, the "this is the thing
being manipulated" signal is universal navy, matching `[data-drag-over]`'s use of `var(--primary)` on the
schedule grid for the same reason (state — not identity — is what a hand mid-gesture needs to read):

```css
.map-location[data-dragging] {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--text) 22%, transparent);
  cursor: grabbing;
  z-index: 5;
}
```

**Resize handle** (reuses the schedule grid's `.overlay-fill-handle` visual almost exactly — same precedent,
new surface):

```css
.map-location-handle {
  position: absolute;
  bottom: -6px; right: -6px;
  width: 14px; height: 14px;
  background: var(--accent);
  border: 2px solid var(--surface-elevated);
  border-radius: 3px;
  cursor: nwse-resize;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out);
  touch-action: none;
}
.map-location:hover .map-location-handle,
.map-location[data-dragging] .map-location-handle {
  opacity: 1;
}
```

Bronze (`--accent`), not navy — it is a *tool* affixed to the box (parallel to how the schedule's own
fill-handle also uses `--accent`), distinct from the navy "this is moving" drag signal above.

**Touch target:** the visual handle is 14×14, under the 24×24 WCAG 2.5.8 minimum — this repo already accepts
that exact deviation for `.expand-handle`/`.overlay-fill-handle` on the same rationale (a real, keyboard-
reachable `<button>` underneath). Maker should pad the handle's actual hit area (invisible, via a larger
`::before` or button padding) to something closer to 24×24 for the staff-tablet touch case specifically —
staff reposition on tablets per Q7, and this surface has no mouse-precision fallback the way a desktop
director's grid interactions do. Flagging for Red Hat/Tester follow-up on real touch hardware, not resolving
here as a fixed pixel number.

### Keyboard access

`@dnd-kit/core`'s `KeyboardSensor`, unmodified — exactly as ScheduleScreen configures it (see Implementation
Notes for the exact `distance` discrepancy to watch). Both the location body and its resize handle are
independently focusable (`tabIndex 0`), so Tab order is: …→ location body (move) → its resize handle
(resize) → next location's body → … `aria-label`s: `"Move {name}"` / `"Resize {name}"`. Standard dnd-kit
keyboard flow applies (Enter/Space to pick up, Arrow keys to nudge, Enter/Space to drop, Esc to cancel) — no
new keyboard vocabulary invented. Reuse the schedule grid's visually-hidden `.drag-live` live-region pattern
(`scheduleGrid.css`) for the pick-up/move/drop announcements, rather than inventing a second one.

### Animation

Per the canvas ADR's Atlassian-sourced finding, cited directly in ADR D8: **drop feedback stays static.**

- **During a live drag (either kind):** the rectangle's `left`/`top`/`width`/`height` update on every pointer
  move with **no transition** — 1:1 pointer following, zero interpolation. This is a hard rule, not a
  preference: any `transition` on those four properties reintroduces exactly the "waited for the animation
  before reading intent" problem the canvas ADR rejected.
- **State chrome that is NOT position/size** (hover reveal, `data-selected` outline, handle opacity, wash
  percentage) *may* use `--motion-fast` (140ms) transitions — this is the same split scheduleGrid.css already
  draws between `.expand-handle`'s hover opacity (transitions) and drag position (never transitions).
- **On release** (drop): nothing animates — the box is already exactly where the pointer left it (this is
  what "static" buys you: there is no settle-into-place step to animate).
- **Tray → canvas placement:** when a chip is dropped onto the canvas, its default synthesized rectangle
  (see Implementation Notes for the exact starting `w`/`h`) appears at the drop point with the same static,
  no-tween rule — it does not fade or scale in.
- `prefers-reduced-motion`: only the hover/selected chrome transitions are affected (crossfade instead of
  animate); the position/size "no transition, ever" rule is already reduced-motion-safe by construction.

---

## Part 5 — Upload / replace flow (admin)

### Trigger

`<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none">`, triggered by:
- Empty state: the primary CTA "Upload a map image" (Part 2).
- Populated state: the "Replace image" button in the admin toolbar (Part 3).

Both open the OS file picker directly — no intermediate Shoresh dialog.

### In-flight state

Per DESIGN_STANDARD §5b ("blocking action... a 16px outline spinner, `stroke-width 2`, `var(--text-secondary)`.
No large centered spinners"): the triggering button's own label swaps to **"Preparing…"** with a small inline
spinner glyph, disabled, while the client-side downscale/re-encode (ADR D2) and the write both run. This can
take a moment on a large photo — the label change is the only feedback needed; no progress bar, no percentage
(the work is not meaningfully divisible into steps a director would want to watch).

### Outcomes

- **Success:** the button returns to its resting label; the new image simply renders in the canvas. **No
  toast, no confetti, no celebratory motion** — "Selection / clear: instant... Precision over flourish," the
  same discipline the M3 spec already set for the location picker.
- **Rejected — wrong type / SVG:** inline `S.errorBanner` above the canvas: **"That file isn't a photo Shoresh
  can use. Choose a JPG, PNG, or WEBP image."** Recoverable-error treatment per §5c (Slide + Fade in, retry is
  simply "pick another file" — no separate retry button needed since the file input is still right there).
- **Rejected — decompression-bomb guard (D2's 40-megapixel decoded-dimension check):** **"That image is too
  large for Shoresh to process. Try a smaller photo, or a screenshot instead of the original file."**
- **Rejected — still oversized after the two-pass downscale (D2's 750KB hard cap):** **"This image is too
  detailed to store, even after shrinking it. Try a simpler photo, or crop it down before uploading."**
- Every rejection leaves the previous image (if any) untouched — a failed replace never clears the existing
  map.

---

## Part 6 — Conflict presentation (D3) — thumbnails, never raw base64

The existing `ConflictsScreen.jsx` machinery (`FIELD_LABELS`, `ChoiceBox`, `ConflictCard`) already handles
every other conflicting field generically by rendering `String(side.value)` — for `camp_maps.image_data`
that would dump ~700KB of unreadable base64 text, which the ADR explicitly forbids.

**Concrete fix, scoped to the smallest possible change to that existing component:**

1. `FIELD_LABELS` gains one entry: `'camp_maps.image_data': '__IMAGE__'` — the same sentinel shape the file
   already uses for `'users.pin_hash'`/`'users.pin_salt'` → `'__PIN__'`. `describeConflict` needs no change;
   it already treats a sentinel-mapped key as a signal, not literal display text.
2. `ChoiceBox` gains one more conditional branch, parallel to its existing `isPin` branch:

```jsx
) : isImage ? (
  <img
    src={`data:image/jpeg;base64,${side.value}`}
    alt=""
    style={{ width: '100%', borderRadius: 6, border: '1px solid var(--border)', margin: '10px 0', display: 'block' }}
  />
) : (
  // existing String(side.value) branch, unchanged for every other field
)
```

3. `ConflictCard`'s title line, when `isImage`, reads **"The camp map image"** (a new literal in
   `describeConflict`'s return, or a one-line `FIELD_LABELS`-adjacent map — Maker's call which is cheaper),
   rather than the generic pin copy.

Visually this is **exactly** today's `ChoiceBox` layout (`S.mergeChoiceBox`, two boxes side by side, each
with its timestamp meta and a "Keep this version" button) — the only change is what fills the box: an image
instead of a PIN-lock icon or a text string. No new component, no new screen. This is the whole D3
requirement satisfied with the smallest possible diff to an already-shipped, already-tested surface.

---

## Part 7 — Remove-image (ADR's open item, resolved here)

**Recommendation: yes, a director can remove the map image entirely, as a distinct action from Replace —
with a real (not decorative) confirmation**, because unlike almost every other delete in this app, **this one
is not Trash-recoverable** (ADR registry row 5: `camp_maps` is refused in `RESTORE_DECISIONS` — clearing the
image is a field write to NULL, not a row delete, so there is no Trash entry to restore from). The
confirmation copy must say so honestly, not imply an undo path that doesn't exist.

**Control:** a second admin-only button next to "Replace image" in the toolbar — **"Remove image"**, styled
like the app's existing quiet-destructive action (`S.btnDanger` ghost — `background: none, border: 1px solid
var(--danger), color: var(--danger)`), the same visual weight as a table row's `Delete` button.

**Confirmation:** reuse `ConfirmDangerDialog` verbatim (already imported in `LocationsScreen.jsx` for "Delete
all places?") — no new dialog component:

- Title: **"Remove the map image?"**
- Recovery line (repurposing the component's `recovery` prop, but telling the truth about this one case):
  **"This can't be undone from Trash — you'll need to upload it again. Every place keeps its position."**
- `confirmLabel`: **"Remove Map Image"**

On confirm: one field write, `camp_maps.image_data = NULL` (same op-log path as any other field write —
D6/D2's write-side guards don't apply to a NULL write). The canvas reverts to the empty state (Part 2);
**every location's `map_geometry` is untouched** — a director who re-uploads a new photo later sees their
places still positioned, just against a blank canvas until the new image lands.

---

## Design judgment calls flagged for owner sign-off

1. **Toggle idiom source (Part 1).** This spec follows ScheduleScreen's actual persistent segmented View
   toggle (`:861-865`), not the one-time route-chooser cards the ADR literally cited (`:736`/`:783`), because
   the chooser is a rare disambiguation screen and the View toggle is the real "switch between two views of
   one screen" precedent. This does not change any ADR decision — just which existing code Maker should copy
   the visual pattern from. Recommend: confirm, no visual risk either way.
2. **Single resize handle, bottom-right only (Part 4).** Not specified in the ADR. Recommend one handle
   (matches the schedule grid's own single-handle precedent, keeps the FSM/hook simple); flag if the owner
   wants full edge/corner resize instead — that would be a real scope addition, not a styling choice.
3. **Tray-to-canvas placement treated as a "move" gesture from a synthesized default rectangle**, not a third
   FSM kind. ADR D7/D8 describe move+resize of *already-positioned* locations; dropping an unplaced chip onto
   the canvas needs a starting `w`/`h` synthesized client-side (recommend **w=0.12, h=0.10**, centered on the
   drop point, clamped to stay inside 0..1) before the same move-write fires. This is a reasoned starting
   point in the same spirit as the ADR's own D2 downscale numbers — adjust freely, it is not load-bearing to
   this design.

---

## Implementation Notes for Maker

- **Reuse `ACTIVITY_COLORS`, don't duplicate it.** Import from `src/components/schedule/slotCellConstants.js`
  into wherever the map marker component lives. This is a plain JS import, not a styling-boundary question —
  it does not touch the `src/components/schedule/` CSS-exception scope (ADR D9's boundary is about the
  *stylesheet*, not the constant array).
- **PointerSensor `distance` — verify against the ADR, not this task's brief text.** The task brief mentions
  `distance: 8`; both the ADR (D8) and the actual `ScheduleScreen.jsx:203` sensor config use `distance: 5`,
  with a code comment explaining why (Windows uses 4, Unity 5, dnd-kit defaults to 5). Follow the ADR/code
  (`5`), not the brief — this spec assumes `5` throughout and doesn't depend on the exact number visually,
  but Maker should not silently pick 8 because the brief said so.
- **`.map-canvas`'s `aspect-ratio` is computed from `camp_maps.image_width`/`image_height`** — set inline
  (per-record computed geometry, same rule as `gridRow`/`gridColumn` staying inline in the schedule grid)
  the instant the row is available, before the `data:` URL image itself has decoded, so there is no layout
  shift. This is explicitly called out in ADR D10 as a requirement, not a nicety.
- **`locationMap.css` file location:** `src/components/locations/locationMap.css` (ADR D9) — a **second**,
  independently-cited scoped exception. Do not touch `scheduleGrid.css`, do not widen
  `src/components/schedule/`'s boundary, do not convert any other part of `LocationsScreen.jsx` to CSS
  classes — everything outside the map canvas stays inline `S`, unchanged.
- **The `ConflictsScreen.jsx` changes in Part 6 are the smallest possible diff** — one `FIELD_LABELS` entry,
  one new conditional branch in `ChoiceBox`, one title-copy branch in `ConflictCard`. Do not build a separate
  conflict-resolution surface for `camp_maps` — the existing generic machinery (`usePendingConflicts`,
  `resolveConflict`) needs zero changes; only the *rendering* of one field's value changes.
- **`ConfirmDangerDialog` reuse (Part 7):** check its actual prop shape before wiring — `LocationsScreen.jsx`
  already calls it with `{ title, recovery, confirmLabel, busy, onConfirm, onCancel }` for "Delete all
  places?"; the remove-image dialog should match that shape exactly, no new props.
- **Staff-tablet touch target on the resize handle** — flagged in Part 4 — needs a Red Hat/Tester pass on
  real touch hardware; this spec sets the *visual* size (14×14) but explicitly does not fix the invisible
  hit-area padding number, since that is a measured decision, not an aesthetic one.
- **Nothing in this spec touches `buildSchedule.js` or `readiness.js`** — confirmed by the ADR (D10, Invariant
  3) and unaffected by anything designed here.

---

## Prototype

[`docs/work/specs/m6-map-mockup.html`](m6-map-mockup.html) — self-contained, real Shoresh tokens/fonts/motion.
Covers: the List|Map segmented toggle; the empty-state pane for both admin and staff (side by side); the
populated map with a placeholder "camp grounds" background, three placed locations rendered with the
identity-color border/wash/chip treatment, and a **live** drag + resize demo on one rectangle (try dragging
its body, or its bottom-right handle); the unplaced tray; the admin Replace/Remove toolbar with a launchable
"Remove image" confirmation; an upload-rejected error banner; and the conflict thumbnail side-by-side (two
placeholder images standing in for two devices' competing map photos). Open it in a browser.
