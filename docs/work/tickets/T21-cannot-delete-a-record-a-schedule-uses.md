---
title: T21-cannot-delete-a-record-a-schedule-uses
document_type: ticket
status: resolved
created: 2026-07-30
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T19-fatal-startup-error-produces-a-silent-windowless-app.md]
archive_when: resolved
---

# T21 — A group or activity used by a schedule cannot be deleted, and the error blames the network

**Risk:** Medium, and it undercuts the Trash feature that just shipped. Pre-existing; not caused
by the trash work, which never touched the delete path.
**Found:** 2026-07-30, testing Trash in the running app.

---

## What happens

Deleting a group that appears in a schedule shows:

> Failed to delete group — check your connection and try again

Nothing is wrong with the connection. The main process throws:

```
SqliteError: FOREIGN KEY constraint failed
  at applyProjection (electron/ops/projections.js:363)
  code: 'SQLITE_CONSTRAINT_FOREIGNKEY'
```

`template_slots` references both parents with no `ON DELETE` behaviour
(`electron/db/schema.sql:198-199`):

```sql
group_id    TEXT REFERENCES groups(id),
activity_id TEXT REFERENCES activities(id),
```

So the projection's `DELETE FROM groups WHERE id = ?` is refused while any slot points at it.

**Measured, not inferred.** On the dev camp: an activity with **0** slots deleted successfully;
`Bunk 2`, with **75** slots, failed. The rule is "used anywhere in either schedule → cannot be
deleted".

## Why it matters more than it looks

The records a director most wants to remove are exactly the used ones — a bunk that folded, an
activity they stopped running. An unused record is the one deletion nobody urgently needs.

So **Trash can only ever contain records that were never scheduled.** The feature works
correctly and is largely unreachable, which is a worse outcome than either a clean failure or a
working delete.

## Two defects, and they should not be conflated

1. **The message misattributes the cause.** It names the network for a constraint violation. A
   director will check their wifi, find it fine, and conclude the app is broken. Compare T19 —
   the same family of problem: a real failure reported as something it is not.
2. **The behaviour itself is undecided.** Nobody chose "you cannot delete a scheduled group";
   it fell out of a foreign key. The options carry different meanings and this is a product
   judgement, not an engineering one:
   - **Refuse, and say why** — "Bunk 2 is used in 75 places in your schedules. Remove it from
     them first." Honest, and possibly infuriating at 75 places.
   - **Offer to clear the slots** — delete the group and empty the cells it occupied, as an
     explicit, counted confirmation. Now genuinely undoable, since Trash exists.
   - **Allow orphans** — drop the FK and let slots point at nothing. Cheapest and worst; the app
     already renders missing parents as an em dash and the grid would quietly hollow out.

Recommend the second, gated on the product owner: it matches what a director means by "delete
this bunk", and restore makes it recoverable. It must state the count before acting.

## Completion evidence

1. Deleting a used group either succeeds with an explicit, counted confirmation, or is refused
   with a message naming the real reason and the number of places.
2. No user-facing message attributes a constraint failure to the connection.
3. If deletion clears slots, the record and its slots are both restorable from Trash.
4. A test covers deleting a referenced record — the case with 75 slots, not only the easy one.
