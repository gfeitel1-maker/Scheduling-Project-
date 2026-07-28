> **ARCHIVED — historical record, not current authority.**
> Completed design spec. Records a decision as made at its date, not the current system.
> Current law: [`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md)

# camp_id overwrite guard in applyProjection

## Problem

`electron/ops/projections.js`'s `applyProjection(db, op)` (around line 238-260) applies any incoming op unconditionally:

```js
projection.ensureExists?.(db, op.entity_id, op.field, op.value)

db.prepare(`UPDATE ${projection.table} SET ${op.field} = ? WHERE ${projection.key} = ?`).run(
  op.value,
  op.entity_id
)
```

Every projection whose `fields` array includes `'camp_id'` (`users`, `cohorts`, `groups`, `days_of_operation`, `time_blocks`, `tiers`, `activities`, `anchor_activities`, `day_override_templates` — 9 of the 12 entries in `PROJECTIONS`) will happily run `UPDATE <table> SET camp_id = ? WHERE id = ?` for **any** value, from any op. A malformed or malicious op with `field: 'camp_id'` silently repoints an arbitrary row to an arbitrary camp id.

This breaks the single-camp-per-device-db invariant (`CLAUDE.md`: "Data isolation is enforced by the app being single-camp-per-device-db ... not by RLS") that every other subsystem assumes holds via the `SELECT ... FROM camps LIMIT 1` pattern. A row with a foreign `camp_id` becomes invisible to camp-scoped queries on this device but is still present in the local db and still gets synced to every other device in this camp's LAN mesh via the op-log, corrupting their local state too.

`camps.ensureExists` (same file, lines 22-32) already has the correct guard shape for this exact class of problem: look up the device's one real camp row, and refuse the write if the caller's id doesn't match it, throwing rather than silently applying. That guard only covers writes to the `camps` table's own singleton row (via `ensureExists`, which only runs on the entity's own key-id, not on arbitrary field values) — it does not cover a `camp_id` *field value* being written on any other entity's row.

## Solution

Add a single, generic guard at the top of `applyProjection`, before the field-write branch: any op writing `field === 'camp_id'` on any entity is only applied if `op.value` matches the device's own single camp id (`SELECT id FROM camps LIMIT 1`). Otherwise the op is rejected — logged and dropped (matching the codebase's existing default-deny-on-malformed-input convention; e.g. `PROJECTIONS[op.entity]` unknown-entity early return, `!projection.fields.includes(op.field)` unknown-field early return), not thrown, since `applyProjection` is called during op-log replay for potentially many ops from other devices and a thrown error there would abort the whole batch/sync run rather than just skip the one bad op.

Guard logic:

```js
if (op.field === 'camp_id') {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp || op.value !== camp.id) {
    console.error(
      `applyProjection: rejected camp_id write on ${op.entity}/${op.entity_id} — value ${JSON.stringify(op.value)} does not match this device's camp (${camp?.id ?? 'none'})`
    )
    return
  }
}
```

Placed after the `!projection.fields.includes(op.field)` check (so unknown fields still short-circuit first, unchanged) and before `ensureExists?.()` runs, so a rejected `camp_id` write never reaches `ensureExists` either — several `ensureExists` implementations (`cohorts`, `groups`, `days_of_operation`, `time_blocks`, `tiers`, `activities`, `anchor_activities`, `day_override_templates`) insert a placeholder row keyed off whatever camp they look up themselves (always `SELECT ... FROM camps LIMIT 1`, never `op.value`), so they were never the vector for this bug — but ordering the guard first is still correct because a legitimate first-time `camp_id` write (row creation) must equal the device's own camp id anyway, and rejecting early avoids doing any DB write work for an op we're about to discard.

This is a generalization of the exact pattern `camps.ensureExists` already established, applied at the `applyProjection` entry point instead of duplicated into each of the 9 affected entities' `ensureExists` functions — one guard, one place, correct for every current and future entity with a `camp_id` field.

## Non-goals

- Not validating any other field's value against a business rule — this guard is scoped to `camp_id` only, the one field with a codebase-wide cross-cutting invariant riding on it.
- Not changing `camps.ensureExists`'s existing singleton-guard behavior (unaffected — `camps` itself has no `camp_id` field, its own `id` *is* the camp id).
- Not adding a UI-facing error or conflict-log entry for a rejected op — out of scope for this fix; `console.error` is consistent with existing silent-reject paths in this function (unknown entity/field already return silently with no logging at all, so this is already more visible than the status quo).
- Not addressing the `ensureExists` "zero-camps db" `camp?.id ?? null` caveat noted inline in several entities (pre-existing, tracked separately, unrelated to this bug).

## Testing

Add/extend `electron/ops/projections.test.js` (or create it if it doesn't exist) covering:
1. A `camp_id` write matching the device's real camp id is applied normally (regression guard — must not break legitimate first-write-of-camp_id-on-row-creation flows).
2. A `camp_id` write with a mismatched value is rejected — the row's `camp_id` is left unchanged (or the row is never created, if this was the first write).
3. A `camp_id` write on a zero-camps db (no camp row exists yet) is rejected.
4. Sanity check across at least 2-3 of the 9 affected entities (not just one), since each has its own `PROJECTIONS` entry.
