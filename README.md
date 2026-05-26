# Shoresh

Shoresh helps camps control, adapt, and own their scheduling logic.

It's the adaptive scheduling layer for camps that outgrow spreadsheets but don't want to surrender their operational judgment to a black-box platform.

---

## The problem

Camp scheduling is a constraint satisfaction problem dressed up as a logistics problem. A typical week involves groups with different availability windows, activities with location capacity and eligibility rules, anchors that can't move, frequency goals, and preferences like “swimming should happen before Wednesday.”

Spreadsheets break down fast. Black-box tools make decisions you can't see or override. Shoresh sits in between — it handles the constraints and surfaces the conflicts, but you stay in control.

## What it does

You define the rules: groups, tiers, time blocks, activities, anchors, and constraints. The engine builds a schedule that respects all of them, then flags what it couldn't satisfy. From there you adjust, lock, drag, and iterate — the schedule is yours to own.

- **Schedule engine** — deterministic, constraint-aware, runs in milliseconds
- **Drag-and-drop editing** — swap slots between groups directly on the grid
- **Flag system** — surfaces unfillable slots, underserved activities, weather risk, and distribution gaps
- **Locking** — protect decisions that shouldn't change across regenerations
- **Snapshots** — named versions with auto-save before every regeneration
- **Multi-tenant** — each camp's data is fully isolated

## Status

Active development. Used internally at Shoresh camp.

Self-hosting guide and contributing guidelines coming with the first stable release.

## Tech

React 19 · Vite · Supabase · PostgreSQL RLS · @dnd-kit · Vitest · Vercel
