# Test Script — Shoresh Scheduling App

Run order matters. Each section depends on the previous not being a BLOCKER.
Tags: `[REGRESSION]` = always run after any code change. `[FULL]` = full run only.

---

## 1. APP LOAD & NAVIGATION `[REGRESSION]`

- 1.1 Navigate to http://localhost:5200 — page loads, sidebar shows "Shoresh" and "Camp Arazim"
- 1.2 Sidebar links visible: Camp Setup, Programs, Units, Groups, Time Blocks, Activities, Anchors, Day Overrides, Schedule
- 1.3 No console errors on load
- 1.4 Camp Setup is the default screen on load

---

## 2. CAMP SETUP SCREEN `[REGRESSION]`

- 2.1 Camp name field shows "Camp Arazim"
- 2.2 Progress bar is full — label reads "5 / 5 complete"
- 2.3 All 5 step cards show a ✓ checkmark
- 2.4 Step counts: Units = 3, Groups = 9, Time Blocks = 8, Activities = 8, Fixed Events = 4
- 2.5 Summary row at bottom shows all 5 counts correctly
- 2.6 "Generate Schedule →" button is active (not greyed/disabled)
- 2.7 Clicking "Generate Schedule →" navigates to the Schedule screen

---

## 3. SETUP SCREENS (CRUD) `[FULL]`

### 3A — Units
- 3A.1 Clicking "Units" in sidebar loads the Units screen
- 3A.2 Three tiers listed: Yeladim, Bonim, Bogrim
- 3A.3 No console errors

### 3B — Groups
- 3B.1 Nine groups visible across the three tiers
- 3B.2 Tzrif Aleph, Tzrif Bet, Tzrif Gimel under Yeladim
- 3B.3 Bunk 5, Bunk 6, Bunk 7 under Bonim
- 3B.4 Senior A, Senior B, Senior C under Bogrim

### 3C — Time Blocks
- 3C.1 Eight time blocks listed in sort order
- 3C.2 First block: Boker Tefillah 08:15–09:00
- 3C.3 Last block: Peulat Erev 19:00–20:30

### 3D — Activities
- 3D.1 Eight activities listed: Swimming, Archery, Arts & Crafts, Basketball, Theater, Ropes Course, Ceramics, Soccer
- 3D.2 Each shows location and indoor/outdoor indicator

### 3E — Fixed Events (Anchors)
- 3E.1 Four anchors listed: Boker Tefillah, Aruchat Tzaharayim, Menucha, Peulat Erev
- 3E.2 Each shows its linked time block

---

## 4. SCHEDULE SCREEN — LOAD & STATS `[REGRESSION]`

- 4.1 Navigate to Schedule via sidebar
- 4.2 Schedule loads — shows filled count (should be ~145–180)
- 4.3 Unfillable = 0
- 4.4 Underserved = 0
- 4.5 Distribution = 0
- 4.6 View tabs visible: Group View, Daily View, Activity View
- 4.7 Group pills show all 9 groups
- 4.8 No console errors after load

---

## 5. SCHEDULE — GROUP VIEW `[REGRESSION]`

- 5.1 Group View is the default active tab
- 5.2 Tzrif Aleph is selected by default (first pill highlighted)
- 5.3 Grid shows 5 day columns (Mon–Fri) and 8 block rows
- 5.4 Boker Tefillah row: all 5 days show purple anchor cell labeled "Boker Tefillah" — NOT an activity
- 5.5 Aruchat Tzaharayim row: all 5 days show purple anchor cell
- 5.6 Menucha row: all 5 days show purple anchor cell
- 5.7 Peulat Erev row: all 5 days show purple anchor cell
- 5.8 No cell has amber/gold border (no stale locks)
- 5.9 Activity blocks show colored activity names (different activities per day per group)
- 5.10 No activity name repeats across multiple blocks on the same day column
- 5.11 Click a different group pill (e.g., Bunk 5) — grid updates for that group
- 5.12 Click a filled activity cell — edit modal opens (does NOT lock the cell)
- 5.13 Edit modal shows the current activity name
- 5.14 Close/cancel the modal — cell returns to normal, no lock applied
- 5.15 Hover a filled activity cell — thin expand handle appears at the bottom of the cell
- 5.16 [MANUAL ONLY] Expand handle shows ↕ symbol and "Drag to extend" tooltip on handle hover — JS cannot trigger React hover state, skip in automated runs

---

## 6. SCHEDULE — DAILY VIEW `[REGRESSION]`

- 6.1 Click "Daily View" tab — view switches
- 6.2 All 9 groups visible as columns
- 6.3 Day tabs (Monday–Friday) are clickable and switch the day
- 6.4 Anchor rows (Boker Tefillah, Aruchat Tzaharayim, etc.) show purple cells across all group columns
- 6.5 No amber/gold border on any cell
- 6.6 Clicking a filled cell opens edit modal — does NOT lock the cell
- 6.7 Close modal — no lock applied

---

## 7. SCHEDULE — ACTIVITY VIEW `[FULL]`

- 7.1 Click "Activity View" tab — view switches
- 7.2 Activity cards are visible (one per activity)
- 7.3 Click an activity card — drilldown opens showing that activity's slot assignments across the week

---

## 8. WEATHER MODE `[REGRESSION]`

- 8.1 Click "Weather Mode OFF" button — toggles to "Weather Mode ON"
- 8.2 Outdoor activity cells (Swimming, Archery, etc.) show a blue highlight border
- 8.3 Indoor activity cells (Arts & Crafts, Theater, Ceramics) do NOT highlight
- 8.4 Click again — toggles back to OFF, highlights removed

---

## 9. FIELD TRIPS / STAMP `[REGRESSION]`

- 9.1 "Field Trips" button shows clean label — NOT "Field Trips · Field Trip" or any stuck state
- 9.2 Click "Field Trips" button — drawer or stamp mode activates
- 9.3 Button label changes to indicate active state (e.g., "✕ Field Trip")
- 9.4 Click the button again or press Escape — stamp mode cancels, button returns to "Field Trips"
- 9.5 No console errors

---

## 10. EXPAND / MERGE INTERACTION `[REGRESSION]`

- 10.1 In Group View, hover a filled non-anchor cell — expand handle appears (invisible until hover)
- 10.2 Handle is at the bottom of the cell, ~10px tall
- 10.3 [MANUAL ONLY] Hover the handle itself — shows ↕ symbol, tooltip "Drag to extend" — JS cannot trigger React hover state, skip in automated runs
- 10.4 Drag the handle downward onto the next block's cell in the same day column
- 10.5 Target cell shows green dashed border highlight while dragging over it
- 10.6 On drop: the head cell spans two rows (taller merged cell)
- 10.7 Displaced palette appears (floating panel) showing the bumped activity name
- 10.8 Displaced palette shows "displaced from [block name] · [day]" subtext
- 10.9 Click X on the displaced palette item — it dismisses (palette disappears or empties)
- 10.10 No console errors during the above flow

---

## 11. REGENERATE `[REGRESSION]`

- 11.1 Click "Regenerate from Scratch" — confirmation modal appears
- 11.2 Modal text mentions data will be lost
- 11.3 Click "Cancel" — modal closes, schedule unchanged
- 11.4 Click "Regenerate from Scratch" again, then confirm — schedule regenerates
- 11.5 After regen: Unfillable = 0, Underserved = 0, anchors still in purple
- 11.6 No activity repeats on the same day for the same group (spot-check Tzrif Gimel)

---

## 12. VERSIONS / SNAPSHOTS `[FULL]`

- 12.1 Click "Versions" dropdown — shows list of saved snapshots (at least one auto-save from regen)
- 12.2 Clicking a snapshot restores it (schedule updates)
- 12.3 No console errors

---

## END OF SCRIPT

After completing all tests, save your report to:
`tester/REPORT_[YYYY-MM-DD].md`

Ping the main session with a one-line summary: "X pass, X fail — [worst failing test if any]"
