---
title: "Retire the schedule overlay/stamp subsystem (template_overlays)"
document_type: adr
status: proposed
authority: normative
implementation_state: not started
task_class: database-sync
date: 2026-08-30
supersedes: []
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-08-23-override-family-model.md
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
amends:
  - "docs/adr/2026-08-23-override-family-model.md (§3 named template_overlays as one of the four live override-family tables; this ADR removes it from that family entirely rather than keeping it separate)"
affects:
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/db/rollback/v46_down.js
  - electron/sync/syncClient.js
  - electron/ops/projections.js
  - electron/ops/campScopedEntities.js
  - electron/ops/restore.js
  - electron/ops/duplicateWeek.js
  - electron/ops/deleteWeek.js
  - src/components/schedule/ScheduleGroupView.jsx
  - src/components/schedule/ScheduleDayView.jsx
  - src/screens/schedule/useSlotMutations.js
  - src/screens/schedule/gridGeometry.js
  - src/screens/schedule/useSnapshots.js
  - src/screens/snapshotMatchesSchedule.js
  - src/screens/snapshotRestore.js
  - src/screens/ScheduleScreen.jsx
  - src/localClient.mock.js
archive_when: owner approves or rejects the recommendation below and, if approved, the retirement PR ships
---

# Retire the schedule overlay/stamp subsystem (template_overlays)

**Owner has approved full retirement (2026-08-30).** This ADR is the migration/removal design, not
a request to reconsider the decision. No code is authorized by this document; it is the brief Maker
executes against.

---

## 1. Scope statement

**Retired, completely, this PR:**

- The `template_overlays` table and everything that reads or writes it.
- The "stamp mode" / field-trip-label authoring UI (`FieldTripDrawer`, `useOverlayFillStamp`,
  `OverlayCell`, the `decision.kind === 'overlay'` render branch).
- The `overlays` column on `schedule_snapshots` and every code path that reads or writes it.

**Explicitly NOT touched by this ADR** (named because a past override-family ADR discussed
`template_overlays` alongside these, and a Maker skimming that history could conflate them):

- The two schedule **routes** (Manual / Generated) — `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`
  stays fully in force.
- **Day overrides** (`day_overrides` table, swap/pull markers, `applyDayOverrides`) — a structurally
  and behaviorally unrelated mechanism that happens to sit in the same "override family" discussion
  in `docs/adr/2026-08-23-override-family-model.md`. Not part of this retirement.
- Schedule **weeks** (`schedule_weeks`) and week-scoped exclusions.
- `registerOverlayOccupancy` inside `src/engine/buildSchedule.js:212` — this is a **different,
  unrelated concept** (location-occupancy bookkeeping for anchors/events/electives placed by the
  engine). The name collision with "overlay" is coincidental. Do not touch it, do not rename it as
  part of this work — a rename would be scope creep and would make this diff harder to review for
  what it actually does.
- `special_days`, `events`, `event_slots` — untouched.

**Why full retirement rather than deprecation:** the investigation (trusted, spot-verified below)
found the authoring path already dead — nothing in `src/` sets `stampMode` to a truthy value outside
its own test, so `handleStampClick` is unreachable and `addOverlay` has no live caller. The only
"live" part of the subsystem is passive: existing rows can still be read, rendered, copied on
`duplicateWeek`, and cleaned up on `deleteWeek`. There is no camp data in the wild (pre-production,
per standing project bias) and no in-repo seed/demo data creates `template_overlays` rows, so there
is nothing to migrate *out of* the table — only schema and code to delete.

**Verification of the investigation's citations** — all confirmed current on this worktree's `main`
before writing this ADR:

- `template_overlays` DDL: `electron/db/schema.sql:615-623` — confirmed, columns match exactly
  (`id, template_id, unit_id, day_id, from_block_order, to_block_order, label`).
- `schedule_snapshots.overlays`: `electron/db/schema.sql:642` (column `overlays TEXT`) — confirmed;
  note the schema comment directly above the table (`schema.sql:626-636`) already documents that
  `slots`/`overlays` are immutable snapshot blobs, not field-synced — relevant to §3 below.
- `electron/sync/syncClient.js:67` (synced entity column map) — confirmed.
- `electron/ops/campScopedEntities.js:52-56,154` — confirmed (registry entry + list membership).
- `electron/ops/projections.js:709-726` — confirmed (`BULK_REPLACE_ENTITIES.template_overlays`).
- `electron/ops/restore.js:40` (`template_overlays: 'refused'`) — confirmed.
- `electron/ops/duplicateWeek.js:138-148` — confirmed (copies overlay rows on week duplication).
- `electron/ops/deleteWeek.js:114-119` — confirmed (FK cleanup on week delete).
- Current schema version is **52** (`electron/db/localDb.js:17`,
  `export const CURRENT_SCHEMA_VERSION = 52`); the last migration block is the `>= 51 && < 52` guard
  for `open_reconciliation_decisions` (`electron/db/localDb.js:2029-2052`). **This ADR's migration is
  v53.**
- Rollback convention confirmed against `electron/db/rollback/v46_down.js` (a same-shaped prior
  DROP, dropping the confirmed-dead `day_override_templates`/`day_override_template_slots` pair) —
  guard-widening comment (`>= 46`, not `= 46`), transactional DDL, `DELETE FROM schema_migrations
  WHERE version >= N`, and a direct-invocation CLI block. §2 below follows this shape.

---

## 2. Migration v53

### 2a. Drop `template_overlays`

Straight `DROP TABLE`. No backfill — the table holds no data worth carrying anywhere; a stamp label
was never anything other than free text painted on the generated-route grid, with no FK anyone
outside this subsystem depends on.

### 2b. `schedule_snapshots.overlays` — DROP, not nullable-and-ignored

**Recommendation: drop the column.** This is the one place with actual stored rows to reason about
(a camp with schedule snapshots will have non-null `overlays` JSON blobs in existing rows), so it
gets the explicit treatment the migration guard skill in this repo expects:

- **What happens to existing snapshot rows:** their `overlays` JSON is discarded. Per the standing
  pre-production bias (no live camps, no real data, owner prefers hard cutovers over back-compat
  ceremony), this is the correct call — there is nothing downstream that reads a snapshot's
  `overlays` value once the render layer that consumes it (§5) no longer exists. Keeping the column
  "just in case" would be exactly the "flexibility nobody asked for" anti-pattern this repo's
  `karpathy-guidelines` skill warns against, on a column nothing will ever populate again.
- **`snapshotMatchesSchedule` / the `on_screen` shape:** both currently compare `{ slots, overlays }`
  (per the investigation, `src/screens/snapshotMatchesSchedule.js` and
  `src/screens/schedule/useSnapshots.js`; `ScheduleScreen.jsx:745-746` computes `on_screen` from that
  pair). After this migration, **snapshots are compared on `slots` alone.** `on_screen` becomes
  `{ slots }`. Maker's job in §5 is to remove the `overlays` half of every one of these comparisons,
  not to leave it comparing against `undefined` — a snapshot's "does this match the live grid" check
  must not silently pass or silently fail because one side of a stale comparison always reads
  `undefined`. This is a correctness requirement, not cosmetic: it is exactly the kind of thing Red
  Hat should be asked to verify (§7).
- **SQLite mechanics:** SQLite's `ALTER TABLE ... DROP COLUMN` is supported (3.35+, which
  better-sqlite3 in this repo satisfies) but is simplest and safest done the same way the codebase
  already handles column-shape changes elsewhere in `localDb.js` (see the v51 `anchor_activities`
  block just above the insertion point, `electron/db/localDb.js:1974-2016`): create the replacement
  table without the column, copy the surviving columns across, drop the old table, rename. Do this in
  one transaction alongside the `template_overlays` drop.

### 2c. Migration guard shape

Follow the exact pattern already established at `electron/db/localDb.js:1976` and `:2029` — widen the
guard, do not narrow it:

```js
// v53 — retire the overlay/stamp subsystem (docs/adr/2026-08-30-retire-overlay-stamp-subsystem.md).
// Drops template_overlays outright (no live writer — the authoring path was already dead, see the
// ADR §1) and drops schedule_snapshots.overlays (hard cutover, no back-compat: pre-production, no
// real camp data, existing snapshot overlays JSON is discarded per the ADR's explicit decision).
if (getSchemaVersion(db) >= 52 && getSchemaVersion(db) < 53) {
  db.transaction(() => {
    db.pragma('foreign_keys = OFF')
    db.exec(`DROP TABLE IF EXISTS template_overlays;`)
    db.exec(`
      CREATE TABLE schedule_snapshots_v53 (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES schedule_templates(id),
        name TEXT,
        is_auto INTEGER,
        created_at TEXT NOT NULL,
        slots TEXT,
        day_overrides_json TEXT
      );
      INSERT INTO schedule_snapshots_v53
        SELECT id, template_id, name, is_auto, created_at, slots, day_overrides_json
        FROM schedule_snapshots;
      DROP TABLE schedule_snapshots;
      ALTER TABLE schedule_snapshots_v53 RENAME TO schedule_snapshots;
    `)
    db.pragma('foreign_keys = ON')
  })()

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (53, ?)').run(
    new Date().toISOString()
  )
}
```

Note `day_overrides_json` must stay the **last** column on the rebuilt table, matching the existing
column-order-trap precedent the schema.sql comment at `:626-636` already calls out for this exact
table (`elective_sets.is_reusable` / `special_days.notes` share the same trap). Also update
`CURRENT_SCHEMA_VERSION` to `53` and `schema.sql` itself (drop `template_overlays`'s `CREATE TABLE`
block at `:615-623`, drop the `overlays TEXT` line from `schedule_snapshots` at `:642`, and update the
comment block above it that currently explains why `overlays` exists) — `schema.sql` is what a fresh
database gets, so it must match the migrated shape exactly (this is what the repo's fresh-vs-migrated
schema-equivalence check enforces per `docs/governance/GOVERNANCE_INDEX.md`'s Database/sync row).

### 2d. Rollback — `electron/db/rollback/v53_down.js`

Mirror `v46_down.js`'s shape and honesty:

- Recreate `template_overlays` (empty — there is no data to restore; per §1 nothing writes to it in
  the current build, so an empty recreation loses nothing that was reachable).
- Recreate `schedule_snapshots.overlays` as a **nullable** `TEXT` column added via `ALTER TABLE
  schedule_snapshots ADD COLUMN overlays TEXT` — do NOT attempt to restore prior values; there is no
  source to restore them from (the forward migration discarded them, by design, per §2b). Existing
  snapshot rows come back with `overlays = NULL`. State this explicitly in the rollback's file-header
  comment, the same way `v46_down.js` states "there was never data to lose" — here the equivalent
  honest statement is "there was data, it was deliberately discarded per ADR §2b, and this rollback
  does not attempt to un-discard it."
- Guard the `schema_migrations` cleanup as `DELETE FROM schema_migrations WHERE version >= 53`, per
  the `v46_down.js` precedent (a later migration's row surviving would defeat the `>= 52 && < 53`
  guard on next `initSchema()`).
- State plainly, as `v46_down.js` does, that this rollback does **not** undo the plumbing-file changes
  (`syncClient.js`, `projections.js`, `campScopedEntities.js`, `restore.js`, the render-layer deletes
  in §5) — a schema-only rollback restores tables a build that no longer references them will simply
  never write to. If the owner ever needs a genuine revert, that is a `git revert` of the whole PR,
  not a database rollback plus a stale build.

---

## 3. Op-log / sync

- Remove `template_overlays` from the synced-entity column map (`electron/sync/syncClient.js:67`).
- Remove the `template_overlays` entry from `campScopedEntities.js` (`:52-56` and its list membership
  at `:154`) and from `projections.js`'s `BULK_REPLACE_ENTITIES` (`:709-726`) and the "entity not
  registered above" comment at `:833` that currently name-checks it as the example.
- Remove the `template_overlays: 'refused'` line from `restore.js:40`.
- **Old op-log replay concern: moot, and here is why, explicitly, so a future reader doesn't have to
  re-derive it.** In principle a device could hold historical `operations` rows that wrote
  `template_overlays` fields, and replaying them post-migration against a schema with no such table
  would throw. In practice: (a) this is pre-production, there are no real camps and no persisted
  devices carrying historical op-log state that outlives a developer's own `shoresh-dev` database;
  (b) the authoring path was already dead per §1, so even in dev, no `template_overlays` write ops
  exist to replay. If this were a post-launch retirement, the correct answer would be to have
  `applyOperation`/whatever replay path exists no-op silently on an unrecognized-but-historical
  entity name rather than throw — but building that guard now, for a scenario with provably zero
  instances, would be exactly the unrequested-flexibility anti-pattern flagged in §2b. Do not add it.

---

## 4. Week ops

- `electron/ops/duplicateWeek.js:138-148` — delete the block that selects and copies
  `template_overlays` rows into the new template. Update the comment at `:20` that currently says
  "copy all template_slots/template_overlays" to say `template_slots` only.
- `electron/ops/deleteWeek.js:114-119` (Step 2 of its numbered cleanup) and the comment at `:18` —
  delete the `template_overlays` FK-cleanup step entirely. Renumber the remaining steps in the
  comment so the numbering stays accurate (do not leave a "Step 2" gap with "Step 1, Step 3, Step 4"
  — a stale numbered comment is the kind of small thing that misleads the next reader).

---

## 5. Render + hooks — delete list

Full deletion, not deprecation, of:

- `src/components/schedule/FieldTripDrawer.jsx` — already confirmed unreferenced anywhere in `src/`
  (its toolbar button was already removed in PR #222). Delete the file outright.
- `src/screens/schedule/useOverlayFillStamp.js` — delete the whole file: `stampMode`/`setStampMode`
  (dead — set nowhere outside its own test), `handleStampClick` (unreachable, gated on the always-null
  `stampMode`), `startFill`/`handleFillEnter`/`updateOverlayRange`/`removeOverlay` (fill-drag authoring
  for a data shape that no longer exists).
- `src/components/schedule/OverlayCell.jsx` — delete; nothing renders an overlay row once the table is
  gone.
- `gridGeometry.js` — delete `overlayForCell` (`:69`) and `isOverlayHead` (`:87`) and any caller of
  them.
- The `decision.kind === 'overlay'` render branch and the `onCellClick={stampMode ? ... : ...}`
  ternaries in `ScheduleGroupView.jsx:200,247` and `ScheduleDayView.jsx:165,212` — collapse each to
  just the non-stamp branch (the branch that already runs today, since `stampMode` is always false).
- `addOverlay` in `useSlotMutations.js:828` — delete; its only caller (`handleStampClick`) is already
  gone per the bullet above.
- `overlays` / `overlaysByRoute` state in `ScheduleScreen.jsx:154,506` and the `{slots, overlays}`
  computation at `:745-746` — delete the `overlays` half; `on_screen` becomes `{ slots }` per §2b.
- `src/screens/schedule/useSnapshots.js` and `src/screens/snapshotMatchesSchedule.js` — remove the
  `overlays` side of every comparison; confirm (do not assume) that no comparison is left silently
  diffing `undefined` against `undefined` — that would read as "always matches" and mask a real
  future regression. Same treatment for `src/screens/snapshotRestore.js` wherever it restores
  `overlays` onto in-memory state from a snapshot row.
- `src/localClient.mock.js` — remove whatever mock/demo scaffolding exists for `template_overlays` so
  the dev-mock client's shape matches the real IPC surface post-retirement.
- `src/screens/ImportScreen.jsx` and `src/screens/SpecialSchedulesScreen.jsx` — the investigation
  flagged these as touching overlay-adjacent code; confirm at implementation time whether either has
  a live reference to `template_overlays`/`overlays` (grep) or whether the match was incidental
  (e.g. matching on the unrelated `registerOverlayOccupancy` name or generic "overlay" prose) before
  changing anything in them — do not delete code in these two files speculatively.

---

## 6. Test impact

Full-repo search for `template_overlays|OverlayCell|useOverlayFillStamp|stampMode|FieldTripDrawer|overlaysByRoute|\.overlays\b`
across `*.test.js`/`*.test.jsx` currently returns:

- `src/screens/schedule/useOverlayFillStamp.test.js` — **delete outright**, its subject is deleted.
- `src/components/schedule/OverlayCell.jsx` has no dedicated test found; confirm at implementation
  time and delete one if it exists.
- Update (not delete) to drop overlay-specific assertions/fixtures, since these files test broader
  subjects that survive: `electron/db/localDb.migrations.test.js`,
  `electron/ops/deleteRecord.test.js`, `electron/ops/duplicateWeek.test.js`,
  `electron/ops/bulkReplace.test.js`, `electron/ops/operations.test.js`,
  `electron/ops/projections.test.js`, `electron/ops/deleteWeek.test.js`, `electron/ops/ingest.test.js`,
  `electron/ops/undoReferences.schemaParity.test.js`, `electron/ops/projectionsCoverage.test.js`,
  `electron/sync/scheduleE2E.sync.test.js`, `electron/sync/syncServer.test.js`,
  `electron/main.test.js`, `electron/ipcSurfaceParity.test.js`,
  `electron/db/retireOrphanSlots.migration.test.js`, `scripts/mcp/tools.test.js`,
  `src/screens/schedule/useSlotMutations.test.js`, `src/components/schedule/SlotCell.test.jsx`,
  `src/screens/ScheduleScreen.test.jsx`, `src/screens/ScheduleScreenExclusions.test.jsx`,
  `src/components/schedule/ScheduleGridKeyboardNav.test.jsx`, `src/screens/snapshotRestore.test.js`,
  `src/screens/schedule/useRouteState.test.js`, `src/screens/schedule/useSnapshots.test.js`,
  `src/components/schedule/ScheduleGroupView.test.jsx`, `src/components/schedule/ScheduleDayView.test.jsx`,
  `src/data/scheduleRepository.test.js`.
- **New tests required**, not just deletions: a v53 migration test (fresh-vs-migrated shape, matching
  `dayOverrideTemplatesRemoval.migration.test.js`'s pattern) asserting `template_overlays` no longer
  exists, `schedule_snapshots` has no `overlays` column, and `CURRENT_SCHEMA_VERSION` is `53` — every
  sibling migration test that currently asserts `CURRENT_SCHEMA_VERSION.toBe(52)` (at minimum
  `anchorKindSplit`, `events`, `dayOverrideTemplatesRemoval`, `anchorRecurrence`, `anchorEventLocation`,
  `declinedTwoRowSplits`, `electiveSetsBinding`, `recurrenceTruthStatus`, `electiveCapacity`
  migration tests, per the grep in the investigation step above) must be bumped to `.toBe(53)` in the
  same PR, per the standing memory tripwire on this exact failure mode from the last schema bump.
- Confirm `schemaParity`-style checks (`electron/ops/undoReferences.schemaParity.test.js`,
  `electron/ops/projectionsCoverage.test.js`) still pass with `template_overlays` removed from every
  registry — these are the checks that catch a table removed from one plumbing file but not another.

---

## 7. Ordering / reviewer gates

Recommended sequence for Maker:

1. Schema + migration + rollback (§2) first, in isolation, with the new v53 migration test green and
   every `.toBe(52)` sibling tripwire bumped to `53`. This is the highest-risk slice — get it right
   and gated before touching anything else.
2. Op-log/sync/week-ops plumbing (§3, §4) — mechanical registry removals, but each one has its own
   test file in §6; update alongside.
3. Render/hooks deletion (§5) last — it is the largest diff by line count but the lowest risk (dead
   or soon-to-be-dead UI code), and doing it last means steps 1–2 aren't blocked on UI test churn.

**Explicitly flag for Red Hat**, per this repo's standing rule that stored-data-shape + sync +
migration + snapshot-format changes get adversarial review: the §2b snapshot-format change (does
`on_screen`/`snapshotMatchesSchedule` genuinely stop comparing `overlays`, or does a stale comparison
against `undefined` silently start "always matching"?), and the migration guard shape itself (correct
`>= 52 && < 53` bound, transactional, FK pragma toggled correctly around the `schedule_snapshots`
rebuild).

**Full `npm run verify` gate is mandatory** before this is considered done — lint + test +
test:integration + check:governance, per `docs/governance/GOVERNANCE_INDEX.md`'s Database/sync row
(integration is mandatory for this task class) — plus the fresh-vs-migrated schema equivalence check
that row also names.

---

## 8. Consequences

- **Positive:** removes an entire dead-and-half-dead authoring surface (drawer, stamp mode, fill-drag)
  and the plumbing that carried it across five op/sync modules, shrinking the "override family"
  surface this codebase has repeatedly had to reason about (`docs/adr/2026-08-23-override-family-model.md`)
  from four tables to three genuinely-live ones.
- **Real risk surface:** the `schedule_snapshots.overlays` format change (§2b) is the one part of this
  retirement that touches something with actual historical rows (existing snapshots), not just dead
  code. The mitigation is the explicit hard-cutover decision stated above (discard, don't shim) plus
  the Red Hat review called out in §7. Get this one change wrong — e.g. leaving a comparison that
  silently treats a missing `overlays` field as "always equal" — and snapshot-matches-live-schedule
  detection degrades silently rather than failing loudly, which is exactly the failure mode this
  repo's `describeWriteFailure`/surface-every-failure convention exists to prevent elsewhere; the
  same bar applies here even though this isn't a write path.
- **No back-compat shim, by design:** per standing pre-production bias, there is no fallback path for
  a hypothetical old snapshot with populated `overlays` JSON surviving the migration with its data
  intact. This is the correct tradeoff today; it would need revisiting (a real migration path, not a
  drop) if this retirement were ever done post-launch with live camp data — noted here so a future
  reader doesn't mistake "we didn't build a shim" for an oversight.

---

## Open questions for Governor

None — the scope, migration shape, and code-deletion list above are fully specified from the
investigation plus this ADR's own verification pass. The one judgment call left for implementation
time (not requiring a product decision) is confirming whether `ImportScreen.jsx` and
`SpecialSchedulesScreen.jsx` (§5, last bullet) have a genuine live reference or an incidental grep
match — that's a five-minute code read, not something needing owner input.
