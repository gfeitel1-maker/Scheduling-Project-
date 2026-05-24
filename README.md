# Shoresh

Camp activity scheduling — built for the complexity of real camps.

---

Shoresh is a scheduling tool for camp directors who manage dozens of groups, activities, locations, and constraints every week. Instead of wrestling with spreadsheets, you define the rules once and let the engine build the schedule — then adjust, lock, and iterate from there.

## The problem it solves

Camp scheduling is a constraint satisfaction problem dressed up as a logistics problem. A typical week involves:

- Groups with different availability windows (morning-only, full-day)
- Activities with location capacity, tier eligibility, and frequency goals
- Anchors that can't move (meals, rest, all-camp events)
- Preferences like "swimming should happen before Wednesday"
- Staff who need to know the final schedule before Sunday

Spreadsheets break down fast. Shoresh handles the constraints, surfaces the conflicts, and keeps a full version history.

## How it works

The core is a pure scheduling engine (`src/engine/buildSchedule.js`) — a deterministic function that takes your groups, activities, anchors, and constraints, and returns a complete slot assignment with a flag report. No side effects, fully unit-tested, runs in milliseconds.

From there, a React UI lets you:

- View the schedule by group, by day, or by activity
- Drag and drop to swap slots between groups
- Lock activities so regeneration doesn't touch them
- Dismiss or investigate flags (unfillable slots, underserved activities, weather risk)
- Save named snapshots and restore previous versions

Each camp is fully isolated — separate auth, separate data, no shared state between tenants.

## Status

Active development. Used internally at Shoresh camp.

Self-hosting guide and contributing guidelines coming when the first stable release is ready.

## Tech

React 19 · Vite · Supabase · PostgreSQL RLS · @dnd-kit · Vitest · Vercel
