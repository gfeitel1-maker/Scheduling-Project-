# Route Config UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Route Configurator UI — screens for managing cohorts, cohort-scoped tiers/time-blocks/anchors, and day override templates.

**Architecture:** Eight sequential tasks. Tasks 1–2 build shared infrastructure (hook + component). Tasks 3–7 build individual screens. Task 8 wires everything into the sidebar. All UI follows the existing inline-style pattern (no CSS files, `S` constants from `src/styles/shared.js`).

**Tech Stack:** React JSX, Supabase JS client, inline styles via `S` shared constants, Vitest (engine tests only — no new UI tests).

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/hooks/useCohorts.js` | Create | Hook: loads cohorts for a camp, tracks active cohort |
| `src/utils/ensureCohort.js` | Create | Creates default "Main" cohort if none exists for camp |
| `src/components/CohortPicker.jsx` | Create | Cohort dropdown, hidden when count ≤ 1 |
| `src/screens/CohortsScreen.jsx` | Create | CRUD for cohorts (name, week range, anchor model, capacity source) |
| `src/screens/DayOverridesScreen.jsx` | Create | CRUD for day_override_templates + template_slots |
| `src/screens/TiersScreen.jsx` | Modify | Add CohortPicker; filter tiers by cohort_id; set cohort_id on insert |
| `src/screens/TimeBlocksScreen.jsx` | Modify | Add CohortPicker; filter time blocks by cohort_id; set cohort_id on insert |
| `src/screens/AnchorsScreen.jsx` | Modify | Add CohortPicker; filter anchors/blocks/tiers by cohort; set cohort_id on insert |
| `src/App.jsx` | Modify | Import and call ensureCohort; register new screens in SCREENS map |
| `src/components/layout/Sidebar.jsx` | Modify | Add Cohorts and Day Overrides nav items |

---

### Task 1: useCohorts hook + ensureCohort bootstrap

**Files:**
- Create: `Scheduling-Project-/src/hooks/useCohorts.js`
- Create: `Scheduling-Project-/src/utils/ensureCohort.js`
- Modify: `Scheduling-Project-/src/App.jsx`

- [ ] **Step 1: Create `src/hooks/useCohorts.js`**

```js
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

// Loads cohorts for a camp and tracks which one is active.
// activeCohort defaults to cohorts[0] (lowest sort_order).
// Screens that need cohort-scoped data call this hook and use activeCohort.id.
export function useCohorts(campId) {
  const [cohorts, setCohorts] = useState([])
  const [activeCohortId, setActiveCohortId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!campId) return
    load()
  }, [campId])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('cohorts')
      .select('*')
      .eq('camp_id', campId)
      .order('sort_order')
      .order('name')
    const list = data || []
    setCohorts(list)
    setActiveCohortId(prev => {
      // Keep selection if previously selected cohort still exists
      if (prev && list.some(c => c.id === prev)) return prev
      return list[0]?.id ?? null
    })
    setLoading(false)
  }

  const activeCohort = cohorts.find(c => c.id === activeCohortId) ?? cohorts[0] ?? null

  return { cohorts, activeCohort, setActiveCohortId, loading, reload: load }
}
```

- [ ] **Step 2: Create `src/utils/ensureCohort.js`**

```js
import { supabase } from '../supabase'

// Called once when a campId first becomes available.
// Creates a "Main" cohort if the camp has none — covers newly created camps.
// Existing camps are handled by migration 20260527050000.
export async function ensureCohort(campId) {
  const { count } = await supabase
    .from('cohorts')
    .select('id', { count: 'exact', head: true })
    .eq('camp_id', campId)
  if (count === 0) {
    await supabase.from('cohorts').insert({
      camp_id: campId,
      name: 'Main',
      session_week_start: 1,
      session_week_end: 1,
      capacity_source: 'groups_per_slot',
      anchor_model: 'fixed',
    })
  }
}
```

- [ ] **Step 3: Update `src/App.jsx`**

Add import after existing imports:
```js
import { ensureCohort } from './utils/ensureCohort'
```

Change the existing campId useEffect from:
```js
useEffect(() => {
  if (campId) seedDays(campId)
}, [campId])
```
To:
```js
useEffect(() => {
  if (campId) {
    seedDays(campId)
    ensureCohort(campId)
  }
}, [campId])
```

- [ ] **Step 4: Build to verify**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: `✓ built in N.Ns` with no errors.

- [ ] **Step 5: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/hooks/useCohorts.js src/utils/ensureCohort.js src/App.jsx
git commit -m "feat: add useCohorts hook and ensureCohort bootstrap"
```

---

### Task 2: CohortPicker component

**Files:**
- Create: `Scheduling-Project-/src/components/CohortPicker.jsx`

Renders a cohort select only when there are 2+ cohorts. Single-cohort camps see nothing (clean UX; they don't need to know about the cohort layer).

- [ ] **Step 1: Create `src/components/CohortPicker.jsx`**

```jsx
import { S } from '../styles/shared'

// Props:
//   cohorts       — array of cohort rows from DB
//   activeCohort  — currently selected cohort object
//   onChange      — fn(cohortId: string)
export default function CohortPicker({ cohorts, activeCohort, onChange }) {
  if (!cohorts || cohorts.length <= 1) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <span style={{
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--text-secondary)',
      }}>
        Cohort
      </span>
      <select
        value={activeCohort?.id ?? ''}
        onChange={e => onChange(e.target.value)}
        style={{ ...S.input, width: 'auto', minWidth: 160 }}
      >
        {cohorts.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  )
}
```

- [ ] **Step 2: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/components/CohortPicker.jsx
git commit -m "feat: add CohortPicker (visible only for multi-cohort camps)"
```

---

### Task 3: CohortsScreen

**Files:**
- Create: `Scheduling-Project-/src/screens/CohortsScreen.jsx`

Inline-edit table (follows TiersScreen pattern) + add form at bottom. Editable fields: name, session_week_start/end, anchor_model, capacity_source, sort_order.

- [ ] **Step 1: Create `src/screens/CohortsScreen.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { S } from '../styles/shared'

const ANCHOR_MODELS = [
  { value: 'none',     label: 'None — no anchors' },
  { value: 'fixed',    label: 'Fixed — anchors locked to day + block' },
  { value: 'floating', label: 'Floating — anchors constrained to a day window' },
]

const CAPACITY_SOURCES = [
  { value: 'groups_per_slot',  label: 'Groups per slot (default)' },
  { value: 'camper_headcount', label: 'Camper headcount' },
]

function CohortRow({ cohort, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(cohort.name)
  const [weekStart, setWeekStart] = useState(cohort.session_week_start)
  const [weekEnd, setWeekEnd] = useState(cohort.session_week_end)
  const [anchorModel, setAnchorModel] = useState(cohort.anchor_model)
  const [capacitySource, setCapacitySource] = useState(cohort.capacity_source)
  const [sortOrder, setSortOrder] = useState(cohort.sort_order)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onSave(cohort.id, {
      name: name.trim(),
      session_week_start: Number(weekStart),
      session_week_end: Number(weekEnd),
      anchor_model: anchorModel,
      capacity_source: capacitySource,
      sort_order: Number(sortOrder),
    })
    setSaving(false)
    setEditing(false)
  }

  function cancel() {
    setName(cohort.name)
    setWeekStart(cohort.session_week_start)
    setWeekEnd(cohort.session_week_end)
    setAnchorModel(cohort.anchor_model)
    setCapacitySource(cohort.capacity_source)
    setSortOrder(cohort.sort_order)
    setEditing(false)
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}>
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()} style={S.input} />
        </td>
        <td style={S.td}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="number" min="1" value={weekStart}
              onChange={e => setWeekStart(e.target.value)}
              style={{ ...S.input, width: 56 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>–</span>
            <input type="number" min="1" value={weekEnd}
              onChange={e => setWeekEnd(e.target.value)}
              style={{ ...S.input, width: 56 }} />
          </div>
        </td>
        <td style={S.td}>
          <select value={anchorModel} onChange={e => setAnchorModel(e.target.value)} style={S.input}>
            {ANCHOR_MODELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={S.td}>
          <select value={capacitySource} onChange={e => setCapacitySource(e.target.value)} style={S.input}>
            {CAPACITY_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={S.td}>
          <input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)}
            style={{ ...S.input, width: 60 }} />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button onClick={save} disabled={saving} style={S.btnPrimary}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={cancel} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={{ ...S.td, fontWeight: 500 }}>{cohort.name}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {cohort.session_week_start}–{cohort.session_week_end}
      </td>
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
        {ANCHOR_MODELS.find(o => o.value === cohort.anchor_model)?.label ?? cohort.anchor_model}
      </td>
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
        {CAPACITY_SOURCES.find(o => o.value === cohort.capacity_source)?.label ?? cohort.capacity_source}
      </td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{cohort.sort_order}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button onClick={() => onDelete(cohort.id)} style={{ ...S.btnDanger, marginLeft: 6 }}>Delete</button>
      </td>
    </tr>
  )
}

export default function CohortsScreen({ campId }) {
  const [cohorts, setCohorts] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newWeekStart, setNewWeekStart] = useState(1)
  const [newWeekEnd, setNewWeekEnd] = useState(1)
  const [newAnchorModel, setNewAnchorModel] = useState('fixed')
  const [newCapacitySource, setNewCapacitySource] = useState('groups_per_slot')
  const [newSort, setNewSort] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data } = await supabase.from('cohorts').select('*')
        .eq('camp_id', campId).order('sort_order').order('name')
      setCohorts(data || [])
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function addCohort() {
    if (!newName.trim()) return
    setAdding(true)
    const sortVal = newSort !== '' ? Number(newSort) : (cohorts.length + 1)
    await supabase.from('cohorts').insert({
      camp_id: campId,
      name: newName.trim(),
      session_week_start: Number(newWeekStart),
      session_week_end: Number(newWeekEnd),
      anchor_model: newAnchorModel,
      capacity_source: newCapacitySource,
      sort_order: sortVal,
    })
    setNewName('')
    setNewWeekStart(1)
    setNewWeekEnd(1)
    setAdding(false)
    load()
  }

  async function saveCohort(id, fields) {
    await supabase.from('cohorts').update(fields).eq('id', id)
    load()
  }

  async function deleteCohort(id) {
    if (cohorts.length <= 1) {
      alert('Cannot delete the last cohort — every camp must have at least one.')
      return
    }
    if (!window.confirm('Delete this cohort? Tiers and time blocks assigned to it will lose their cohort reference.')) return
    await supabase.from('cohorts').delete().eq('id', id)
    load()
  }

  return (
    <div style={{ maxWidth: 900 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {cohorts.length} cohort{cohorts.length !== 1 ? 's' : ''}
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Session Weeks</th>
                <th style={S.th}>Anchor Model</th>
                <th style={S.th}>Capacity Source</th>
                <th style={S.th}>Order</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cohorts.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No cohorts yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first cohort below.</div>
                </td></tr>
              ) : cohorts.map(c => (
                <CohortRow key={c.id} cohort={c} onSave={saveCohort} onDelete={deleteCohort} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Add Cohort
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <input placeholder="Name (e.g. Main, Specialty)" value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCohort()}
            style={{ ...S.input, flex: '1 1 160px' }} />
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Weeks</span>
            <input type="number" min="1" value={newWeekStart}
              onChange={e => setNewWeekStart(e.target.value)}
              style={{ ...S.input, width: 56 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>–</span>
            <input type="number" min="1" value={newWeekEnd}
              onChange={e => setNewWeekEnd(e.target.value)}
              style={{ ...S.input, width: 56 }} />
          </div>
          <input type="number" placeholder="Order" value={newSort}
            onChange={e => setNewSort(e.target.value)}
            style={{ ...S.input, width: 70 }} />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={newAnchorModel} onChange={e => setNewAnchorModel(e.target.value)}
            style={{ ...S.input, flex: '1 1 220px' }}>
            {ANCHOR_MODELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={newCapacitySource} onChange={e => setNewCapacitySource(e.target.value)}
            style={{ ...S.input, flex: '1 1 200px' }}>
            {CAPACITY_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={addCohort} disabled={adding || !newName.trim()}
            style={{ ...S.btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add Cohort'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        A cohort groups tiers, time blocks, and anchors that share a schedule structure.
        Most camps have one cohort ("Main"). Add a second for specialty programs with a different time grid.
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/screens/CohortsScreen.jsx
git commit -m "feat: add CohortsScreen"
```

---

### Task 4: TiersScreen — cohort scoping

**Files:**
- Modify: `Scheduling-Project-/src/screens/TiersScreen.jsx`

Three changes: (1) import hook + component, (2) re-run load when activeCohort changes and filter query by cohort_id, (3) attach cohort_id on insert.

- [ ] **Step 1: Add imports at top of TiersScreen.jsx**

After the existing imports (after `import { S } from '../styles/shared'`), add:
```js
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
```

- [ ] **Step 2: Add useCohorts hook inside TiersScreen**

Inside `export default function TiersScreen({ campId, onNavigate }) {`, after the last existing `useState` call (the `fileRef` line), add:
```js
const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)
```

- [ ] **Step 3: Update useEffect and load()**

Change:
```js
useEffect(() => { load() }, [campId])
```
To:
```js
useEffect(() => {
  if (activeCohort) load()
}, [campId, activeCohort?.id])
```

Add a guard at the very top of `load()` and filter the tiers query by `cohort_id`:
```js
async function load() {
  if (!activeCohort) return
  setLoading(true)
  setError(null)
  try {
    const [{ data: tierData }, { data: groupData }] = await Promise.all([
      supabase.from('tiers').select('*').eq('camp_id', campId)
        .eq('cohort_id', activeCohort.id).order('sort_order').order('name'),
      supabase.from('groups').select('id, tier_id').eq('camp_id', campId),
    ])
    setTiers(tierData || [])
    const counts = {}
    for (const g of groupData || []) {
      counts[g.tier_id] = (counts[g.tier_id] || 0) + 1
    }
    setGroupCounts(counts)
  } catch {
    setError('Failed to load data — check your connection and refresh')
  } finally {
    setLoading(false)
  }
}
```

- [ ] **Step 4: Add cohort_id to addTier()**

Change:
```js
await supabase.from('tiers').insert({ camp_id: campId, name: newName.trim(), sort_order: sortVal })
```
To:
```js
await supabase.from('tiers').insert({ camp_id: campId, cohort_id: activeCohort.id, name: newName.trim(), sort_order: sortVal })
```

- [ ] **Step 5: Add cohort_id to confirmImport()**

Change:
```js
await supabase.from('tiers').insert({ camp_id: campId, name: row.name, sort_order: sortVal })
```
To:
```js
await supabase.from('tiers').insert({ camp_id: campId, cohort_id: activeCohort.id, name: row.name, sort_order: sortVal })
```

- [ ] **Step 6: Add CohortPicker to JSX**

In the `return`, make the first element inside the outer `<div style={{ maxWidth: 700 }}>`:
```jsx
return (
  <div style={{ maxWidth: 700 }}>
    <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
    {error && (
      <div style={S.errorBanner}>
        {error}
      </div>
    )}
    {/* ... rest of existing JSX unchanged ... */}
  </div>
)
```

- [ ] **Step 7: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/screens/TiersScreen.jsx
git commit -m "feat: scope TiersScreen to active cohort"
```

---

### Task 5: TimeBlocksScreen — cohort scoping

**Files:**
- Modify: `Scheduling-Project-/src/screens/TimeBlocksScreen.jsx`

Same pattern as TiersScreen.

- [ ] **Step 1: Add imports**

After `import { S } from '../styles/shared'`, add:
```js
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
```

- [ ] **Step 2: Add hook inside TimeBlocksScreen**

After the last `useState` / `useRef` call, add:
```js
const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)
```

- [ ] **Step 3: Update useEffect and load()**

Change:
```js
useEffect(() => { load() }, [campId])
```
To:
```js
useEffect(() => {
  if (activeCohort) load()
}, [campId, activeCohort?.id])
```

Replace the `load()` body:
```js
async function load() {
  if (!activeCohort) return
  setLoading(true)
  setError(null)
  try {
    const { data } = await supabase.from('time_blocks').select('*')
      .eq('camp_id', campId)
      .eq('cohort_id', activeCohort.id)
      .order('sort_order').order('start_time')
    setBlocks(data || [])
  } catch {
    setError('Failed to load data — check your connection and refresh')
  } finally {
    setLoading(false)
  }
}
```

- [ ] **Step 4: Add cohort_id to addBlock()**

Change:
```js
await supabase.from('time_blocks').insert({ camp_id: campId, name: newName.trim(), start_time: newStart, end_time: newEnd, part_of_day: newPod, sort_order: sortVal })
```
To:
```js
await supabase.from('time_blocks').insert({ camp_id: campId, cohort_id: activeCohort.id, name: newName.trim(), start_time: newStart, end_time: newEnd, part_of_day: newPod, sort_order: sortVal })
```

- [ ] **Step 5: Add cohort_id to confirmImport()**

Change:
```js
await supabase.from('time_blocks').insert({ camp_id: campId, name: row.name, start_time: row.start_time, end_time: row.end_time, part_of_day: row.part_of_day, sort_order: sortVal })
```
To:
```js
await supabase.from('time_blocks').insert({ camp_id: campId, cohort_id: activeCohort.id, name: row.name, start_time: row.start_time, end_time: row.end_time, part_of_day: row.part_of_day, sort_order: sortVal })
```

- [ ] **Step 6: Add CohortPicker to JSX**

In the `return`, make the first element inside the outer `<div style={{ maxWidth: 780 }}>`:
```jsx
return (
  <div style={{ maxWidth: 780 }}>
    <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
    {error && (
      <div style={S.errorBanner}>
        {error}
      </div>
    )}
    {/* ... rest of existing JSX unchanged ... */}
  </div>
)
```

- [ ] **Step 7: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/screens/TimeBlocksScreen.jsx
git commit -m "feat: scope TimeBlocksScreen to active cohort"
```

---

### Task 6: AnchorsScreen — cohort scoping

**Files:**
- Modify: `Scheduling-Project-/src/screens/AnchorsScreen.jsx`

Three changes: filter anchor_activities, time_blocks, and tiers by cohort_id; add cohort_id on insert.

- [ ] **Step 1: Add imports**

After `import { S } from '../styles/shared'`, add:
```js
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
```

- [ ] **Step 2: Add hook inside AnchorsScreen**

After the last `useState` / `useRef` call, add:
```js
const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)
```

- [ ] **Step 3: Update useEffect and load()**

Change:
```js
useEffect(() => { load() }, [campId])
```
To:
```js
useEffect(() => {
  if (activeCohort) load()
}, [campId, activeCohort?.id])
```

Replace the full `load()` function:
```js
async function load() {
  if (!activeCohort) return
  setLoading(true)
  setError(null)
  try {
    const [{ data: aData }, { data: dData }, { data: bData }, { data: tData }, { data: gData }] = await Promise.all([
      supabase.from('anchor_activities').select('*').eq('camp_id', campId)
        .eq('cohort_id', activeCohort.id).order('name'),
      supabase.from('days_of_operation').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('time_blocks').select('*').eq('camp_id', campId)
        .eq('cohort_id', activeCohort.id).order('sort_order'),
      supabase.from('tiers').select('*').eq('camp_id', campId)
        .eq('cohort_id', activeCohort.id).order('sort_order'),
      supabase.from('groups').select('*').eq('camp_id', campId).order('name'),
    ])
    setAnchors(aData || [])
    const uniqueDays = (dData || []).filter((d, i, arr) => arr.findIndex(x => x.day_of_week === d.day_of_week) === i)
    setDays(uniqueDays)
    setTimeBlocks(bData || [])
    setTiers(tData || [])
    setGroups(gData || [])
  } catch {
    setError('Failed to load data — check your connection and refresh')
  } finally {
    setLoading(false)
  }
}
```

- [ ] **Step 4: Add cohort_id to saveAnchor() insert**

In `saveAnchor()`, change the `Promise.all` insert:
```js
supabase.from('anchor_activities').insert({ ...base, day_id: dayId, camp_id: campId })
```
To:
```js
supabase.from('anchor_activities').insert({ ...base, day_id: dayId, camp_id: campId, cohort_id: activeCohort.id })
```

- [ ] **Step 5: Add cohort_id to confirmImport() and update onFileChange lookups**

In `confirmImport()`, change:
```js
await supabase.from('anchor_activities').insert({ ...record, camp_id: campId })
```
To:
```js
await supabase.from('anchor_activities').insert({ ...record, camp_id: campId, cohort_id: activeCohort.id })
```

In `onFileChange`, update the two `Promise.all` queries so time_blocks and tiers are filtered by cohort:
```js
supabase.from('time_blocks').select('*').eq('camp_id', campId)
  .eq('cohort_id', activeCohort.id).order('sort_order'),
supabase.from('tiers').select('*').eq('camp_id', campId)
  .eq('cohort_id', activeCohort.id).order('sort_order'),
```

- [ ] **Step 6: Add CohortPicker to JSX**

In the `return`, make the first element inside the outer `<div style={{ maxWidth: 760 }}>`:
```jsx
return (
  <div style={{ maxWidth: 760 }}>
    <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
    {error && (
      <div style={S.errorBanner}>
        {error}
      </div>
    )}
    {/* ... rest of existing JSX unchanged ... */}
  </div>
)
```

- [ ] **Step 7: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/screens/AnchorsScreen.jsx
git commit -m "feat: scope AnchorsScreen to active cohort"
```

---

### Task 7: DayOverridesScreen

**Files:**
- Create: `Scheduling-Project-/src/screens/DayOverridesScreen.jsx`

Template list + modal editor. The modal shows all cohort time blocks as a checklist; checked blocks get an activity dropdown (empty = clear block / free time).

- [ ] **Step 1: Create `src/screens/DayOverridesScreen.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { S } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'

const FREQUENCY_MODES = [
  { value: 'reduced',     label: 'Reduced — targets scale down proportionally' },
  { value: 'best_effort', label: 'Best effort — targets unchanged, engine does what it can' },
]

function OverrideModal({ template, cohortId, campId, onClose, onSaved }) {
  const isNew = !template?.id
  const [name, setName] = useState(template?.name || '')
  const [freqMode, setFreqMode] = useState(template?.frequency_mode || 'reduced')
  const [saving, setSaving] = useState(false)
  const [timeBlocks, setTimeBlocks] = useState([])
  const [activities, setActivities] = useState([])
  // slots: { [blockId]: activityId | '' }  (presence = overridden, '' = clear block)
  const [slots, setSlots] = useState({})

  useEffect(() => { loadResources() }, [cohortId])

  async function loadResources() {
    const [{ data: blocks }, { data: acts }, { data: existing }] = await Promise.all([
      supabase.from('time_blocks').select('*').eq('camp_id', campId)
        .eq('cohort_id', cohortId).order('sort_order'),
      supabase.from('activities').select('id, name').eq('camp_id', campId).order('name'),
      template?.id
        ? supabase.from('day_override_template_slots').select('*').eq('template_id', template.id)
        : Promise.resolve({ data: [] }),
    ])
    setTimeBlocks(blocks || [])
    setActivities(acts || [])
    const map = {}
    for (const s of existing || []) {
      map[s.time_block_id] = s.activity_id || ''
    }
    setSlots(map)
  }

  function toggleSlot(blockId) {
    setSlots(prev => {
      if (blockId in prev) {
        const next = { ...prev }
        delete next[blockId]
        return next
      }
      return { ...prev, [blockId]: '' }
    })
  }

  function setSlotActivity(blockId, activityId) {
    setSlots(prev => ({ ...prev, [blockId]: activityId }))
  }

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      let templateId = template?.id
      if (isNew) {
        const { data } = await supabase.from('day_override_templates').insert({
          camp_id: campId,
          cohort_id: cohortId,
          name: name.trim(),
          frequency_mode: freqMode,
        }).select('id').single()
        templateId = data.id
      } else {
        await supabase.from('day_override_templates').update({
          name: name.trim(),
          frequency_mode: freqMode,
        }).eq('id', templateId)
      }
      // Replace all slots
      await supabase.from('day_override_template_slots').delete().eq('template_id', templateId)
      const rows = Object.entries(slots).map(([blockId, activityId]) => ({
        template_id: templateId,
        time_block_id: blockId,
        activity_id: activityId || null,
      }))
      if (rows.length > 0) {
        await supabase.from('day_override_template_slots').insert(rows)
      }
      onSaved()
    } catch (err) {
      console.error('Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, width: 560 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
          {isNew ? 'New Override Template' : `Edit: ${template.name}`}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={S.label}>Template Name</div>
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()} style={S.input}
            placeholder="e.g. Field Trip, Color War, Shabbaton" />
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={S.label}>Frequency Mode</div>
          <select value={freqMode} onChange={e => setFreqMode(e.target.value)} style={S.input}>
            {FREQUENCY_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Block Overrides
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Check a block to override it on this day type. Leave activity blank to clear the block (free time).
          </div>
          {timeBlocks.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              No time blocks in this cohort yet.
            </div>
          ) : timeBlocks.map(block => {
            const overridden = block.id in slots
            return (
              <div key={block.id} style={{
                display: 'flex', gap: 10, alignItems: 'center',
                padding: '8px 10px', marginBottom: 4,
                background: overridden ? 'var(--surface)' : 'transparent',
                border: `1px solid ${overridden ? 'var(--border)' : 'transparent'}`,
                borderRadius: 7,
              }}>
                <input type="checkbox" checked={overridden} onChange={() => toggleSlot(block.id)}
                  style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 500, minWidth: 120 }}>{block.name}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', minWidth: 90 }}>
                  {block.start_time?.slice(0, 5)}–{block.end_time?.slice(0, 5)}
                </span>
                {overridden && (
                  <select value={slots[block.id] || ''}
                    onChange={e => setSlotActivity(block.id, e.target.value)}
                    style={{ ...S.input, flex: 1, fontSize: 12 }}>
                    <option value="">— Clear block (free time) —</option>
                    {activities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()}
            style={{ ...S.btnPrimary, opacity: (!name.trim() || saving) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : isNew ? 'Create Template' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DayOverridesScreen({ campId }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null) // null | { template: obj|null }
  const [error, setError] = useState(null)
  const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)

  useEffect(() => {
    if (activeCohort) load()
  }, [campId, activeCohort?.id])

  async function load() {
    if (!activeCohort) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await supabase
        .from('day_override_templates')
        .select('*, day_override_template_slots(*)')
        .eq('camp_id', campId)
        .eq('cohort_id', activeCohort.id)
        .order('name')
      setTemplates(data || [])
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function deleteTemplate(id) {
    if (!window.confirm('Delete this override template?')) return
    await supabase.from('day_override_template_slots').delete().eq('template_id', id)
    await supabase.from('day_override_templates').delete().eq('id', id)
    load()
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {templates.length} template{templates.length !== 1 ? 's' : ''}
        </div>
        <button onClick={() => setModal({ template: null })} style={S.btnPrimary}>+ New Template</button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Frequency Mode</th>
                <th style={S.th}>Block Overrides</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No templates yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Create templates for field trips, color war, or other days with a different schedule.</div>
                </td></tr>
              ) : templates.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ ...S.td, fontWeight: 500 }}>{t.name}</td>
                  <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {FREQUENCY_MODES.find(o => o.value === t.frequency_mode)?.label ?? t.frequency_mode}
                  </td>
                  <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t.day_override_template_slots?.length ?? 0} block{(t.day_override_template_slots?.length ?? 0) !== 1 ? 's' : ''}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <button onClick={() => setModal({ template: t })} style={S.btnSecondary}>Edit</button>
                    <button onClick={() => deleteTemplate(t.id)} style={{ ...S.btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Override templates define how specific days differ from the standard schedule.
        Apply them to individual calendar dates in the Schedule screen.
      </div>

      {modal && activeCohort && (
        <OverrideModal
          template={modal.template}
          cohortId={activeCohort.id}
          campId={campId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/screens/DayOverridesScreen.jsx
git commit -m "feat: add DayOverridesScreen"
```

---

### Task 8: Sidebar + App.jsx wiring

**Files:**
- Modify: `Scheduling-Project-/src/App.jsx`
- Modify: `Scheduling-Project-/src/components/layout/Sidebar.jsx`

- [ ] **Step 1: Register new screens in App.jsx**

Add imports after the existing screen imports:
```js
import CohortsScreen from './screens/CohortsScreen'
import DayOverridesScreen from './screens/DayOverridesScreen'
```

Update the `SCREENS` object:
```js
const SCREENS = {
  setup:        CampSetup,
  cohorts:      CohortsScreen,
  tiers:        TiersScreen,
  groups:       GroupsScreen,
  timeblocks:   TimeBlocksScreen,
  activities:   ActivitiesScreen,
  anchors:      AnchorsScreen,
  dayoverrides: DayOverridesScreen,
  schedule:     ScheduleScreen,
}
```

- [ ] **Step 2: Update NAV in Sidebar.jsx**

Change the `NAV` array from its current value to:
```js
const NAV = [
  { key: 'setup',        label: 'Camp Setup' },
  { key: 'cohorts',      label: 'Cohorts' },
  { key: 'tiers',        label: 'Tiers' },
  { key: 'groups',       label: 'Groups' },
  { key: 'timeblocks',   label: 'Time Blocks' },
  { key: 'activities',   label: 'Activities' },
  { key: 'anchors',      label: 'Anchors' },
  { key: 'dayoverrides', label: 'Day Overrides' },
  { key: 'schedule',     label: 'Schedule', divider: true },
]
```

- [ ] **Step 3: Build**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
npm test
```

Expected: 16/16 engine tests still passing.

- [ ] **Step 5: Commit**

```bash
cd "/Users/gregfeitel/Desktop/Camp App System /Applications/Schedule Project/Scheduling-Project-"
git add src/App.jsx src/components/layout/Sidebar.jsx
git commit -m "feat: wire CohortsScreen and DayOverridesScreen into sidebar nav"
```

---

## Self-Review Notes

- Spec coverage: cohorts CRUD ✓, session weeks ✓, anchor_model ✓, capacity_source ✓, tiers cohort-scoped ✓, time_blocks cohort-scoped ✓, anchors cohort-scoped ✓, day_override_templates ✓, day_override_template_slots ✓, CohortPicker hidden for single-cohort camps ✓, ensureCohort for new camps ✓
- Placeholder scan: all code is complete, no TBDs
- Type consistency: `activeCohort.id` (string UUID) used throughout; `setActiveCohortId` takes a string matching `<select onChange> e.target.value`; slot map keys are `time_block_id` strings matching DB uuids
- `schedule_day_overrides` (applying a template to a specific date in a schedule run) is a ScheduleScreen concern — deferred to Sub-project 3
- Load guard `if (!activeCohort) return` prevents queries before useCohorts finishes; the `[campId, activeCohort?.id]` dep array re-triggers load once cohorts are available
