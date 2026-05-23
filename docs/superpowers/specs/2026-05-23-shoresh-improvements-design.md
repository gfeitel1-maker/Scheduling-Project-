# Shoresh Improvements Design
**Date:** 2026-05-23
**Scope:** Invite-link model, seeded PRNG, error handling, style consolidation, drag-and-drop prototype

---

## Priority Order

1. Invite-link model (ID storage)
2. Seeded PRNG (tie-breaking)
3. Error handling
4. Style consolidation + ScheduleScreen split
5. Drag-and-drop prototype

---

## Section 1: Entry Flow & Invite-Link Model

### Problem
Users must copy a UUID from the Supabase Table Editor and paste it manually. No way to create a camp from within the app.

### Solution
Replace `CampIdGate` with a landing screen. **Camp name is the primary access path.**

**Primary path — Open by name:**
- Landing shows a single camp name input with an "Open camp" button
- On submit: query `camps` where `name = entered_name` (case-insensitive)
- **Found:** load camp, store `campId` in localStorage, redirect to `/?camp=<uuid>`
- **Not found:** show "No camp named X exists yet — create it?" with a Create button
- This is how staff on any device access the schedule without needing a bookmarked URL

**Secondary path — Create a new camp:**
- "New to Shoresh? Create a new camp" link below the primary input
- User enters camp name → app inserts row into `camps` → confirmation screen
- Confirmation shows the generated URL with a "Copy link" button and a "Bookmark this" note
- Camp name must be unique — if name already exists on creation, show: *"A camp with this name already exists. Try opening it instead."*

**Direct URL access (returning users):**
- If URL contains `?camp=<uuid>`, validate against Supabase and skip the landing screen entirely
- **URL wins over localStorage** — if `?camp=A` is in the URL but localStorage has `B`, use A and update localStorage
- localStorage persists `campId` for refresh persistence

**Supabase change:** Add a `UNIQUE` constraint on `camps.name`. Case-insensitive uniqueness enforced at the DB level.

### Sidebar
- Replace hardcoded "Camp Achva" with the actual `name` field from the `camps` table
- Pass `campId` through `Shell` → `Sidebar` as a prop; `Sidebar` fetches `camps.name` on mount

### Constraints
- No new tables
- No auth
- One DB constraint added (`camps.name` unique)

### Data preservation
- Existing `campId` in localStorage is read on every load — returning users with a valid `?camp=` URL or localStorage entry skip the landing screen entirely
- No Supabase data is migrated, deleted, or modified
- Existing schedule, groups, activities, anchors remain intact

---

## Section 2: Seeded PRNG

### Problem
`buildSchedule.js:164` uses `Math.random() - 0.5` as a tie-breaker. Identical inputs produce slightly different schedules on each regeneration.

### Solution
Add a 10-line `mulberry32` seeded PRNG at the top of `buildSchedule.js`. Seed is derived from `campId` using a djb2 string hash (standard: `hash = hash * 31 + charCode`, initialized at 5381). Replace the single `Math.random()` call with a call to the seeded generator.

### Behavior
- Same camp + same inputs → same schedule every time
- Changed inputs → output changes as expected
- No UI changes, no new dependencies

---

## Section 3: Error Handling

### Problem
All `loadAll()` functions silently fall back to `|| []`. Network errors and invalid camp IDs are indistinguishable from empty datasets.

### Solution — three targeted changes:

**3a. Camp ID validation on entry**
- After creating or loading a camp, query `camps` to confirm the ID exists
- On failure: *"Camp not found. Check your link or create a new camp."*

**3b. Load error state per screen**
- Each screen gets an `error` state variable
- If `loadAll()` throws, render an error banner: *"Failed to load data — check your connection and refresh"*
- Applied to the 6 data-loading screens: `TiersScreen`, `GroupsScreen`, `TimeBlocksScreen`, `ActivitiesScreen`, `AnchorsScreen`, `ScheduleScreen`
- `DaysScreen.jsx` exists on disk but is not registered in `App.jsx` and is dead code — skip it
- `ScheduleScreen` has two failure modes in `loadAll`: (a) the main `Promise.all` for groups/activities/etc., and (b) a sequential template-slots load. Each gets its own `try/catch` with the same error banner; the banner distinguishes which block failed: *"Failed to load schedule data"* vs *"Failed to load saved schedule"*

**3c. Save error feedback in modals**
- All modals already have `saving` state
- Add `saveError` state; on Supabase failure show inline message in modal
- Modal stays open on failure so user doesn't lose their input

### Constraints
- No error boundaries
- No retry logic
- Visible failure states only

---

## Section 4: Style Consolidation & ScheduleScreen Split

### 4a. Shared styles
- Create `src/styles/shared.js` exporting an `S` object
- Exports: `S.btnPrimary`, `S.btnSecondary`, `S.table`, `S.th`, `S.td`, `S.modalSm` (maxWidth 400), `S.modalLg` (width 480), `S.input`, `S.label`
- All screens import from `src/styles/shared.js` and remove local duplicates
- Source of truth: ActivitiesScreen (most complete)
- No visual changes

### 4b. ScheduleScreen split
Extract into `src/components/schedule/`:
- `SlotCell.jsx`
- `FlagDetailModal.jsx`
- `EditModal.jsx`
- `StatBadge.jsx`
- `ConfirmRegenModal.jsx` (currently inline JSX in the render tree, ~15 lines)

`ScheduleScreen.jsx` stays as the orchestrator, drops from ~832 lines to ~280.

### Constraints
- No behavior changes
- 4a and 4b are independent, can be done in either order

---

## Section 5: Drag-and-Drop Prototype

### Goal
Validate whether drag-and-drop feels right before committing. Build in Group view only; if it feels good, keep it; if not, revert cleanly.

### Library
`@dnd-kit/core` — lightweight, React 19 compatible, no jQuery.

### Behavior
- Each `SlotCell` in Group view becomes a draggable item (except `type === 'anchor'` and `type === 'unavailable'` — these are non-draggable)
- Dropping onto another cell swaps their activities
- Requires a new `swapSlots(slotA, slotB)` function — `editSlotSave` reads from component state and cannot be called twice for different cells. `swapSlots` takes two slot coordinate objects `{ groupId, dayId, blockId, activityId }` and writes both to Supabase directly
- Visual: dragged cell at 50% opacity, drop target gets highlight border

### Scope
- Group view only
- Swap only (no cross-group reorder)
- No undo

### Revert plan
Remove `@dnd-kit/core` and revert `SlotCell.jsx` — no other files touched.

---

## Out of Scope
- Staff/resource constraints
- Mobile responsiveness
- PDF export (XLSX only)
- Multi-session support
- Shareable read-only links
- Schedule versioning (overwrite-on-regenerate is correct behavior)
