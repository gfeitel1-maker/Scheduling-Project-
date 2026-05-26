# Schedule Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add flag explainability + dismissal, activity-level slot locking, and named schedule snapshots to the Shoresh schedule screen.

**Architecture:** Three self-contained features layered onto `ScheduleScreen.jsx` and supporting components. The engine (`buildSchedule.js`) gets extended for flag reasons and lock pre-placement. New DB columns and a new table handle persistence. A new `VersionsDropdown` component handles snapshot UI.

**Tech Stack:** React 19, Vite 8, Supabase (PostgreSQL + JS client), @dnd-kit/core, Vitest (added in Task 1 for pure-function tests)

---

## Codebase Context

```
src/
  engine/buildSchedule.js         — pure scheduling function, no deps
  screens/ScheduleScreen.jsx      — main screen (619 lines), all state here
  components/schedule/
    SlotCell.jsx                  — renders one grid cell (123 lines)
    FlagDetailModal.jsx           — flag drill-down modal (125 lines)
    StatBadge.jsx                 — small topbar stat chip
    EditModal.jsx                 — slot edit modal
    ConfirmRegenModal.jsx         — regen confirmation modal
  styles/shared.js                — S.* inline style tokens
src/supabase.js                   — Supabase client (import { supabase })
```

**Key design rules:**
- Inline styles everywhere using `S.*` tokens and CSS variables
- CSS vars: `--bg #FAF6F0`, `--surface #FFFCF8`, `--surface-elevated #FFF8F0`, `--border #E8DDD0`, `--primary #00ADBB`, `--text #2D1F12`, `--text-secondary #7A6152`, `--warning #F0585D`
- Fonts: `var(--font-condensed)` (Fredoka), `var(--font-sans)` (Nunito), `var(--font-mono)` (IBM Plex Mono)
- `S.btnPrimary`, `S.btnSecondary`, `S.btnDanger`, `S.overlay`, `S.modalLg`, `S.input`
- DB slot shape (snake_case from Supabase): `{ id, template_id, group_id, day_id, time_block_id, activity_id, anchor_id, is_anchor, flags }`
- Engine slot shape (camelCase): `{ groupId, dayId, blockId, type, activityId, anchorId, flags }`
- `actMap` in ScheduleScreen is `Map<id, { ...activity, colorIdx: number }>`

**Flag system today:**
- Flags stored as JSONB on `template_slots.flags`: `{ UNFILLABLE: true, WEATHER_RISK: true, ... }`
- `FLAG_COLORS = { UNFILLABLE: '#F0585D', UNDERSERVED: '#F5A623', WEATHER_RISK: '#2F7DE1', DISTRIBUTION: '#7DC433' }`
- SlotCell renders a colored dot per flag key
- `recalcStats` counts `Object.keys(s.flags || {}).length` — currently overcounts because `_reason`/`_dismissed` keys will be added

---

## File Map

| File | Change |
|------|--------|
| `src/engine/buildSchedule.js` | Add `_reason` strings; accept `preplacedSlots` param |
| `src/components/schedule/SlotCell.jsx` | Lock visual; click=lock/right-click=edit; filter real flags |
| `src/components/schedule/FlagDetailModal.jsx` | Reason column; Dismiss button; filter dismissed rows |
| `src/components/schedule/VersionsDropdown.jsx` | New component — snapshot dropdown |
| `src/screens/ScheduleScreen.jsx` | Dismiss handler; lock/release handlers; snapshot save/restore; stats fix; wire new props |
| `package.json` + `vite.config.js` | Add Vitest |
| `src/engine/buildSchedule.test.js` | Unit tests for flag reasons + lock pre-placement |
| Supabase SQL (run manually) | `activities.is_locked`, `template_slots.is_released`, `schedule_snapshots` table |

---

## Task 1: Vitest setup + engine flag reasons

**Files:**
- Modify: `package.json`
- Modify: `vite.config.js`
- Create: `src/engine/buildSchedule.test.js`
- Modify: `src/engine/buildSchedule.js`

### Background

`buildSchedule.js` is a pure function — ideal to unit test. This task adds Vitest, writes tests for the flag reason strings, then implements them.

The four flags and their `_reason` format:
- `UNFILLABLE_reason`: `"No eligible activity could be placed in this slot"`
- `UNDERSERVED_reason`: `"Goal: {min_per_week}×/wk — scheduled {got}× (group: {groupName}, activity: {actName})"`
- `WEATHER_RISK_reason`: `"Outdoor activity scheduled in this slot"`
- `DISTRIBUTION_reason`: `"Goal: {prefer_before_day_min}× before day {prefer_before_day} — only {beforeCount}× placed (group: {groupName}, activity: {actName})"`

- [ ] **Step 1: Install Vitest**

```bash
cd /home/user/shoresh
npm install -D vitest
```

- [ ] **Step 2: Add test script to package.json**

In `package.json`, add `"test": "vitest run"` to the `"scripts"` section:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Configure Vitest in vite.config.js**

Read `vite.config.js`. Add `test: { environment: 'node' }` inside the `defineConfig({...})` object:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
})
```

- [ ] **Step 4: Write failing tests for flag reasons**

Create `src/engine/buildSchedule.test.js`:

```js
import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

const baseGroup = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }
const baseDay = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const baseBlock = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:15', sort_order: 0, part_of_day: 'morning' }

function minimal(overrides = {}) {
  return {
    groups: [baseGroup],
    tiers: [{ id: 't1', name: 'Junior' }],
    days: [baseDay],
    timeBlocks: [baseBlock],
    activities: [],
    anchors: [],
    campId: 'test',
    ...overrides,
  }
}

describe('UNFILLABLE flag', () => {
  it('sets UNFILLABLE_reason when no activities are eligible', () => {
    const { slots } = buildSchedule(minimal({ activities: [] }))
    const unfillable = slots.find(s => s.flags?.UNFILLABLE)
    expect(unfillable).toBeTruthy()
    expect(unfillable.flags.UNFILLABLE_reason).toBe('No eligible activity could be placed in this slot')
  })
})

describe('WEATHER_RISK flag', () => {
  it('sets WEATHER_RISK_reason on outdoor activity slots', () => {
    const act = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: true, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots } = buildSchedule(minimal({ activities: [act] }))
    const weatherSlot = slots.find(s => s.flags?.WEATHER_RISK)
    expect(weatherSlot).toBeTruthy()
    expect(weatherSlot.flags.WEATHER_RISK_reason).toBe('Outdoor activity scheduled in this slot')
  })
})

describe('UNDERSERVED flag', () => {
  it('sets UNDERSERVED_reason with counts when min_per_week cannot be met', () => {
    // 1 block available, min_per_week = 3 → underserved
    const act = { id: 'a1', name: 'Archery', priority: 'low', max_per_week: 5, min_per_week: 3, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const { slots } = buildSchedule(minimal({ activities: [act] }))
    const underservedSlot = slots.find(s => s.flags?.UNDERSERVED)
    expect(underservedSlot).toBeTruthy()
    expect(underservedSlot.flags.UNDERSERVED_reason).toMatch(/Goal: 3×\/wk/)
    expect(underservedSlot.flags.UNDERSERVED_reason).toMatch(/Aleph/)
    expect(underservedSlot.flags.UNDERSERVED_reason).toMatch(/Archery/)
  })
})

describe('DISTRIBUTION flag', () => {
  it('sets DISTRIBUTION_reason when early-week goal not met', () => {
    // 2 days, prefer 2× before day_of_week=2 (Tuesday), but activity placed both Mon+Tue
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const act = { id: 'a1', name: 'Arts', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: 2, prefer_before_day_min: 2 }
    const { slots } = buildSchedule(minimal({ days: [baseDay, day2], activities: [act] }))
    const distSlot = slots.find(s => s.flags?.DISTRIBUTION)
    expect(distSlot).toBeTruthy()
    expect(distSlot.flags.DISTRIBUTION_reason).toMatch(/Goal: 2×/)
    expect(distSlot.flags.DISTRIBUTION_reason).toMatch(/Arts/)
    expect(distSlot.flags.DISTRIBUTION_reason).toMatch(/Aleph/)
  })
})
```

- [ ] **Step 5: Run tests — expect failures**

```bash
cd /home/user/shoresh && npm test
```

Expected: 4 test failures — `_reason` keys don't exist yet.

- [ ] **Step 6: Add `_reason` strings to buildSchedule.js**

Open `src/engine/buildSchedule.js`. Make the following targeted changes:

**Change 1** — UNFILLABLE and WEATHER_RISK reasons (in Pass 3, around line 207):

Replace:
```js
    if (!actId) {
      flags.UNFILLABLE = true
    } else {
      const act = activities.find(a => a.id === actId)
      if (act?.is_outdoor) flags.WEATHER_RISK = true
    }
```

With:
```js
    if (!actId) {
      flags.UNFILLABLE = true
      flags.UNFILLABLE_reason = 'No eligible activity could be placed in this slot'
    } else {
      const act = activities.find(a => a.id === actId)
      if (act?.is_outdoor) {
        flags.WEATHER_RISK = true
        flags.WEATHER_RISK_reason = 'Outdoor activity scheduled in this slot'
      }
    }
```

**Change 2** — UNDERSERVED reasons (around line 229, the loop that marks UNDERSERVED on slots):

Replace:
```js
  for (const u of underserved) {
    for (const slot of resultSlots) {
      if (slot.type === 'activity' && slot.groupId === u.groupId && slot.activityId === u.activityId) {
        slot.flags = { ...slot.flags, UNDERSERVED: true }
      }
    }
  }
```

With:
```js
  for (const u of underserved) {
    const groupName = groupMap.get(u.groupId)?.name || u.groupId
    const act = activities.find(a => a.id === u.activityId)
    const actName = act?.name || u.activityId
    const reason = `Goal: ${u.needed}×/wk — scheduled ${u.got}× (group: ${groupName}, activity: ${actName})`
    for (const slot of resultSlots) {
      if (slot.type === 'activity' && slot.groupId === u.groupId && slot.activityId === u.activityId) {
        slot.flags = { ...slot.flags, UNDERSERVED: true, UNDERSERVED_reason: reason }
      }
    }
  }
```

**Change 3** — DISTRIBUTION reasons (around line 238, the DISTRIBUTION loop):

Replace:
```js
  for (const group of groups) {
    for (const act of activities) {
      if (act.prefer_before_day == null || act.prefer_before_day_min == null) continue
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
      if (targetIdx < 0) continue
      const beforeCount = resultSlots.filter(s =>
        s.type === 'activity' && s.groupId === group.id && s.activityId === act.id &&
        (dayOrder.get(s.dayId) ?? 99) < targetIdx
      ).length
      if (beforeCount < act.prefer_before_day_min) {
        for (const slot of resultSlots) {
          if (slot.type === 'activity' && slot.groupId === group.id && slot.activityId === act.id) {
            slot.flags = { ...slot.flags, DISTRIBUTION: true }
          }
        }
      }
    }
  }
```

With:
```js
  for (const group of groups) {
    for (const act of activities) {
      if (act.prefer_before_day == null || act.prefer_before_day_min == null) continue
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
      if (targetIdx < 0) continue
      const beforeCount = resultSlots.filter(s =>
        s.type === 'activity' && s.groupId === group.id && s.activityId === act.id &&
        (dayOrder.get(s.dayId) ?? 99) < targetIdx
      ).length
      if (beforeCount < act.prefer_before_day_min) {
        const reason = `Goal: ${act.prefer_before_day_min}× before day ${act.prefer_before_day} — only ${beforeCount}× placed (group: ${group.name}, activity: ${act.name})`
        for (const slot of resultSlots) {
          if (slot.type === 'activity' && slot.groupId === group.id && slot.activityId === act.id) {
            slot.flags = { ...slot.flags, DISTRIBUTION: true, DISTRIBUTION_reason: reason }
          }
        }
      }
    }
  }
```

- [ ] **Step 7: Run tests — expect pass**

```bash
cd /home/user/shoresh && npm test
```

Expected: 4 tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json vite.config.js src/engine/buildSchedule.js src/engine/buildSchedule.test.js
git commit -m "feat: add flag reason strings to engine + Vitest setup"
```

---

## Task 2: SlotCell — filter real flags + lock visual

**Files:**
- Modify: `src/components/schedule/SlotCell.jsx`

### Background

SlotCell currently renders dots for every key in `slot.flags`. After Task 1, flags JSONB will contain `_reason` and (later) `_dismissed` keys that should not render as dots. The fix: only render dots for keys present in `FLAG_COLORS`.

This task also adds the locked slot visual styling and new props for the lock interaction (wired in Task 8). Add the props now so the component is ready; the Day view wiring happens in Task 8.

**Locked slot visual spec:**
- Border: `2px solid #E8A020`
- Background: `#FFFBF0`
- Text color: `#7A5100`
- Corner triangle: CSS border trick at top-right of the inner div

- [ ] **Step 1: Update SlotCell exports and props**

Open `src/components/schedule/SlotCell.jsx`. Replace the entire file with:

```jsx
import React from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'

const ACTIVITY_COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']
export const ANCHOR_COLOR = '#A63595'

export const FLAG_COLORS = {
  UNFILLABLE: '#F0585D',
  UNDERSERVED: '#F5A623',
  WEATHER_RISK: '#2F7DE1',
  DISTRIBUTION: '#7DC433',
}

const REAL_FLAG_NAMES = new Set(Object.keys(FLAG_COLORS))

export function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

export const cellTd = { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '8px 6px', verticalAlign: 'top' }

export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit, onLock, onRelease, isLocked, isDndEnabled }) {
  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity' && !isLocked

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id,
    disabled: !canDrag,
    data: { slot },
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${id}`,
    disabled: !isDndEnabled,
    data: { slot },
  })

  const setRef = el => { setDragRef(el); setDropRef(el) }

  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td ref={setRef} style={cellTd} onClick={() => onEdit(slot)}>
        <div style={{
          background: '#F3E8FA',
          border: '1.5px solid #A6359566',
          borderRadius: 8,
          padding: '10px 12px',
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {anchor?.name || 'Anchor'}
          </div>
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return (
      <td ref={setRef} style={emptyTd}>
        <div style={{ background: 'var(--bg)', border: '1.5px dashed #D8C8B8', borderRadius: 8, minHeight: 56, opacity: 0.5 }} />
      </td>
    )
  }

  const flags = slot.flags || {}
  // Only render dots for real flag names (not _reason, _dismissed, etc.)
  const activeFlags = Object.keys(flags).filter(f => REAL_FLAG_NAMES.has(f) && !flags[`${f}_dismissed`])
  const hasFlags = activeFlags.length > 0
  const isOutdoor = flags.WEATHER_RISK && !flags.WEATHER_RISK_dismissed
  const color = activity ? activityColor(actColorIdx) : null
  const isWeatherHighlight = weatherMode && isOutdoor

  function handleClick(e) {
    e.preventDefault()
    if (!activity) { onEdit(slot); return }
    if (isLocked) { onRelease?.(slot); return }
    if (onLock) { onLock(slot); return }
    onEdit(slot)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    onEdit(slot)
  }

  const lockedInnerStyle = {
    background: '#FFFBF0',
    border: '2px solid #E8A020',
    borderRadius: 8,
    padding: '10px 12px',
    minHeight: 56,
    position: 'relative',
    overflow: 'hidden',
  }

  const normalInnerStyle = activity
    ? {
        background: `${color}1E`,
        border: isWeatherHighlight ? `2px solid #2F7DE1` : `1.5px solid ${color}55`,
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        opacity: isDragging ? 0.4 : 1,
        outline: isOver && isDndEnabled ? '2px solid var(--primary)' : 'none',
        outlineOffset: -2,
        position: 'relative',
      }
    : {
        background: 'var(--bg)',
        border: '1.5px dashed #D8C8B8',
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        position: 'relative',
      }

  const innerStyle = isLocked ? lockedInnerStyle : normalInnerStyle

  // Build tooltip: activity name + flag reasons
  const tooltipParts = [activity?.name || 'Unassigned']
  for (const f of activeFlags) {
    if (flags[`${f}_reason`]) tooltipParts.push(flags[`${f}_reason`])
  }
  const tooltipText = tooltipParts.join('\n')

  return (
    <td
      ref={setRef}
      style={{
        ...cellTd,
        cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
      }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={tooltipText}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
    >
      <div style={innerStyle}>
        {/* Amber corner triangle for locked cells */}
        {isLocked && (
          <div style={{
            position: 'absolute', top: 0, right: 0,
            width: 0, height: 0,
            borderTop: '12px solid #E8A020',
            borderLeft: '12px solid transparent',
          }} />
        )}
        <div style={{
          fontSize: 12,
          fontWeight: activity ? 700 : 500,
          color: isLocked ? '#7A5100' : (activity ? color : '#B0A090'),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activity?.name || <span style={{ fontSize: 11 }}>Unassigned</span>}
        </div>
        {hasFlags && !isLocked && (
          <div style={{ display: 'flex', gap: 2, marginTop: 4, flexWrap: 'wrap' }}>
            {activeFlags.map(f => (
              <span
                key={f}
                style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f], display: 'inline-block' }}
                title={flags[`${f}_reason`] || f}
              />
            ))}
          </div>
        )}
      </div>
    </td>
  )
}
```

- [ ] **Step 2: Verify the app still builds**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/schedule/SlotCell.jsx
git commit -m "feat: filter real flags in SlotCell, add lock visual + props"
```

---

## Task 3: FlagDetailModal — reason column + dismiss button

**Files:**
- Modify: `src/components/schedule/FlagDetailModal.jsx`

### Background

Each `rows` entry needs:
- A `reason` field (from `flags.FLAGNAME_reason` on the slot)
- A `slotIds` array (slot IDs affected — one for UNFILLABLE/WEATHER_RISK, all matching slots for UNDERSERVED/DISTRIBUTION)

The Dismiss button calls `onDismiss(slotIds, flagName)` passed from ScheduleScreen.

The modal must also filter out already-dismissed rows (where `flags.FLAGNAME_dismissed === true`).

- [ ] **Step 1: Replace FlagDetailModal.jsx**

Write the following to `src/components/schedule/FlagDetailModal.jsx`:

```jsx
import React from 'react'
import { FLAG_COLORS } from './SlotCell'
import { S } from '../../styles/shared'

const FLAG_DESCRIPTIONS = {
  UNFILLABLE: 'No eligible activity could be placed — the slot was left empty.',
  UNDERSERVED: 'Activity was scheduled fewer times than its minimum per week.',
  WEATHER_RISK: 'Outdoor activity — will be affected by weather.',
  DISTRIBUTION: 'Activity did not meet its early-week distribution preference.',
}

export default function FlagDetailModal({ flag, slots, groups, days, timeBlocks, activities, onDismiss, onClose }) {
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]))
  const dayMap = Object.fromEntries(days.map(d => [d.id, d.label]))
  const blockMap = Object.fromEntries(timeBlocks.map(b => [b.id, b.name]))
  const actMap = Object.fromEntries(activities.map(a => [a.id, a]))

  // Only include slots where flag is set AND not dismissed
  const flaggedSlots = slots.filter(s => s.flags?.[flag] && !s.flags?.[`${flag}_dismissed`])

  let rows = []

  if (flag === 'UNFILLABLE') {
    rows = flaggedSlots.map(s => ({
      col1: groupMap[s.group_id] || '?',
      col2: dayMap[s.day_id] || '?',
      col3: blockMap[s.time_block_id] || '?',
      col4: 'No eligible activity',
      reason: s.flags?.[`${flag}_reason`] || '',
      slotIds: [s.id],
    }))
  } else if (flag === 'UNDERSERVED') {
    const seen = new Set()
    for (const s of flaggedSlots) {
      if (!s.activity_id) continue
      const key = `${s.group_id}|${s.activity_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const act = actMap[s.activity_id]
      const scheduled = slots.filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id).length
      const matchingSlotIds = flaggedSlots
        .filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id)
        .map(x => x.id)
      rows.push({
        col1: groupMap[s.group_id] || '?',
        col2: act?.name || '?',
        col3: `${scheduled} / ${act?.min_per_week ?? '?'} needed`,
        col4: '',
        reason: s.flags?.[`${flag}_reason`] || '',
        slotIds: matchingSlotIds,
      })
    }
  } else if (flag === 'WEATHER_RISK') {
    rows = flaggedSlots.map(s => ({
      col1: groupMap[s.group_id] || '?',
      col2: dayMap[s.day_id] || '?',
      col3: blockMap[s.time_block_id] || '?',
      col4: actMap[s.activity_id]?.name || '?',
      reason: s.flags?.[`${flag}_reason`] || '',
      slotIds: [s.id],
    }))
  } else if (flag === 'DISTRIBUTION') {
    const seen = new Set()
    for (const s of flaggedSlots) {
      if (!s.activity_id) continue
      const key = `${s.group_id}|${s.activity_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const act = actMap[s.activity_id]
      const matchingSlotIds = flaggedSlots
        .filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id)
        .map(x => x.id)
      rows.push({
        col1: groupMap[s.group_id] || '?',
        col2: act?.name || '?',
        col3: `Prefer ${act?.prefer_before_day_min ?? '?'}× before day ${act?.prefer_before_day ?? '?'}`,
        col4: '',
        reason: s.flags?.[`${flag}_reason`] || '',
        slotIds: matchingSlotIds,
      })
    }
  }

  const headers = {
    UNFILLABLE:   ['Group', 'Day', 'Block', 'Reason'],
    UNDERSERVED:  ['Group', 'Activity', 'Scheduled / Min', ''],
    WEATHER_RISK: ['Group', 'Day', 'Block', 'Activity'],
    DISTRIBUTION: ['Group', 'Activity', 'Preference', ''],
  }[flag] || ['Col 1', 'Col 2', 'Col 3', 'Col 4']

  const color = FLAG_COLORS[flag] || '#ccc'

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, width: 640 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {flag.replace('_', ' ')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{FLAG_DESCRIPTIONS[flag]}</div>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color }}>{rows.length}</span>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No issues found.</div>
        ) : (
          <div style={{ overflowY: 'auto', maxHeight: 380, border: '1px solid var(--border)', borderRadius: 6, marginTop: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                  {headers.filter(h => h).map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Reason</th>
                  {onDismiss && <th style={{ padding: '7px 12px', width: 80 }} />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '' : 'var(--bg)' }}>
                    <td style={{ padding: '7px 12px', fontWeight: 500 }}>{r.col1}</td>
                    <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.col2}</td>
                    <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.col3}</td>
                    {r.col4 !== '' && <td style={{ padding: '7px 12px', fontSize: 12 }}>{r.col4}</td>}
                    <td style={{ padding: '7px 12px', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 180, whiteSpace: 'normal', lineHeight: 1.4 }}>{r.reason}</td>
                    {onDismiss && (
                      <td style={{ padding: '7px 12px' }}>
                        <button
                          onClick={() => onDismiss(r.slotIds, flag)}
                          style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', background: 'none', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', padding: '3px 8px', fontFamily: 'inherit' }}
                        >
                          Dismiss
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={S.btnPrimary}>Close</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/schedule/FlagDetailModal.jsx
git commit -m "feat: add reason column and dismiss button to FlagDetailModal"
```

---

## Task 4: ScheduleScreen — dismiss handler + stats fix

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

### Background

Two changes:
1. `recalcStats` currently counts all flag keys including `_reason` and `_dismissed`. Fix it to count only active real flags.
2. Add `dismissFlag(slotIds, flagName)` that writes `FLAGNAME_dismissed: true` to each slot in Supabase and updates local state.
3. Pass `onDismiss` to `FlagDetailModal`.
4. The stats bar counts (Unfillable, Underserved, Weather Risk, Distribution) should all exclude dismissed slots.

**Real flag names:** `UNFILLABLE`, `UNDERSERVED`, `WEATHER_RISK`, `DISTRIBUTION`

- [ ] **Step 1: Fix recalcStats in ScheduleScreen.jsx**

Find the `recalcStats` function (around line 79) and replace it:

```js
  const REAL_FLAGS = ['UNFILLABLE', 'UNDERSERVED', 'WEATHER_RISK', 'DISTRIBUTION']

  function recalcStats(slotList) {
    const unfillable = slotList.filter(s => s.flags?.UNFILLABLE && !s.flags?.UNFILLABLE_dismissed).length
    const underserved = slotList.filter(s => s.flags?.UNDERSERVED && !s.flags?.UNDERSERVED_dismissed).length
    const open = slotList.filter(s => s.is_anchor === false).length
    const filled = slotList.filter(s => s.is_anchor === false && s.activity_id).length
    setStats({ open, filled, unfillable, underserved })
  }
```

Note: `recalcStats` is called with `(saved, loadedActivities)` in two places — remove the second `actList` parameter since it's unused. Find both call sites:
- Line 71: `recalcStats(saved, loadedActivities)` → change to `recalcStats(saved)`
- Line 123: `recalcStats(freshSlots || [], activities)` → change to `recalcStats(freshSlots || [])`

- [ ] **Step 2: Add dismissFlag function**

Add this function after `swapSlots` (around line 168):

```js
  async function dismissFlag(slotIds, flagName) {
    const updates = slotIds.map(id => {
      const slot = slots.find(s => s.id === id)
      if (!slot) return null
      const newFlags = { ...(slot.flags || {}), [`${flagName}_dismissed`]: true }
      return { id, newFlags }
    }).filter(Boolean)

    await Promise.all(updates.map(({ id, newFlags }) =>
      supabase.from('template_slots').update({ flags: newFlags }).eq('id', id)
    ))

    setSlots(prev => prev.map(s => {
      const u = updates.find(u => u.id === s.id)
      return u ? { ...s, flags: u.newFlags } : s
    }))
  }
```

- [ ] **Step 3: Fix the stats bar to use per-flag dismissed check**

Find the stats bar section (around line 307) and update the Weather Risk and Distribution counts:

```jsx
          <StatBadge label="Filled" value={`${stats.filled}/${stats.open}`} color="var(--success)" />
          <StatBadge label="Unfillable" value={stats.unfillable} color={stats.unfillable > 0 ? '#F0585D' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNFILLABLE')} />
          <StatBadge label="Underserved" value={stats.underserved} color={stats.underserved > 0 ? '#F5A623' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNDERSERVED')} />
          <StatBadge label="Weather Risk" value={slots.filter(s => s.flags?.WEATHER_RISK && !s.flags?.WEATHER_RISK_dismissed).length} color="#2F7DE1" onClick={() => setActiveFlag('WEATHER_RISK')} />
          <StatBadge label="Distribution" value={slots.filter(s => s.flags?.DISTRIBUTION && !s.flags?.DISTRIBUTION_dismissed).length} color="#7DC433" onClick={() => setActiveFlag('DISTRIBUTION')} />
```

- [ ] **Step 4: Pass onDismiss to FlagDetailModal**

Find the FlagDetailModal usage (around line 587) and add the `onDismiss` prop:

```jsx
      {activeFlag && (
        <FlagDetailModal
          flag={activeFlag}
          slots={slots}
          groups={groups}
          days={days}
          timeBlocks={timeBlocks}
          activities={activities}
          onDismiss={dismissFlag}
          onClose={() => setActiveFlag(null)}
        />
      )}
```

- [ ] **Step 5: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: flag dismiss handler + stats exclude dismissed flags"
```

---

## Task 5: DB schema — lock columns

**Files:**
- No source files — SQL run against Supabase

### Background

Add `is_locked boolean DEFAULT false` to `activities` and `is_released boolean DEFAULT false` to `template_slots`. These columns default to `false` so existing data needs no migration.

- [ ] **Step 1: Run SQL in Supabase dashboard**

Go to Supabase project → SQL Editor → run:

```sql
ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT false;
ALTER TABLE template_slots ADD COLUMN IF NOT EXISTS is_released boolean DEFAULT false;
```

- [ ] **Step 2: Verify columns exist**

Run in SQL Editor:

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('activities', 'template_slots')
  AND column_name IN ('is_locked', 'is_released');
```

Expected: 2 rows returned (`activities.is_locked` and `template_slots.is_released`, both `boolean`, default `false`).

- [ ] **Step 3: Commit a note** (no code change, just mark done)

```bash
git commit --allow-empty -m "chore: DB schema — added is_locked to activities, is_released to template_slots"
```

---

## Task 6: Engine — lock pre-placement

**Files:**
- Modify: `src/engine/buildSchedule.js`
- Modify: `src/engine/buildSchedule.test.js`

### Background

The engine accepts a new optional `preplacedSlots` array: `[{ groupId, dayId, blockId, activityId }]`. These represent locked activity slots from the previous schedule. The engine pre-populates `assigned`, `usageCount`, and `locationUsage` with these before Pass 2, and excludes those grid positions from `openSlots`.

- [ ] **Step 1: Write failing tests for lock pre-placement**

Add to `src/engine/buildSchedule.test.js`:

```js
describe('preplacedSlots (locking)', () => {
  it('keeps a preplaced slot even when another activity would be preferred', () => {
    const swim = { id: 'a1', name: 'Swimming', priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const arch = { id: 'a2', name: 'Archery', priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'a2' }]
    const { slots } = buildSchedule(minimal({ activities: [swim, arch], preplacedSlots: preplaced }))
    const slot = slots.find(s => s.groupId === 'g1' && s.dayId === 'd1' && s.blockId === 'b1')
    expect(slot?.activityId).toBe('a2')
  })

  it('counts preplaced slots toward usageCount', () => {
    // max_per_week = 1, preplaced once — should not appear again in a second block
    const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
    const block2 = { id: 'b2', name: 'Afternoon', start_time: '14:00', end_time: '15:30', sort_order: 1, part_of_day: 'afternoon' }
    const swim = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 1, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    const preplaced = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'a1' }]
    const { slots } = buildSchedule(minimal({ days: [baseDay, day2], timeBlocks: [baseBlock, block2], activities: [swim], preplacedSlots: preplaced }))
    const swimSlots = slots.filter(s => s.activityId === 'a1')
    expect(swimSlots.length).toBe(1) // only the preplaced one
  })

  it('ignores preplacedSlots param when undefined', () => {
    const act = { id: 'a1', name: 'Swimming', priority: 'low', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
    expect(() => buildSchedule(minimal({ activities: [act] }))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests — expect 2 new failures + 4 passing**

```bash
cd /home/user/shoresh && npm test
```

Expected: 4 pass (from Task 1), 2 fail (preplaced tests), 1 pass (undefined preplacedSlots since it doesn't throw yet but might).

- [ ] **Step 3: Implement preplacedSlots in buildSchedule.js**

Update the function signature and add pre-placement logic.

**Change 1** — function signature (line 23):

```js
function buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId = '', preplacedSlots = [] }) {
```

**Change 2** — after Pass 1 grid mapping and before `runRound` (after the `openSlots` loop, before `runRound` is defined), add pre-placement initialization. Insert this block right after the `openSlots.push(...)` loop closes (around line 86), replacing the blank line before `// ── Pass 2`:

```js
  // ── Pre-place locked slots ───────────────────────────────────────────────
  // Initialize assigned/usageCount/locationUsage with preplaced entries
  // so Pass 2 respects locks and doesn't double-schedule.
```

Actually, `assigned`, `usageCount`, `locationUsage` are declared inside Pass 2. Move the pre-placement initialization to just after those declarations (after line 91 `const locationUsage = new Map()`). Insert:

```js
  // Pre-place locked slots before Pass 2 scoring
  for (const pre of preplacedSlots) {
    const key = `${pre.groupId}|${pre.dayId}|${pre.blockId}`
    if (!assigned.has(key)) {
      assigned.set(key, pre.activityId)
      incCount(pre.groupId, pre.activityId)
      const act = activities.find(a => a.id === pre.activityId)
      if (act?.location) {
        const lk = locationKey(act.location, pre.dayId, pre.blockId)
        const group = groupMap.get(pre.groupId)
        const list = locationUsage.get(lk) || []
        list.push({ groupId: pre.groupId, tierId: group?.tier_id })
        locationUsage.set(lk, list)
      }
    }
  }
```

The exact insertion point: in `buildSchedule.js`, find `const locationUsage = new Map()` (line ~91) and insert the pre-placement loop right after it, before `function getCount`.

**Change 3** — Pass 3 audit: preplaced slots produce activity slots, not open slots. They're already in `openSlots` if they were in the grid (they are — they were added to `openSlots` before the pre-placement), so they'll get picked up naturally. But we need to ensure they get type 'activity' with the correct activityId. The existing code at Pass 3 does:

```js
const actId = assigned.get(`${os.groupId}|${os.dayId}|${os.blockId}`) || null
```

Since pre-placed slots are in `assigned`, this already works. No additional change needed for Pass 3.

- [ ] **Step 4: Run tests — expect all pass**

```bash
cd /home/user/shoresh && npm test
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/buildSchedule.js src/engine/buildSchedule.test.js
git commit -m "feat: engine accepts preplacedSlots for locked activities"
```

---

## Task 7: ScheduleScreen — lock and release handlers

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

### Background

Two new async functions:
- `lockActivity(activityId)` — sets `activities.is_locked = true` in DB and local state
- `releaseCell(slotId)` — sets `template_slots.is_released = true` in DB and local state

Also: before calling `buildSchedule`, compute `preplacedSlots` from locked activities (excluding released cells).

Also: reload `is_released` from DB slots after regen (the column is now in the schema, Supabase select `*` will return it automatically).

- [ ] **Step 1: Add lockActivity and releaseCell functions**

Add after the `dismissFlag` function:

```js
  async function lockActivity(activityId) {
    await supabase.from('activities').update({ is_locked: true }).eq('id', activityId)
    setActivities(prev => prev.map(a => a.id === activityId ? { ...a, is_locked: true } : a))
  }

  async function releaseCell(slotId) {
    await supabase.from('template_slots').update({ is_released: true }).eq('id', slotId)
    setSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_released: true } : s))
  }
```

- [ ] **Step 2: Compute preplacedSlots and pass to buildSchedule**

Find the `generate()` function (around line 89). Update it to compute and pass `preplacedSlots`:

```js
  async function generate() {
    setGenerating(true)

    // Collect locked slots (activity is locked, cell not released)
    const lockedActIds = new Set(activities.filter(a => a.is_locked).map(a => a.id))
    const preplacedSlots = slots
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_anchor)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))

    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })

    // ... rest of generate() unchanged
```

- [ ] **Step 3: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: lockActivity + releaseCell handlers, pass preplacedSlots to engine"
```

---

## Task 8: SlotCell lock wiring — Day view click behavior

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

### Background

Wire up the lock/release interaction in the Day view only. Group view keeps click-to-edit. Activity view has no slot click interactions.

For each SlotCell in Day view:
- Compute `isLocked`: activity has `is_locked` AND this specific slot is NOT `is_released`
- Pass `isLocked`, `onLock`, `onRelease`, and also include `id` in the slot object so `releaseCell` can use it

The slot object passed to SlotCell in Day view currently doesn't include `slot.id`. Add it.

- [ ] **Step 1: Update Day view SlotCell rendering**

Find the Day view's SlotCell usage (around line 431 in ScheduleScreen.jsx). Replace it:

```jsx
                        {groups.map(group => {
                        const slot = getSlot(group.id, selectedDay, block.id)
                        if (!slot) return <td key={group.id} style={emptyTd} />
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        const actIsLocked = slot.activity_id && act?.is_locked
                        const isLocked = Boolean(actIsLocked && !slot.is_released)
                        return (
                          <SlotCell
                            key={group.id}
                            slot={slot.is_anchor
                              ? { ...slot, id: slot.id, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }
                              : { ...slot, id: slot.id, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            anchor={anchor}
                            actColorIdx={act?.colorIdx || 0}
                            weatherMode={weatherMode}
                            onEdit={s => setEditSlot(s)}
                            onLock={s => lockActivity(s.activity_id)}
                            onRelease={s => releaseCell(s.id)}
                            isLocked={isLocked}
                            isDndEnabled={!isLocked}
                          />
                        )
                      })}
```

- [ ] **Step 2: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: wire lock/release click in Day view SlotCell"
```

---

## Task 9: DB schema — snapshots table

**Files:**
- No source files — SQL run against Supabase

- [ ] **Step 1: Run SQL in Supabase dashboard**

```sql
CREATE TABLE IF NOT EXISTS schedule_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  name        text,
  is_auto     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  slots       jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS schedule_snapshots_template_time_idx
  ON schedule_snapshots (template_id, created_at DESC);
```

- [ ] **Step 2: Verify table exists**

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'schedule_snapshots'
ORDER BY ordinal_position;
```

Expected: 6 rows (id, template_id, name, is_auto, created_at, slots).

- [ ] **Step 3: Commit a note**

```bash
git commit --allow-empty -m "chore: DB schema — created schedule_snapshots table"
```

---

## Task 10: VersionsDropdown component

**Files:**
- Create: `src/components/schedule/VersionsDropdown.jsx`

### Background

A dropdown panel toggled by a "Versions ▾" button in the topbar. When open, it lists snapshots newest-first. Auto-saves show "Auto-save" in italic + timestamp. Named snapshots show name + timestamp. Current snapshot has a "current" badge and no Restore button. A footer has a name input + "Save as named version" button.

Props:
```
snapshots: Array<{ id, template_id, name, is_auto, created_at, slots }>
isOpen: boolean
onToggle: () => void
onRestore: (snapshot) => void
onSaveNamed: (name: string) => void
onRenameAutoSave: (snapshotId, newName) => void
```

The "current" snapshot is `snapshots[0]` (most recently created).

- [ ] **Step 1: Create VersionsDropdown.jsx**

Create `src/components/schedule/VersionsDropdown.jsx`:

```jsx
import React, { useState, useRef, useEffect } from 'react'
import { S } from '../../styles/shared'

function formatTime(isoString) {
  const d = new Date(isoString)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (isToday) return `today ${timeStr}`
  if (isYesterday) return `yesterday ${timeStr}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr
}

export default function VersionsDropdown({ snapshots, isOpen, onToggle, onRestore, onSaveNamed, onRenameAutoSave }) {
  const [nameInput, setNameInput] = useState('')
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const dropRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) onToggle()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onToggle])

  const btnStyle = {
    padding: '6px 12px',
    border: `1px solid ${isOpen ? '#E8A020' : 'var(--border)'}`,
    borderRadius: 6,
    background: isOpen ? '#FFF3DC' : 'var(--surface)',
    color: isOpen ? '#9A6200' : 'var(--text)',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    position: 'relative',
  }

  return (
    <div ref={dropRef} style={{ position: 'relative' }}>
      <button onClick={onToggle} style={btnStyle}>
        📋 Versions ▾
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 8px 24px rgba(0,0,0,0.10)', width: 320, overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 15, fontWeight: 600 }}>Version History</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Auto-saved before each regeneration</div>
          </div>

          {/* Snapshot list */}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {snapshots.length === 0 && (
              <div style={{ padding: '16px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>No versions saved yet.</div>
            )}
            {snapshots.map((snap, i) => {
              const isCurrent = i === 0
              const isRenaming = renamingId === snap.id

              return (
                <div key={snap.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px',
                  borderBottom: '1px solid var(--border)',
                  background: isCurrent ? '#00ADBB08' : undefined,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isRenaming ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && renameValue.trim()) {
                              onRenameAutoSave(snap.id, renameValue.trim())
                              setRenamingId(null)
                            }
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          style={{ ...S.input, padding: '3px 6px', fontSize: 12, width: '100%' }}
                          placeholder="Version name…"
                        />
                        <button
                          onClick={() => {
                            if (renameValue.trim()) onRenameAutoSave(snap.id, renameValue.trim())
                            setRenamingId(null)
                          }}
                          style={{ ...S.btnPrimary, padding: '3px 8px', fontSize: 11 }}
                        >Save</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 600, color: snap.is_auto ? 'var(--text-secondary)' : 'var(--text)', fontStyle: snap.is_auto ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {snap.is_auto ? 'Auto-save' : snap.name}
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>
                          {formatTime(snap.created_at)}
                        </div>
                      </>
                    )}
                  </div>

                  {isCurrent && !isRenaming && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: '#00ADBB14', padding: '2px 6px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                      current
                    </span>
                  )}

                  {!isCurrent && !isRenaming && snap.is_auto && (
                    <button
                      onClick={() => { setRenamingId(snap.id); setRenameValue('') }}
                      style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      rename
                    </button>
                  )}

                  {!isCurrent && !isRenaming && (
                    <button
                      onClick={() => { onRestore(snap); onToggle() }}
                      style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 6px', borderRadius: 5, fontFamily: 'inherit' }}
                    >
                      Restore
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Save footer */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && nameInput.trim()) {
                  onSaveNamed(nameInput.trim())
                  setNameInput('')
                }
              }}
              style={{ ...S.input, fontSize: 12, marginBottom: 6 }}
              placeholder="Name current version…"
            />
            <button
              onClick={() => { if (nameInput.trim()) { onSaveNamed(nameInput.trim()); setNameInput('') } }}
              disabled={!nameInput.trim()}
              style={{ width: '100%', padding: 6, borderRadius: 7, background: nameInput.trim() ? 'var(--primary)' : 'var(--border)', color: nameInput.trim() ? '#fff' : 'var(--text-secondary)', border: 'none', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: nameInput.trim() ? 'pointer' : 'default' }}
            >
              Save as named version
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/schedule/VersionsDropdown.jsx
git commit -m "feat: VersionsDropdown component"
```

---

## Task 11: ScheduleScreen — snapshot integration

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

### Background

Four changes:
1. Add `snapshots` and `showVersions` state
2. Load snapshots from `schedule_snapshots` in `loadAll()`
3. Add `saveSnapshot(name, isAuto)`, `restoreSnapshot(snapshot)`, `renameSnapshot(id, newName)` functions
4. Auto-save before every regeneration in `generate()`
5. Wire `VersionsDropdown` into the controls bar
6. Import `VersionsDropdown`

- [ ] **Step 1: Add state and import**

At the top of `ScheduleScreen.jsx`, add the import:

```js
import VersionsDropdown from '../components/schedule/VersionsDropdown'
```

Add to the state declarations (after `templateError`):

```js
  const [snapshots, setSnapshots] = useState([])
  const [showVersions, setShowVersions] = useState(false)
```

- [ ] **Step 2: Load snapshots in loadAll()**

In the `loadAll()` function, inside the `try` block that loads `schedule_templates` (around line 64), add snapshot loading after loading `slotData`:

```js
      if (tmpl) {
        setTemplateId(tmpl.id)
        const { data: slotData } = await supabase.from('template_slots').select('*').eq('template_id', tmpl.id)
        const saved = slotData || []
        setSlots(saved)
        recalcStats(saved)

        const { data: snapData } = await supabase
          .from('schedule_snapshots')
          .select('id, template_id, name, is_auto, created_at')
          .eq('template_id', tmpl.id)
          .order('created_at', { ascending: false })
        setSnapshots(snapData || [])
      }
```

Note: we select only metadata columns (no `slots` JSONB) for the list — fetch full `slots` only on restore.

- [ ] **Step 3: Add saveSnapshot, restoreSnapshot, renameSnapshot**

Add these three functions after `releaseCell`:

```js
  async function saveSnapshot(name, isAuto) {
    if (!templateId) return
    const snapSlots = slots.map(s => ({
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor,
      flags: s.flags || {},
    }))
    const { data: snap } = await supabase
      .from('schedule_snapshots')
      .insert({ template_id: templateId, name: name || null, is_auto: isAuto, slots: snapSlots })
      .select('id, template_id, name, is_auto, created_at')
      .single()
    if (snap) setSnapshots(prev => [snap, ...prev])
  }

  async function restoreSnapshot(snapshot) {
    if (!templateId) return
    // Fetch full slots from the snapshot
    const { data: fullSnap } = await supabase
      .from('schedule_snapshots')
      .select('slots')
      .eq('id', snapshot.id)
      .single()
    if (!fullSnap?.slots) return

    await supabase.from('template_slots').delete().eq('template_id', templateId)

    const rows = fullSnap.slots.map(s => ({
      template_id: templateId,
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor,
      flags: s.flags || {},
    }))

    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('template_slots').insert(rows.slice(i, i + 500))
    }

    const { data: freshSlots } = await supabase.from('template_slots').select('*').eq('template_id', templateId)
    setSlots(freshSlots || [])
    recalcStats(freshSlots || [])
  }

  async function renameSnapshot(snapshotId, newName) {
    await supabase.from('schedule_snapshots').update({ name: newName, is_auto: false }).eq('id', snapshotId)
    setSnapshots(prev => prev.map(s => s.id === snapshotId ? { ...s, name: newName, is_auto: false } : s))
  }
```

- [ ] **Step 4: Auto-save before regen in generate()**

Update the `generate()` function to auto-save before deleting slots. Find the line `// Delete existing slots` (around line 101) and insert before it:

```js
    // Auto-save current schedule before overwriting
    if (slots.length > 0) {
      await saveSnapshot(null, true)
    }
```

The full updated `generate()` function looks like:

```js
  async function generate() {
    setGenerating(true)

    const lockedActIds = new Set(activities.filter(a => a.is_locked).map(a => a.id))
    const preplacedSlots = slots
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_anchor)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))

    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })

    let tid = templateId
    if (!tid) {
      const { data } = await supabase.from('schedule_templates').insert({ camp_id: campId, name: 'Master Template' }).select('id').single()
      tid = data.id
      setTemplateId(tid)
    }

    // Auto-save current schedule before overwriting
    if (slots.length > 0) {
      await saveSnapshot(null, true)
    }

    await supabase.from('template_slots').delete().eq('template_id', tid)

    const rows = result.slots.map(s => ({
      template_id: tid,
      group_id: s.groupId,
      day_id: s.dayId,
      time_block_id: s.blockId,
      activity_id: s.activityId,
      anchor_id: s.anchorId,
      is_anchor: s.type === 'anchor',
      flags: s.flags || {},
    }))

    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('template_slots').insert(rows.slice(i, i + 500))
    }

    const { data: freshSlots } = await supabase.from('template_slots').select('*').eq('template_id', tid)
    setSlots(freshSlots || [])
    recalcStats(freshSlots || [])
    setGenerating(false)
  }
```

- [ ] **Step 5: Wire VersionsDropdown into controls bar**

Find the controls bar section (around line 269, `{hasSchedule && ...}`). Add the `VersionsDropdown` between the weather toggle and the Export button:

```jsx
        {hasSchedule && (
          <>
            {/* View toggle */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
              {[['group','Group View'],['day','Daily View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)', background: view === v ? 'var(--surface)' : 'none', color: view === v ? 'var(--text)' : 'var(--text-secondary)', boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>{label}</button>
              ))}
            </div>

            {/* Weather toggle */}
            <button
              onClick={() => setWeatherMode(w => !w)}
              style={{ padding: '6px 14px', border: `1px solid ${weatherMode ? '#2F7DE1' : 'var(--border)'}`, borderRadius: 6, background: weatherMode ? '#EEF4FD' : 'var(--surface)', color: weatherMode ? '#2F7DE1' : 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
            >
              ⛅ Weather Mode {weatherMode ? 'ON' : 'OFF'}
            </button>

            <div style={{ flex: 1 }} />

            {/* Versions dropdown */}
            <VersionsDropdown
              snapshots={snapshots}
              isOpen={showVersions}
              onToggle={() => setShowVersions(v => !v)}
              onRestore={restoreSnapshot}
              onSaveNamed={name => saveSnapshot(name, false)}
              onRenameAutoSave={renameSnapshot}
            />

            <button onClick={exportToExcel} style={S.btnSecondary}>Export to Excel</button>
            <button onClick={() => setConfirmRegen(true)} style={S.btnDanger}>Regenerate from Scratch</button>
          </>
        )}
```

- [ ] **Step 6: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 7: Run all tests**

```bash
cd /home/user/shoresh && npm test
```

Expected: 7 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/screens/ScheduleScreen.jsx src/components/schedule/VersionsDropdown.jsx
git commit -m "feat: snapshot save/restore + VersionsDropdown + auto-save before regen"
```

---

## Task 12: Push and wrap up

- [ ] **Step 1: Push to development branch**

```bash
git push -u origin claude/intelligent-hopper-QaSJ3
```

- [ ] **Step 2: Verify all tests still pass**

```bash
cd /home/user/shoresh && npm test
```

Expected: 7 tests pass.

- [ ] **Step 3: Final build check**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -10
```

Expected: Build succeeds, no errors.
