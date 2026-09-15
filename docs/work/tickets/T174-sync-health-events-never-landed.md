---
title: "T148's two durable traces never landed a row"
document_type: ticket
status: completed
created: 2026-09-15
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a failed document save and a failed merge projection each leave a row a support tool can read back, and the health check can no longer report healthy because nothing could be written
---

# T174 — T148's two durable traces never landed a row

**My own defect, shipped in #388, found by a Maker building on top of it.**

T148 closed a class of defect: a write reaching SQLite but not the authoritative
Automerge document, with nothing durable to show for it. Two of its three paths
have no op id to key on — a merged document that will not project (a merge has no
op) and a debounced save that fails on disk (the window is gone by the time it
fails) — so both were routed to `audit_events` with `outcome: 'error'`.

`audit_events.outcome` is `CHECK (outcome IN ('allow','deny'))`. Every one of
those inserts was rejected. `recordAuditEvent` caught the violation and turned it
into a console line, exactly as designed — an audit failure must never break the
action it records.

So the durable trace never landed a single row. And
`check_projection_health` read those two actions back, found nothing, and
reported **healthy**.

Absence read as success, inside the fix written to remove absence read as
success.

## Measured, not inferred

A three-row probe against a real database: both `outcome:'error'` rows rejected
with `CHECK constraint failed`, the `outcome:'deny'` control landed.

## What changed

- **`sync_health_events`** (schema v62) — its own host-local table, never
  replicated. Additive, no rebuild, nothing to migrate, because no row could
  ever have been written.
- **Not** `audit_events`: its outcome vocabulary is an authorization one and
  correctly so. Widening it would have muddied a security log to fit a
  diagnostic. **Not** `projection_failures`: its primary key is an op id with a
  foreign key to `operations(id)`, and neither event has an op.
- `recordSyncHealthEvent` **returns whether the row landed**. `liveDoc`'s flush
  now folds that into its existing "nothing durable was recorded" warning.
- `check_projection_health` reads the new table.

## The lesson, which is the point

`recordAuditEvent` never throwing is correct. It is also why nobody noticed for a
week: the tests that existed asserted *the call was made*.

**Every test in `syncHealthEvents.test.js` asserts the row is read back.** Two of
them pin the original defect directly — that `audit_events` still rejects a
non-allow/deny outcome, and a control proving that empty result is the constraint
rather than a broken writer.

A writer that cannot throw needs a caller that can ask whether it worked. That is
what `documentWriteFailureRecorded` already does on the sibling path, and what
this now does here.
