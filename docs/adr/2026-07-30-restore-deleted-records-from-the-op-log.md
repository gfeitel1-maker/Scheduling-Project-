---
title: "Restoring deleted records by re-emitting their field ops"
document_type: adr
authority: normative
status: proposed
date: 2026-07-30
supersedes: []
implementation_state: not-started
affects:
  - docs/work/specs/2026-07-29-trash-and-record-history-design.md
  - docs/adr/2026-07-25-device-trust-revocation.md
---

# Restoring deleted records by re-emitting their field ops

**Status: PROPOSED — not accepted, not implementable.** Per Article IV an
architecture change requires explicit product-owner acceptance before Maker is
dispatched. This ADR also records **two defects in the approved spec** that must
be settled before code is written (§4, §5); one of them is a security hole and
the other is a correctness bug on any device that is not the Host.

Governs [`docs/work/specs/2026-07-29-trash-and-record-history-design.md`](../work/specs/2026-07-29-trash-and-record-history-design.md).

---

## Context

A delete is already an ordinary op. `localClient.deleteEntity`
(`src/localClient.js:33`) writes the reserved sentinel field `__deleted__`
(`electron/ops/operations.js:19`), so the record's whole history — every field
value, author, device and timestamp — survives in `operations`. Only the
materialized row is dropped. **Verified in code, not assumed.**

So the app already holds everything needed to answer "what did I delete, and
can I have it back", and shows a director neither.

### Verified current state

- `idx_operations_entity ON operations(entity, entity_id, field)` **already
  exists**. Per-entity history reads and the restore read are indexed. Confirmed
  against a live database.
- `users` **is** a writable projection (`electron/ops/projections.js:34`), so
  user records have ops — including `pin_hash` and `pin_salt`.
- `main.js` already strips those two fields from op-applied IPC pushes
  (`IPC_PIN_FIELDS`, `electron/main.js:37,86`) — at the *read* boundary only.
- A first-pairing Client receives a `full_sync` of **materialized rows**, not op
  history (`electron/sync/syncServer.js:165-186`), and `last_synced_seq` is set
  to the then-current max so prior ops are never sent (`schema.sql:28-35`).

## Decision

### 1. Restore re-emits the entity's last-known field values as ordinary ops

Adopted from the spec. Read the entity's ops, take the last value per field,
append one ordinary op per field through the normal write path. `ensureExists`
on the projection re-inserts the row; the field ops repopulate it. `camp_id` is
written first so the camp guard (`projections.js:369-378`) sees a consistent row.

The spec's rejection of a `__restored__` sentinel is correct and is upheld: a
sentinel asks every device to rebuild the row from its own local history, and
not every device has it (see Verified current state). Re-emitting real ops needs
no new projection branch and no assumption about history depth **on the
receiving side**.

### 2. No schema change, and therefore no migration

This is the significant difference from the v23/v24 work. Reads use an index
that already exists; restore uses the write path that already exists; the three
new IPC handlers add no tables and no columns.

**Consequences for the gate profile:** there is no migration, so there is no
migration/rollback plan to write and no fresh-vs-migrated equivalence check.
Integration tests remain **mandatory** — this emits ops that replicate to peers,
which is the Database/sync row's real concern — but the blast radius is far
smaller than the last change of this class. Rollback is reverting the commit.

### 3. Children are never restored implicitly

Adopted from the spec. Restoring a parent reports its deleted children and
offers a second, explicit action. A cascade cannot distinguish "deleted with the
parent" from "deleted deliberately, earlier", and would silently resurrect the
second kind. Orphans are permitted; the app already tolerates them
(`GroupsScreen.jsx:27` renders a missing parent as `—`).

### 4. Restore is restricted to an explicit entity allowlist, enforced in the main process

**This corrects a hole in the spec.** The spec scopes the feature to setup
entities *in prose*, but the handler it specifies takes an arbitrary entity
string: `restoreEntity(token, { entity, entity_id })`. Prose is not enforcement.

Because `users` is a writable projection, a restore of a deleted user would
re-emit **`pin_hash` and `pin_salt`** as ordinary ops through the normal write
path, and those ops replicate. The existing `IPC_PIN_FIELDS` guard does not help:
it filters what is *pushed to the renderer*, not what is *written to the log*.
That would make a restore a credential-lifecycle operation — resurrecting an
account someone deliberately removed, with its old PIN intact.

Therefore:

- `restoreEntity` accepts only: `cohorts`, `tiers`, `groups`, `activities`,
  `days_of_operation`, `time_blocks`, `anchor_activities`,
  `day_override_templates`.
- Anything else — `users`, `camps`, `devices`, `schedule_templates`,
  `template_slots` — is rejected with `error: 'not-restorable'`. Not hidden in
  the UI; **refused in the handler.**
- The sentinel fields `__deleted__` and `__bulk_replace__` are never re-emitted.
- The allowlist is asserted by a test that fails if a new entity is added to the
  projection registry without a deliberate decision about restorability.

### 5. Restore executes on the Host, not on whichever device asked

**This corrects a correctness bug in the spec**, and it is the same argument the
spec itself uses to reject the sentinel.

The spec says "the Host reads the entity's history", but specifies
`restoreEntity` as a local main-process IPC handler with nothing routing it to
the Host. On a Client, `operations` does **not** contain history for records
created before that device paired — the first `full_sync` sends materialized
rows and sets `last_synced_seq` to the current max. A Client restoring such a
record would find no ops and produce exactly the empty shell the spec set out to
avoid.

Therefore:

- A Client sends a restore **request** to the Host over the existing WebSocket;
  the Host performs the read and appends the ops, which then replicate back
  normally.
- If the Host is unreachable, restore fails with a plain-language message saying
  so. It does not fall back to local history.
- On the Host, `restoreEntity` additionally asserts it holds the entity's
  **creation** op before proceeding, and returns `error: 'no-history'` if not —
  a cheap guard against restoring a partial record from a truncated log.

Restore is therefore **not** available offline on a Client. That is a real
limitation and is accepted: a wrong restore is worse than a delayed one.

### 6. Authorization

Adopted from the spec. `restoreEntity` requires `admin`, matching the delete
path. `listDeleted` and `getEntityHistory` are read-only and available to any
authenticated role — hiding "who changed this" from staff on a shared LAN device
serves nobody. All three go through `authorize()`.

Note `getEntityHistory` returns author and device names. It must apply the same
`IPC_PIN_FIELDS` filtering as the op-applied path, or a user's history would
expose `pin_hash` to any authenticated caller. This is the read-boundary twin of
§4 and is easy to miss.

## Consequences

- A director can see what was deleted and get it back, from data the app already
  had and never surfaced.
- Op-log volume grows by N ops per restore, N = the entity's field count.
  Acceptable at camp scale; noted so it is not a surprise.
- Restore is Host-only. Clients get a clear failure, not a wrong answer.
- `users` can never be restored through this path. Deliberate: account recovery
  is a separate concern with different rules, and should not arrive as a side
  effect of a trash can.

## Open questions for the product owner

1. **Should the Trash screen show *who* deleted a record to non-admin staff?**
   §6 says yes for history generally. Delete attribution on a shared device is
   more pointed than edit attribution, and this is a product judgement.
2. **Is a Host-only restore acceptable**, or should a Client queue the request
   for when the Host returns? Queuing is more work and adds a pending-intent
   concept the app does not otherwise have.

## Completion evidence

1. Deleting a setup record then restoring it returns the record with every field
   as it was, verified against the pre-delete values.
2. A restore performed on a **Client** produces the same result as on the Host —
   or fails with a clear message when the Host is unreachable. Tested with two
   devices, not one.
3. `restoreEntity('users', …)` is refused by the handler, with a test proving it.
4. `getEntityHistory` never returns `pin_hash` or `pin_salt`.
5. Restoring a parent does not resurrect its children; the offer to restore them
   is explicit.
6. Integration tests cover restore-and-replicate across two devices.
