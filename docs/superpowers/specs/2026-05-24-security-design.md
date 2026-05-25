# Security Design: Auth, RLS, GitHub & Vercel

**Goal:** Multi-tenant-safe — each camp's data fully isolated, only authenticated owners can access.

## Auth
- Supabase Auth (email/password)
- `AuthScreen.jsx`: Login + Signup tabs
- `useSession.js`: wraps `onAuthStateChange`, exposes `{ session, campId, loading }`

## RLS
- `get_my_camp_id()` SECURITY DEFINER function
- All tables: `camp_id = get_my_camp_id()`
- `camps` table: `owner_user_id = auth.uid()`
- `template_slots` / `schedule_snapshots`: join through `schedule_templates`

## Migrations
- `20260524_01_auth_owner.sql`: Add `owner_user_id`, create `get_my_camp_id()`
- `20260524_02_rls_policies.sql`: Enable RLS + create policies on all 10 tables
