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
Replace `CampIdGate` with a landing screen offering two paths:

**Path A — Create a new camp:**
- User enters a camp name
- App inserts a row into `camps` table
- Redirects to `/?camp=<uuid>`
- One-time confirmation: *"Bookmark this URL — it's how you and your team will access this camp."*

**Path B — Open existing camp:**
- If URL already contains `?camp=<uuid>`, validate against Supabase and skip the gate entirely
- localStorage still persists `campId` for refresh persistence
- Invalid `?camp=` param shows inline error: *"Camp not found. Check your link or create a new camp."*

### Sidebar
- Replace hardcoded "Camp Achva" with the actual `name` field from the `camps` table

### Constraints
- No new tables
- No auth
- Pure UX change on top of existing `camps` table

---

## Section 2: Seeded PRNG

### Problem
`buildSchedule.js:164` uses `Math.random() - 0.5` as a tie-breaker. Identical inputs produce slightly different schedules on each regeneration.

### Solution
Add a 10-line `mulberry32` seeded PRNG at the top of `buildSchedule.js`. Seed is derived from `campId` (string → numeric hash). Replace the single `Math.random()` call with a call to the seeded generator.

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
- Applied consistently across all 6 screens

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
- Exports: `S.btnPrimary`, `S.btnSecondary`, `S.table`, `S.th`, `S.td`, `S.modal`, `S.input`, `S.label`
- All screens import from `src/styles/shared.js` and remove local duplicates
- Source of truth: ActivitiesScreen (most complete)
- No visual changes

### 4b. ScheduleScreen split
Extract into `src/components/schedule/`:
- `SlotCell.jsx`
- `FlagDetailModal.jsx`
- `EditModal.jsx`
- `StatBadge.jsx`

`ScheduleScreen.jsx` stays as the orchestrator, drops from ~832 lines to ~300.

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
- Each `SlotCell` in Group view becomes a draggable item
- Dropping onto another cell swaps their activities
- Calls existing `editSlotSave` twice (swap A→B, B→A)
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
