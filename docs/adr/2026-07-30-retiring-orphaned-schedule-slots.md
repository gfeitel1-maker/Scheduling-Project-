---
title: "Retiring orphaned schedule slots by preserving them as a Version"
document_type: adr
authority: normative
status: accepted
date: 2026-07-30
supersedes: []
implementation_state: not-started
affects:
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
  - docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  - docs/work/tickets/T21-cannot-delete-a-record-a-schedule-uses.md
---

# Retiring orphaned schedule slots by preserving them as a Version

**Status: ACCEPTED — product owner instructed "fix the orphans first", 2026-07-30.** The one
judgement this ADR makes on their behalf is *preserve rather than discard* (§3); it is the
non-destructive reading of that instruction, and it is called out here so it can be overruled.

---

## Context

Some databases carry `template_slots` rows whose `template_id` has no row in
`schedule_templates`. Measured on the dev camp:

```
template_id                        slots   has a template row?
48485127-…                          50     yes  (kind: generated)
schedule-template:<campId>          50     NO   ← orphaned
schedule-template:<campId>:manual   50     yes  (kind: manual)
```

They are the residue of the v23 window: the renderer wrote slots under the *derived* generated
id while the camp's real generated row still carried a random UUID, and the
`(camp_id, kind)` constraint refused to create a second row for it.

**v24 already tried to repair this, and correctly declined here.** Its repair repoints orphans
onto the real template only when that template has no competing rows —
`if (mine > 0) continue`, "a competing week exists — leave the orphans alone". The real
generated template holds 50 slots, so repointing would overwrite a visible week with an
invisible one. Leaving them was the right call at the time.

### Why they can no longer be left alone

[T21](2026-07-30-deleting-a-record-a-schedule-uses.md) makes deleting a used record conditional
on snapshotting the affected routes first. An orphan slot belongs to no route, so it cannot be
snapshotted, so the delete must refuse. Tester found exactly that in the running app:

> "25 of the places 'Bunk 2' is used are in a schedule this app can no longer open, so they
> could not be saved first. Nothing was deleted."

The refusal is correct — it will not destroy what it cannot protect — but it means **no group
can be deleted on any camp carrying orphans.** The parked decision has come due.

## Decision

### 1. The orphans are not a duplicate, so discarding is not free

Compared placement by placement against the visible generated week: **2 differ each way.** They
are a near-identical but distinct week. Small, and not nothing.

### 2. They cannot be repointed

That is v24's approach and it remains unavailable for the same reason: the real generated
template already holds a week, and `(camp_id, kind)` permits only one generated row. Repointing
means overwriting what the director can see with what they cannot.

### 3. Therefore: preserve each orphan set as a Version, then delete the rows

Migration **v26**, for each orphan `template_id`:

1. Attribute it to a route, using v24's own method — the orphan id equals
   `deriveScheduleTemplateId(camp_id, kind)` for exactly one real template. That id-parsing is
   permitted **inside a migration only**; `schedule_templates.kind` remains the sole runtime
   authority, per the plural-candidates ADR.
2. Write a `schedule_snapshots` row against the **real** template, carrying the orphan slots and
   overlays in the shape `saveSnapshot` already writes, `is_auto = 0`, and a name a director can
   understand — not "orphan", not "template_id".
3. Delete the orphan `template_slots` and `template_overlays` rows.
4. Journal what was moved, as v24 did, so the operation is inspectable afterwards.

Nothing is lost: the week becomes a Version the director can open and restore. The blocker
clears because no slot without a route remains.

**This is the same shape as T21 itself** — snapshot, then remove — which is the point. The app
already has one answer to "destroy something recoverable"; this uses it rather than inventing a
second.

### 4. The snapshot must succeed or the migration must not proceed

If the snapshot insert fails for a camp, leave that camp's orphans alone and record why. A
migration that deletes rows it failed to preserve is worse than one that does nothing.

## Consequences

- Deleting a used group becomes possible on affected camps, unblocking T21.
- The recovered week appears in Versions on the generated route, where a director may be
  surprised to find a schedule they do not remember saving. The name must therefore explain
  itself without jargon.
- Camps with no orphans are untouched. Production was verified clean on 2026-07-29 — one
  template, twenty slots, no orphans — so this is expected to be a no-op there.
- Rollback restores the deleted rows from the journal; the snapshot row is left in place, since
  removing a Version a director may since have restored from would be its own harm.

## Completion evidence

1. On a database carrying orphans, v26 leaves zero `template_slots` rows whose `template_id` has
   no `schedule_templates` row.
2. The orphan week is present in Versions, opens, and restores.
3. No slot is deleted for a camp whose snapshot insert failed.
4. A camp with no orphans is byte-identically unchanged.
5. Fresh-vs-migrated schema equivalence holds, per the precedent in
   `electron/db/scheduleKind.migration.test.js`.
6. After v26, deleting a group with slots in both routes succeeds — the T21 case that is
   currently refused.
