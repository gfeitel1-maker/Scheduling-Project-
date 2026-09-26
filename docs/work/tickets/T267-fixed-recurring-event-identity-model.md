---
title: T267-fixed-recurring-event-identity-model
document_type: ticket
status: in-progress
created: 2026-09-26
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-26-fixed-recurring-event-identity-model.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
archive_when: anchor_activities is renamed fixed_events, carries activity_id, resolution is by id with the name-matching fallback deleted, and a test pins that a fixed or recurring event resolves to exactly one activity
---

# T267 — Fixed events, recurring events and activities: one model, resolved by id

## What it is

`anchor_activities` already carries the owner's categories
(`kind TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed','recurring'))`, `electron/db/schema.sql`).
The category model exists. What is wrong is the **shape**: the table has a `name TEXT` column and
**no `activity_id`**, so `src/engine/anchorActivityLink.js:41-43` resolves a pinned event to its
catalogue activity **by name**, with `[]` — a silent no-op — as the failure mode.

That is the root cause of a hazard recorded in
`docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md`, and of the T62 scar
documented in `anchorActivityLink.js`'s own header (an exclusion Set empty in production for a
month behind a green unit test that hand-built the missing field).

The point of this ticket is the **model, not the labels**. A rename that leaves resolution-by-name
intact is not this ticket.

## Definition of done

- A fixed or recurring event resolves to **exactly one** activity — zero and two-or-more are both
  failures, and both are visible rather than silent.
- That event still appears on the generated grid exactly once per group per day after the change.
- The name-matching fallback (`anchorNameKey`, `indexActivitiesByName`) is deleted, not kept as a belt.
- `activities.catalog_role` (T266) is the single authority for "is this catalogue row pinned"; no
  second mechanism for the same idea exists.

## Design

`docs/adr/2026-09-26-fixed-recurring-event-identity-model.md` (accepted 2026-09-26; owner delegated
the call). Three PRs, each independently green: schema + rename + backfill; cutover to `activity_id`;
cosmetic rename cleanup.

## Related

- T266 (`activities.catalog_role`) — absorbed by this ticket, not superseded.
- T197 (elective run outer-schedule export) — `electron/ops/electiveRunOuterSchedule.js` returns
  `activityId: null` for an anchor today because no `activity_id` exists. Coordinate before landing.
