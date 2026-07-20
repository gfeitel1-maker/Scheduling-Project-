# Merge / Conflict Resolution Screen — Design

**Date:** 2026-07-19
**Status:** Ready for build
**Prototype:** `docs/superpowers/specs/prototypes/2026-07-19-merge-screen.html`

## Context

Final screen in Shoresh's local-first rearchitecture. When two devices edit the same field
offline and reconnect, the sync layer (`electron/sync/syncClient.js`, `syncServer.js`) detects
the collision instead of silently picking a winner, and this screen is where a human — the
camp director — resolves it. This is reached from *inside* the authenticated app (Shell +
Sidebar chrome), not the pre-login `authCard` pattern used by `LoginScreen`/`ModeSelectScreen`.

Data shapes this screen must consume (from the architecture spec, verified against source):

- Direct `write()` conflict response (`syncClient.js` line ~322): `{ status: 'conflict', existingOp }`.
  The caller already has their own local attempt in hand (what "my machine" tried to write);
  `existingOp` is what's already been applied by the other side.
- Broadcast conflict (`syncServer.js` line ~96, forwarded to clients): `{ type: 'op_conflict', incomingOp, existingOp }`.
- `existingOp`/`incomingOp` shape: `{ id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id }`.
- **Hard constraint** (`2026-07-19-users-camps-sync-design.md`): when `entity === 'users'` and
  `field` is `pin_hash` or `pin_salt`, never render the raw value (hash or otherwise). Show a
  generic "PIN changed on [side A] vs [side B]" choice with no value shown. All other
  entity/field combinations show the actual conflicting values.

Both data shapes (direct-write conflict and broadcast conflict) normalize to the same two-sided
record before reaching this screen's UI — see Implementation Notes.

## Sidebar / navigation decision

**The screen always exists in `SCREENS`/`Sidebar` NAV, at all times — it is not hidden or
conditionally routed.** A badge (small red-orange count pill) appears next to the "Conflicts"
nav item only when `pendingConflicts.length > 0`; when the count is 0 the nav item is present
but bare. Navigating there directly always shows either the list or the empty state gracefully.

Justification:
- A conflict list that only becomes navigable when non-empty would mean a director who resolves
  the last conflict, then wonders "did that work, is my sidebar broken now?" — permanence removes
  that doubt.
- Consistent with how every other screen in this app works (Cohorts, Groups, etc. always exist
  in nav even when their list is empty, per `CohortsScreen`'s "No programs yet" pattern).
- The badge is the actual urgency signal — a bare nav item is calm, a badge is the call to action.
  This matches the "reassuring, not alarming" tone this skill's brief calls for: the *screen*
  is not scary, only the badge count communicates "something needs you."

Placed near the top of the nav list, right under "Camp Setup" (before Programs/Units/etc.),
since a live conflict blocks a director's confidence in *everything downstream* — schedule,
groups, staff — so it should be the first thing they see, not buried after operational config
screens.

## Layout

Full `Shell`-wrapped screen (`Sidebar` + `TopBar` + scrollable `<main>`), `maxWidth: 760` content
column, matching `CohortsScreen`'s content-width convention.

```
┌─────────────────────────────────────────────┐
│  3 conflicts need your attention              │  <- eyebrow + count, not a table header
│  These happened while devices were offline.   │  <- one reassuring sentence, no jargon
│  Pick which version to keep for each one.      │
├─────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐│
│ │ Card 1: readable description                ││
│ │  [Side A box]         [Side B box]           ││
│ │   author/device • time   author/device • time││
│ │  [Keep this version]   [Keep this version]   ││
│ └───────────────────────────────────────────┘│
│ ┌───────────────────────────────────────────┐│
│ │ Card 2 ...                                   ││
│ └───────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

Each conflict is a **card**, not a table row (unlike Cohorts/Groups) — two long free-text values
side-by-side don't fit table cells at any reasonable column width, and a card gives each
conflict enough visual weight to feel deliberate rather than another row to rubber-stamp.

### Card anatomy
1. **Header row**: plain-language description of what's disagreed about (see mapping below),
   left-aligned, `font-condensed` bold ~15px. Right-aligned: a small muted "2h ago" (of the more
   recent op) so the director has a sense of staleness at a glance without reading both timestamps.
2. **Two side-by-side choice boxes** (flex, gap 14, each `flex: 1`, min width so they never
   get uncomfortably narrow — wrap to stacked on narrow viewports).
   - Box shows: author/device label ("This computer" / device name / user name — whichever the
     data provides, see Implementation Notes), relative timestamp, then either:
     - the actual value (schedule slot, name, role — rendered as plain text, monospace only if
       genuinely code-like), or
     - for PIN fields: a lock icon + "PIN was changed" with no value at all.
   - A "Keep this version" button at the bottom of each box.
3. Boxes are visually equal-weight (no "recommended" side) — this is a human decision, the UI
   must not bias it.

## Visual Style

Reuses tokens already established by `CohortsScreen`/`shared.js` (`S.*`) plus a small set of new
`merge`-prefixed style objects (additive to `shared.js`, not a new pattern):

- Card container: `background: var(--surface)`, `border: 1px solid var(--border)`, `borderRadius: 12`,
  `padding: 18px 20px`, `marginBottom: 14` — identical container language to Cohorts' add-panel.
- Choice box: `background: var(--bg)`, `border: 1.5px solid var(--border)`, `borderRadius: 9`,
  `padding: 14px`. On hover: `border-color: var(--primary)` (cheap affordance, no layout shift).
- Value text: `fontSize: 13.5`, `color: var(--text)`, `lineHeight: 1.5`.
- Author/meta line: `fontSize: 11.5`, `fontFamily: var(--font-mono)`, `color: var(--text-secondary)`.
- PIN-hidden box: same box shell, but content replaced with a centered lock glyph + "PIN was changed"
  in `var(--text-secondary)`, no value line at all — visually distinct enough (no long text) that a
  director immediately understands "there's nothing to compare, just pick who's right."
- "Keep this version" button: `S.btnSecondary` styling by default; on the box the user is
  hovering, it flips to `S.btnPrimary`-like (teal) treatment via local hover state, so the act of
  choosing feels affirmative rather than picking a table action.
- Screen intro block: eyebrow-style count line reuses the `font-condensed` uppercase pattern from
  Cohorts ("N conflicts need your attention"), body sentence in `var(--text-secondary)`,
  `fontSize: 13`, explicitly non-technical ("These happened while two devices made changes at the
  same time." — no mention of "ops," "entities," or "sync").
- Empty state: centered block, reuses the same visual language as Cohorts' "No programs yet" —
  `font-condensed` 16px headline "No conflicts to resolve", secondary line "Everything's in sync."
  A small checkmark-in-circle glyph in `var(--success)` above the text, tone: quiet relief, not
  a blank void.

## Plain-language mapping (entity/field → description)

A small lookup table, generic-fallback safe, so Maker doesn't need a full schema-aware mapper:

```js
const FIELD_LABELS = {
  'users.name':      'A staff member\'s name',
  'users.role':       'A staff member\'s role',
  'users.pin_hash':   '__PIN__',   // sentinel handled specially, never displayed as text
  'users.pin_salt':   '__PIN__',
  'template_slots.activity_id': 'A schedule slot\'s activity',
  'template_slots.group_id':    'A schedule slot\'s assigned group',
  'template_slots.locked':      'A schedule slot\'s lock status',
  // fallback for anything not in this table:
}
function describeConflict(entity, field) {
  const key = `${entity}.${field}`
  if (FIELD_LABELS[key] === '__PIN__') return null // signals PIN-mode to the card renderer
  return FIELD_LABELS[key] || `A ${field.replace(/_/g, ' ')} change`
}
```

This satisfies the brief's "your call" on full readable-mapping vs. generic fallback: a curated
table for the handful of fields directors will actually hit often (staff name/role, schedule
slot fields), graceful generic fallback (`"A <field> change"`, human-cased) for anything Maker's
table doesn't yet cover — never raw `entity: field` dumped at a non-technical user.

## States

1. **Loading** — while the conflict list is being fetched/derived, same `Loading…` text treatment
   as Cohorts (`font-mono`, `var(--text-secondary)`).
2. **Empty** — see above. Always reachable directly (nav item has no gate).
3. **List with N conflicts** — the main state described above.
4. **Resolving (in-flight)** — the clicked "Keep this version" button shows a brief `Saving…`
   label state (mirrors Cohorts' Save button pattern) and disables both boxes' buttons in that
   card to prevent double-submits.
5. **Just resolved** — the card doesn't just vanish (would read as an error/glitch to a stressed
   director double-checking their work). It shows a **1.1s confirmation moment inside the same
   card position**: content swaps to a centered checkmark + "Kept [side]'s version" in
   `var(--success)`, card border flashes to success-green, then the whole card collapses
   height-to-zero and is removed from the list. Prevents any "wait, did that work?" doubt.
6. **PIN conflict card** — structurally identical card, but both choice boxes render the
   lock-glyph/"PIN was changed" treatment instead of a value line. Button copy still reads
   "Keep this version" (not "Keep this PIN") since no PIN value is ever named.

## Interactions

- Clicking "Keep this version" on either side is the entire interaction — no secondary confirm
  dialog (unlike destructive deletes elsewhere in the app, e.g. Cohorts' `window.confirm` on
  delete). Conflict resolution is not destructive in the sense of losing data forever — the
  losing op remains in the op-log — so a confirm dialog would only add friction to what's already
  a slightly stressful moment. Note for Maker: if product later decides the losing op should be
  irrecoverable from the UI, add a confirm; the design intentionally omits one now given the op
  log preserves history.
- Hover on a choice box raises its "Keep this version" button to primary-teal, giving a light
  preview of "this is the side I'm about to commit to" before the click.
- Keyboard: buttons are real `<button>` elements, tab order flows through boxes top-to-bottom,
  left-to-right, Enter/Space activates focused button — no custom keyboard handling needed.

## Animation

All transitions are cheap CSS, consistent with the rest of the app's timing (`transition:
background 0.1s` on nav items, `0.15s` on choice cards):

- Choice box hover border color: `transition: border-color 0.15s`.
- Button hover: `transition: background 0.12s, color 0.12s`.
- Resolution confirmation: card content cross-fades (`opacity 0.15s`) from the two-box layout to
  the checkmark confirmation; after holding ~1.1s, the whole card animates
  `max-height`/`opacity`/`margin` down to 0 over `0.35s ease` before being removed from the DOM
  (a manual `max-height` collapse is required since CSS can't transition `display: none` or React
  unmount — see Implementation Notes).
- No animation on initial list load (avoid enter-in stagger which draws extra attention to what's
  already a slightly tense screen) — cards should just be there, ready, calm.

## Prototype

Self-contained HTML at `docs/superpowers/specs/prototypes/2026-07-19-merge-screen.html`. Covers:
- Empty state (toggle button in the prototype's dev toolbar to view it)
- List with 3 conflicts: a staff-name conflict, a schedule-slot conflict, and a PIN conflict
  (hidden-value treatment)
- Clicking "Keep this version" on any card demonstrates the checkmark → collapse → removal
  sequence, and the sidebar badge count live-decrements

## Implementation Notes for Maker

- **Normalizing both conflict shapes into one model.** Direct-write conflicts
  (`{ status: 'conflict', existingOp }`) only carry the *other* side — the caller's own attempted
  op is already in memory at the call site (e.g. the field the user just tried to save locally).
  Broadcast conflicts (`{ type: 'op_conflict', incomingOp, existingOp }`) carry both sides
  explicitly. Build a small adapter so the merge screen's data layer always ends up with a
  uniform `{ id, entity, entity_id, field, sideA: opLike, sideB: opLike }` record regardless of
  which path produced it — where for the direct-write case, `sideA` is constructed from the
  caller's local attempt (its own author/device/timestamp/value, using local device identity)
  and `sideB = existingOp`. Do not surface "existingOp"/"incomingOp" naming in the UI layer at
  all — those are transport-level names, the UI only knows "side A" / "side B" with real author
  labels attached.
- **Author/device labels.** Prefer resolving `author_user_id` to a display name (join against the
  local `users` table) over `device_id`/device name — "Kept Sarah's version" reads more human than
  "Kept Device-3F2A's version." Fall back to a device label (`devices.name` if the schema has one,
  else "Device [id.slice(0,6)]") only when the author can't be resolved (e.g. author row not yet
  synced locally). If the current device authored a side, label it "This computer" regardless of
  device name — it's the most reassuring, unambiguous label for the person sitting at that machine.
- **Relative timestamps.** `op.timestamp` → "2 hours ago" style. Reuse an existing date-fns-style
  helper if one already exists in the codebase (check `src/utils/`); if not, a small inline
  formatter is fine (this screen doesn't need sub-minute precision).
- **Resolution write-back.** "Keep this version" should call whatever local write path re-applies
  the chosen side's `value` as the new op (parented appropriately so it doesn't itself look like a
  fresh unresolved conflict), then remove the conflict from local pending-conflict storage. Confirm
  the exact API with the sync-layer implementation (`electron/sync/syncClient.js` /
  `electron/ops/operations.js`) — this design does not prescribe the write mechanism, only the UI
  contract: a resolve action takes `(conflictId, chosenSide)` and resolves to success/failure.
- **Where the pending list lives.** Out of scope for this design doc, but the screen needs a
  data source — likely a small store/hook (`usePendingConflicts` or similar) fed by both the
  direct-write conflict path and the `op_conflict` broadcast listener, deduped by conflict id.
  Whatever persistence backs it, the badge count on the sidebar and the screen's list must read
  from the same source so they never disagree.
- **PIN sentinel.** Use the `describeConflict` return value of `null` (or an explicit
  `isPinConflict` boolean computed the same way) to branch card rendering — never pass
  `pin_hash`/`pin_salt` raw values into any component prop, log line, or dev tool, even ones that
  won't render them. Treat it as sensitive at the data-fetch boundary, not just the render
  boundary.
- **New shared styles**: add `mergeCard`, `mergeChoiceBox`, `mergeChoiceBoxHover`, `mergeMeta`,
  `mergeBtnKeep`, `mergePinLock`, `mergeEmptyState`, `mergeConfirmed` to `src/styles/shared.js`
  under a clearly commented "Merge / conflict resolution" section, following the existing
  `S.auth*` grouping convention.
- **New screen file**: `src/screens/ConflictsScreen.jsx`, registered in `App.jsx`'s `SCREENS` map
  as `conflicts: ConflictsScreen`, and added to `Sidebar.jsx`'s `NAV` array as
  `{ key: 'conflicts', label: 'Conflicts', badge: pendingCount }` (Sidebar needs a small addition
  to render an optional badge per nav item — currently it has no badge support at all).
