# Terminology Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all user-visible "Cohort" → "Program" and "Tier" → "Unit" text across the UI. No schema or logic changes.

**Architecture:** Pure string replacement across 5 files. Internal variable names, component names, and DB columns are untouched. TopBar's `TITLES` map gets `cohorts` added (currently missing — the Programs screen falls back to "Shoresh" in the title bar).

**Tech Stack:** React, Vite (no new dependencies)

---

### Task 1: Sidebar + TopBar labels

**Files:**
- Modify: `src/components/layout/Sidebar.jsx`
- Modify: `src/components/layout/TopBar.jsx`

- [ ] **Step 1: Update Sidebar nav labels**

In `src/components/layout/Sidebar.jsx`, change:
```js
{ key: 'cohorts',      label: 'Cohorts' },
{ key: 'tiers',        label: 'Tiers' },
```
to:
```js
{ key: 'cohorts',      label: 'Programs' },
{ key: 'tiers',        label: 'Units' },
```

- [ ] **Step 2: Update TopBar TITLES map**

In `src/components/layout/TopBar.jsx`, change:
```js
const TITLES = {
  setup:      'Camp Setup',
  tiers:      'Tiers',
  groups:     'Groups',
  days:       'Days of Operation',
  timeblocks: 'Time Blocks',
  activities: 'Activities',
  anchors:    'Anchors',
  schedule:   'Schedule',
}
```
to:
```js
const TITLES = {
  setup:        'Camp Setup',
  cohorts:      'Programs',
  tiers:        'Units',
  groups:       'Groups',
  days:         'Days of Operation',
  timeblocks:   'Time Blocks',
  activities:   'Activities',
  anchors:      'Anchors',
  dayoverrides: 'Day Overrides',
  schedule:     'Schedule',
}
```

- [ ] **Step 3: Verify**

```bash
grep -n "Cohorts\|Tiers" src/components/layout/Sidebar.jsx src/components/layout/TopBar.jsx
```
Expected: no matches (only internal key strings like `'cohorts'` and `'tiers'` should remain, not display labels).

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/Sidebar.jsx src/components/layout/TopBar.jsx
git commit -m "feat: rename nav labels Cohorts→Programs, Tiers→Units"
```

---

### Task 2: CohortPicker label

**Files:**
- Modify: `src/components/CohortPicker.jsx`

- [ ] **Step 1: Change the picker label**

In `src/components/CohortPicker.jsx`, find the label span (around line 20) that reads:
```jsx
        Cohort
```
Change it to:
```jsx
        Program
```

- [ ] **Step 2: Verify**

```bash
grep -n "Cohort" src/components/CohortPicker.jsx
```
Expected: only comments and prop/variable names (`cohorts`, `activeCohort`), no visible UI text.

- [ ] **Step 3: Commit**

```bash
git add src/components/CohortPicker.jsx
git commit -m "feat: rename CohortPicker label Cohort→Program"
```

---

### Task 3: CohortsScreen UI text

**Files:**
- Modify: `src/screens/CohortsScreen.jsx`

- [ ] **Step 1: Update count display (line ~189)**

Change:
```jsx
{cohorts.length} cohort{cohorts.length !== 1 ? 's' : ''}
```
to:
```jsx
{cohorts.length} program{cohorts.length !== 1 ? 's' : ''}
```

- [ ] **Step 2: Update empty state (lines ~211–212)**

Change:
```jsx
<div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No cohorts yet</div>
<div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first cohort below.</div>
```
to:
```jsx
<div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No programs yet</div>
<div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first program below.</div>
```

- [ ] **Step 3: Update Add form heading (line ~224)**

Change:
```jsx
          Add Cohort
```
to:
```jsx
          Add Program
```

- [ ] **Step 4: Update Add button (line ~256)**

Change:
```jsx
{adding ? 'Adding…' : '+ Add Cohort'}
```
to:
```jsx
{adding ? 'Adding…' : '+ Add Program'}
```

- [ ] **Step 5: Update delete alert (line ~175)**

Change:
```js
alert('Cannot delete the last cohort — every camp must have at least one.')
```
to:
```js
alert('Cannot delete the last program — every camp must have at least one.')
```

- [ ] **Step 6: Update delete confirm dialog (line ~178)**

Change:
```js
if (!window.confirm('Delete this cohort? Tiers and time blocks assigned to it will lose their cohort reference.')) return
```
to:
```js
if (!window.confirm('Delete this program? Units and time blocks assigned to it will lose their program reference.')) return
```

- [ ] **Step 7: Update bottom description text (lines ~262–263)**

Change:
```jsx
        A cohort groups tiers, time blocks, and anchors that share a schedule structure.
        Most camps have one cohort ("Main"). Add a second for specialty programs with a different time grid.
```
to:
```jsx
        A program groups units, time blocks, and anchors that share a schedule structure.
        Most camps have one program ("Main"). Add a second for specialty programs with a different time grid.
```

- [ ] **Step 8: Verify**

```bash
grep -n '"Cohort\|Cohorts\|cohort' src/screens/CohortsScreen.jsx | grep -v "//\|import\|useCohorts\|activeCohort\|cohorts\.\|cohort\.\|cohort_id\|setCohorts\|newCohort\|CohortRow\|CohortPicker\|onSave\|onDelete\|campId"
```
Expected: no user-visible string matches.

- [ ] **Step 9: Commit**

```bash
git add src/screens/CohortsScreen.jsx
git commit -m "feat: rename CohortsScreen UI text Cohort→Program"
```

---

### Task 4: TiersScreen UI text

**Files:**
- Modify: `src/screens/TiersScreen.jsx`

- [ ] **Step 1: Update delete button tooltip (line ~67)**

Change:
```jsx
title={groupCount > 0 ? 'Remove groups from this tier first' : ''}
```
to:
```jsx
title={groupCount > 0 ? 'Remove groups from this unit first' : ''}
```

- [ ] **Step 2: Update Excel sheet name (line ~150)**

Change:
```js
XLSX.utils.book_append_sheet(wb, ws, 'Tiers')
```
to:
```js
XLSX.utils.book_append_sheet(wb, ws, 'Units')
```

- [ ] **Step 3: Update count display (line ~206)**

Change:
```jsx
{tiers.length} tier{tiers.length !== 1 ? 's' : ''}
```
to:
```jsx
{tiers.length} unit{tiers.length !== 1 ? 's' : ''}
```

- [ ] **Step 4: Update empty state (lines ~233–234)**

Change:
```jsx
<div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No tiers yet</div>
<div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first tier below or import from Excel.</div>
```
to:
```jsx
<div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No units yet</div>
<div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first unit below or import from Excel.</div>
```

- [ ] **Step 5: Update Add form heading (line ~253)**

Change:
```jsx
          Add Tier
```
to:
```jsx
          Add Unit
```

- [ ] **Step 6: Update input placeholder (line ~257)**

Change:
```jsx
placeholder="Tier name (e.g. Yeladim)"
```
to:
```jsx
placeholder="Unit name (e.g. Yeladim)"
```

- [ ] **Step 7: Verify**

```bash
grep -n '"Tier\|Tiers\b' src/screens/TiersScreen.jsx | grep -v "//\|import\|tiers\.\|tier\.\|tier_id\|setTiers\|newTier\|TierRow"
```
Expected: no user-visible string matches.

- [ ] **Step 8: Commit**

```bash
git add src/screens/TiersScreen.jsx
git commit -m "feat: rename TiersScreen UI text Tier→Unit"
```

---

### Task 5: Visual verification

- [ ] **Step 1: Check the app looks right**

Dev server should already be running at `http://localhost:5200`. Navigate to each screen and confirm:

| Screen | Check |
|---|---|
| Sidebar | "Programs" and "Units" in nav (not "Cohorts"/"Tiers") |
| Programs screen | Title bar shows "Programs", count says "N programs", add form says "Add Program" |
| Units screen | Title bar shows "Units", count says "N units", add form says "Add Unit" |
| CohortPicker (any screen with 2+ programs) | Dropdown label says "Program" |

- [ ] **Step 2: Push**

```bash
git push origin main
```
