# Shoresh UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace IBM Plex fonts and cold neutral colors with Fredoka + Nunito fonts and a warm sandy palette, and redesign the schedule Day view axis (rows = days, columns = groups, time block selector at top), making spacious rounded slot cells throughout.

**Architecture:** CSS variables and shared style tokens (`S.*`) flow to all screens automatically — changing them + the font import covers most of the visual update. The schedule Day view needs a structural JSX change (axis flip + state rename). SlotCell gets a new inner-div rendering pattern for spacious rounded cells.

**Tech Stack:** React 19, Vite 8, inline styles, `src/styles/shared.js` for shared tokens, Google Fonts via `index.html` link tag.

---

## File Map

| File | Change |
|---|---|
| `index.html` | Replace IBM Plex font links with Fredoka + Nunito + keep Mono |
| `src/index.css` | Update CSS variables (colors, fonts) |
| `src/styles/shared.js` | Update all S.* tokens (borderRadius, fontFamily, fontWeight) |
| `src/components/schedule/SlotCell.jsx` | Spacious inner-div cell design |
| `src/components/schedule/StatBadge.jsx` | Warm surface background |
| `src/screens/ScheduleScreen.jsx` | Day view axis flip, view toggle pill style, warm container styles |
| `src/screens/GroupsScreen.jsx` | Table container radius, modal radius, empty state |
| `src/screens/TiersScreen.jsx` | Table container radius, modal radius, empty state |
| `src/screens/TimeBlocksScreen.jsx` | Table container radius, empty state |
| `src/screens/ActivitiesScreen.jsx` | Table container radius, modal radius, empty state |
| `src/screens/AnchorsScreen.jsx` | Table container radius, empty state |
| `src/screens/CampSetup.jsx` | Container radius |

---

### Task 1: Font Import & CSS Variables

**Files:**
- Modify: `index.html`
- Modify: `src/index.css`

- [ ] **Step 1: Update font links in index.html**

Replace the single `<link>` for Google Fonts with these two lines (keep IBM Plex Mono, drop IBM Plex Sans and Condensed, add Fredoka and Nunito):

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

The full `<head>` section should look like:
```html
<head>
  <meta charset="UTF-8" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Shoresh</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
```

- [ ] **Step 2: Update CSS variables in src/index.css**

Replace the entire file with:

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #FAF6F0;
  --surface: #FFFCF8;
  --surface-elevated: #FFF8F0;
  --primary: #00ADBB;
  --primary-dark: #008a96;
  --secondary: #2F7DE1;
  --success: #00AA59;
  --warning: #F0585D;
  --purple: #A63595;
  --yellow-green: #7DC433;
  --text: #2D1F12;
  --text-secondary: #7A6152;
  --border: #E8DDD0;

  --font-sans: 'Nunito', sans-serif;
  --font-condensed: 'Fredoka', sans-serif;
  --font-mono: 'IBM Plex Mono', monospace;
}

html, body, #root {
  height: 100%;
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

button { cursor: pointer; font-family: inherit; }
input, select, textarea { font-family: inherit; }
a { text-decoration: none; color: inherit; }
```

- [ ] **Step 3: Verify build compiles**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: `✓ built in` — no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/user/shoresh && git add index.html src/index.css && git commit -m "style: warm color palette and Fredoka/Nunito fonts"
```

---

### Task 2: Shared Style Tokens

**Files:**
- Modify: `src/styles/shared.js`

- [ ] **Step 1: Replace the entire S object**

Replace the full contents of `src/styles/shared.js` with:

```javascript
// Shared inline style constants — import as: import { S } from '../styles/shared'
export const S = {
  btnPrimary: {
    padding: '7px 14px',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnSecondary: {
    padding: '7px 14px',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnDanger: {
    padding: '7px 14px',
    background: 'none',
    color: 'var(--warning)',
    border: '1px solid var(--warning)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  th: {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 12,
    fontFamily: 'var(--font-condensed)',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  td: {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 13,
  },
  input: {
    padding: '8px 10px',
    border: '1.5px solid var(--border)',
    borderRadius: 7,
    fontSize: 13,
    outline: 'none',
    background: 'var(--surface)',
    width: '100%',
    fontFamily: 'inherit',
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    display: 'block',
    marginBottom: 4,
  },
  modalSm: {
    background: 'var(--surface-elevated)',
    borderRadius: 12,
    padding: 28,
    maxWidth: 400,
    width: '100%',
  },
  modalLg: {
    background: 'var(--surface-elevated)',
    borderRadius: 12,
    padding: 28,
    width: 480,
    maxWidth: '100%',
    maxHeight: '90vh',
    overflowY: 'auto',
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
  },
  errorBanner: {
    background: '#fff5f5',
    border: '1px solid #f5c6c6',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 13,
    color: 'var(--warning)',
  },
}
```

- [ ] **Step 2: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: `✓ built in` — no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/user/shoresh && git add src/styles/shared.js && git commit -m "style: update shared S tokens to warm rounded design"
```

---

### Task 3: Spacious Slot Cells

**Files:**
- Modify: `src/components/schedule/SlotCell.jsx`

The current design puts color styling directly on the `<td>`. The new design wraps content in an inner `<div>` with rounded corners, full-border, and min-height 56px. The `<td>` itself gets minimal padding.

- [ ] **Step 1: Replace the full contents of SlotCell.jsx**

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

export function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

export const cellTd = { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '8px 6px', verticalAlign: 'top' }

export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit, isDndEnabled }) {
  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity'

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
  const hasFlags = Object.keys(flags).length > 0
  const isOutdoor = flags.WEATHER_RISK
  const color = activity ? activityColor(actColorIdx) : null
  const isWeatherHighlight = weatherMode && isOutdoor

  const innerStyle = activity
    ? {
        background: `${color}1E`,
        border: isWeatherHighlight ? `2px solid #2F7DE1` : `1.5px solid ${color}55`,
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        opacity: isDragging ? 0.4 : 1,
        outline: isOver && isDndEnabled ? '2px solid var(--primary)' : 'none',
        outlineOffset: -2,
      }
    : {
        background: 'var(--bg)',
        border: '1.5px dashed #D8C8B8',
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
      }

  return (
    <td
      ref={setRef}
      style={{
        ...cellTd,
        cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
      }}
      onClick={() => onEdit(slot)}
      title={activity?.name || 'Empty — click to assign'}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
    >
      <div style={innerStyle}>
        <div style={{
          fontSize: 12,
          fontWeight: activity ? 700 : 500,
          color: activity ? color : '#B0A090',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activity?.name || <span style={{ fontSize: 11 }}>Unassigned</span>}
        </div>
        {hasFlags && (
          <div style={{ display: 'flex', gap: 2, marginTop: 4, flexWrap: 'wrap' }}>
            {Object.keys(flags).map(f => (
              <span key={f} style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f] || '#ccc', display: 'inline-block' }} title={f} />
            ))}
          </div>
        )}
      </div>
    </td>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: `✓ built in` — no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/user/shoresh && git add src/components/schedule/SlotCell.jsx && git commit -m "style: spacious rounded slot cells with inner-div design"
```

---

### Task 4: Schedule Day View Axis Flip

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

The current Day view: day-selector pills, rows = time blocks, cols = groups.
The new Day view: time-block-selector pills, rows = days, cols = groups.

State change: `selectedDay` → `selectedBlock`.

- [ ] **Step 1: Replace the selectedDay state declaration**

Find this line (around line 28):
```javascript
  const [selectedDay, setSelectedDay] = useState(null)
```

Replace with:
```javascript
  const [selectedBlock, setSelectedBlock] = useState(null)
```

- [ ] **Step 2: Update loadAll to initialize selectedBlock instead of selectedDay**

Find this line in `loadAll` (around line 57):
```javascript
      if (d.length > 0) setSelectedDay(d[0].id)
```

Replace with:
```javascript
      if (b.length > 0) setSelectedBlock(b[0].id)
```

Note: `b` is the `bd` data variable for time_blocks, already assigned to `const b = bd || []` on the same line as other destructuring.

- [ ] **Step 3: Replace the entire Day view JSX block**

Find the comment `{/* Daily view — all groups for one day */}` and replace the entire block that follows it (from `{hasSchedule && view === 'day' && (` through its closing `)}`) with:

```jsx
      {/* Daily view — time block selected, rows = days, cols = groups */}
      {hasSchedule && view === 'day' && (
        <div>
          {/* Time block pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {timeBlocks.map(b => (
              <button key={b.id} onClick={() => setSelectedBlock(b.id)} style={{
                padding: '5px 16px', borderRadius: 20,
                border: `1.5px solid ${selectedBlock === b.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedBlock === b.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedBlock === b.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}>
                {b.name}
                {b.start_time && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.75, marginLeft: 6 }}>{b.start_time.slice(0,5)}</span>}
              </button>
            ))}
          </div>

          {selectedBlock && (
            <DndContext
              onDragEnd={({ active, over }) => {
                if (!over) return
                const slotA = active.data.current?.slot
                const slotB = over.data.current?.slot
                if (!slotA || !slotB) return
                if (slotA.groupId === slotB.groupId && slotA.dayId === slotB.dayId && slotA.blockId === slotB.blockId) return
                if (slotB.type === 'anchor' || slotB.type === 'unavailable') return
                swapSlots(
                  { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
                  { groupId: slotB.groupId, dayId: slotB.dayId, blockId: slotB.blockId, activityId: slotB.activity_id }
                )
              }}
            >
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
                      <th style={{ ...S.th, whiteSpace: 'nowrap', minWidth: 100, position: 'sticky', left: 0, background: 'var(--surface-elevated)', zIndex: 1 }}>Day</th>
                      {groups.map(g => <th key={g.id} style={{ ...S.th, whiteSpace: 'nowrap', minWidth: 110 }}>{g.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map(day => (
                      <tr key={day.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{
                          padding: '10px 14px', verticalAlign: 'middle',
                          fontFamily: 'var(--font-condensed)', fontSize: 14, fontWeight: 600,
                          color: 'var(--text)', whiteSpace: 'nowrap',
                          position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1,
                          borderRight: '1px solid var(--border)',
                        }}>{day.label}</td>
                        {groups.map(group => {
                          const slot = getSlot(group.id, day.id, selectedBlock)
                          if (!slot) return <td key={group.id} style={emptyTd} />
                          const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                          const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                          return (
                            <SlotCell
                              key={group.id}
                              slot={slot.is_anchor
                                ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }
                                : { ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                              activity={act}
                              anchor={anchor}
                              actColorIdx={act?.colorIdx || 0}
                              weatherMode={weatherMode}
                              onEdit={s => setEditSlot(s)}
                              isDndEnabled={true}
                            />
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DndContext>
          )}
        </div>
      )}
```

- [ ] **Step 4: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: `✓ built in` — no errors. If there's a `selectedDay is not defined` error, search for any remaining `selectedDay` references and replace them with `selectedBlock`.

- [ ] **Step 5: Commit**

```bash
cd /home/user/shoresh && git add src/screens/ScheduleScreen.jsx && git commit -m "feat: day view rows=days cols=groups with time block selector"
```

---

### Task 5: Schedule Screen Visual Polish

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`
- Modify: `src/components/schedule/StatBadge.jsx`

Update the view toggle, group view table container, group pills, activity cards, stat badges, and empty states.

- [ ] **Step 1: Update the view toggle buttons**

Find the view toggle div (around line 273):
```javascript
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {[['group','Group View'],['day','Daily View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: view === v ? 'var(--primary)' : 'var(--surface)', color: view === v ? '#fff' : 'var(--text)' }}>{label}</button>
              ))}
            </div>
```

Replace with:
```javascript
            <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
              {[['group','Group View'],['day','Daily View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)', background: view === v ? 'var(--surface)' : 'none', color: view === v ? 'var(--text)' : 'var(--text-secondary)', boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>{label}</button>
              ))}
            </div>
```

- [ ] **Step 2: Update group pills in Group view**

Find the group pills mapping (around line 329):
```javascript
              border: `1px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedGroup === g.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedGroup === g.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 500, cursor: 'pointer',
```

Replace with:
```javascript
              border: `1.5px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedGroup === g.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedGroup === g.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
```

- [ ] **Step 3: Update Group view table container and header row**

Find the Group view table (around line 340):
```javascript
                <table style={{ borderCollapse: 'collapse', minWidth: 500, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
```

Replace with:
```javascript
                <table style={{ borderCollapse: 'collapse', minWidth: 500, width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
```

- [ ] **Step 4: Update Group view block label cell**

Find the block label `<td>` in the Group view (around line 350 — the one with `fontFamily: 'var(--font-mono)'`):
```javascript
                        <td style={{ ...S.td, padding: '8px 10px', fontSize: 12, verticalAlign: 'middle', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{block.name}</div>
                          <div>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                        </td>
```

Replace with:
```javascript
                        <td style={{ padding: '10px 14px', verticalAlign: 'middle', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{block.name}</div>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                        </td>
```

- [ ] **Step 5: Update "Setup incomplete" warning**

Find the setup incomplete block (around line 239):
```javascript
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 8, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Setup incomplete</div>
```

Replace with:
```javascript
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 12, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 16, marginBottom: 8, color: '#7A5100' }}>Setup incomplete</div>
```

- [ ] **Step 6: Update "No schedule yet" empty state**

Find the no-schedule empty state (around line 316):
```javascript
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-secondary)', fontSize: 13 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📅</div>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, color: 'var(--text)', marginBottom: 8 }}>No schedule yet</div>
          <div>Click "Generate Schedule" to build one from your current setup.</div>
        </div>
```

Replace with:
```javascript
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-secondary)', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 20, color: 'var(--text)', marginBottom: 8 }}>No schedule yet</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Click "Generate Schedule" to build one from your current setup.</div>
        </div>
```

- [ ] **Step 7: Update StatBadge background**

In `src/components/schedule/StatBadge.jsx`, find:
```javascript
        background: 'var(--surface)', border: `1px solid ${clickable ? color || 'var(--border)' : 'var(--border)'}`,
        borderRadius: 6, padding: '8px 14px',
```

Replace with:
```javascript
        background: 'var(--bg)', border: `1px solid ${clickable ? color || 'var(--border)' : 'var(--border)'}`,
        borderRadius: 8, padding: '8px 14px',
```

Also update the number font from mono to condensed:
```javascript
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
```
Replace with:
```javascript
      <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 20, fontWeight: 600, color: color || 'var(--text)' }}>{value}</div>
```

- [ ] **Step 8: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: `✓ built in` — no errors.

- [ ] **Step 9: Commit**

```bash
cd /home/user/shoresh && git add src/screens/ScheduleScreen.jsx src/components/schedule/StatBadge.jsx && git commit -m "style: schedule screen visual polish and warm containers"
```

---

### Task 6: Setup Screen Container & Empty State Updates

**Files:**
- Modify: `src/screens/GroupsScreen.jsx`
- Modify: `src/screens/TiersScreen.jsx`
- Modify: `src/screens/TimeBlocksScreen.jsx`
- Modify: `src/screens/ActivitiesScreen.jsx`
- Modify: `src/screens/AnchorsScreen.jsx`

Each setup screen has table container divs with `borderRadius: 8` and modal divs with `borderRadius: 10`. Update them to `borderRadius: 12`. Also update empty state text to use Fredoka.

**Pattern to find and replace in ALL five setup screen files:**

Table container (appears as the outer div wrapping `<table>`):
```javascript
background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden'
```
Replace with:
```javascript
background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden'
```

Table header row (where `background: 'var(--bg)'` is used):
```javascript
background: 'var(--bg)', borderBottom: '1px solid var(--border)'
```
Replace with:
```javascript
background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)'
```

Local modal container (used in GroupsScreen, TiersScreen, ActivitiesScreen):
```javascript
background: 'var(--surface)', borderRadius: 10, padding: 28,
```
Replace with:
```javascript
background: 'var(--surface-elevated)', borderRadius: 12, padding: 28,
```

- [ ] **Step 1: Update GroupsScreen.jsx**

Apply the three pattern replacements above in `src/screens/GroupsScreen.jsx`.

Also update the "Add Group" section container:
Find:
```javascript
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
```
Replace with:
```javascript
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
```

Also update the empty state cell:
Find:
```javascript
                <tr><td colSpan={4} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No groups yet.</td></tr>
```
Replace with:
```javascript
                <tr><td colSpan={4} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No groups yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first group below.</div>
                </td></tr>
```

- [ ] **Step 2: Update TiersScreen.jsx**

Apply the same pattern replacements. Also update the TiersScreen empty state (around line 224):
Find:
```javascript
                    No tiers yet. Add one below or import from Excel.
```
It appears inside a `<td>` — replace the wrapping `<td>` content with:
```javascript
                <tr><td colSpan={4} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No tiers yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first tier below.</div>
                </td></tr>
```

- [ ] **Step 3: Update TimeBlocksScreen.jsx**

Apply the container borderRadius pattern. Find the empty state message and replace in the same pattern as above:
- "No time blocks yet" with Fredoka heading + Nunito subtext.

- [ ] **Step 4: Update ActivitiesScreen.jsx**

Apply the container borderRadius and modal container pattern.

Update the empty state (around line 345: `No activities yet. Add one or import from Excel.`):
Replace the wrapping td with:
```javascript
<tr><td colSpan={5} style={{ padding: '40px 16px', textAlign: 'center' }}>
  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No activities yet</div>
  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first activity or import from Excel.</div>
</td></tr>
```

- [ ] **Step 5: Update AnchorsScreen.jsx**

Apply the container borderRadius pattern and add Fredoka empty state message.

- [ ] **Step 6: Verify build**

```bash
cd /home/user/shoresh && npm run build 2>&1 | tail -5
```

Expected: `✓ built in` — no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/user/shoresh && git add src/screens/GroupsScreen.jsx src/screens/TiersScreen.jsx src/screens/TimeBlocksScreen.jsx src/screens/ActivitiesScreen.jsx src/screens/AnchorsScreen.jsx && git commit -m "style: warm containers and Fredoka empty states across setup screens"
```

---

### Task 7: Push Branch

- [ ] **Step 1: Push all commits**

```bash
cd /home/user/shoresh && git push -u origin claude/intelligent-hopper-QaSJ3
```

Expected: branch pushed with all 6 commits.
