# Legacy Supabase path

This directory holds the pre-rebuild Supabase (Postgres + Auth + RLS) backend that Shoresh
originally shipped with, before the migration to the Electron + SQLite + LAN-sync local-first
architecture described in the root [`CLAUDE.md`](../../CLAUDE.md).

- `supabase.js` — the old Supabase client instance (previously `src/supabase.js`).
- `migrations/` — the old Postgres migrations, applied manually via the Supabase SQL editor in
  filename order (previously `supabase/migrations/`).

This code is kept for historical/reference purposes only. It is **not imported by any active
code** under `src/` or `electron/`, and `@supabase/supabase-js` has been removed from
`package.json` — do not resurrect or extend this path. New work should target the
Electron/SQLite local-first architecture; see [`PLATFORM_STATE.md`](../../PLATFORM_STATE.md) for
what's actually active.
