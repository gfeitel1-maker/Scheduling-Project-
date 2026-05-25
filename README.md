# Camp Scheduling Platform

A generalized camp scheduling platform built on the foundations of Shoresh.

Shoresh proved the model — deterministic constraint-aware scheduling, drag-and-drop editing, a flag system that surfaces conflicts without blocking you, and locking that protects decisions across regenerations.

This project extends that foundation to serve camps with different scheduling structures: multi-week sessions, per-cohort time rhythms, staff-driven capacity, and activity availability driven by resources — not just fixed numbers.

---

## Architecture

**Scheduling routes** — different camps use different scheduling methodologies. The platform supports configuring the route before building: time structure (cohort rhythms vs. universal blocks), capacity source (staff assignments vs. fixed numbers), temporal scope (single week vs. multi-week), and anchor model.

**Staff as resources** — activity capacity is derived from staff assignments, not stored on the activity. Staff availability gates activity availability. Absences cascade to flags.

**Multi-week templates** — a base week with per-week override layers. Field trip weeks and other exceptions are overlays on the base.

**Inherited from Shoresh** — schedule engine (deterministic, seeded PRNG), drag-and-drop editing, flag system, locking, snapshots, multi-tenant RLS.

---

## Status

Active development. Forked from Shoresh.

---

## Tech

React 19 · Vite · Supabase · PostgreSQL RLS · @dnd-kit · Vitest · Vercel
