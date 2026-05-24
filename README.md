# Shoresh

Camp activity scheduling — multi-tenant SaaS for managing weekly schedules across groups, tiers, and time blocks.

---

## What it does

Shoresh lets camp directors build and iterate on weekly activity schedules. You define your groups, tiers, time blocks, and activities — then the engine generates a schedule that respects eligibility rules, location capacity, min/max frequencies, and outdoor-activity preferences. From there you can drag slots, lock activities, dismiss flags, and snapshot versions.

**Core features:**
- **Schedule engine** — deterministic, pure-function scheduler with priority rounds and constraint scoring
- **Drag-and-drop** — swap slots between groups directly on the grid
- **Flag system** — automatic warnings for unfillable slots, underserved activities, weather risk, and distribution goals
- **Snapshots** — named versions with auto-save before every regeneration
- **Anchor activities** — fixed slots (meals, rest) that the engine works around
- **Multi-tenant** — each camp is fully isolated behind Supabase Auth + Row Level Security

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite |
| Database + Auth | Supabase (PostgreSQL + Auth) |
| Drag and drop | @dnd-kit/core |
| Tests | Vitest |
| Deployment | Vercel |

---

## Running locally

```bash
git clone https://github.com/gfeitel1-maker/shoresh.git
cd shoresh
npm install
```

Create a `.env` file at the project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

```bash
npm run dev
```

App runs at `http://localhost:5173`. Sign up with an email and camp name to get started.

---

## Project structure

```
src/
  engine/         # Pure schedule-building logic (no React, no Supabase)
  screens/        # Top-level page components
  components/     # Shared UI — schedule grid, modals, layout
  hooks/          # useSession (auth state)
  styles/         # Shared inline style constants
supabase/
  migrations/     # SQL migration files
docs/
  superpowers/
    specs/        # Design specs for each feature
    plans/        # Implementation plans
```

The schedule engine (`src/engine/buildSchedule.js`) is a pure function — given groups, activities, anchors, and constraints, it returns slots and a stats object. No side effects, fully unit-tested.

---

## Database migrations

Migrations live in `supabase/migrations/` and are applied manually via the Supabase SQL editor or CLI. Run them in filename order.

---

## Environment variables

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key (safe to expose — RLS enforces data isolation) |

Never use the `service_role` key in the frontend.
