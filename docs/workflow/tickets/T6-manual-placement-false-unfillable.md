# T6 — Manual placement falsely flags every slot UNFILLABLE

**Risk:** Moderate — no data loss, but the flag system becomes noise, which is worse than no flags.
**Found:** 2026-07-27, verifying drag-and-drop end to end in the real app.
**Status:** CONFIRMED against the running app and the live schema.

---

## The defect

Every activity dropped onto the grid is written with `flags = {"UNFILLABLE": true}`, regardless of eligibility. Observed twice in the app: dropping basketball on Tuesday and soccer on Tuesday each drove the Unfillable badge up by one (0 → 1 → 2) and wrote `{"UNFILLABLE":true}` to the op log (seq 292, 294).

Root cause is a missing read-side parse, the same class of bug as the `is_span_head` integer/boolean mismatch fixed in `af6a9d8`.

`eligible_tier_ids` and `eligible_group_ids` are stored as JSON **strings** (`'[]'` for all four activities in the test camp). `ScheduleScreen.jsx:194` loads activities raw:

```js
const a = (ad || []).filter(x => x.camp_id === campId)
```

No `parseIdList`, unlike `normalizeActivity` in `ActivitiesScreen.jsx:32-44`, which does parse them. So at `ScheduleScreen.jsx:692-705`:

```js
const tierIds = activity.eligible_tier_ids || []   // '[]' — a 2-char STRING, truthy
const eligible = (tierIds.length === 0 && groupIds.length === 0)   // '[]'.length is 2 -> false
  || tierIds.includes(group?.tier_id)                             // substring search -> false
  || groupIds.includes(groupId)                                   // false
if (!eligible || locationFull) flags.UNFILLABLE = true            // always fires
```

"No eligibility restrictions" is encoded as an empty list, so the one case that should always be eligible is the one that always fails.

## Why it matters operationally

The Unfillable badge is how a director spots slots the engine could not legitimately fill. If every hand-placed activity raises it, the badge stops meaning anything and real problems get ignored. A director hand-adjusting a schedule the night before camp will light up the whole board.

## Observable completion evidence

1. Drop an activity with no eligibility restrictions onto an open slot: the row's `flags` is `{}` (or has no `UNFILLABLE` key) and the Unfillable count does not change.
2. Drop an activity whose `eligible_tier_ids` genuinely excludes the target group's tier: `UNFILLABLE` IS set. The flag must keep working, not just stop firing.
3. Same for `eligible_group_ids`.
4. `locationFull` still flags correctly when `max_groups_per_slot` is reached.
5. A regression test asserting eligibility with DB-shaped activity rows — JSON strings, not arrays. Test fixtures using JS arrays would pass today and prove nothing.

## Files expected to change

- `src/screens/ScheduleScreen.jsx:194` — normalize activities on load. Reuse the existing precedent rather than inventing a new one: `parseIdList` / `normalizeActivity` in `src/screens/ActivitiesScreen.jsx`. Consider extracting it to `src/utils/` alongside `normalizeSlots.js`, which was moved there for exactly this reason.

## Note for whoever picks this up

Check whether `buildSchedule.js` receives parsed or raw activities. If the engine parses (or is handed parsed data) and only the manual path does not, that explains why the generator placed basketball for yeladim 1 while the manual path calls the same placement ineligible. If the engine has the same bug, its eligibility pass is also wrong and the blast radius is larger than this ticket.
