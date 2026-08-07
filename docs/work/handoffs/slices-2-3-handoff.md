---
title: "Handoff — multi-week Slices 2 and 3"
document_type: handoff
authority: descriptive
status: active
date: 2026-08-03
created: 2026-08-03
task: docs/work/specs/multi-week-slices-2-3.md
archive_when: multi-week slices 2 and 3 are implemented and merged
spec: docs/workflow/specs/multi-week-slices-2-3.md
---

# Handoff — multi-week Slices 2 and 3

For whoever picks this up next, in a fresh session, with none of this conversation.

## Where things stand

Slice 1 is **merged and hardened** on `work/multi-week-slice-1` (HEAD `4af27c6`). It shipped
`schedule_weeks` at migration v27, `schedule_templates.week_id`, `UNIQUE(week_id, kind)`, the
WeekSwitcher, and the week repository methods.

Slices 2 and 3 are **specified but not approved and not started.** No code has been written.
The spec is `docs/workflow/specs/multi-week-slices-2-3.md`. Four gates in its §7 must clear
before Maker starts; two of them are product decisions belonging to the owner.

## What was run to produce the spec

A divergence pass (`adhd`, five isolated cognitive frames: regulator, inversion, 3am on-call,
logistics, biology), then Architect, Designer and Red Hat in parallel against the real
codebase. No Maker, no Verifier, no Grader — this cycle produced a specification, not code,
so the implementation loop was deliberately not entered. Recorded here per Article VII's
requirement that omitted agents be named with a reason.

## The three decisions that matter most

**1. The schema is an EXCLUDE list, not an include list.** Architect proposed
`week_activity_participation` where a row means "runs this week" and zero rows means "inherit
everything." Red Hat found the fatal case: a director turning off *every* activity produces
zero rows, indistinguishable from an untouched week, so the app would silently schedule the
whole catalog — the inverse of the instruction, with the UI reporting "not customized."
The spec reverses this to `week_activity_exclusions` / `week_group_exclusions`, where a row
means "does not run this week." Zero-off and all-off are then distinct, the common case
stores nothing, and the one-click toggle UX falls out naturally.

**If you read Architect's original design anywhere, it is superseded on this point.**

**2. Anchors must be filtered too.** `buildSchedule` pre-places anchors as locked slots before
the eligibility pass and never checks an anchor's activity against the `activities` array
handed to it. Filtering activities and groups but not anchors lets an excluded activity
reappear, locked, in the generated schedule. `resolveWeekCatalog` filters anchors and returns
`suppressedAnchors` for the screen to surface — never silently dropped.

**3. Duplicate-a-week routes each entity through the mechanism it is already registered for.**
Slots and overlays via `appendBulkReplaceOp` against the fresh empty target (one atomic op per
table, already how `generate()` replicates); weeks, templates and exclusion rows via ordinary
per-row `appendOp`. Inventing a third op kind with an inline payload is rejected — the
projection layer has no such shape. Every op's `client_write_id` must be deterministic from
the duplication's identity, or a timed-out retry produces a second whole duplicate week.

## Traps that will bite you

- **`syncServer.js`'s `DOMAIN_PARENT_SCOPED_ENTITIES` is hand-maintained** and is *not*
  derived from `PARENT_SCOPED_ENTITIES`, despite `campScopedEntities.js`'s header comment
  claiming the two are structurally guaranteed to match. Register new entities in **both**
  files or first-pairing full sync silently omits them. Worth its own cleanup ticket.
- **Missing a `PROJECTIONS` entry means writes silently never materialize.** No error.
- **Do not copy `schedule_snapshots` on duplicate.** It is an easy reflexive addition and it
  is wrong; a duplicated week starts with no version history.
- **Do not verify any of this against `http://localhost:5200`.** That is the browser mock
  (`src/localClient.mock.js`). Migration, sync, delete and duplicate must be verified under
  `npm run electron:dev`.
- **`better-sqlite3` ABI drift.** `npx electron-rebuild -f -w better-sqlite3` before
  `electron:dev`; `npm rebuild better-sqlite3` before `npm test`.
- **Deleting a camp's last week must be refused in the data layer**, not only in the UI.
  `ScheduleScreen`'s week resolution falls back to `camp[0]?.id`, which is `undefined` on an
  empty array — an unrecoverable state.

## Open questions for the owner

1. **The downgrade contract (spec Gate B).** An older build cannot see exclusion rows and would
   show and schedule activities the director turned off for that week. Slice 1's promise was
   non-destructive downgrade; this stretches it from *subtractive* degradation to *contradictory*
   data. Recommendation: accept as a documented bounded degradation, record it in the ADR.
   Owner's call.
2. **The v26 migration escape hatch (Gate C).** Deferred once already by the Slice 1 ADR, which
   named "the next migration" as where it should land. v28 is that migration. Take it now as a
   small ticket, or defer a third time with eyes open.
3. **Duplicated-week naming.** Spec says `"{name} copy"` with " (2)" collision suffixes, matching
   `duplicateActivity`. Confirm, or switch to prompting inline.

## First three moves

1. Get owner decisions on Gates B and C.
2. Architect writes the ADR (Gate A), carrying the exclude-list reversal and the duplicate-op
   resolution into its candidates-considered. Nothing implements before it is accepted.
3. Re-run Red Hat against the *new* exclusion-list design. Its Risk 1 attack landed on the
   include-list version; the replacement has not faced the same hostility yet.

Then S2-1 through S2-9, then Slice 3. Data layer before UI in both.
