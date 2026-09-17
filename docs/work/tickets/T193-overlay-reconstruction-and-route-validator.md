---
title: T193-overlay-reconstruction-and-route-validator
document_type: ticket
status: open
created: 2026-09-17
archive_when: both fixes ship and are folded into PLATFORM_STATE
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T193 — Slice 1: overlay-aware schedule state and a route-wide resource validator

**Severable, and owner-ratified as such (2026-09-17).** These are pre-existing defects on shipped
surfaces — an MCP caller gets a falsely clean schedule state today, with no campers involved. This
ticket is **not sequenced behind the governance gate** on the rest of the feature and does not wait
on T192.

## Defect A — MCP `schedule_state` is falsely clean

`scripts/mcp/tools.js:136` reconstructs preplaced slots with
`.filter((s) => s.activity_id && !s.is_anchor)`, dropping every elective and event overlay. An MCP
caller re-running validation on a schedule containing overlays receives a clean state that is wrong.

**The brief named only this filter, and that is not enough.**
`electron/ops/scheduleEngineInputs.js:26-53` returns
`{groups, tiers, days, timeBlocks, activities, anchors, locations}` and never assembles
`electiveSetActivities` or `events`. Fixing the filter without fixing the inputs restores the rows
but not the occupancy — a second falsely-clean result. Both must land together.

## Defect B — cross-cohort location conflicts are undetected

`src/engine/buildSchedule.js:874` returns `conflicts: []`. A cohort loop exists (`:862-870`) and
location accounting is real *within* a cohort; what is missing is detection *across* cohorts. Two
divisions in different cohorts can be placed in the same location at the same time with no finding.

Add a route-wide validator over concrete location/day/block occupancy from regular activities,
anchors, events, and elective offerings. It **reports** `OUTER_RESOURCE_CONFLICT`; it never moves a
group or removes an offering.

## Exit condition

- A fixture schedule carrying a stored elective overlay and a stored event overlay is represented
  in `schedule_state`, with offering locations counted as occupied.
- A cross-cohort location-conflict fixture **fails before the change and passes after** — the test
  is written first and observed red.
- `buildSchedule.test.js` (mandatory for this task class) is green; no existing flag or placement
  behaviour changes.
