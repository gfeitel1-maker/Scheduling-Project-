---
title: "Deleting a setup record that a schedule uses"
document_type: adr
authority: normative
status: accepted
date: 2026-07-30
supersedes: []
implementation_state: implemented
affects:
  - docs/work/tickets/T21-cannot-delete-a-record-a-schedule-uses.md
  - docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md
---

# Deleting a setup record that a schedule uses

**Status: ACCEPTED by the product owner, 2026-07-30.** Both decisions are made: *offer to clear
the slots*, and *two-step recovery* — Trash restores the record, Versions restores the week. The
mechanism still differs by entity (§2), which is the substance of this ADR.

Resolves [T21](../work/tickets/T21-cannot-delete-a-record-a-schedule-uses.md).

---

## Context

A group or activity that appears in a schedule cannot be deleted. `template_slots` references
both parents with no `ON DELETE`, so the projection's `DELETE` is refused and the director sees
*"Failed to delete group — check your connection and try again"* — which names the wrong cause
entirely.

Measured on the dev camp: an activity with **0** slots deleted; `Bunk 2`, with **75**, failed.

The behaviour was never chosen. It fell out of a foreign key, and the message was written for a
different failure.

### Every relationship that can block a delete

Mapped from `electron/db/schema.sql`, not assumed:

| Deleting | Blocked by | Rows involved |
|---|---|---|
| `groups` | `template_slots.group_id` | that group's entire week, per route |
| `activities` | `template_slots.activity_id` | every cell where it is placed |
| `days_of_operation` | `anchor_activities.day_id`, `template_overlays.day_id` | fixed events and overlays on that day |

Note `template_slots.day_id` and `.time_block_id` carry **no** FK, so deleting a day or a time
block does not fail on slots — it silently orphans them instead. That asymmetry is pre-existing
and worth fixing separately; this ADR does not.

## Decision

### 1. Deleting offers to clear, with the count stated

Product owner, 2026-07-30: **offer to clear the slots.**

The confirmation names the real number before anything happens — *"Bunk 2 is used in 75 places
in your schedules. Delete it and clear those?"* — because the count is the whole basis on which
a director decides. It must be counted, never estimated, and shown before the action, not
reported after.

Refusing outright was rejected: telling a director to empty 75 cells by hand before deleting a
bunk that no longer exists is not a workflow.

### 2. "Clear the slots" is not one operation — it differs by entity

This is the substance of the ADR, and it is why the ticket's one-line remedy is not
implementable as written.

**Deleting an activity → empty the cells, keep them.** The slots are grid positions that
happen to hold this activity. Set `activity_id` to null and each cell becomes "not filled yet".
The week keeps its shape; the director sees gaps where the activity was.

**Deleting a group → delete the slot rows.** A group's slots are not cells that reference it,
they *are* that group's week — one row per day × block. There is nothing to empty; the column
ceases to exist. This is the destructive case.

**Deleting a day → remove its anchors and overlays**, and additionally clear the orphaned
`template_slots` rows for that day, which no FK protects today.

### 3. What is recoverable afterwards, stated honestly

Trash restores **the record**, not its slots
([restore ADR](2026-07-30-restore-deleted-records-from-the-op-log.md) §3 — restore the
requested record only). So:

- Restoring a deleted **activity** gives back the activity. It does **not** re-place it; the
  cleared cells stay empty. That is correct and should be said in the confirmation, because a
  director may reasonably expect otherwise.
- Restoring a deleted **group** gives back a group with **no week at all**. Its 75 slots are
  gone and Trash cannot bring them back.

That second case is a real hole. My earlier claim on the ticket — "restore makes it
recoverable" — was **wrong for groups**, and is corrected here.

### 4. Therefore: snapshot the affected route before clearing a group's week

The mechanism already exists and is proven — auto-saving a version before a destructive
schedule change is what regeneration already does, and snapshots were verified to record a real
payload on 2026-07-28.

So before deleting a group, auto-save a version of each route that holds its slots. The group
comes back from Trash; its week comes back from Versions. Neither mechanism is stretched beyond
what it already does.

**Decided 2026-07-30: two-step recovery.** Trash restores the bunk, Versions restores the week.
Deleting a group is not refused, because the snapshot makes it reversible and the director asked
for the delete.

Two things this obliges the implementation to get right, since recovery now depends on them:

- The snapshot must be saved **before** any slot is removed, and a failure to save it must
  **abort the delete** rather than proceeding unprotected. A half-done version is worse than no
  feature.
- The confirmation must tell the director where the week went, in their words — not "a snapshot
  was taken". Something they could act on months later without knowing what a snapshot is.

### 5. The error message is a separate fix and must land regardless

Whatever is decided above, a foreign-key violation must never be reported as a connection
problem. That message sends a director to check their wifi for a problem that has nothing to do
with the network — the same class of misdirection as T19's silent failure.

## Consequences

- Deleting a used record becomes possible, which is what makes Trash reachable at all: today it
  can only ever hold records that were never scheduled.
- Clearing writes one op per affected slot. For a group with 75 slots across two routes that is
  ~150 ops in one action. Acceptable at camp scale, and it is bounded and countable — the
  confirmation already knows the number.
- Restoring an activity leaves gaps rather than restoring placements. Deliberate, and stated in
  the copy.

## Completion evidence

1. Deleting a group used by a schedule succeeds after a confirmation that names the real count.
2. The confirmation shows the count **before** the action.
3. A version is saved for each affected route before a group's slots are removed, and restoring
   that version brings the week back.
4. Deleting an activity empties its cells and leaves the grid otherwise intact.
5. No user-facing message attributes a foreign-key failure to the connection.
6. Integration tests cover deleting a referenced record — the 75-slot case, not only the easy
   one — and the resulting ops replicating to a second device.
