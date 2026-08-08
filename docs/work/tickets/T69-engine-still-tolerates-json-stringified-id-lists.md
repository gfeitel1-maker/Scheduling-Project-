---
title: T69-engine-still-tolerates-json-stringified-id-lists
document_type: ticket
status: completed
created: 2026-08-08
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T63-anchor-group-ids-parsing-belongs-at-the-boundary.md, docs/work/tickets/T70-dev-only-shape-assertion-at-engine-id-list-inputs.md]
related_adrs: []
archive_when: "`grep -rn 'JSON.parse' src/engine/` returns nothing, and tests pin the array-only contract for both `activities.eligible_group_ids` (buildSchedule + computeFindings) and `anchor_activities.group_ids` (resolveWeekCatalog)"
---

# T69 — The engine layer still tolerates JSON-stringified id lists

**Risk:** Low. Deletion of dead tolerance branches; no behavioural change on any live path.
**Task class:** scheduling-engine.

---

## Why this ticket exists

T63 ("Move the anchor `group_ids` JSON.parse out of the pure engine") is marked
`status: completed` on `main` as of `4341664`. Its `archive_when` reads:

> buildSchedule.js contains no JSON.parse and a test pins the array-only anchor contract.

**That condition was not met when the ticket was closed.** The second half landed
(`src/engine/buildSchedule.test.js:491` pins the array-only anchor contract; the boundary
normalization landed at `src/screens/schedule/useScheduleData.js:122` via `parseIdList`). The first
half did not: `grep -n 'JSON.parse' src/engine/buildSchedule.js` still returns two hits.

T63 is **not** reopened or edited here — another session owns it and is actively committing to
`main`. This ticket carries the residual scope. T63's own "Out" section explicitly anticipated it:
*"If others exist (`eligible_group_ids` is parsed by `parseIds`/`parseIdsField` inside the engine),
report them as a finding, do not fix them here. They … deserve their own ticket."* This is that
ticket, plus one site T63's `archive_when` missed entirely (`weekCatalog.js` — see item 3).

## Problem

`ARCHITECTURE_STANDARD.md` §8–§9: the engine is pure, and deserializing a SQLite TEXT column is
boundary work. Three sites in `src/engine/` still accept *either* a real array *or* a
JSON-stringified array, which means the engine's input contract is "either shape" — not a contract.
Each tolerance is an untested parallel deserializer that will drift from the real one in
`src/utils/normalizeActivityEligibility.js`.

1. `src/engine/buildSchedule.js:80-82` — `parseIds()`, consumed at `:87-88` for
   `act.eligible_tier_ids` / `act.eligible_group_ids` inside `scheduleCohort`.
2. `src/engine/buildSchedule.js:417-419` — `parseIdsField()`, consumed at `:429-430` for the same
   two fields inside the exported `computeFindings()`.
3. `src/engine/weekCatalog.js:42-49` — `JSON.parse(anchor.group_ids || '[]')` inside
   `resolveWeekCatalog`. This is the **same anchor field T63 was about**; T63's `archive_when`
   named only `buildSchedule.js` and missed it. `resolveWeekCatalog` runs *upstream* of
   `buildSchedule` at `src/screens/schedule/useGeneration.js:66`, so the field T63 declared
   normalized is still being re-parsed one call earlier.

### All three tolerances are dead on every live path (verified)

- `src/screens/schedule/useScheduleData.js:117` maps every `activities` row through
  `normalizeActivityEligibility`, which runs `parseIdList` over `eligible_tier_ids` and
  `eligible_group_ids`.
- `src/screens/schedule/useScheduleData.js:122` maps every `anchor_activities` row's `group_ids`
  through `parseIdList`.
- The only `buildSchedule()` callers are `useGeneration.js:78` and `:147`; the only
  `resolveWeekCatalog()` caller is `useGeneration.js:66`; the only `computeFindings()` callers are
  `useGeneration.js:191`, `useSnapshots.js:147`, and `useScheduleData.js:55`. Every one is fed from
  that same normalized `setupLists` state.
- The one in-place mutation of that state, `useSlotMutations.js:205`
  (`setActivities(prev => prev.map(... is_locked: true ...))`), spreads already-normalized rows and
  does not reintroduce strings.
- `ActivitiesScreen.jsx` and `DayOverridesScreen.jsx` read `activities` raw from
  `localClient.list('activities')`, but neither feeds the engine — `ActivitiesScreen` runs its own
  `parseIdList` at `:48-49`, and `DayOverridesScreen` writes exclusion rows only.

So this is a **deletion plus test-pinning** task, not new logic.

## Scope

**In:**

1. Delete `parseIds` (`buildSchedule.js:80-82`) and read `act.eligible_tier_ids || []` /
   `act.eligible_group_ids || []` directly.
2. Delete `parseIdsField` (`buildSchedule.js:417-419`) and do the same in `computeFindings`.
3. Delete the `try`/`JSON.parse` block in `weekCatalog.js:42-49`; read `anchor.group_ids || []`.
4. State the array-only contract in a comment at each engine input boundary, matching the wording
   already at `buildSchedule.js:120` ("Contract: group_ids is an array of ids. Callers normalize").
5. Update `src/engine/weekCatalog.test.js:19-21`, whose anchor fixtures currently supply
   **string** `group_ids` — they must become real arrays, or the tests would be pinning the shape
   this ticket removes.

**Out:**

- Any behavioural change. Same schedules in, same schedules out.
- Editing, reopening, or re-scoping T63.
- Touching the boundary normalizers themselves (`normalizeActivityEligibility.js`,
  `useScheduleData.js`) — they are correct and stay.
- Adding a defensive runtime assertion/throw in the engine. If we want a shape guard, that is its
  own decision, not a smuggled-in replacement for the tolerance being deleted.
- `null`-safety: `|| []` still handles `NULL`/`undefined`, which is a real DB state and not a
  string-tolerance concern.

## Red Hat findings folded in (2026-08-08)

Red Hat could not construct a live counterexample and confirmed all three sites DEAD. Two of its
findings change the work:

- **The `|| []` replacement is not behaviour-preserving for the string `'[]'` at the two
  `buildSchedule.js` sites, and inverts the failure direction.** Today `parseIds('[]')` → `[]` →
  `tierIds.length === 0 && groupIds.length === 0` → "no restriction" (permissive). After deletion,
  `'[]' || []` is the truthy 2-char string, `.length` is 2, so the gate fails and
  `new Set('[]')` iterates the *characters* `[` and `]` — the activity becomes eligible for
  **nothing** (restrictive). Unreachable today, but "zero behavioural change" is true only *on the
  live path*; the acceptance criterion is worded that way deliberately.
- **Correction (round 2): `weekCatalog.js` is not clean by contrast — it is worse.** An earlier
  draft of this section claimed its `anchorGroupIds.length > 0` gate at `:55` keeps `'[]'` and `[]`
  on the same outcome. That is false. Strings have `.length` but no `.every`. Post-deletion,
  `anchor.group_ids || []` on **any** non-empty string — a well-formed `'["g1"]'` included — passes
  the `length > 0` gate and then **throws** `TypeError: anchorGroupIds.every is not a function`.
  `'[]'` throws too (`length` 2 > 0). The old `try`/`JSON.parse` handled well-formed strings
  *correctly*, so removing it did not merely drop malformed-input tolerance — it converted a working
  input into a throw. (The `is_all_groups` short-circuit statement stands: it does return before
  `group_ids` is read.)

  **Operational consequence.** `resolveWeekCatalog` is called at
  `src/screens/schedule/useGeneration.js:66`, **outside** any `try` (the first `try` in `generate()`
  is at `:88`) and **after** `setGenerating(true)` at `:52`, from a floating promise. A throw there
  leaves the director on a spinner that never resolves, with no banner — precisely the failure the
  comment at `useGeneration.js:84-87` says was deliberately guarded against for `ensureTemplateRow`.
  Only reachable if the boundary normalizer at `useScheduleData.js:122` regresses, which is exactly
  why scope item 6 (the seam test) is not optional.
- **No test spans the normalizer → `resolveWeekCatalog` seam.** `useScheduleData.test.js:84` pins
  one half and `weekCatalog.test.js` the other; nothing joins them, and
  `ScheduleScreenExclusions.test.jsx:51` passes `anchor_activities: []`, so anchor group-exclusion
  suppression has no integration coverage at all. Once engine tolerance is gone, a regression at
  `useScheduleData.js:122` fails silently. **Added to scope as item 6.**
- Also confirmed mechanically: `weekCatalog.test.js:80` *will* fail after the deletion (fixture
  `anch-3` at `:21` is a string), while `:91` asserts a negative and would stay green for the wrong
  reason. The fixture conversion is a blocker, not cosmetic.
- A dev-only shape assertion (`throw` in DEV when a string arrives) would convert RISK 1's silent
  wrong-schedule into a loud failure at no production cost. Correctly **out of scope here** — it is
  a decision, not a substitute for the deletion. Recorded as a follow-up candidate rather than left
  implicit.

Scope item 6 (added): extend `src/screens/ScheduleScreenExclusions.test.jsx` with a non-empty
`anchor_activities` row whose `group_ids` arrives as a JSON **string**, plus a matching
`week_group_exclusions` row, asserting suppression through the real screen. This is the test that
makes the deletion safe as a contract rather than as a currently-true fact.

## Testing

Test-first at this seam (`CLAUDE.md`: engine + data-shape work).

- [ ] `src/engine/buildSchedule.test.js` — a case where `eligible_group_ids` is a **raw array**
      restricting an activity to a subset of groups, asserting placement respects it with no string
      handling anywhere.
- [ ] `src/engine/buildSchedule.test.js` — the same for `computeFindings()`, whose eligibility path
      is separate code and is currently unpinned on this field.
- [ ] `src/engine/weekCatalog.test.js` — array-only anchor `group_ids`: an anchor is suppressed when
      **every** listed group is excluded, and kept when only some are.
- [ ] The existing boundary tests that cover the string → array conversion stay green and are not
      weakened: `src/screens/schedule/useScheduleData.test.js:84` (anchor `group_ids`) and whatever
      covers `normalizeActivityEligibility`. Deleting engine tolerance is only safe because those
      exist.

## Acceptance

- [ ] `grep -rn "JSON.parse" src/engine/` returns nothing
- [ ] No `typeof v === 'string'` id-list branch remains under `src/engine/`
- [ ] `parseIds` and `parseIdsField` are gone, not merely unreferenced
- [ ] `npm run lint`, `npm run check:governance`, `npm run build`, and
      `npx vitest run --no-file-parallelism` all pass
- [ ] Zero behavioural change on the live path
