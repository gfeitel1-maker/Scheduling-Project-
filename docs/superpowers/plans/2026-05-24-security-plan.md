# Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Supabase Auth + Row Level Security so each camp's data is fully isolated behind a login wall, and remove the unauthenticated open camp-name lookup.

**Architecture:** Supabase Auth (email/password) stores sessions in localStorage via the JS client. A `useSession` hook wraps `onAuthStateChange` and resolves the authenticated user's campId. `App.jsx` gates on `session` — no session → `AuthScreen`, session → existing app. RLS on all tables enforces data isolation at the DB layer using a `get_my_camp_id()` helper function. GitHub and Vercel hardening is configuration-only.

**Tech Stack:** Supabase Auth, PostgreSQL RLS, React hooks, Vitest

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `supabase/migrations/20260524_01_auth_owner.sql` | Create | Add `owner_user_id` to camps, create `get_my_camp_id()` |
| `supabase/migrations/20260524_02_rls_policies.sql` | Create | Enable RLS + policies on all 10 tables |
| `src/hooks/useSession.js` | Create | Auth state hook — exposes `{ session, campId, loading }` |
| `src/screens/AuthScreen.jsx` | Create | Login + Signup tabs |
| `src/App.jsx` | Modify | Use `useSession`, gate on session, remove URL/localStorage camp logic |
| `src/components/layout/TopBar.jsx` | Modify | Add logout button |
| `src/components/entry/LandingScreen.jsx` | Delete | Replaced by AuthScreen |

---

## Task 1: Migration — owner_user_id + get_my_camp_id()

**Files:**
- Create: `supabase/migrations/20260524_01_auth_owner.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260524_01_auth_owner.sql

-- Link each camp to its owner in auth.users
ALTER TABLE camps ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id);

-- Helper: returns the camp_id owned by the currently authenticated user.
-- Used by all RLS policies so they don't repeat the subquery.
CREATE OR REPLACE FUNCTION get_my_camp_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM camps WHERE owner_user_id = auth.uid() LIMIT 1
$$;
```

- [ ] **Step 2: Run in Supabase SQL editor**

Open Supabase dashboard → SQL Editor → paste and run the file contents.
Expected: no errors, `camps` table now has `owner_user_id` column.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260524_01_auth_owner.sql
git commit -m "feat: add owner_user_id to camps and get_my_camp_id() function"
```

---

## Task 2: Migration — RLS on all tables

**Files:**
- Create: `supabase/migrations/20260524_02_rls_policies.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260524_02_rls_policies.sql

-- ── camps ──────────────────────────────────────────────────────────────────
ALTER TABLE camps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "camps_owner_select" ON camps
  FOR SELECT USING (owner_user_id = auth.uid());

CREATE POLICY "camps_owner_insert" ON camps
  FOR INSERT WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY "camps_owner_update" ON camps
  FOR UPDATE USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ── groups ─────────────────────────────────────────────────────────────────
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "groups_owner" ON groups FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── tiers ──────────────────────────────────────────────────────────────────
ALTER TABLE tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tiers_owner" ON tiers FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── days_of_operation ──────────────────────────────────────────────────────
ALTER TABLE days_of_operation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "days_of_operation_owner" ON days_of_operation FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── time_blocks ────────────────────────────────────────────────────────────
ALTER TABLE time_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "time_blocks_owner" ON time_blocks FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── activities ─────────────────────────────────────────────────────────────
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "activities_owner" ON activities FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── anchor_activities ──────────────────────────────────────────────────────
ALTER TABLE anchor_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anchor_activities_owner" ON anchor_activities FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── schedule_templates ─────────────────────────────────────────────────────
ALTER TABLE schedule_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schedule_templates_owner" ON schedule_templates FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── template_slots ─────────────────────────────────────────────────────────
ALTER TABLE template_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "template_slots_owner" ON template_slots FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());

-- ── schedule_snapshots ─────────────────────────────────────────────────────
ALTER TABLE schedule_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schedule_snapshots_owner" ON schedule_snapshots FOR ALL
  USING (camp_id = get_my_camp_id()) WITH CHECK (camp_id = get_my_camp_id());
```

- [ ] **Step 2: Run in Supabase SQL editor**

Open Supabase dashboard → SQL Editor → paste and run the file contents.
Expected: no errors. Each table now has RLS enabled.

- [ ] **Step 3: Verify RLS is active**

In the Supabase Table Editor, select `groups` — you should see "RLS enabled" badge on the table header.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260524_02_rls_policies.sql
git commit -m "feat: enable RLS on all tables with camp owner policies"
```

---

## Task 3: useSession hook

**Files:**
- Create: `src/hooks/useSession.js`
- Test: `src/hooks/useSession.test.js`

- [ ] **Step 1: Create the hooks directory and write the failing test**

```bash
mkdir -p src/hooks
```

```js
// @vitest-environment node
// src/hooks/useSession.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the supabase module before importing the hook
vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(),
  },
}))

import { supabase } from '../supabase'

// useSession is a React hook — test its internal logic directly
// by simulating what onAuthStateChange would emit
describe('useSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves campId when a session and camp row exist', async () => {
    const fakeSession = { user: { id: 'user-123' } }
    const fakeCamp = { id: 'camp-abc' }

    supabase.auth.getSession.mockResolvedValue({ data: { session: fakeSession } })
    supabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: fakeCamp }),
        }),
      }),
    })

    // Import here so mock is applied
    const { resolveCampId } = await import('./useSession.js')
    const campId = await resolveCampId(fakeSession)
    expect(campId).toBe('camp-abc')
  })

  it('returns null campId when session is null', async () => {
    const { resolveCampId } = await import('./useSession.js')
    const campId = await resolveCampId(null)
    expect(campId).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- src/hooks/useSession.test.js
```
Expected: FAIL — `resolveCampId` not exported

- [ ] **Step 3: Implement useSession**

```js
// src/hooks/useSession.js
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export async function resolveCampId(session) {
  if (!session) return null
  const { data } = await supabase
    .from('camps')
    .select('id')
    .eq('owner_user_id', session.user.id)
    .maybeSingle()
  return data?.id ?? null
}

export function useSession() {
  const [session, setSession] = useState(null)
  const [campId, setCampId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s)
      setCampId(await resolveCampId(s))
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s)
      setCampId(await resolveCampId(s))
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  return { session, campId, loading }
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npm test -- src/hooks/useSession.test.js
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSession.js src/hooks/useSession.test.js
git commit -m "feat: add useSession hook with resolveCampId"
```

---

## Task 4: AuthScreen

**Files:**
- Create: `src/screens/AuthScreen.jsx`
- Test: `src/screens/AuthScreen.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
// src/screens/AuthScreen.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AuthScreen from './AuthScreen'

vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      signUp: vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    },
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue({ error: null }),
    }),
  },
}))

describe('AuthScreen', () => {
  it('renders login tab by default', () => {
    render(<AuthScreen />)
    expect(screen.getByText('Log in')).toBeTruthy()
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy()
  })

  it('switches to signup tab', () => {
    render(<AuthScreen />)
    fireEvent.click(screen.getByText('Sign up'))
    expect(screen.getByPlaceholderText('Camp Achva')).toBeTruthy()
  })

  it('shows error on empty login submit', async () => {
    render(<AuthScreen />)
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
    // button disabled when fields empty — no error shown
    const btn = screen.getByRole('button', { name: /log in/i })
    expect(btn.disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Install @testing-library/react if not present**

```bash
npm list @testing-library/react || npm install --save-dev @testing-library/react jsdom
```

The `vite.config.js` global test environment stays `node` (so `buildSchedule.test.js` keeps working). The `// @vitest-environment jsdom` comment at the top of `AuthScreen.test.jsx` overrides the environment for that file only.

- [ ] **Step 3: Run test to confirm it fails**

```bash
npm test -- src/screens/AuthScreen.test.jsx
```
Expected: FAIL — module not found

- [ ] **Step 4: Implement AuthScreen**

```jsx
// src/screens/AuthScreen.jsx
import { useState } from 'react'
import { supabase } from '../supabase'

export default function AuthScreen() {
  const [tab, setTab] = useState('login') // 'login' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [campName, setCampName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function handleLogin(e) {
    e.preventDefault()
    setError(''); setMessage('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) setError(error.message)
    // on success: onAuthStateChange in useSession handles the rest
  }

  async function handleForgot() {
    if (!email.trim()) { setError('Enter your email above first.'); return }
    setError(''); setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim())
    setLoading(false)
    if (error) setError(error.message)
    else setMessage('Check your email for a password reset link.')
  }

  async function handleSignup(e) {
    e.preventDefault()
    setError(''); setMessage('')
    if (!campName.trim()) { setError('Camp name is required.'); return }
    setLoading(true)
    const { data, error: signUpError } = await supabase.auth.signUp({ email, password })
    if (signUpError) { setLoading(false); setError(signUpError.message); return }

    if (data.user) {
      const { error: campError } = await supabase
        .from('camps')
        .insert({ name: campName.trim(), owner_user_id: data.user.id })
      if (campError) { setLoading(false); setError(campError.message); return }
    } else {
      // email confirmation required
      setLoading(false)
      setMessage('Check your email to confirm your account, then log in.')
      return
    }
    setLoading(false)
    // on success: onAuthStateChange in useSession handles the rest
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={logoBlock}>
          <div style={logo}>Shoresh</div>
          <div style={logoSub}>Camp activity scheduling</div>
        </div>

        <div style={tabs}>
          <button style={tab === 'login' ? activeTab : inactiveTab} onClick={() => { setTab('login'); setError(''); setMessage('') }}>Log in</button>
          <button style={tab === 'signup' ? activeTab : inactiveTab} onClick={() => { setTab('signup'); setError(''); setMessage('') }}>Sign up</button>
        </div>

        {error && <div style={errorBox}>{error}</div>}
        {message && <div style={messageBox}>{message}</div>}

        {tab === 'login' && (
          <form onSubmit={handleLogin}>
            <label style={lbl}>Email</label>
            <input style={inputStyle} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
            <label style={lbl}>Password</label>
            <input style={inputStyle} type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="submit" style={btnPrimary} disabled={!email.trim() || !password.trim() || loading}>
              {loading ? 'Logging in…' : 'Log in'}
            </button>
            <button type="button" style={linkBtn} onClick={handleForgot}>Forgot password?</button>
          </form>
        )}

        {tab === 'signup' && (
          <form onSubmit={handleSignup}>
            <label style={lbl}>Camp name</label>
            <input style={inputStyle} type="text" placeholder="Camp Achva" value={campName} onChange={e => setCampName(e.target.value)} autoFocus />
            <label style={lbl}>Email</label>
            <input style={inputStyle} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            <label style={lbl}>Password</label>
            <input style={inputStyle} type="password" placeholder="At least 6 characters" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="submit" style={btnPrimary} disabled={!campName.trim() || !email.trim() || !password.trim() || loading}>
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const page = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '40px 48px', maxWidth: 440, width: '100%' }
const logoBlock = { marginBottom: 28 }
const logo = { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 28, color: 'var(--primary)', letterSpacing: '-0.5px' }
const logoSub = { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2 }
const tabs = { display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1.5px solid var(--border)' }
const activeTab = { background: 'none', border: 'none', borderBottom: '2px solid var(--primary)', marginBottom: -2, padding: '8px 16px', fontWeight: 700, fontSize: 13, color: 'var(--primary)', cursor: 'pointer', fontFamily: 'inherit' }
const inactiveTab = { background: 'none', border: 'none', borderBottom: '2px solid transparent', marginBottom: -2, padding: '8px 16px', fontWeight: 500, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit' }
const lbl = { fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 5, marginTop: 14, color: 'var(--text-secondary)' }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1.5px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', marginBottom: 0, outline: 'none', background: 'var(--bg)', boxSizing: 'border-box' }
const btnPrimary = { display: 'block', width: '100%', padding: '10px 0', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 }
const linkBtn = { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: '8px 0 0 0', fontFamily: 'inherit', display: 'block' }
const errorBox = { background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#c0392b', marginBottom: 12 }
const messageBox = { background: '#f0faf5', border: '1px solid #a8e6c8', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#1a7a4a', marginBottom: 12 }
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
npm test -- src/screens/AuthScreen.test.jsx
```
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/screens/AuthScreen.jsx src/screens/AuthScreen.test.jsx
git commit -m "feat: add AuthScreen with login and signup tabs"
```

---

## Task 5: Wire App.jsx, TopBar, and remove LandingScreen

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/components/layout/TopBar.jsx`
- Delete: `src/components/entry/LandingScreen.jsx`

- [ ] **Step 1: Update App.jsx**

Replace the entire content of `src/App.jsx` with:

```jsx
// src/App.jsx
import { useEffect } from 'react'
import Shell from './components/layout/Shell'
import AuthScreen from './screens/AuthScreen'
import CampSetup from './screens/CampSetup'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import { useSession } from './hooks/useSession'
import { supabase } from './supabase'
import { useState } from 'react'

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

export default function App() {
  const { session, campId, loading } = useSession()
  const [screen, setScreen] = useState('setup')

  useEffect(() => {
    if (campId) seedDays(campId)
  }, [campId])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)', color: 'var(--text-secondary)', fontSize: 13 }}>
        Loading…
      </div>
    )
  }

  if (!session || !campId) {
    return <AuthScreen />
  }

  const Screen = SCREENS[screen] || CampSetup

  return (
    <Shell currentScreen={screen} onNavigate={setScreen} campId={campId} onLogout={() => supabase.auth.signOut()}>
      <Screen campId={campId} onNavigate={setScreen} />
    </Shell>
  )
}
```

- [ ] **Step 2: Update Shell.jsx to pass onLogout to TopBar**

Replace the Shell component in `src/components/layout/Shell.jsx`:

```jsx
// src/components/layout/Shell.jsx
import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Shell({ children, currentScreen, onNavigate, campId, onLogout }) {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar current={currentScreen} onNavigate={onNavigate} campId={campId} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar screen={currentScreen} onLogout={onLogout} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {children}
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Update TopBar.jsx to show logout button**

Replace the entire content of `src/components/layout/TopBar.jsx`:

```jsx
// src/components/layout/TopBar.jsx
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

export default function TopBar({ screen, onLogout }) {
  return (
    <header style={{
      height: 52, minHeight: 52, background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px',
    }}>
      <h1 style={{
        fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18,
        letterSpacing: '-0.2px', color: 'var(--text)',
      }}>
        {TITLES[screen] || 'Shoresh'}
      </h1>
      {onLogout && (
        <button onClick={onLogout} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 6,
          padding: '5px 12px', fontSize: 12, color: 'var(--text-secondary)',
          cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
        }}>
          Log out
        </button>
      )}
    </header>
  )
}
```

- [ ] **Step 4: Delete LandingScreen**

```bash
rm src/components/entry/LandingScreen.jsx
```

- [ ] **Step 5: Verify the app builds without errors**

```bash
npm run build 2>&1 | tail -10
```
Expected: build succeeds, no import errors referencing LandingScreen

- [ ] **Step 6: Run all tests**

```bash
npm test
```
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/components/layout/Shell.jsx src/components/layout/TopBar.jsx
git rm src/components/entry/LandingScreen.jsx
git commit -m "feat: gate app on Supabase auth session, add logout button"
```

---

## Task 6: Push and verify

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

- [ ] **Step 2: Manual integration test (do in browser)**

1. Open the app (local dev or deployed URL)
2. You should see the Login/Signup screen — not the old camp name lookup
3. Sign up with a new email + camp name → you should land inside the app
4. Log out → you should return to the login screen
5. Log back in → you should land back in your camp automatically
6. Open an incognito window and try to access the app → should show login screen

- [ ] **Step 3: Verify RLS is blocking unauthenticated access**

In the Supabase SQL editor, run:
```sql
-- Should return 0 rows (no active session = RLS blocks everything)
SELECT * FROM groups LIMIT 5;
```
Expected: 0 rows returned (RLS active, no auth.uid())

---

## Task 7: GitHub & Vercel hardening (manual config)

These are configuration steps in external dashboards — no code changes.

**GitHub (app.github.com → your repo → Settings):**

- [ ] **Branch protection:** Settings → Branches → Add rule for `main`
  - Check: "Require status checks to pass before merging"
  - Check: "Do not allow bypassing the above settings"
  - Check: "Restrict who can push to matching branches" (just you)

- [ ] **Secret scanning:** Settings → Code security and analysis
  - Enable "Secret scanning"
  - Enable "Push protection"

- [ ] **Dependabot:** Settings → Code security and analysis
  - Enable "Dependabot alerts"
  - Enable "Dependabot security updates"

**Vercel (vercel.com → your project → Settings):**

- [ ] **Environment variables:** Settings → Environment Variables
  - Add `VITE_SUPABASE_URL` = your project URL (all environments)
  - Add `VITE_SUPABASE_ANON_KEY` = your anon key (all environments)
  - Confirm service role key is NOT present anywhere

- [ ] **Preview protection:** Settings → Deployment Protection
  - Enable "Vercel Authentication" for Preview deployments

- [ ] **Production domain:** Settings → Domains
  - Verify production is served from your custom domain, not raw `*.vercel.app`
