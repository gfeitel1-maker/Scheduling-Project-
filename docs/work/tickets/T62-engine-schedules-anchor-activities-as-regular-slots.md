---
title: T62-engine-schedules-anchor-activities-as-regular-slots
document_type: ticket
status: completed
created: 2026-08-07
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T63-anchor-group-ids-parsing-belongs-at-the-boundary.md]
related_adrs: []
archive_when: an activity an anchor NAMES never appears as a regular slot for the groups that anchor covers, covered by a unit test built on the row shape the app actually writes (no synthetic activity_id)
---

# T62 — The engine places anchor activities a second time as regular slots

**Closed 2026-09-18.** `archive_when` met. `src/engine/anchorActivityLink.js` resolves an
anchor's activity by NAME (`anchor_activities` has no `activity_id` column and never did), and
`src/engine/buildSchedule.js` excludes the resolved ids per group. The regression is pinned on the
row shape the app actually writes — `src/engine/buildSchedule.test.js` "never places an anchored
activity as a regular slot when the anchor links by NAME (real row shape)" — and the synthetic
`activity_id` that let this defect hide for a month is now blocked at the fixture level by
`src/engine/fixtureSchemaParity.test.js`.

Shipped as #443.

**Risk:** Medium — touches `src/engine/buildSchedule.js`, the pure scheduling engine.
**Task class:** scheduling-engine. `buildSchedule.test.js` is a mandatory gate
(`GOVERNANCE_INDEX.md` §3–8).

---

## Problem

The activity-placement passes do not exclude activities that are already covered by
`anchor_activities`. An activity like Lunch or Rest Hour carries `min_per_week = 2` like any other
activity, so the engine treats it as schedulable and places it twice per group per week **on top of
its anchor slots**.

Observed: the Activity View drilldown shows 30 regular Lunch slots placed across the week. All 30
are wrong. Every one of them also consumes a block that a real activity should have had, so the
damage is not only the duplicate — it displaces correct placements and distorts the
`min_per_week` / `prefer_before_day` audit in pass 3.

The anchor is the scheduling of that activity. There is no case in which the engine should place it
again as a regular slot.

## Scope

**In:**

1. In `src/engine/buildSchedule.js`, before the activity-placement passes, collect a `Set` of every
   `activity_id` present in the `anchors` input array.
2. Filter those IDs out of the schedulable-activity set so neither the high-priority nor the
   low-priority round can place them.
3. The exclusion is derived from the `anchors` input, not from a flag on the activity row — an
   activity is excluded because an anchor references it, and for no other reason.

**Out:**

- Any change to anchor placement itself (pass 1), to span handling, or to scope resolution
  (`unit_id` / `is_all_groups` / `group_ids`).
- The `group_ids` parsing guard — that is **T63** and lands first.
- Changing `min_per_week` data on any activity. The fix is engine-side; the data is not wrong.
- Any change to flag taxonomy or placement priority (human gate — do not cross it).

## Testing

Test-first. `src/engine/buildSchedule.test.js` is mandatory for this task class.

- [ ] Given an anchor referencing activity X, X appears in **no** regular slot in the output —
      only in anchor slots.
- [ ] An activity **not** referenced by any anchor is still placed normally (the filter is narrow).
- [ ] Determinism holds: identical inputs still produce identical schedules (the seeded PRNG
      contract must not be perturbed in a way that is unaccounted for). If removing activities from
      the pool changes previously-recorded expected output, say so explicitly rather than silently
      updating fixtures.

## Acceptance

- [ ] New unit test in `src/engine/buildSchedule.test.js` fails before the change, passes after
- [ ] `npm run test`, `npm run lint` pass
- [ ] `src/engine/buildSchedule.js` remains a pure function — no React, no IPC, no I/O

## Dependencies

- **T63** should land first so this ticket edits an engine that already has the boundary parsing
  removed, and the two diffs stay separable.

---

## Reopened 2026-09-16 — the 2026-08-07 fix was inert

`420cadc` implemented this ticket's Scope §1 literally: "collect a `Set` of every
`activity_id` present in the `anchors` input array." **`anchor_activities` has no
`activity_id` column and never has had one.** Not dropped — never added: it is absent from
the original `CREATE TABLE` (`electron/db/localDb.js`), from every migration, from the v51
table rebuild, and from `schema.sql`. The sole writer of anchor rows
(`electron/ops/ingest.js`) writes `name/day_id/time_block_id/kind/scope/span_blocks` and no
activity link, and `AnchorsScreen.jsx` has asked the director to TYPE the event
("e.g. Mifkad, Lunch, Swim") since the first commit. An anchor references its activity BY
NAME.

So `anchoredActivityIds` was empty on every real build, the placement filter excluded
nothing, and the reported symptom (Lunch placed on top of its own anchor, displacing real
activities and distorting the pass-3 audit) was never actually fixed.

**Why the gate did not catch it.** The unit test added alongside the fix hand-built an
anchor `{ activity_id: 'lunch', ... }` — a shape no writer produces. The test asserted the
fix's own premise rather than the app's behavior, so it passed on a codebase where the
bug was fully live. Same defect class as the audit writer that recorded nothing and the
gate script that exited 0 on both branches.

`resolveWeekCatalog` (`src/engine/weekCatalog.js`) carried the same broken read —
`anchor.activity_id ?? anchor.unit_id`, which fell back to a TIER id compared against
ACTIVITY ids — so both of its anchor-suppression rules were inert too: closing Swim, or
the Pool, for a week left the Swim anchor standing on the grid. Fixed here as well.

### What changed

- New `src/engine/anchorActivityLink.js` — the single place the anchor→activity link is
  resolved, keyed on the repo's existing recognition key (`whitespaceInsensitiveName`:
  lowercase, whitespace-stripped). An explicit `activity_id` still wins if a caller
  supplies one; an anchor whose name matches no activity resolves to nothing.
- `buildSchedule.js` — exclusion is now keyed by name **and scoped per group**, not
  camp-wide. `anchor_activities` holds both all-camp Fixed events and group-scoped
  Recurring ones; a camp-wide exclusion would let one group's recurring Swim delete Swim
  from every other group's catalog.
- `weekCatalog.js` — both suppression rules use the same resolver.
- Four tests that fail on the pre-fix engine and pass after, all using the row shape the
  app actually writes; plus overreach guards (an anchor named "Mifkad" excludes nothing).
  The two surviving `activity_id` fixtures are now commented as synthetic rather than
  described as "what the app produces".

### Owner decision recorded

Name matching over adding a real activity link to the Anchors UI (which would be a schema
change, a migration, and a screen change). Confirmed 2026-09-16: a fixed event of this
class is the scheduling of that activity — the engine must not also fill free blocks with
it.

### Remaining before this closes

- [ ] Full `npm run verify` green.
- [ ] Look at a generated schedule for a real imported camp before/after. The corrected
      exclusion removes placements that were silently there, so expect fewer regular slots
      and possibly NEW `UNFILLABLE` flags where the phantom placements were masking a
      genuine shortage. That surfacing is correct, but it should be seen, not assumed.
