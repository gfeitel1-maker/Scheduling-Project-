---
title: "Hard-set UNIQUE collisions become a document-derived typed conflict"
document_type: ticket
status: open
created: 2026-09-23
archive_when: two devices concurrently creating a colliding days_of_operation row both derive an identical unique:-namespaced conflicts row, and the projection choke point refuses to project a document holding an unrecorded structural collision
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md, docs/superpowers/specs/2026-09-23-merge-unique-collision-design.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md, docs/adr/2026-09-08-crdt-conflict-reconciliation.md]
related_tickets: [docs/work/tickets/T241-relax-name-unique-constraints-schema-v73.md]
---

# T235 — Hard-set UNIQUE collisions become a typed, document-derived conflict

## Why

Four constraints are real invariants and stay: `users(camp_id,name)` (`localAuth.js` resolves a login
by name — a duplicate authenticates a director against an arbitrary one of two PIN/role pairs),
`days_of_operation(camp_id,day_of_week)`, `schedule_templates(camp_id,kind)`, `camp_maps(camp_id,kind)`.
Their collisions must stop being a `console.error` plus a discarded record and become a loud, typed,
director-visible conflict — derived from the merged document so every device derives the same one.

## Success predicate (observable)

1. New pure module `electron/automerge/uniqueConflicts.js` exports `deriveUniqueConflicts(doc)` and
   `assertNoUnrecordedUniqueConflicts(doc, recorded)`. Pure with respect to SQLite and the clock,
   exactly as `reconcile.js` is.
2. Output is deterministically ordered (entity, then scoped unique value, then the sorted tuple of
   colliding ids) so two devices derive **byte-identical** output from the same document bytes. A test
   asserts this by deriving from the same document with its records inserted in reversed order.
3. Rows land under the `unique:` id namespace and carry both whole records, not one field.
4. `projector.js`'s `assertConflictsRecorded(db, doc)` gains a **second** assertion call alongside the
   existing `assertNoUnrecordedConflicts`. The scalar derivation and its shape are untouched. Two
   independent guards, one shared choke point.
5. A document holding an unrecorded structural collision cannot be projected — the guard throws with
   the same "a director's edit would be silently discarded" framing.
6. A collision resolved on either device (rename or delete) stops being derived and the row clears via
   the same sweep `crdt:` rows already use, scoped to `unique:`.
7. Integration: two `days_of_operation` rows for Tuesday with different ids, driven through the **real
   write path**, produce a `unique:` conflict row on **both** devices.

## Non-goals

Widening `reconcile()`'s return shape. Reference-aware merge. Any resolution IPC. The UI (T242).

## Notes for the implementer

- `conflicts.entity_id`, `field`, `incoming_op`, `existing_op`, `existing_op_id` are all **NOT NULL**
  in `schema.sql`. The ADR's suggestion that `entity_id` be left NULL for `unique:` rows is therefore
  not available without a further table rebuild — store the **lowest colliding id** instead (the ADR's
  own stated alternative) and put the full sorted id list in `entity_ids`.
- Do not assume the hard set's by-name lookups are safe while a collision is open: `dayIdByName`
  (`electron/ops/ingest.js` ~909) is transiently ambiguous until the director resolves it. This is
  named residual risk, not a bug to fix here.
