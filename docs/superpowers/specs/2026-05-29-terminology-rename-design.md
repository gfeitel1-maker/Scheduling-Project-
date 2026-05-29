# Terminology Rename Design

## Goal

Replace developer-facing terminology ("Cohort", "Tier") with camp-natural language ("Program", "Unit") throughout the UI. No schema or code structure changes — UI text only.

## Background

The current 4-level hierarchy is: **Camp → Cohort → Tier → Group**.

- "Cohort" means: a named grouping that owns a shared schedule (time blocks + anchors). Most camps have one ("Main"); specialty programs get their own.
- "Tier" means: an age/ability grouping within a cohort that contains groups.

Neither word is natural to camp staff. The agreed rename:
- **Cohort → Program** ("Program" avoids collision with the existing "Schedule" screen in the nav)
- **Tier → Unit**

The long-term goal (a future sub-project) is a true 3-level restructure (Camp → Unit → Group) where units own their schedules directly. This spec covers only the immediate rename.

## Scope: What Changes

**UI text only.** Internal variable names, component names, database columns, and API calls are unchanged.

| Location | Before | After |
|---|---|---|
| Sidebar nav item | Cohorts | Programs |
| Sidebar nav item | Tiers | Units |
| CohortsScreen heading | Cohorts / N COHORTS | Programs / N PROGRAMS |
| CohortsScreen add form | Add Cohort / + Add Cohort | Add Program / + Add Program |
| CohortsScreen input placeholder | Name (e.g. Main, Specialty) | Name (e.g. Main, Specialty) *(unchanged)* |
| CohortsScreen table column | — | *(column headers stay the same)* |
| CohortsScreen delete guard alert | "Cannot delete the last cohort." | "Cannot delete the last program." |
| CohortPicker label | Cohort | Program |
| TiersScreen heading | Tiers / N TIERS | Units / N UNITS |
| TiersScreen add form | Add Tier / + Add | Add Unit / + Add |
| TiersScreen input placeholder | Tier name (e.g. Yeladim) | Unit name (e.g. Yeladim) |
| TiersScreen empty state | No tiers yet / Add your first tier below | No units yet / Add your first unit below |
| TiersScreen Next button | Next: Groups → | Next: Groups → *(unchanged)* |
| DayOverridesScreen (CohortPicker) | Cohort | Program |
| TimeBlocksScreen (CohortPicker) | Cohort | Program |
| AnchorsScreen (CohortPicker) | Cohort | Program |

## What Does NOT Change

- Internal component names: `CohortsScreen`, `CohortPicker`, `useCohorts`, `ensureCohort`
- Database column names: `cohort_id`, `cohorts` table, `tiers` table
- JavaScript variable names: `activeCohort`, `cohorts`, `tier`, etc.
- Screen keys in `App.jsx`: `cohorts`, `tiers`
- Any backend logic or RLS policies

## Future Work (Out of Scope)

Sub-project: 3-level restructure — collapse Cohort+Tier into a single "Unit" entity that owns its own time blocks, with a camp-level default schedule that units can override.
