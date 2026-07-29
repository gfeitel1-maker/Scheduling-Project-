---
title: "Trash and record history — design"
document_type: spec
status: active
created: 2026-07-29
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: []
archive_when: this work is merged and Verifier PASS recorded
---

# Trash and record history — design

Surfaces two things the op log already knows but the app never shows: **what
was deleted** (and how to get it back) and **who changed what, when**.

Scope: all setup entities — `cohorts`, `tiers`, `groups`, `activities`,
`days_of_operation`, `time_blocks`, `anchor_activities`,
`day_override_templates`. Explicitly **not** `template_slots` — schedule edits
already have snapshots on ScheduleScreen, and a second competing undo story
there would be worse than none.

## 1. What already exists

A delete is not a delete. `localClient.deleteEntity` (`src/localClient.js:32`)
routes through the ordinary `write` IPC with the reserved sentinel field
`__deleted__` (`electron/ops/operations.js:19`). So the delete is **an op like
any other** — it has an `id`, `author_user_id`, `device_id`, `timestamp`, and a
`seq`, and it replicates to every device.

What is lost is only the *materialized row*: `applyProjection`
(`electron/ops/projections.js:361-365`) turns that sentinel into a real
`DELETE FROM <table>`. The history survives; the row does not.

Two consequences that shape this whole design:

- **History is pure presentation.** Every field change of every entity is
  already a row in `operations`, indexed by `(entity, entity_id, field)`
  (`electron/db/schema.sql:91`). Reading it back is a query, nothing more.
- **Restore is not a flag flip.** There is no soft-deleted row to un-hide. The
  row must be rebuilt from the op history.

## 2. Restore mechanism

**A restore re-emits the entity's field ops with their last-known values.**

The Host reads the entity's history, computes the last value for each field
before the delete, and appends one ordinary op per field. `ensureExists` on the
relevant projection re-inserts the row; the subsequent field ops populate it.

```
restoreEntity(entity, entity_id):
  ops = SELECT * FROM operations
        WHERE entity = ? AND entity_id = ?
        ORDER BY seq ASC
  assert last op with field '__deleted__' exists and is the latest op
  lastValue = {}            // field -> value, last write wins
  for op in ops where op.field != '__deleted__':
      lastValue[op.field] = op.value
  for (field, value) of lastValue:
      appendOp({ entity, entity_id, field, value })   // ordinary write path
```

`camp_id` is written first so `applyProjection`'s camp guard
(`projections.js:369-378`) sees a consistent row.

### Why not a `__restored__` sentinel

The obvious alternative — one sentinel op, each device rebuilding the row from
its own local history — is rejected. It assumes every device holds the full op
history for the entity, and that is not guaranteed: a device's first
authenticate only establishes a `last_synced_seq` baseline rather than
replaying all prior ops (`electron/db/schema.sql:30-35`). A Client that paired
after the record was created has the row but not the ops that made it, and
would restore an empty shell.

Re-emitting real field ops needs no new projection branch, no new sentinel, and
no assumption about any device's history depth. It costs op-log volume — N ops
per restore, where N is the entity's field count — which is acceptable at camp
scale (tens of restores per season, not thousands).

### Idempotency and conflicts

Each re-emitted op carries a fresh `client_write_id`, so a retried restore is
deduplicated by the existing `handleSubmitOp` path rather than producing a
second set. A restore is a normal write and can conflict normally; no special
casing.

## 3. Children

Per decision: **restore the requested record only.**

After a successful restore, if the entity has deleted children (a `tier` whose
`groups` reference it, a `cohort` whose `tiers` reference it), the UI reports
them and offers a second, explicit action:

> Restored **Unit B**. 6 groups were deleted with it — restore those too?

Never automatic. The director deleted a parent and its children in one motion,
but may have deliberately removed a child separately beforehand; a cascade
cannot tell those apart and would resurrect the second kind silently.

Restoring a child whose parent is still deleted is **allowed** and produces an
orphan (`tier_id` pointing at nothing). This is the same state the app already
tolerates — `GroupsScreen.jsx:27` renders a missing tier as `—`. The Structure
tree (separate spec) surfaces orphans as a first-class state; Trash does not
need to prevent them.

## 4. IPC surface

Three new handlers in `electron/main.js`, exposed via `contextBridge` in
`electron/preload.js` and wrapped in `src/localClient.js`. All three go through
`authorize()` like every other handler.

```js
listDeleted(token)
// -> [{ entity, entity_id, name, deleted_at, deleted_by_user_id, deleted_by_name }]
// Latest op per (entity, entity_id) is a '__deleted__' op with value 1.
// `name` is the last-known value of the entity's `name` field, so the trash
// list is readable — a bare uuid is useless to a director.

getEntityHistory(token, { entity, entity_id })
// -> [{ seq, field, value, previous_value, timestamp, author_user_id,
//       author_name, device_id, device_name }]
// Ascending by seq. `previous_value` is derived, not stored: the prior op on
// the same (entity, entity_id, field).

restoreEntity(token, { entity, entity_id })
// -> { ok: true, restored_fields: n, deleted_children: [{ entity, entity_id, name }] }
//    | { error: 'not-deleted' | 'no-history' | 'forbidden' }
```

**Authorization:** `restoreEntity` requires `admin`, matching the existing
delete path (`GroupsScreen.jsx:194` already reports "Only an admin can delete
groups"). `listDeleted` and `getEntityHistory` are read-only and available to
any authenticated role — hiding "who changed this" from non-admins on a shared
LAN device serves nobody.

## 5. UI

### Trash screen

New sidebar item under **Operations**, below Conflicts. Renders via the shared
`EntityTable` (see the entity-table spec — this screen is a consumer of it, not
a reason to build a bespoke table).

Columns: Type · Name · Deleted · By · [Restore]. Grouped by entity type by
default. Empty state: "Nothing deleted. Deleted records appear here and can be
restored."

Retention is **unbounded**. The op log is already permanent and a camp's delete
volume is small; a retention window would be a second thing to explain and the
only thing it buys is hiding rows the director may still want.

### History panel

A **History** tab on the record detail surface for every covered entity,
reading `getEntityHistory`. Reverse-chronological list:

> **Ruth** changed *Unit* from `Unit A` to `Unit B` — Tue 2:14pm, iPad-Lakeside

Field names render through the same labels the edit form uses, never raw column
names (`tier_id` → "Unit"). Foreign-key values render as the referenced
record's name, falling back to the raw id when the referent is itself deleted.

## 6. Bulk delete

The current bulk path (`GroupsScreen.jsx:201`) warns "Delete all groups? This
cannot be undone." That sentence becomes false with this work and must change:

> Delete all 42 groups? They can be restored from Trash.

The per-record `window.confirm` calls lose their scare framing for the same
reason.

## 7. Testing

Test-first at these seams:

- `restoreEntity` rebuilds every field of a deleted record — round-trip a
  `groups` row through create → edit → delete → restore, assert the projected
  row equals the pre-delete row.
- Restore of a record with no history returns `no-history`, does not partially
  insert.
- Restore of a live (non-deleted) record returns `not-deleted`.
- A re-emitted restore replicates: apply the restore ops on a second db via the
  existing replay path, assert the row appears there too.
- `getEntityHistory` derives `previous_value` correctly across three sequential
  writes to the same field.
- `listDeleted` excludes a record that was deleted and then restored.
- Non-admin `restoreEntity` returns `forbidden` and writes no ops.

## 8. Non-goals

- No retention/purge policy.
- No `template_slots` coverage (snapshots own that).
- No diff view or point-in-time rollback of a whole camp — this is per-record.
- No undo stack or `⌘Z`.
