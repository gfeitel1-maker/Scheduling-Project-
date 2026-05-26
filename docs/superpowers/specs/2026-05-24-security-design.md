# Security Design: Auth, RLS, GitHub & Vercel

**Goal:** Make Shoresh multi-tenant-safe — each camp's data is fully isolated, only authenticated owners can access their camp, and no credentials are exposed in the codebase or deployments.

**Architecture:** Supabase Auth (email/password) gates access. Row Level Security on every table enforces data isolation at the database layer. The frontend replaces the current open camp-name lookup with a Login/Signup screen. GitHub and Vercel are hardened via configuration only.

**Tech Stack:** Supabase Auth, PostgreSQL RLS, React (AuthScreen + useSession hook), Vercel dashboard config, GitHub repo settings.

---

## 1. Supabase — Data Model Changes

### 1.1 `camps` table
Add column:
```sql
ALTER TABLE camps ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id);
```

### 1.2 RLS helper function
```sql
CREATE OR REPLACE FUNCTION get_my_camp_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM camps WHERE owner_user_id = auth.uid() LIMIT 1
$$;
```

---

## 2. Row Level Security

Enable RLS and add policies on every table. All tables except `camps` use the same pattern.

### 2.1 Standard policy (all tables with `camp_id`)
Tables: `groups`, `tiers`, `days_of_operation`, `time_blocks`, `activities`, `anchor_activities`, `schedule_templates`, `template_slots`, `schedule_snapshots`

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY "<table>_owner" ON <table>
  FOR ALL
  USING (camp_id = get_my_camp_id())
  WITH CHECK (camp_id = get_my_camp_id());
```

### 2.2 `camps` table policy
```sql
ALTER TABLE camps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "camps_owner_select" ON camps
  FOR SELECT USING (owner_user_id = auth.uid());

CREATE POLICY "camps_owner_insert" ON camps
  FOR INSERT WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY "camps_owner_update" ON camps
  FOR UPDATE USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());
```

No DELETE policy on camps — camps are not self-deletable.

---

## 3. Auth UI

### 3.1 New files
- `src/screens/AuthScreen.jsx` — Login and Signup tabs
- `src/hooks/useSession.js` — wraps `onAuthStateChange`, exposes `{ session, campId, loading }`

### 3.2 `useSession.js` behaviour
```js
// On mount: subscribe to onAuthStateChange
// session present → query camps where owner_user_id = user.id → store campId
// session absent → campId is null
// Expose: { session, campId, loading }
```

### 3.3 `AuthScreen.jsx` — Login tab
- Fields: email, password
- Submit: `supabase.auth.signInWithPassword({ email, password })`
- On success: `onAuthStateChange` fires → `useSession` resolves campId → app renders
- Error: show inline message (invalid credentials, unconfirmed email)
- "Forgot password?" link → calls `supabase.auth.resetPasswordForEmail(email)` → show "Check your email" confirmation

### 3.4 `AuthScreen.jsx` — Signup tab
- Fields: camp name, email, password
- Submit sequence:
  1. `supabase.auth.signUp({ email, password })`
  2. On success: `supabase.from('camps').insert({ name: campName, owner_user_id: user.id })`
  3. `onAuthStateChange` fires → `useSession` resolves campId → app renders
- Error: show inline message (email taken, weak password)
- If Supabase email confirmation is enabled, show "Check your email to confirm your account" instead of entering the app

### 3.5 `App.jsx` changes
- Wrap app with `useSession`
- If `loading`: show spinner
- If `!session`: render `<AuthScreen />`
- If `session && campId`: render existing app with `campId` from session (remove `?camp=` URL param and localStorage lookup entirely)
- Add logout button to app header: calls `supabase.auth.signOut()`

### 3.6 `LandingScreen.jsx`
- Remove entirely — replaced by `AuthScreen`

---

## 4. GitHub Hardening

All configuration — no code changes.

| Setting | Location | Value |
|---|---|---|
| Branch protection | Settings → Branches → main | Require status checks to pass, no force-push, no deletion |
| Secret scanning | Settings → Code security | Enable |
| Push protection | Settings → Code security | Enable (blocks pushes containing secrets) |
| Dependabot alerts | Settings → Code security | Enable for npm |
| `.mcp.json` gitignored | `.gitignore` | Already done |
| `.env` gitignored | `.gitignore` | Already done |

---

## 5. Vercel Hardening

All configuration — no code changes.

| Setting | Location | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | Project Settings → Environment Variables | Set for Production, Preview, Development |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → Environment Variables | Set for Production, Preview, Development |
| Preview protection | Settings → Deployment Protection | Enable Vercel Authentication on Preview deployments |
| Production domain | Settings → Domains | Lock to custom domain; disable raw `*.vercel.app` URL |
| Service role key | Anywhere | Never set — not needed for a static SPA |

---

## 6. Migration Files

Two new migration files:

### `supabase/migrations/20260524_01_auth_owner.sql`
- Add `owner_user_id` to `camps`
- Create `get_my_camp_id()` function

### `supabase/migrations/20260524_02_rls_policies.sql`
- Enable RLS and create policies on all 10 tables

---

## 7. What Does Not Change

- All existing Supabase queries in the app (`eq('camp_id', campId)`) stay in place — they become redundant safety nets on top of RLS, which is fine.
- The schedule engine, DnD, flags, snapshots, and all other features are untouched.
- The anon key remains the only key in the frontend — it is safe once RLS is active.

---

## 8. Out of Scope

- Multi-role access within a camp (admin + staff) — deferred
- Social login (Google, etc.) — deferred
- MFA — deferred
- Camp deletion / account management — deferred
