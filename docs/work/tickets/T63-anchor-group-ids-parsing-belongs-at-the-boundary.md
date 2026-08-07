---
title: T63-anchor-group-ids-parsing-belongs-at-the-boundary
document_type: ticket
status: open
created: 2026-08-07
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T62-engine-schedules-anchor-activities-as-regular-slots.md]
related_adrs: []
archive_when: buildSchedule.js contains no JSON.parse and a test pins the array-only anchor contract
---

# T63 — Move the anchor `group_ids` JSON.parse out of the pure engine

**Risk:** Low. Pure relocation of a normalization step, no behavioural change intended.
**Task class:** scheduling-engine.

---

## Problem

Commit `8512fb6` added this to `src/engine/buildSchedule.js` (lines 114–116):

```js
groupList = typeof anchor.group_ids === 'string'
  ? JSON.parse(anchor.group_ids || '[]')
  : (anchor.group_ids || [])
```

`buildSchedule.js` is a pure function with no React and no IPC dependencies
(`ARCHITECTURE_STANDARD.md` §8, §9). Deserializing a SQLite TEXT column is boundary work. Putting it
in the engine means the engine's input contract is now "either shape", which is not a contract at
all — every future field gets the same treatment and the pure core accretes a parallel, untested
deserializer. No unit test covers the guard today, so the drift is also invisible.

**Correction to the original premise.** The dispatching brief guessed the assembly point was an IPC
handler in `electron/main.js`. It is not. `buildSchedule` is called only from the **renderer**, at
`src/screens/schedule/useGeneration.js:78` and `:147`. Anchors reach it from
`src/screens/schedule/useScheduleData.js`, which reads the `anchor_activities` rows back across the
IPC seam (~lines 95–113) and sets them into state. **That load site is the boundary** and is where
the normalization belongs. Confirm this before editing — do not assume this ticket's reading is
complete.

## Scope

**In:**

1. Normalize `group_ids` to an array once, where `anchor_activities` rows cross the IPC seam into
   renderer state (`src/screens/schedule/useScheduleData.js`, or the narrowest correct site if
   investigation shows another).
2. Delete the `typeof ... === 'string' ? JSON.parse(...)` guard from `buildSchedule.js`, leaving
   `groupList = anchor.group_ids || []`.
3. State the engine's anchor contract in a comment at the input boundary of `buildSchedule.js`:
   `group_ids` is an array of ids; callers normalize.

**Out:**

- The duplicate-anchor-activity bug — that is **T62**.
- Normalizing any other serialized column in the same pass. If others exist
  (`eligible_group_ids` is parsed by `parseIds`/`parseIdsField` inside the engine at lines 86 and
  431), **report them as a finding, do not fix them here.** They are a real instance of the same
  problem and deserve their own ticket rather than an unscoped sweep.
- Any behavioural change. Same schedules in, same schedules out.

## Testing

- [ ] Unit test in `src/engine/buildSchedule.test.js` passing **raw array** anchors — the engine's
      correct contract — confirming placement works without any string handling.
- [ ] A test at the boundary layer covering the string → array normalization, so the behaviour that
      `8512fb6` was fixing stays covered after it leaves the engine. Do not delete the guard without
      landing this test; the original bug was real.

## Acceptance

- [ ] `grep -n "JSON.parse" src/engine/buildSchedule.js` returns nothing
- [ ] The string case is handled exactly once, at the boundary, and is tested there
- [ ] `npm run test`, `npm run lint` pass
- [ ] Zero behavioural change — an anchor whose `group_ids` arrives as a JSON string still scopes to
      the same groups
