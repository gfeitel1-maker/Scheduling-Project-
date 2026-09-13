---
title: "Remove Day Overrides entirely (reversing the T108 re-point)"
document_type: ticket
status: open
created: 2026-09-12
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-23-override-family-model.md]
related_adrs: [docs/adr/2026-08-21-day-overrides-repoint-shape.md, docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md, docs/adr/2026-08-23-override-family-model.md, docs/adr/2026-08-23-unified-schedule-overlay-model.md]
supersedes: [docs/work/tickets/T108-day-overrides-repoint.md, docs/work/tickets/T113-day-override-undo-redo.md]
archive_when: the day_overrides table, its projections/undo/restore/document wiring, and its render path are gone; no screen offers override authoring; the full gate is green
---

# T145 — Remove Day Overrides entirely

**Owner decision, 2026-09-12 (verbatim):** *"day overrides should be taken out — there was a
ticket for that at some point. if you are overriding a day you are either changing it in the
special events schedule or you are replacing it on the grid."*

This **reverses the owner decision recorded in T108** ("re-point, don't remove", 2026-08-20).
That reversal is deliberate and is the point of this ticket — T108's re-point shipped, and the
owner has since concluded the feature should not exist at all. Pre-production, no live camps,
no back-compat obligation (see `feedback_preproduction_bias_bold`).

## Why this is coherent, not just a reversal

The owner's reasoning — *either it's a special event, or you replace it on the grid* — is the
same conclusion `docs/adr/2026-08-23-override-family-model.md` reached independently from the
data. That ADR found (§line 78) that `events` **"already absorbed the partial-day, multi-block,
multi-group case"**, and that what remained was *"a naming/navigation problem"*: a director
hunting for "how do I record Friday afternoon" faces two plausibly-named entry points with no
guidance on which fits.

Day Overrides is the third such entry point. Removing it collapses the choice to the two the
owner named, which is the IA fix that ADR identified but did not take.

**Non-goal:** this does NOT touch `events`, `special_days`, `template_overlays`, or electives.
Only the `day_overrides` family. The override-family ADR's argument for keeping those tables
separate still holds and is not reopened here.

## Blast radius (measured, 2026-09-12, not estimated)

**28 non-test source files + 23 test files.** This is a large removal, comparable in class to
the Stage 6 WS deletion — not a column drop.

**Data layer**
- `electron/db/schema.sql` — `day_overrides` table (~L1050) and the `day_overrides_json` column
  on schedule snapshots (~L697-711). **Both are stored shape; snapshots serialize overrides
  inline**, so removal changes what a saved snapshot contains.
- `electron/db/localDb.js` — migration to drop; `CURRENT_SCHEMA_VERSION` 58 → 59.
- `electron/db/rollback/v38_down.js`, `v46_down.js` — historical rollbacks referencing the pair.

**Document / sync layer (Automerge)**
- `electron/automerge/campDocument.js`, `projector.js`, `seed.js`, `electron/sync/automerge/liveDoc.js`

**Ops layer**
- `electron/ops/projections.js`, `campScopedEntities.js`, `undoReferences.js`, `restore.js`,
  `materializeImportedVersion.js`, `electron/auth/permissions.js`

**Renderer**
- `src/utils/applyDayOverrides.js`, `src/utils/dayOverrideCoordinate.js` — **delete outright**
- `src/components/schedule/PulledCell.jsx` — **delete outright**
- `src/screens/schedule/useSlotMutations.js` — override-mode routing, `writeOverrideForCoordinate`,
  `pullOverrideCell`, `pullOverrideDay`, `overrideModeDayId`
- `src/screens/schedule/useScheduleData.js`, `useSnapshots.js`, `gridGeometry.js`
- `src/components/schedule/ScheduleGroupView.jsx`, `ScheduleDayView.jsx`
- `src/screens/ScheduleScreen.jsx`, `ImportScreen.jsx`, `recordLabels.js`
- `src/data/scheduleRepository.js`, `src/localClient.mock.js`, `src/engine/readiness.js`

## Sequencing (small reversible slices, not one PR)

1. **UI removal** — take override authoring out of ScheduleScreen/useSlotMutations and delete
   `PulledCell`. Nothing can create an override. Ship and verify alone.
2. **Render removal** — delete `applyDayOverrides`/`dayOverrideCoordinate` and their call sites
   in the two views + gridGeometry. Existing rows become inert.
3. **Plumbing removal** — projections, undoReferences, restore, permissions, campScopedEntities,
   the Automerge document + projector + seed, mock parity.
4. **Schema drop** — v59 migration dropping `day_overrides` and the snapshot
   `day_overrides_json` column, with a rollback and a migration test.

### CORRECTION 2026-09-13 — slices 3 and 4 CANNOT be separated

The sequencing above was wrong, and the tests said so. Three parity scanners compare
`schema.sql` against the registries:

| scanner | what it asserts |
|---|---|
| `electron/ops/projectionsCoverage.test.js` | every non-key column of every PROJECTIONS table is a registered field |
| `electron/ops/undoReferences.schemaParity.test.js` | every DB-enforced `REFERENCES` clause at a deletable entity is registered |
| `electron/ops/dayOverrides.projections.test.js` | the entity's own projection behaviour |

With `day_overrides` removed from `PROJECTIONS`/`undoReferences` but the TABLE still present in
`schema.sql`, all three red — **correctly**, because "a table exists that no registry knows about"
is exactly the drift they are built to catch. Measured at commit `c435f83`: 8 failures across
those three files, 1188 passing.

So the registry removal and the table drop must land in **one** commit. The original instinct
(isolate the schema change, because the last several schema-touching PRs each failed a gate on a
missed sibling test or a version canary) was right in spirit and wrong in fact: isolating it here
means deliberately committing a state the repo's own guards reject.

## Risks to challenge before coding (Red Hat)

- **Saved snapshots already contain `day_overrides_json`.** Dropping the column must not make an
  existing snapshot unrestorable. Decide explicitly: ignore-on-read, or rewrite stored snapshots.
- **Undo.** `undoReferences.js` knows about override rows; removing the entity while undo history
  still references it must not throw on an old undo entry.
- **Readiness engine.** `readiness.js` counts overrides; removing them must not change a camp's
  readiness state in a way that surprises a director mid-setup.
- The `retireOrphanSlots` / `deleteWeek` paths touch override rows — confirm no orphan class opens.
- **`day_overrides` is a MODELED SYNC ENTITY, and `check:governance` gates the pair.** The
  `entity-cannot-sync` finding (added by #370 / `e70e2eb`, 2026-09-12) fails when an entity is
  registered in `PROJECTIONS` (`electron/ops/projections.js`) but absent from `MODELED_ENTITIES`
  (`electron/automerge/campDocument.js`) — a table a screen can write, no other device ever sees,
  and `projectAll` may delete. `day_overrides` is in BOTH today. The check is **one-directional**,
  so the ordering is:

  | order | result |
  |---|---|
  | remove from `PROJECTIONS` only | clean — the check does not look this way |
  | remove from `MODELED_ENTITIES` only | **gate fails, correctly** — leaves a writable table that cannot sync |
  | remove from both in one change | clean |

  So either the two removals travel together in slice 3, or `PROJECTIONS` goes first. Never
  `MODELED_ENTITIES` first. The `SQLITE_ONLY_BY_DESIGN` allowlist in `scripts/check-governance.js`
  is **not** the way past this — it is for deliberately device-local data and requires a written
  reason plus a row in `docs/current/WHERE_DATA_LIVES.md`.

## What this closes

- **T108** — the feature it built is being removed. Close as superseded, not completed.
- **T113** (undo/redo for override writes) — moot; there is nothing left to undo.

## Review loop

**Architect (removal design + snapshot-compat decision) → Red Hat (stored-shape change on a
synced table) → Maker (slice-at-a-time) → Red Hat → Code Reviewer → Verifier → Grader.**
