# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Dev server at http://localhost:5200
npm run build     # Production build
npm run lint      # ESLint
npm run test      # Run all Vitest tests
npm test -- src/path/to/file.test.js  # Run a single test file
```

## Architecture

**Auth gate** — `src/App.jsx` is the entry point. It uses `useSession()` to gate rendering: no session → `AuthScreen`, session but no campId → recovery screen, both present → the app. `campId` flows as a prop to every screen.

**Session & auth** — `src/hooks/useSession.js` wraps Supabase auth state. It exports `useSession()` (returns `{ session, campId, loading }`) and `resolveCampId(session)` (queries the `camps` table to find the camp owned by the current user). All data isolation is enforced at the DB layer via Row Level Security — the anon key is safe in the frontend because RLS policies block cross-tenant access.

**Screen routing** — screens live in `src/screens/` and are registered in the `SCREENS` object in `App.jsx`. Navigation is a simple string state (`screen`) passed to `Shell` → `Sidebar`.

**Schedule engine** — `src/engine/buildSchedule.js` is a pure function with no React or Supabase dependencies. Signature: `buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })` → `{ slots, stats }`. It runs in three passes: resolve eligibility, place activities (high-priority round then low-priority), audit flags. Uses a seeded PRNG (DJB2 + Mulberry32) so identical inputs produce identical schedules. This is the only file with unit tests (`src/engine/buildSchedule.test.js`).

**ScheduleScreen** — `src/screens/ScheduleScreen.jsx` is the most complex file. It owns the schedule state, DnD context (`@dnd-kit/core` with `distance: 8` activation constraint to coexist with click handlers), flag dismissal, activity locking, slot swapping, and snapshot management. Three views: group (one group across all days), day (all groups on one day), activity drilldown.

**Styling** — all styles are inline React objects. Shared constants live in `src/styles/shared.js` and are imported as `import { S } from '../styles/shared'`. Component-specific styles are defined as `const` objects at the bottom of each file. No CSS files, no CSS modules.

**Supabase** — single client instance at `src/supabase.js`. All tables have RLS enabled. `template_slots` and `schedule_snapshots` do not have a direct `camp_id` column — their RLS policies join through `schedule_templates` using a subquery. The `get_my_camp_id()` SQL function (defined in migrations) is the shared helper used by all RLS policies.

## Environment

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Database migrations

Migrations are in `supabase/migrations/` and applied manually via the Supabase SQL editor. Run in filename order. The service role key is never used in the frontend.
