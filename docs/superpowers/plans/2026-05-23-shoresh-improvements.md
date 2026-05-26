# Shoresh Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add camp-name-based entry with self-serve creation, seeded schedule generation, visible error states, shared styles, extracted ScheduleScreen components, and a drag-and-drop prototype.

**Architecture:** Five independent feature tracks executed in priority order. No new tables; one DB constraint added. All changes are additive — existing localStorage campId continues to work for returning users.

**Tech Stack:** React 19, Vite 8, Supabase JS v2, @dnd-kit/core (Task 14 only), inline styles via shared constants.

---

## File Map

**Create:**
- `src/components/entry/LandingScreen.jsx` — name-based camp entry (replaces CampIdGate)
- `src/styles/shared.js` — shared style constants (S.btnPrimary, S.btnSecondary, etc.)
- `src/components/schedule/SlotCell.jsx` — extracted from ScheduleScreen
- `src/components/schedule/StatBadge.jsx` — extracted from ScheduleScreen
- `src/components/schedule/FlagDetailModal.jsx` — extracted from ScheduleScreen
- `src/components/schedule/EditModal.jsx` — extracted from ScheduleScreen
- `src/components/schedule/ConfirmRegenModal.jsx` — extracted from ScheduleScreen

**Modify:**
- `src/App.jsx` — replace CampIdGate with LandingScreen, add URL param logic
- `src/engine/buildSchedule.js` — add djb2 + mulberry32, replace Math.random()
- `src/components/layout/Shell.jsx` — pass campId prop to Sidebar
- `src/components/layout/Sidebar.jsx` — fetch camp name from DB
- `src/screens/TiersScreen.jsx` — error state, shared styles
- `src/screens/GroupsScreen.jsx` — error state, shared styles
- `src/screens/TimeBlocksScreen.jsx` — error state, shared styles
- `src/screens/ActivitiesScreen.jsx` — error state, saveError in modals, shared styles
- `src/screens/AnchorsScreen.jsx` — error state, saveError in modals, shared styles
- `src/screens/CampSetup.jsx` — error state, shared styles
- `src/screens/ScheduleScreen.jsx` — error states (two modes), swapSlots, import extracted components, shared styles, DnD

---

## Track 1: Entry Flow

### Task 1: DB — Add UNIQUE constraint on camps.name

**Files:**
- No code files — run SQL in Supabase Dashboard

- [ ] **Step 1: Open Supabase SQL Editor**

Navigate to your Supabase project → SQL Editor → New query. Run:

```sql
ALTER TABLE camps
  ADD CONSTRAINT camps_name_unique UNIQUE (name);

CREATE UNIQUE INDEX camps_name_lower_idx
  ON camps (lower(name));
```

The first line adds a standard unique constraint. The second adds a case-insensitive index so `ALTER TABLE` alone isn't enough — `lower(name)` ensures "Camp Achva" and "camp achva" are treated as the same.

- [ ] **Step 2: Verify**

In Table Editor → camps, try inserting two rows with names that differ only by case. The second should fail with a unique constraint violation. Then delete the test rows.

- [ ] **Step 3: Commit note**

```bash
git commit --allow-empty -m "db: add unique constraint on camps.name (run in Supabase dashboard)"
```

---

### Task 2: Create LandingScreen — primary path (open by name)

**Files:**
- Create: `src/components/entry/LandingScreen.jsx`

- [ ] **Step 1: Create the file**

Create `src/components/entry/LandingScreen.jsx`:

```jsx
import { useState } from 'react'
import { supabase } from '../../supabase'

// screen: 'open' | 'notFound' | 'create' | 'confirm'
export default function LandingScreen({ onEnter }) {
  const [screen, setScreen] = useState('open')
  const [name, setName] = useState('')
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirmUrl, setConfirmUrl] = useState('')
  const [nameError, setNameError] = useState('')

  async function handleOpen() {
    if (!name.trim()) return
    setSearching(true)
    setNameError('')
    const { data } = await supabase
      .from('camps')
      .select('id')
      .ilike('name', name.trim())
      .maybeSingle()
    setSearching(false)
    if (data) {
      onEnter(data.id)
    } else {
      setScreen('notFound')
    }
  }

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    setNameError('')
    const { data, error } = await supabase
      .from('camps')
      .insert({ name: name.trim() })
      .select('id')
      .single()
    setCreating(false)
    if (error) {
      if (error.code === '23505') {
        setNameError('A camp with this name already exists. Try opening it instead.')
      } else {
        setNameError('Failed to create camp. Check your connection and try again.')
      }
      return
    }
    const url = `${window.location.origin}${window.location.pathname}?camp=${data.id}`
    setConfirmUrl(url)
    onEnter(data.id, url)
    setScreen('confirm')
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={logoBlock}>
          <div style={logo}>Shoresh</div>
          <div style={logoSub}>Camp activity scheduling</div>
        </div>

        {screen === 'open' && (
          <OpenScreen
            name={name}
            setName={setName}
            searching={searching}
            onOpen={handleOpen}
            onCreateNew={() => { setScreen('create') }}
          />
        )}

        {screen === 'notFound' && (
          <NotFoundScreen
            name={name}
            onCreate={handleCreate}
            creating={creating}
            onBack={() => setScreen('open')}
            nameError={nameError}
          />
        )}

        {screen === 'create' && (
          <CreateScreen
            name={name}
            setName={setName}
            onCreate={handleCreate}
            creating={creating}
            onBack={() => setScreen('open')}
            nameError={nameError}
          />
        )}

        {screen === 'confirm' && (
          <ConfirmScreen url={confirmUrl} campName={name.trim()} />
        )}
      </div>
    </div>
  )
}

function OpenScreen({ name, setName, searching, onOpen, onCreateNew }) {
  return (
    <div>
      <div style={heading}>Open your camp</div>
      <div style={bodyText}>Enter your camp name to continue.</div>
      <label style={lbl}>Camp name</label>
      <input
        style={inputStyle}
        placeholder="e.g. Camp Achva"
        value={name}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && name.trim() && onOpen()}
      />
      <button
        style={{ ...btnPrimary, ...((!name.trim() || searching) ? { background: '#cce9ec', cursor: 'default' } : {}) }}
        onClick={onOpen}
        disabled={!name.trim() || searching}
      >
        {searching ? 'Searching…' : 'Open camp'}
      </button>
      <div style={divider} />
      <div style={hintRow}>
        <span style={hintText}>New to Shoresh?</span>
        <button style={linkBtn} onClick={onCreateNew}>Create a new camp</button>
      </div>
    </div>
  )
}

function NotFoundScreen({ name, onCreate, creating, onBack, nameError }) {
  return (
    <div>
      <div style={{ ...iconCircle, background: '#fff0f0', color: '#F0585D' }}>✕</div>
      <div style={heading}>Camp not found</div>
      <div style={bodyText}>
        No camp named <strong>"{name.trim()}"</strong> exists yet. Would you like to create it?
      </div>
      {nameError && <div style={errorMsg}>{nameError}</div>}
      <button
        style={btnPrimary}
        onClick={onCreate}
        disabled={creating}
      >
        {creating ? 'Creating…' : `Create "${name.trim()}"`}
      </button>
      <button style={{ ...btnSecondary, marginTop: 8 }} onClick={onBack}>← Try a different name</button>
    </div>
  )
}

function CreateScreen({ name, setName, onCreate, creating, onBack, nameError }) {
  return (
    <div>
      <button style={backBtn} onClick={onBack}>← Back</button>
      <div style={heading}>Create a new camp</div>
      <div style={bodyText}>Give your camp a name. Anyone who knows this name can access the schedule.</div>
      <label style={lbl}>Camp name</label>
      <input
        style={inputStyle}
        placeholder="e.g. Camp Achva"
        value={name}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && name.trim() && onCreate()}
      />
      {nameError && <div style={errorMsg}>{nameError}</div>}
      <button
        style={{ ...btnPrimary, ...((!name.trim() || creating) ? { background: '#cce9ec', cursor: 'default' } : {}) }}
        onClick={onCreate}
        disabled={!name.trim() || creating}
      >
        {creating ? 'Creating…' : 'Create camp'}
      </button>
    </div>
  )
}

function ConfirmScreen({ url, campName }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div>
      <div style={{ ...iconCircle, background: '#e6f7f8', color: '#00ADBB' }}>✓</div>
      <div style={heading}>{campName} is ready</div>
      <div style={bodyText}>
        Bookmark this link — it's how you and your team will access this camp on any device.
      </div>
      <div style={urlBox}>
        <span style={urlText}>{url}</span>
        <button
          style={{ ...copyBtn, ...(copied ? { background: '#00AA59' } : {}) }}
          onClick={copy}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const page = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '40px 48px', maxWidth: 480, width: '100%' }
const logoBlock = { marginBottom: 32 }
const logo = { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 28, color: 'var(--primary)', letterSpacing: '-0.5px' }
const logoSub = { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2 }
const heading = { fontWeight: 600, fontSize: 15, marginBottom: 6 }
const bodyText = { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }
const lbl = { fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 6 }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', marginBottom: 12, outline: 'none', background: 'var(--bg)' }
const btnPrimary = { display: 'block', width: '100%', padding: '10px 0', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 0 }
const btnSecondary = { display: 'block', width: '100%', padding: '10px 0', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 500, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }
const backBtn = { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 20, fontFamily: 'inherit' }
const divider = { height: 1, background: 'var(--border)', margin: '20px 0' }
const hintRow = { textAlign: 'center', fontSize: 12 }
const hintText = { color: 'var(--text-secondary)', marginRight: 4 }
const linkBtn = { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }
const iconCircle = { width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, fontSize: 18 }
const errorMsg = { fontSize: 12, color: 'var(--warning)', marginBottom: 10, padding: '8px 10px', background: '#fff5f5', borderRadius: 5, border: '1px solid #f5c6c6' }
const urlBox = { background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }
const urlText = { flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--primary)', wordBreak: 'break-all' }
const copyBtn = { flexShrink: 0, background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
```

- [ ] **Step 2: Verify it renders**

Run `npm run dev` (or `pnpm dev`). The file won't be wired in yet — no visual change. No errors in terminal = step passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/entry/LandingScreen.jsx
git commit -m "feat: add LandingScreen with name-based camp lookup"
```

---

### Task 3: Wire LandingScreen into App.jsx + URL param logic

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Replace CampIdGate and add URL param reading**

Open `src/App.jsx`. Replace the entire file with:

```jsx
import { useState, useEffect } from 'react'
import Shell from './components/layout/Shell'
import LandingScreen from './components/entry/LandingScreen'
import CampSetup from './screens/CampSetup'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import { supabase } from './supabase'

const SCREENS = {
  setup: CampSetup,
  tiers: TiersScreen,
  groups: GroupsScreen,
  timeblocks: TimeBlocksScreen,
  activities: ActivitiesScreen,
  anchors: AnchorsScreen,
  schedule: ScheduleScreen,
}

const MON_FRI = [
  { label: 'Monday',    day_of_week: 1, sort_order: 1 },
  { label: 'Tuesday',   day_of_week: 2, sort_order: 2 },
  { label: 'Wednesday', day_of_week: 3, sort_order: 3 },
  { label: 'Thursday',  day_of_week: 4, sort_order: 4 },
  { label: 'Friday',    day_of_week: 5, sort_order: 5 },
]

async function seedDays(campId) {
  const { count } = await supabase
    .from('days_of_operation')
    .select('id', { count: 'exact', head: true })
    .eq('camp_id', campId)
  if (count === 0) {
    await supabase.from('days_of_operation').insert(
      MON_FRI.map(d => ({ ...d, camp_id: campId }))
    )
  }
}

function getUrlCampId() {
  return new URLSearchParams(window.location.search).get('camp')
}

function setUrlCampId(campId) {
  const url = new URL(window.location.href)
  url.searchParams.set('camp', campId)
  window.history.replaceState({}, '', url.toString())
}

export default function App() {
  // URL param wins over localStorage
  const urlCampId = getUrlCampId()
  const storedCampId = localStorage.getItem('campId')
  const initialCampId = urlCampId || storedCampId || null

  const [campId, setCampId] = useState(initialCampId)
  const [screen, setScreen] = useState('setup')

  useEffect(() => {
    if (campId) {
      localStorage.setItem('campId', campId)
      setUrlCampId(campId)
      seedDays(campId)
    }
  }, [campId])

  function handleEnter(id) {
    setCampId(id)
  }

  if (!campId) {
    return <LandingScreen onEnter={handleEnter} />
  }

  const Screen = SCREENS[screen] || CampSetup

  return (
    <Shell currentScreen={screen} onNavigate={setScreen} campId={campId}>
      <Screen campId={campId} onNavigate={setScreen} />
    </Shell>
  )
}
```

- [ ] **Step 2: Verify in browser**

Run the dev server. If you have a `campId` in localStorage, you should land directly in the app (no landing screen). Open a new incognito window — you should see the new landing screen with "Open your camp" and a name input.

- [ ] **Step 3: Test the happy path**

In the incognito window, type your camp's name and click "Open camp". You should land in the app. Check localStorage in DevTools → Application → Local Storage — `campId` should be set.

- [ ] **Step 4: Test URL priority**

Navigate to `/?camp=<your-campId>` directly. You should skip the landing screen and land in the app. Then modify the URL to `/?camp=fake-uuid` — you should also skip to the app (camp validation is Task 2's Supabase query, not here). This is acceptable — invalid IDs will surface as empty data in screens.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: wire LandingScreen, URL-param-wins-over-localStorage entry flow"
```

---

### Task 4: Sidebar — fetch and display camp name

**Files:**
- Modify: `src/components/layout/Shell.jsx`
- Modify: `src/components/layout/Sidebar.jsx`

- [ ] **Step 1: Pass campId through Shell to Sidebar**

Open `src/components/layout/Shell.jsx`. Replace with:

```jsx
import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Shell({ children, currentScreen, onNavigate, campId }) {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar current={currentScreen} onNavigate={onNavigate} campId={campId} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar screen={currentScreen} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {children}
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Fetch camp name in Sidebar**

Open `src/components/layout/Sidebar.jsx`. Replace the hardcoded `"Camp Achva"` sub-label with a fetched name. Replace the full file with:

```jsx
import { useState, useEffect } from 'react'
import { supabase } from '../../supabase'

const NAV = [
  { key: 'setup',      label: 'Camp Setup' },
  { key: 'tiers',      label: 'Tiers' },
  { key: 'groups',     label: 'Groups' },
  { key: 'timeblocks', label: 'Time Blocks' },
  { key: 'activities', label: 'Activities' },
  { key: 'anchors',    label: 'Anchors' },
  { key: 'schedule',   label: 'Schedule', divider: true },
]

export default function Sidebar({ current, onNavigate, campId }) {
  const [campName, setCampName] = useState('')

  useEffect(() => {
    if (!campId) return
    supabase.from('camps').select('name').eq('id', campId).single()
      .then(({ data }) => { if (data) setCampName(data.name) })
  }, [campId])

  return (
    <aside style={{
      width: 200, minWidth: 200, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 22,
          color: 'var(--primary)', letterSpacing: '-0.3px',
        }}>Shoresh</div>
        {campName && (
          <div style={{
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2,
          }}>{campName}</div>
        )}
      </div>

      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
        {NAV.map(item => (
          <div key={item.key}>
            {item.divider && <div style={{ height: 1, background: 'var(--border)', margin: '8px 16px' }} />}
            <button
              onClick={() => onNavigate(item.key)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 20px', border: 'none', background: 'none',
                fontSize: 13, fontWeight: current === item.key ? 600 : 400,
                color: current === item.key ? 'var(--primary)' : 'var(--text)',
                borderLeft: current === item.key
                  ? '3px solid var(--primary)'
                  : '3px solid transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (current !== item.key) e.currentTarget.style.background = 'var(--bg)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </nav>

      <div style={{
        padding: '12px 20px', borderTop: '1px solid var(--border)',
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
      }}>
        v0.1.0
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: Verify in browser**

Open the app. The sidebar sub-label under "Shoresh" should now show the actual camp name from Supabase (e.g. "Camp Achva") instead of the hardcoded string. It may flicker briefly while loading — that's fine.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/Shell.jsx src/components/layout/Sidebar.jsx
git commit -m "feat: sidebar fetches and displays camp name from DB"
```

---

## Track 2: Seeded PRNG

### Task 5: Replace Math.random() with seeded PRNG in buildSchedule.js

**Files:**
- Modify: `src/engine/buildSchedule.js`

- [ ] **Step 1: Add djb2 hash and mulberry32 PRNG at the top of the file**

Open `src/engine/buildSchedule.js`. Add these two functions immediately after the opening comment block, before `function buildSchedule(`:

```js
function djb2(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash & hash // force 32-bit int
  }
  return Math.abs(hash)
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
```

- [ ] **Step 2: Accept campId in buildSchedule and wire up the PRNG**

`buildSchedule` currently takes `{ groups, tiers, days, timeBlocks, activities, anchors }`. Add `campId` to the destructure and create the seeded random function:

```js
function buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId = '' }) {
  const rand = mulberry32(djb2(campId))
  // ... rest of function unchanged
```

- [ ] **Step 3: Replace Math.random() with rand()**

Find line 164 (the tie-breaking sort inside `runRound`):

```js
return diff !== 0 ? diff : Math.random() - 0.5
```

Replace with:

```js
return diff !== 0 ? diff : rand() - 0.5
```

- [ ] **Step 4: Pass campId from ScheduleScreen**

Open `src/screens/ScheduleScreen.jsx`. Find the `generate()` function (around line 335). Find this line:

```js
const result = buildSchedule({ groups, tiers, days, timeBlocks: timeBlocks, activities, anchors })
```

Replace with:

```js
const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId })
```

- [ ] **Step 5: Verify determinism**

In the browser, open the Schedule screen and generate a schedule. Note the layout. Click "Regenerate from Scratch" and confirm. The new schedule should be identical to the previous one (same activities in the same slots). Regenerate a second time — still identical.

- [ ] **Step 6: Commit**

```bash
git add src/engine/buildSchedule.js src/screens/ScheduleScreen.jsx
git commit -m "feat: seeded PRNG in buildSchedule — deterministic schedules per campId"
```

---

## Track 3: Error Handling

### Task 6: Error states — TiersScreen and GroupsScreen

**Files:**
- Modify: `src/screens/TiersScreen.jsx`
- Modify: `src/screens/GroupsScreen.jsx`

- [ ] **Step 1: Add error state to TiersScreen**

Open `src/screens/TiersScreen.jsx`. In the state declarations (around line 71), add:

```js
const [error, setError] = useState(null)
```

In the `load()` function, wrap the body:

```js
async function load() {
  setLoading(true)
  setError(null)
  try {
    const [{ data: tierData }, { data: groupData }] = await Promise.all([
      supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order').order('name'),
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

Add the error banner immediately after the opening `<div style={{ maxWidth: 700 }}>` in the return block:

```jsx
{error && (
  <div style={{ background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--warning)' }}>
    {error}
  </div>
)}
```

- [ ] **Step 2: Apply same pattern to GroupsScreen**

Open `src/screens/GroupsScreen.jsx`. Apply the identical pattern:
1. Add `const [error, setError] = useState(null)` to state
2. Wrap `load()` body in `try/catch/finally` with `setError(null)` at top and `setError('Failed to load data — check your connection and refresh')` in catch
3. Add the same error banner JSX above the table

- [ ] **Step 3: Verify**

In the browser, temporarily break the Supabase URL in `.env` (e.g. add a typo). Reload the Tiers screen — it should show the error banner instead of silently showing an empty table. Restore the correct URL.

- [ ] **Step 4: Commit**

```bash
git add src/screens/TiersScreen.jsx src/screens/GroupsScreen.jsx
git commit -m "feat: error states in TiersScreen and GroupsScreen"
```

---

### Task 7: Error states — TimeBlocksScreen and ActivitiesScreen

**Files:**
- Modify: `src/screens/TimeBlocksScreen.jsx`
- Modify: `src/screens/ActivitiesScreen.jsx`

- [ ] **Step 1: Apply error pattern to TimeBlocksScreen**

Open `src/screens/TimeBlocksScreen.jsx`. Apply the same three-part pattern from Task 6:
1. Add `const [error, setError] = useState(null)`
2. Wrap `load()` in `try/catch/finally`
3. Add error banner JSX

- [ ] **Step 2: Apply error pattern to ActivitiesScreen**

Open `src/screens/ActivitiesScreen.jsx`. Apply the same three-part pattern. The load function in ActivitiesScreen may be named `load()` or `loadAll()` — wrap whichever fetches the initial data.

- [ ] **Step 3: Commit**

```bash
git add src/screens/TimeBlocksScreen.jsx src/screens/ActivitiesScreen.jsx
git commit -m "feat: error states in TimeBlocksScreen and ActivitiesScreen"
```

---

### Task 8: Error states — AnchorsScreen and CampSetup

**Files:**
- Modify: `src/screens/AnchorsScreen.jsx`
- Modify: `src/screens/CampSetup.jsx`

- [ ] **Step 1: Apply error pattern to AnchorsScreen**

Open `src/screens/AnchorsScreen.jsx`. Apply the same three-part pattern from Task 6. Note: AnchorsScreen's `load()` has a `Promise.all` at line 152 — wrap only the outer `try` around the entire function body.

- [ ] **Step 2: Apply error pattern to CampSetup**

Open `src/screens/CampSetup.jsx`. If it has a load function that fetches from Supabase, apply the same pattern. If it has no async load, skip the try/catch and just add the state variable for consistency.

- [ ] **Step 3: Commit**

```bash
git add src/screens/AnchorsScreen.jsx src/screens/CampSetup.jsx
git commit -m "feat: error states in AnchorsScreen and CampSetup"
```

---

### Task 9: Error states — ScheduleScreen (two failure modes)

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

- [ ] **Step 1: Add two error states**

Open `src/screens/ScheduleScreen.jsx`. In the state declarations add:

```js
const [loadError, setLoadError] = useState(null)
const [templateError, setTemplateError] = useState(null)
```

- [ ] **Step 2: Wrap loadAll() in two separate try/catch blocks**

Find `async function loadAll()` (around line 297). Replace with:

```js
async function loadAll() {
  setLoading(true)
  setLoadError(null)
  setTemplateError(null)
  try {
    const [{ data: gd }, { data: td }, { data: bd }, { data: ad }, { data: ancd }, { data: tierd }] = await Promise.all([
      supabase.from('groups').select('*').eq('camp_id', campId).order('name'),
      supabase.from('days_of_operation').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('time_blocks').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('activities').select('*').eq('camp_id', campId),
      supabase.from('anchor_activities').select('*').eq('camp_id', campId),
      supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order'),
    ])
    const g = gd || []; const b = bd || []; const a = ad || []; const anc = ancd || []; const t = tierd || []
    const d = (td || []).filter((x, i, arr) => arr.findIndex(y => y.day_of_week === x.day_of_week) === i)
    setGroups(g); setDays(d); setTimeBlocks(b); setActivities(a); setAnchors(anc); setTiers(t)
    if (g.length > 0) setSelectedGroup(g[0].id)
    if (d.length > 0) setSelectedDay(d[0].id)
  } catch {
    setLoadError('Failed to load schedule data — check your connection and refresh')
    setLoading(false)
    return
  }

  try {
    const { data: tmpl } = await supabase.from('schedule_templates').select('id').eq('camp_id', campId).single()
    if (tmpl) {
      setTemplateId(tmpl.id)
      const { data: slotData } = await supabase.from('template_slots').select('*').eq('template_id', tmpl.id)
      const saved = slotData || []
      setSlots(saved)
      recalcStats(saved, [])
    }
  } catch {
    setTemplateError('Failed to load saved schedule — your data is intact, try refreshing')
  }

  setLoading(false)
}
```

- [ ] **Step 3: Add error banners to the render**

Find the main return block. Add both banners just before the stats/schedule content:

```jsx
{loadError && (
  <div style={{ background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--warning)' }}>
    {loadError}
  </div>
)}
{templateError && (
  <div style={{ background: '#fff8e7', border: '1px solid #f5e6a3', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#8a6800' }}>
    {templateError}
  </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: two-mode error states in ScheduleScreen"
```

---

### Task 10: Save error feedback in modals — ActivitiesScreen and AnchorsScreen

**Files:**
- Modify: `src/screens/ActivitiesScreen.jsx`
- Modify: `src/screens/AnchorsScreen.jsx`

- [ ] **Step 1: Add saveError to ActivityModal in ActivitiesScreen**

Open `src/screens/ActivitiesScreen.jsx`. Find `ActivityModal`. In its state declarations, add:

```js
const [saveError, setSaveError] = useState(null)
```

Find the `save()` function. Wrap the `await onSave(...)` call:

```js
async function save() {
  if (!name.trim()) return
  setSaving(true)
  setSaveError(null)
  try {
    await onSave(activity?.id || null, record)
  } catch {
    setSaveError('Failed to save — check your connection and try again')
    setSaving(false)
    return
  }
  setSaving(false)
}
```

Add the error message inside the modal, just above the Save button:

```jsx
{saveError && (
  <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 10, padding: '8px 10px', background: '#fff5f5', borderRadius: 5, border: '1px solid #f5c6c6' }}>
    {saveError}
  </div>
)}
```

Do NOT close the modal on save error — the modal stays open so the user's input is preserved.

- [ ] **Step 2: Apply the same pattern to AnchorsScreen modals**

Open `src/screens/AnchorsScreen.jsx`. Find any modal component that calls Supabase on save. Add `saveError` state and the same try/catch/error-display pattern.

- [ ] **Step 3: Commit**

```bash
git add src/screens/ActivitiesScreen.jsx src/screens/AnchorsScreen.jsx
git commit -m "feat: save error feedback in activity and anchor modals"
```

---

## Track 4: Style Consolidation & ScheduleScreen Split

### Task 11: Create src/styles/shared.js

**Files:**
- Create: `src/styles/shared.js`

- [ ] **Step 1: Create the shared styles file**

Create `src/styles/shared.js`. Source of truth is ActivitiesScreen / TiersScreen:

```js
// Shared inline style constants — import as: import { S } from '../styles/shared'
export const S = {
  btnPrimary: {
    padding: '7px 14px',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnSecondary: {
    padding: '7px 14px',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    fontWeight: 500,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnDanger: {
    padding: '7px 14px',
    background: 'none',
    color: 'var(--warning)',
    border: '1px solid var(--warning)',
    borderRadius: 5,
    fontWeight: 500,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  th: {
    padding: '9px 14px',
    textAlign: 'left',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  td: {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 13,
  },
  input: {
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 5,
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
    background: 'var(--surface)',
    borderRadius: 10,
    padding: 28,
    maxWidth: 400,
    width: '100%',
  },
  modalLg: {
    background: 'var(--surface)',
    borderRadius: 10,
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

- [ ] **Step 2: Commit**

```bash
git add src/styles/shared.js
git commit -m "feat: add src/styles/shared.js with shared style constants"
```

---

### Task 12: Apply shared styles to TiersScreen and GroupsScreen

**Files:**
- Modify: `src/screens/TiersScreen.jsx`
- Modify: `src/screens/GroupsScreen.jsx`

- [ ] **Step 1: Replace local constants in TiersScreen**

Open `src/screens/TiersScreen.jsx`. At the top, add:

```js
import { S } from '../styles/shared'
```

At the bottom, delete the `const td`, `const th`, `const inputStyle`, `const btnPrimary`, `const btnSecondary`, `const btnDanger` declarations.

In the JSX, replace all usages:
- `style={td}` → `style={S.td}`
- `style={th}` → `style={S.th}`
- `style={inputStyle}` → `style={S.input}`
- `style={btnPrimary}` → `style={S.btnPrimary}`
- `style={btnSecondary}` → `style={S.btnSecondary}`
- `style={btnDanger}` → `style={S.btnDanger}`
- Spread merges like `style={{ ...btnPrimary, marginLeft: 6 }}` → `style={{ ...S.btnPrimary, marginLeft: 6 }}`

Also replace the inline error banner style with `style={S.errorBanner}`.

- [ ] **Step 2: Apply same to GroupsScreen**

Repeat Step 1 for `src/screens/GroupsScreen.jsx`.

- [ ] **Step 3: Verify visually**

Open both screens in the browser. No visual change should be visible — same padding, colors, font sizes as before.

- [ ] **Step 4: Commit**

```bash
git add src/screens/TiersScreen.jsx src/screens/GroupsScreen.jsx
git commit -m "refactor: use shared styles in TiersScreen and GroupsScreen"
```

---

### Task 13: Apply shared styles to remaining screens

**Files:**
- Modify: `src/screens/TimeBlocksScreen.jsx`
- Modify: `src/screens/ActivitiesScreen.jsx`
- Modify: `src/screens/AnchorsScreen.jsx`
- Modify: `src/screens/CampSetup.jsx`
- Modify: `src/screens/ScheduleScreen.jsx` (style constants only)

- [ ] **Step 1: Apply to TimeBlocksScreen and ActivitiesScreen**

Follow the same pattern from Task 12 for both files.

- [ ] **Step 2: Apply to AnchorsScreen and CampSetup**

Follow the same pattern for both files.

- [ ] **Step 3: Apply to ScheduleScreen style constants**

Open `src/screens/ScheduleScreen.jsx`. At the bottom, the file has:
```js
const td = { ... }
const th = { ... }
const overlay = { ... }
const modalBox = { ... }
const btnPrimary = { ... }
const btnSecondary = { ... }
const btnDanger = { ... }
```

Add the import, then replace:
- `td` → `S.td` (note: ScheduleScreen's `td` has slightly different padding — keep that as a local override: `style={{ ...S.td, padding: '8px 10px', fontSize: 12, verticalAlign: 'middle' }}`)
- `th` → `S.th` (same — ScheduleScreen `th` has `whiteSpace: 'nowrap'`, keep as: `style={{ ...S.th, whiteSpace: 'nowrap' }}`)
- `overlay` → `S.overlay`
- `modalBox` where `maxWidth: 400` → `S.modalSm`
- `modalBox` where `width: 480` → `S.modalLg`
- `btnPrimary` → `S.btnPrimary`
- `btnSecondary` → `S.btnSecondary`
- `btnDanger` → `S.btnDanger`
- Delete the local constant declarations

- [ ] **Step 4: Verify visually**

Check each screen in the browser. No visual change expected.

- [ ] **Step 5: Commit**

```bash
git add src/screens/TimeBlocksScreen.jsx src/screens/ActivitiesScreen.jsx src/screens/AnchorsScreen.jsx src/screens/CampSetup.jsx src/screens/ScheduleScreen.jsx
git commit -m "refactor: use shared styles in all remaining screens"
```

---

### Task 14: Extract ScheduleScreen components — StatBadge and SlotCell

**Files:**
- Create: `src/components/schedule/StatBadge.jsx`
- Create: `src/components/schedule/SlotCell.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`

- [ ] **Step 1: Create src/components/schedule/StatBadge.jsx**

```jsx
export default function StatBadge({ label, value, color, onClick }) {
  const clickable = onClick && value > 0
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        background: 'var(--surface)', border: `1px solid ${clickable ? color || 'var(--border)' : 'var(--border)'}`,
        borderRadius: 6, padding: '8px 14px', textAlign: 'center', minWidth: 90,
        cursor: clickable ? 'pointer' : 'default', transition: 'border-color 0.15s',
      }}
      title={clickable ? 'Click to see details' : undefined}
    >
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>
        {label}{clickable ? ' ↗' : ''}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Find SlotCell in ScheduleScreen and extract it**

Open `src/screens/ScheduleScreen.jsx`. Find `function SlotCell(` (line 161). Cut the entire function and create `src/components/schedule/SlotCell.jsx`:

```jsx
const ANCHOR_COLOR = '#A63595'
const FLAG_COLORS = {
  UNFILLABLE: '#F0585D',
  UNDERSERVED: '#F5A623',
  WEATHER_RISK: '#2F7DE1',
  DISTRIBUTION: '#7DC433',
}
function activityColor(idx) {
  const ACTIVITY_COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']
  return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length]
}

const cellTd = { padding: '6px 8px', width: 100, minWidth: 80, verticalAlign: 'top', cursor: 'pointer' }
const emptyTd = { padding: '6px 8px', width: 100, minWidth: 80, background: 'var(--bg)', opacity: 0.3 }

export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit }) {
  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td style={{ ...cellTd, background: '#F3E8FA', borderLeft: `3px solid ${ANCHOR_COLOR}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {anchor?.name || 'Anchor'}
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return <td style={{ ...cellTd, background: 'var(--bg)', opacity: 0.4 }} />
  }

  const flags = slot.flags || {}
  const hasFlags = Object.keys(flags).length > 0
  const isOutdoor = flags.WEATHER_RISK
  const color = activity ? activityColor(actColorIdx) : '#E0E0E0'
  const isWeatherHighlight = weatherMode && isOutdoor

  return (
    <td
      style={{
        ...cellTd,
        background: activity ? `${color}18` : '#F8F8F8',
        borderLeft: activity ? `3px solid ${color}` : '3px solid #E0E0E0',
        outline: isWeatherHighlight ? '2px solid #2F7DE1' : 'none',
        cursor: 'pointer',
        position: 'relative',
      }}
      onClick={() => onEdit(slot)}
      title={activity?.name || 'Empty — click to assign'}
    >
      <div style={{ fontSize: 11, fontWeight: activity ? 600 : 400, color: activity ? color : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activity?.name || <span style={{ opacity: 0.5 }}>—</span>}
      </div>
      {hasFlags && (
        <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
          {Object.keys(flags).map(f => (
            <span key={f} style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f] || '#ccc', display: 'inline-block' }} title={f} />
          ))}
        </div>
      )}
    </td>
  )
}
```

Remove the `ANCHOR_COLOR`, `FLAG_COLORS`, and `activityColor` declarations from `ScheduleScreen.jsx` (they now live in SlotCell). Remove the `cellTd` and `emptyTd` constants from the bottom of ScheduleScreen too.

- [ ] **Step 3: Update ScheduleScreen imports**

At the top of `src/screens/ScheduleScreen.jsx`, add:

```js
import StatBadge from '../components/schedule/StatBadge'
import SlotCell from '../components/schedule/SlotCell'
```

Remove the inline `StatBadge` and `SlotCell` function definitions from ScheduleScreen.

- [ ] **Step 4: Verify in browser**

Open the Schedule screen. The stats badges and all grid cells should render and be clickable exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/StatBadge.jsx src/components/schedule/SlotCell.jsx src/screens/ScheduleScreen.jsx
git commit -m "refactor: extract StatBadge and SlotCell from ScheduleScreen"
```

---

### Task 15: Extract FlagDetailModal, EditModal, ConfirmRegenModal

**Files:**
- Create: `src/components/schedule/FlagDetailModal.jsx`
- Create: `src/components/schedule/EditModal.jsx`
- Create: `src/components/schedule/ConfirmRegenModal.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`

- [ ] **Step 1: Extract FlagDetailModal**

Find `function FlagDetailModal(...)` in ScheduleScreen. Cut it and create `src/components/schedule/FlagDetailModal.jsx`. Add `import { S } from '../../styles/shared'` at the top. Export it as default.

- [ ] **Step 2: Extract EditModal**

Find the edit slot modal component (look for where `onSave={editSlotSave}` is used — the component definition will be above it). Cut it and create `src/components/schedule/EditModal.jsx`. Add `import { S } from '../../styles/shared'`. Export as default.

- [ ] **Step 3: Extract ConfirmRegenModal**

Find the inline `{confirmRegen && (...)}` block (around line 793–807). Convert it to a component:

```jsx
// src/components/schedule/ConfirmRegenModal.jsx
import { S } from '../../styles/shared'

export default function ConfirmRegenModal({ onConfirm, onCancel }) {
  return (
    <div style={S.overlay}>
      <div style={S.modalSm}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
          Regenerate from Scratch?
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
          This will delete your current schedule including all manual edits. Continue?
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={S.btnSecondary}>Cancel</button>
          <button onClick={onConfirm} style={S.btnDanger}>Yes, Regenerate</button>
        </div>
      </div>
    </div>
  )
}
```

Replace the inline JSX block in ScheduleScreen with:

```jsx
{confirmRegen && (
  <ConfirmRegenModal
    onConfirm={regenFromScratch}
    onCancel={() => setConfirmRegen(false)}
  />
)}
```

- [ ] **Step 4: Update imports in ScheduleScreen**

```js
import FlagDetailModal from '../components/schedule/FlagDetailModal'
import EditModal from '../components/schedule/EditModal'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'
```

- [ ] **Step 5: Verify in browser**

Open Schedule screen. Generate a schedule. Click stat badges (FlagDetailModal), click a cell (EditModal), click "Regenerate from Scratch" (ConfirmRegenModal). All should work identically to before.

- [ ] **Step 6: Commit**

```bash
git add src/components/schedule/FlagDetailModal.jsx src/components/schedule/EditModal.jsx src/components/schedule/ConfirmRegenModal.jsx src/screens/ScheduleScreen.jsx
git commit -m "refactor: extract FlagDetailModal, EditModal, ConfirmRegenModal from ScheduleScreen"
```

---

## Track 5: Drag-and-Drop Prototype

### Task 16: Add swapSlots function to ScheduleScreen

**Files:**
- Modify: `src/screens/ScheduleScreen.jsx`

- [ ] **Step 1: Add swapSlots function**

Open `src/screens/ScheduleScreen.jsx`. After `editSlotSave` (around line 385), add:

```js
async function swapSlots(slotA, slotB) {
  // slotA and slotB are { groupId, dayId, blockId, activityId }
  if (!templateId) return
  await Promise.all([
    supabase.from('template_slots')
      .update({ activity_id: slotB.activityId || null, flags: {} })
      .eq('template_id', templateId)
      .eq('group_id', slotA.groupId)
      .eq('day_id', slotA.dayId)
      .eq('time_block_id', slotA.blockId),
    supabase.from('template_slots')
      .update({ activity_id: slotA.activityId || null, flags: {} })
      .eq('template_id', templateId)
      .eq('group_id', slotB.groupId)
      .eq('day_id', slotB.dayId)
      .eq('time_block_id', slotB.blockId),
  ])
  setSlots(prev => prev.map(s => {
    if (s.group_id === slotA.groupId && s.day_id === slotA.dayId && s.time_block_id === slotA.blockId)
      return { ...s, activity_id: slotB.activityId || null, flags: {} }
    if (s.group_id === slotB.groupId && s.day_id === slotB.dayId && s.time_block_id === slotB.blockId)
      return { ...s, activity_id: slotA.activityId || null, flags: {} }
    return s
  }))
}
```

- [ ] **Step 2: Commit (function exists but not yet wired to DnD)**

```bash
git add src/screens/ScheduleScreen.jsx
git commit -m "feat: add swapSlots function to ScheduleScreen"
```

---

### Task 17: Wire @dnd-kit drag-and-drop in Group view

**Files:**
- Modify: `package.json` / install
- Modify: `src/components/schedule/SlotCell.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`

- [ ] **Step 1: Install @dnd-kit/core**

```bash
npm install @dnd-kit/core
```

- [ ] **Step 2: Add DnD to SlotCell**

Open `src/components/schedule/SlotCell.jsx`. The existing `export default function SlotCell` returns a `<td>`. Add a new `isDndEnabled` prop and wrap with DnD hooks. Replace the file's export with:

```jsx
import { useDraggable, useDroppable } from '@dnd-kit/core'

// ... (keep ANCHOR_COLOR, FLAG_COLORS, activityColor, cellTd, emptyTd as-is)

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
    disabled: !canDrag,
    data: { slot },
  })

  const setRef = el => { setDragRef(el); setDropRef(el) }
  const dndStyle = isDragging ? { opacity: 0.4 } : isOver && canDrag ? { outline: '2px solid var(--primary)', outlineOffset: -2 } : {}

  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td ref={setRef} style={{ ...cellTd, background: '#F3E8FA', borderLeft: `3px solid ${ANCHOR_COLOR}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {anchor?.name || 'Anchor'}
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return <td ref={setRef} style={{ ...cellTd, background: 'var(--bg)', opacity: 0.4 }} />
  }

  const flags = slot.flags || {}
  const hasFlags = Object.keys(flags).length > 0
  const color = activity ? activityColor(actColorIdx) : '#E0E0E0'
  const isWeatherHighlight = weatherMode && flags.WEATHER_RISK

  return (
    <td
      ref={setRef}
      style={{ ...cellTd, background: activity ? `${color}18` : '#F8F8F8', borderLeft: activity ? `3px solid ${color}` : '3px solid #E0E0E0', outline: isWeatherHighlight ? '2px solid #2F7DE1' : 'none', cursor: 'pointer', position: 'relative', ...dndStyle }}
      onClick={() => onEdit(slot)}
      title={activity?.name || 'Empty — click to assign'}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
    >
      <div style={{ fontSize: 11, fontWeight: activity ? 600 : 400, color: activity ? color : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activity?.name || <span style={{ opacity: 0.5 }}>—</span>}
      </div>
      {hasFlags && (
        <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
          {Object.keys(flags).map(f => (
            <span key={f} style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f] || '#ccc', display: 'inline-block' }} title={f} />
          ))}
        </div>
      )}
    </td>
  )
}
```

- [ ] **Step 3: Wire DnDContext in ScheduleScreen Group view**

Open `src/screens/ScheduleScreen.jsx`. Add import:

```js
import { DndContext } from '@dnd-kit/core'
```

In the Group view render section (around line 565), wrap the `<table>` with `<DndContext>`:

```jsx
<DndContext
  onDragEnd={({ active, over }) => {
    if (!over) return
    const slotA = active.data.current?.slot
    const slotB = over.data.current?.slot
    if (!slotA || !slotB) return
    if (slotA.groupId === slotB.groupId && slotA.dayId === slotB.dayId && slotA.blockId === slotB.blockId) return
    if (slotB.type === 'anchor' || slotB.type === 'unavailable') return
    swapSlots(
      { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activityId },
      { groupId: slotB.groupId, dayId: slotB.dayId, blockId: slotB.blockId, activityId: slotB.activityId }
    )
  }}
>
  <table>...</table>
</DndContext>
```

Pass `isDndEnabled={true}` to every `<SlotCell>` rendered in the Group view (around line 570). The Daily and Activity views already use `<SlotCell>` without this prop — it defaults to `undefined` (falsy), so those views won't be affected.

- [ ] **Step 4: Verify prototype**

Open the Schedule screen, Group view. Generate or load a schedule. Try dragging one cell onto another — the activities should swap immediately. Anchor and unavailable cells should not be draggable. Daily and Activity views should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/components/schedule/SlotCell.jsx src/screens/ScheduleScreen.jsx
git commit -m "feat(prototype): drag-and-drop swap in Schedule Group view"
```

---

## Final Step: Push

```bash
git push -u origin claude/intelligent-hopper-QaSJ3
```
