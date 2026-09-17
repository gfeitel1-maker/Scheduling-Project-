---
title: "The headless schedule-input assembler was a hand-copied mirror of the renderer's load(), and it had already drifted — anchors lost their v65 division scope"
document_type: ticket
status: completed
created: 2026-09-17
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "Raised as a MEDIUM by Code Reviewer during T193 and deliberately deferred there to avoid scope creep. Overlaps T193 (PR #465) on electron/ops/scheduleEngineInputs.js only."
archive_when: "The filter/sort/de-dupe/id-list-parse rules for schedule setup lists have exactly one implementation, both the renderer and the headless path call it, the anchors `unit_ids` regression is covered by a test proven to fail without the fix, and `npm run verify` is green"
---

# T206 — one normalization, not two hand-copied ones

## Confirmed problem (verified against `main` at 2d49c55)

`electron/ops/scheduleEngineInputs.js` carried a header declaring itself a manual mirror of
`src/screens/schedule/useScheduleData.js`'s `load()`:

> Keep this in sync with useScheduleData.js's `load()` if that logic changes.

It had not stayed in sync. The renderer parses **both** JSON-stringified id-list columns on an
anchor:

```js
.map(x => ({ ...x, group_ids: parseIdList(x.group_ids), unit_ids: parseIdList(x.unit_ids) }))
```

The headless copy parsed only `group_ids`.

This is not cosmetic. `src/engine/anchorScope.js`'s `resolveAnchorGroupIds` resolves scope in the
order `unit_ids > unit_id > is_all_groups > group_ids`, and tests the first with
`Array.isArray(anchor.unit_ids)`. A raw JSON **string** is not an array, so it is not a scope claim
at all: it falls silently through to the fallback. Every headless caller — `scripts/mcp/tools.js`'s
`schedule_state`, which is exactly the surface a director's tooling reads — therefore resolved a
division-scoped anchor to the wrong groups, usually none, for the entire life of the v65 column.
Nothing threw, nothing lint-failed, no test went red.

By T193 the mirror covered eight fields.

## Why not the originally suggested fix

The review suggestion was to derive the field list and scoping from
`electron/ops/campScopedEntities.js`. That module answers "which tables belong to a camp and how are
they scoped" — and `electron/ops/read.js`'s `listEntities` **already applies it**, so every row the
assembler receives is camp-scoped before it arrives. The half that actually drifted is the per-field
sort, de-dupe and JSON-parse rules, which `campScopedEntities.js` neither knows nor could know.

The danger is not that deriving from it would have been merely insufficient. It is that it would
have **looked like a fix**: it unifies the half that already agreed, leaves the half that had
drifted exactly as it was, closes the review finding, and ships the `unit_ids` bug intact — now
under a header saying the duplication has been solved. A de-duplication that does not touch the
rules that actually diverged is worse than none, because it removes the reason anyone would look
again.

## Why the renderer could share after all

The deferral rationale was that the renderer's logic is "entangled with React state". Checked: it is
not. The entanglement is the load-generation guard and the `setState` calls that **wrap** the
normalization; the normalization itself is pure and takes rows keyed by table name — the same shape
`repo.loadSetupLists()` and `listEntities()` both already speak.

## What shipped

- `electron/ops/scheduleInputNormalization.js` — the one pure implementation, plus
  `SCHEDULE_INPUT_ENTITIES`, the declared input set.
- `electron/ops/scheduleEngineInputs.js` — derives its fetch from `SCHEDULE_INPUT_ENTITIES` and
  calls the normalizer. `cohorts` and `electiveSets` are normalized but deliberately not returned;
  handing `buildSchedule` a `cohorts` key switches it off the legacy signature its headless callers
  expect.
- `src/screens/schedule/useScheduleData.js` — `load()` calls the same normalizer.
- Tests: the `unit_ids` regression (proven to fail without the parse), the declared-vs-read entity
  seam, the `campScopedEntities` serviceability check, and a repository-side assertion that what the
  renderer fetches is exactly what the normalizer consumes.

## Known overlap

T193 (PR #465) independently added `electiveSetActivities` and `events` to the same assembler. Both
arrive here through the shared normalizer, so whichever lands second resolves to the same end state.
