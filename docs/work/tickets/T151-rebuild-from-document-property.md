---
title: "Prove the rebuild property, and pin its precondition"
document_type: ticket
status: completed
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a test projects a rich camp document into a genuinely empty current-schema database and compares every modeled table, and the camps-row precondition has its own failing-case test
---

# T151 — Prove the rebuild property, and pin its precondition

From the external architecture review of 2026-09-13 (item 3), which asked for
this as a **system property** rather than entity-by-entity unit behaviour. The
concern was right about the gap and wrong about the outcome: the property holds.

The nearest existing coverage (`generalize.test.js`) rebuilds **in place** into
the same database with its tables wiped, covers only `DIRECT_CAMP_ENTITIES`, and
uses a minimal hand-built fixture. It structurally cannot catch anything that
depends on a row already being there.

## What was measured

A camp built through the real write paths — a full `commitIngest`, a schedule
week, a manual template, a location with capacity, a special day, an elective
set, an event, three parent-scoped children, `template_slots` through the
**bulk-replace** primitive (whose rows live in a different document collection
from the entity's own), and a tombstone — seeded into a document and projected
into a **fresh, empty, current-schema database**. Every modeled table, including
`camps` and `users`, comes back identical.

The `day_overrides` dependency the review remembered is gone: `DEFERRED_ENTITIES`
is empty and pinned, and v59 dropped the table.

## The precondition, now pinned by its own test

The fresh database must already hold the `camps` row with the matching id.
Document replay never creates it, and the projection guard rejects every
`camp_id` write that does not match this device's camp — so against a truly
empty database the rebuild **fails outright** rather than producing a half-camp.
That is the better behaviour, and the second test measures it so it cannot
quietly change.

The honest form of the promise is therefore *"delete SQLite, bootstrap the camps
row, rebuild"*, and no production code path runs that sequence — it is a
recovery procedure, not a feature. Recorded in `docs/current/WHERE_DATA_LIVES.md`
along with what a rebuild does **not** restore (the `operations` history ledger:
Trash, Restore's prior values, ingest-undo).
