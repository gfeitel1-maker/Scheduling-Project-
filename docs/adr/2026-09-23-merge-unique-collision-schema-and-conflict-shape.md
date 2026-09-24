---
title: "ADR: Merge-path UNIQUE collisions — relaxed-set schema shape and hard-set conflict shape"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
date: 2026-09-23
decided: 2026-09-23
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_specs:
  - docs/superpowers/specs/2026-09-23-merge-unique-collision-design.md
related_tickets: []
related_adrs:
  - docs/adr/2026-09-08-crdt-conflict-reconciliation.md
  - docs/adr/2026-08-15-locations-concurrent-create-collision.md
  - docs/adr/2026-09-08-flat-record-shape.md
supersedes: []
affects: []
program: shoresh-future-architecture
---

# ADR: Merge-path UNIQUE collisions — relaxed-set schema shape and hard-set conflict shape

**Status: the PRODUCT decision is closed** (owner-approved spec,
`docs/superpowers/specs/2026-09-23-merge-unique-collision-design.md`, committed at `ef9acb5`). This
ADR is the **technical design** for that decision: exact schema version, exact index/table changes,
and the shape of the two derivations (relaxed-set duplicate flag, hard-set typed conflict). It also
corrects three factual claims in the spec that this audit found to be wrong, and names two things the
spec's greps missed.

## What the spec got right and what it left to this ADR

The product shape is not re-litigated here: nine free-text-name tables get a relaxed (non-unique)
index and a derived per-row duplicate flag; four structural constraints stay hard and their
collisions become a typed, loud conflict; resolution everywhere is rename-or-delete with existing
controls, never a reference-aware merge, never new chrome. See the spec for the full rationale.

Left open by the spec, closed here:

1. Whether the hard-set derivation extends `reconcile()`'s shape or is a new module.
2. Whether `ConflictsScreen` needs a new conflict kind.
3. The exact schema version.
4. The exact index/table changes and the rollback refusal behaviour.

## Correction 1 — the schema version is v73, not v71

`electron/db/localDb.js` currently defines `CURRENT_SCHEMA_VERSION = 72`. Both v71 and v72 are
already claimed and merged:

- v71 = T181, dropping the dead `recurrence_level` column (`1d68fcc`, PR #506).
- v72 = T233, the `tombstones` table for signed purge-tombstone erasure (`3b4aa0a`, PR #515 — visible
  at the top of this branch's own git log).

The spec was written against a stale view of `main`. This work is **v73**. The migration guard is
`getSchemaVersion(db) >= 72 && getSchemaVersion(db) < 73`, matching the `>= N-1 && < N` form used by
every block from v60 onward — never a bare `< 73`, which would silently re-run this migration against
a v50 database that skipped every intermediate step.

Maker must re-check `CURRENT_SCHEMA_VERSION` immediately before implementing, not trust this number:
other in-flight branches routinely claim the next version, and the spec's own v71 guess is direct
proof that a number written down at design time can be stale by the time code lands.

## Correction 2 — the affected surface is larger than the spec's grep found

**`special_days` is a tenth relaxed-set candidate the spec's grep missed entirely.**
`electron/db/schema.sql` declares `special_days` with `UNIQUE(camp_id, name)`
(`CREATE TABLE IF NOT EXISTS special_days`, schema.sql ~line 962), it is listed in
`campDocument.js`'s modeled-entity set (line 288) alongside the other document-projected,
op-log-synced, camp-scoped entities, and its own schema comment states it explicitly: *"same trust
model as groups/activities"* — the exact profile of the nine tables the spec does relax. It appears
in neither the spec's relaxed list nor its hard list. Two offline devices each creating a special day
named "Color War" today hit the same silent-drop defect as a duplicate location, and after this ADR's
fix ships to the other nine tables without special_days, they still would.

**Decision: `special_days` joins the relaxed set, making it ten tables, not nine.** Nothing about it
resembles the hard set's structural-invariant argument (it has no code path that resolves it by a
single-row lookup keyed on name — verified, see below — and no security or engine-correctness
consequence turns on uniqueness the way `users.name` does for login). Governor should confirm this
addition with the owner before Maker builds it, since it changes the spec's stated table count; it is
not a judgement call this ADR is positioned to make unilaterally, but leaving it out is worse — it
would ship the defect fix over nine tables while knowingly leaving a tenth, identically-shaped one
broken. See "Open questions for Governor."

**The name→id map surface is five sites, not the three the spec cited**, all in
`electron/ops/ingest.js`'s `seedNameMaps` (~line 897–916):

| Site | Line | Keys against | At risk? |
|---|---|---|---|
| `tierIdByName` | 902 | `tiers` (relaxed) | **Yes — spec missed this one** |
| `blockIdByName` | 906 | `time_blocks` (relaxed) | Yes (spec named this one) |
| `dayIdByName` | 909 | `days_of_operation` (**hard**) | No — stays unique, no duplicate rows possible once merged (still transiently ambiguous during an unresolved hard conflict; see "Residual risk") |
| `groupIdByName` | 912 | `groups` (relaxed) | Yes (spec named this one) |
| `locationIdByName` | 915 | `locations` (relaxed) | **Yes — spec missed this one** |

Plus the generic `nameMap()` helper the spec did cite, `electron/ops/materializeImportedVersion.js:26`,
used against whichever table its caller passes.

All five follow the same `Map.set(key, row.id)` pattern with no `ORDER BY` on the seeding query, so
last-row-wins is governed by SQLite's return order for an unordered `SELECT`, which is not guaranteed
and is not guaranteed identical across two devices whose rows for the same camp arrived via merge in
different physical insert order. **Decision: all five sites (four in `ingest.js`, one in
`materializeImportedVersion.js`) get the same explicit deterministic tie-break — sort candidates by
`id` ascending before the `.set()` loop, so the lowest id always wins the map slot, byte-identically
regardless of insertion order.** This is a small, mechanical, uniform fix across five call sites, not
five different designs.

Verified, not assumed: no site in the relaxed set (now ten tables) resolves a record by name via a
single-row `db.prepare(...).get()` — every by-name lookup found goes through one of the `Map`-based
helpers above or through `anchorActivityLink.js`'s `indexActivitiesByName`, which is already
duplicate-safe (it accumulates an array of ids per name key, not a single winner — no change needed
there).

## Correction 3 — the index change is a table rebuild for eight of the nine tables, not a plain index swap

The spec's migration section describes v71 (now v73) as "drop the nine unique indexes, create plain
indexes in their place," implying a uniform `DROP INDEX` / `CREATE INDEX` pair. That is **only true
for `schedule_weeks`**. For the other eight relaxed tables, the constraint exists in **two different
places that must both change, or a fresh install and a migrated database diverge** — which is exactly
the equivalence the Database/sync task class requires checking (`docs/governance/GOVERNANCE_INDEX.md`
§3–8: "fresh-vs-migrated schema equivalence" is a mandatory deterministic check for this task class).

Verified directly against `electron/db/schema.sql` and `electron/db/localDb.js`:

| Table | Inline `UNIQUE` in schema.sql's `CREATE TABLE` (fresh install) | Named index in localDb.js (migrated db) |
|---|---|---|
| `locations` | line 877, `UNIQUE(camp_id, name)` | `idx_locations_camp_name` (localDb.js:1940) |
| `activities` | line 538, `UNIQUE(camp_id, name)` | `idx_activities_camp_name` (localDb.js:641) |
| `events` | line 1148, `UNIQUE(camp_id, name)` | none found — enforced only by the inline constraint |
| `elective_sets` | line 1057, `UNIQUE(camp_id, name)` | none found — enforced only by the inline constraint |
| `groups` | line 473, `UNIQUE(camp_id, name)` | `idx_groups_camp_name` (localDb.js:458) |
| `cohorts` | line 655, `UNIQUE(camp_id, name)` | `idx_cohorts_camp_name` (localDb.js:404) |
| `tiers` | line 488, `UNIQUE(camp_id, cohort_id, name)` | `idx_tiers_camp_cohort_name` (localDb.js:557) |
| `time_blocks` | line 704, `UNIQUE(camp_id, cohort_id, name)` | `idx_time_blocks_camp_cohort_name` (localDb.js:494) |
| `schedule_weeks` | **none** (schema.sql's own comment: *"created by migration v27, not here"*) | `idx_schedule_weeks_camp_name` (localDb.js:1364) |
| `special_days` (added to scope, see above) | line 969, `UNIQUE(camp_id, name)` | none found — enforced only by the inline constraint |

A table-level `UNIQUE(...)` clause inside `CREATE TABLE` compiles to an internal SQLite
autoindex (`sqlite_autoindex_<table>_N`) that **cannot be dropped with `DROP INDEX`** — it can only be
removed by rebuilding the table. `schema.sql` runs unconditionally at every startup via
`CREATE TABLE IF NOT EXISTS`, so on a genuinely fresh install after this ships, if `schema.sql`'s text
still declares the inline `UNIQUE`, the table is created with the constraint baked in **before** the
v73 migration block ever runs — and `DROP INDEX IF EXISTS idx_locations_camp_name` inside that block
is a silent no-op, because that named index never existed on this fresh install; the autoindex was
the actual enforcement, and it survives untouched. This is precisely the "fresh install and a migrated
db must end up identical" failure mode this ADR was asked to verify against, and today it is **not**
identical — it requires deliberate handling, not an assumption that they already match.

**Decision — two different operations, applied per table:**

- **`schedule_weeks`** (only a named index, no inline constraint): the simple case the spec assumed.
  `DROP INDEX idx_schedule_weeks_camp_name; CREATE INDEX idx_schedule_weeks_camp_name ON schedule_weeks(camp_id, name)`.
- **The other nine** (`locations`, `activities`, `events`, `elective_sets`, `groups`, `cohorts`,
  `tiers`, `time_blocks`, `special_days`): a **table rebuild**, the same recipe this codebase already
  used for CHECK-constraint growth on `anchor_activities` at v51/v65 (per the v71/T181 migration
  comment's own cross-reference): `PRAGMA foreign_keys=OFF` inside the migration transaction; create
  `<table>_v73new` with the identical column list minus the `UNIQUE(...)` clause; `INSERT INTO
  <table>_v73new SELECT * FROM <table>`; `DROP TABLE <table>`; `ALTER TABLE <table>_v73new RENAME TO
  <table>`; recreate every OTHER index and trigger that table had (foreign keys are recreated
  automatically since they're part of the new table's DDL, but any named non-unique index on the same
  table must be explicitly recreated post-rename); `PRAGMA foreign_keys=ON`; then, for the four of
  these nine that also carry a separately-named unique index from an earlier migration (`locations`,
  `activities`, `groups`, `cohorts`, `tiers`, `time_blocks` — six, not four; `events`/`elective_sets`/
  `special_days` never got a named index because they always relied on the inline constraint alone),
  `DROP INDEX IF EXISTS idx_<table>_...; CREATE INDEX idx_<table>_... ON <table>(...)` for the plain
  replacement index.
  **`schema.sql`'s `CREATE TABLE` text for these nine tables must also be edited** to drop the inline
  `UNIQUE(...)` clause, so a fresh install after this ships never gets the autoindex in the first
  place — this is the change that makes "fresh install" and "migrated" converge, not an optional
  cleanup.

**Verification obligation for Maker**: a test that creates one database via `schema.sql` alone
(fresh-install path) and one via every migration from v0 through v73 in sequence (migrated path),
then asserts the two produce identical `PRAGMA table_info(<table>)` and `PRAGMA index_list(<table>)`
output for all ten affected tables. This is the deterministic "fresh-vs-migrated schema equivalence"
check the Database/sync task class already mandates — it is not new process, it is the existing gate
applied to this specific migration.

**Forward migration cannot fail on existing data** — a table rebuild that drops a constraint always
succeeds, same as a plain index drop would have. The complexity above is entirely about *where* the
constraint lives, not about data safety.

## Decision 1 — hard-set derivation is a new module, not an extension of `reconcile()`

`reconcile()`'s contract is fixed to a specific shape by three things that all assume one field of one
entity: its traversal (`for entity → for key in doc[entity]`, where `splitRecordKey` always yields
exactly one `entityId` + one `field`), its output (`{entity, entityId, field, values}` — a single
scalar disagreement), and its consumer `conflictStore.recordConflicts`, which writes one row keyed
`crdt:${entity}:${entityId}:${field}` into a `conflicts` table shaped for exactly that: one
`entity_id` column, one `field` column, `incoming_op`/`existing_op` each holding a single value.

A hard-set collision is a different *kind* of fact: it is **two records, of the same entity, in the
same scope, sharing one value** — there is no single `entityId` to key on, and "the field" is not a
disagreement about what one field should be, it is the value that makes two whole records collide.
Forcing this into `reconcile()`'s return shape means inventing a fake single `entityId` (which one?)
and cramming a second record's identity into a column designed to hold one value — corrupting the
exact shape `ConflictsScreen`, `FIELD_LABELS`, and `clearResolvedConflicts` all depend on structurally
today. The traversal is different too: `reconcile()` walks keys one at a time; detecting a structural
collision requires grouping every record of an entity by its scoped unique value first, which is a
different pass over the document, not a variant of the existing one.

**Decision: a new pure module, `electron/automerge/uniqueConflicts.js`, exporting
`deriveUniqueConflicts(doc)`.** Same discipline as `reconcile.js` — pure with respect to SQLite and
the clock, deterministic ordering (sort by entity, then by the scoped unique value, then by the sorted
tuple of colliding ids) so two devices derive byte-identical output from the same document. Signature
mirrors `reconcile()`'s spirit without inheriting its shape:

```js
// [{ entity, scopeId, field, entityIds: [id, ...] /* sorted */, values: [{ entityId, record }] }]
export function deriveUniqueConflicts(doc) { ... }
```

`values` carries the two (or more) full records, not one field — the director needs to see what each
device actually typed for the whole record, per the spec's success predicate #4 ("carrying both
records' values").

**The structural guarantee is preserved by hanging a second guard off the exact same choke point,
not by weakening the first one.** `projector.js`'s `assertConflictsRecorded(db, doc)` — the function
already called from both `projectEntity` and `projectAll`, i.e. the one place a merged document
becomes SQLite — gets a second call alongside its existing
`assertNoUnrecordedConflicts(doc, recorded)`:

```js
function assertConflictsRecorded(db, doc) {
  const recorded = /* existing scalar query */
  assertNoUnrecordedConflicts(doc, recorded)          // unchanged

  const recordedUnique = /* SELECT ... WHERE id LIKE 'unique:%' AND resolved_at IS NULL */
  assertNoUnrecordedUniqueConflicts(doc, recordedUnique)   // new
}
```

`assertNoUnrecordedUniqueConflicts` (new, in `uniqueConflicts.js`, mirroring
`assertNoUnrecordedConflicts`'s own logic exactly) throws with the same "a director's edit would be
silently discarded" framing if `deriveUniqueConflicts(doc)` finds a collision not present in
`recordedUnique`. Two independent assertions, two independent derivations, one shared choke point —
"no path around it" survives because both guards live at the same single call site, not because they
share a data shape. This is the smallest change that does not corrupt the scalar conflict's shape and
does not weaken the "system cannot be in a state where a conflict went unhandled" property; the
alternative (widening `reconcile()`'s return shape to carry both kinds) would touch
`assertNoUnrecordedConflicts`, `conflictStore.js`, `ConflictsScreen`, and every test written against
the scalar shape, for a saving of one extra function call.

**`conflicts` table gets one new nullable column: `entity_ids TEXT`** (JSON array of the colliding
ids, sorted), populated only for `unique:`-prefixed rows; `entity_id` continues to hold the single
scalar-conflict id for `crdt:`-prefixed rows and is left `NULL` for `unique:` rows (or holds the
lowest colliding id, purely for a director's convenience if `ConflictsScreen` ever needs a single
id to link out to a screen — not required for correctness). `incoming_op`/`existing_op` are
generalized from "one value" to "one whole record" (`JSON.stringify(record)` instead of
`JSON.stringify({value, op_id})`) for `unique:` rows only; this is additive and does not change what
existing `crdt:` rows store. A new `kind` column (`'scalar' | 'unique'`, default `'scalar'` via the
migration's backfill so every existing row is unambiguous) discriminates the two without
`ConflictsScreen` having to sniff the id prefix.

## Decision 2 — `ConflictsScreen` needs a new conflict kind, scoped narrowly

`ChoiceBox` (`src/screens/ConflictsScreen.jsx`) is built entirely around "one value per side, a Keep
this version button that writes that value as the resolution." A structural collision is not that
shape: there are two *records*, and per the spec's own non-goals, resolution is never "the app picks
one and repoints references" — it is "the director renames or deletes one of the two records using
the screen that already owns that entity." There is nothing for a "Keep this version" button to write.

**Decision: yes, a new kind, minimally scoped.** `ConflictCard` branches on the new `kind` field:

- `kind: 'scalar'` (today's only kind, renamed for the discriminant but behaviourally identical):
  unchanged — `ChoiceBox` × 2, "Keep this version," writes a document field via
  `resolveConflictInDoc`.
- `kind: 'unique'` (new): a single informational card, no `ChoiceBox`, no buttons. It names the
  colliding value and both records in plain language (reusing the `FIELD_LABELS`-style plain-language
  mapping, extended with per-entity names — "Two staff members are both named X" / "Two Tuesday
  schedules exist") and tells the director where to resolve it ("Rename or delete one on the
  &lt;entity&gt; screen"). It **self-clears** exactly like a scalar conflict does — `syncNode.js`'s
  merge cycle re-derives `deriveUniqueConflicts` every merge, and a resolved collision (renamed or
  deleted on either device) simply stops appearing, clearing the row via the same
  `clearResolvedConflicts`-style sweep already used for `crdt:` rows, scoped to `unique:` rows the
  same way that function is already scoped to `id LIKE 'crdt:%'`.

This is a new **rendering branch inside the existing screen**, not a new screen, no new sidebar
surface beyond the badge count it already contributes to, and no new resolution IPC call — satisfying
the spec's "no new chrome" constraint while giving the director the loud, typed signal the spec's
success predicate #4 requires instead of a bare `console.error`.

## Files/modules affected

- `electron/db/schema.sql` — remove inline `UNIQUE(...)` from nine `CREATE TABLE` statements
  (`locations`, `activities`, `events`, `elective_sets`, `groups`, `cohorts`, `tiers`, `time_blocks`,
  `special_days`); add plain (non-unique) `CREATE INDEX` statements for the same nine plus
  `schedule_weeks`, matching whatever `localDb.js`'s v73 block leaves behind.
- `electron/db/localDb.js` — new v73 migration block: table rebuild for the nine inline-constraint
  tables, index swap for all ten relaxed tables (including `schedule_weeks`), version guard
  `>= 72 && < 73`; `CURRENT_SCHEMA_VERSION` bumped to 73 (re-verify at implementation time).
- `electron/automerge/uniqueConflicts.js` — **new file**: `deriveUniqueConflicts(doc)`,
  `assertNoUnrecordedUniqueConflicts(doc, recorded)`.
- `electron/automerge/projector.js` — `assertConflictsRecorded` gains the second assertion call.
- `electron/automerge/conflictStore.js` — `recordConflicts`/`clearResolvedConflicts` generalized (or
  parallel `recordUniqueConflicts`/`clearResolvedUniqueConflicts` functions — Maker's call, both
  satisfy this design) to write/clear `unique:`-prefixed, multi-entity rows.
  `electron/db/schema.sql`'s `conflicts` table gains `entity_ids TEXT NULL` and
  `kind TEXT NOT NULL DEFAULT 'scalar'` columns (part of the same v73 migration).
- `electron/sync/automerge/syncNode.js` — `reconcileForProjection` (or a sibling) also calls
  `deriveUniqueConflicts` and records/clears it, same place the scalar path already does.
- `electron/ops/ingest.js` — `seedNameMaps`'s five queries get `ORDER BY id ASC` (or an explicit sort
  before the `.set()` loop) so lowest-id-wins is deterministic.
- `electron/ops/materializeImportedVersion.js` — `nameMap()` gets the same tie-break.
- `src/screens/ConflictsScreen.jsx` — `ConflictCard` branches on `conflict.kind`; new plain-language
  descriptions for the `unique:` kind, no new IPC.
- IPC surface for duplicate-flag derivation on the ten relaxed tables (per screen: Locations,
  Activities, Events, Elective Sets, Groups, Cohorts, Tiers, Time Blocks, Schedule Weeks, Special
  Days) — a `GROUP BY camp_id, <field> HAVING COUNT(*) > 1` read, name-normalized via the existing
  `normalizeName`, exposed however each screen already fetches its list (this is per-screen wiring,
  not a new architectural seam — left to Maker/Designer per screen).

## Reused vs. new

**Reused:** `reconcile()` and its scalar shape, untouched; `conflictStore.js`'s idempotence pattern
(insert-once-per-live-disagreement, clear-when-gone); `ConflictsScreen`'s list, badge, and
plain-language philosophy; `projectAll`'s single-choke-point guard pattern; the table-rebuild recipe
already proven at v51/v65; `UNIQUE_FIELD_ENTITIES`/`detectUniqueFieldCollision` on the local-write and
restore paths, unchanged, per the spec's "Unchanged, deliberately" section — confirmed still correct:
it remains an advisory pre-check on a director's own device, now genuinely advisory rather than
racing a hard constraint.

**New:** `uniqueConflicts.js` (a second derivation, not a widened first one — see Decision 1);
`conflicts` table's `entity_ids`/`kind` columns; `ConflictsScreen`'s `unique` card variant; per-screen
duplicate-flag reads (mechanically similar across ten screens, not a shared abstraction unless Maker
finds three or more screens converging on identical logic worth factoring — not designed here,
per the karpathy default of not building the abstraction before three real instances justify it).

**Not reused, and deliberately left alone:** `UNIQUE_FIELD_ENTITIES` currently registers only five
entities (`locations`, `elective_sets`, `events`, `activities`, `days_of_operation`) — `groups`,
`cohorts`, `tiers`, `time_blocks`, `schedule_weeks`, and `special_days` are **not** in that registry
today, meaning a same-device write race on those six already throws a raw `SQLITE_CONSTRAINT_UNIQUE`
rather than a typed conflict, independent of anything in this ADR. This is a pre-existing gap, not
introduced or worsened by relaxing the index (if anything, relaxing removes the raw-constraint crash
risk for those six on the *merge* path, while leaving the *local-write* path's raw-constraint gap
exactly as it was). Flagged for Governor to decide whether it is in scope for this work or a separate
ticket — see "Open questions."

## ADR required: yes

This is the ADR — filed at
`docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md`. It introduces a new
document-derivation module and a new conflict shape (a changed contract other modules — the
projection guard, the `conflicts` table, `ConflictsScreen` — now depend on), and it makes an
irreversible-by-default schema change (dropping nine/ten UNIQUE constraints, whose `v73_down` cannot
silently restore them once real duplicates exist — see below). Both independently clear the ADR bar
in `CONSTITUTION.md`.

## Migration and rollback

**Forward (v73):** as detailed in Correction 3 — table rebuild for nine tables (drop inline `UNIQUE`),
plain index swap for all ten, plus the additive `conflicts.entity_ids`/`conflicts.kind` columns.
Cannot fail on existing data: dropping a constraint and adding nullable columns are both always
satisfiable regardless of current row contents.

**Rollback (v73_down):** must **refuse and name the offending rows** rather than silently deleting or
merging duplicates to fit the constraint back in — exactly the spec's stated asymmetry, carried
through to the corrected ten-table, table-rebuild shape. Concretely: before rebuilding any of the ten
tables back to an inline/named `UNIQUE`, run the same `GROUP BY camp_id, <field> HAVING COUNT(*) > 1`
query the duplicate-flag derivation uses, against every one of the ten tables; if any table has live
duplicates, throw a single error naming every offending table, its colliding value, and the row ids —
not just the first table encountered, since a director attempting a rollback needs the complete list
to decide whether to proceed at all, not to fix one table and re-run into the next. Only when all ten
report zero duplicates does `v73_down` actually rebuild the tables back to their v72 shape and drop
the `conflicts.entity_ids`/`kind` columns (SQLite requires a table rebuild to drop columns too, same
recipe, reverse direction).

## Residual risk, stated rather than discovered

- **The hard set's transient duplicate window.** Between the moment two devices concurrently create
  colliding `days_of_operation`/`schedule_templates`/`camp_maps`/`users` rows and the moment a
  director resolves the `unique:` conflict, the document genuinely holds two records sharing a
  structural key. `dayIdByName` (ingest.js:909) and any other by-name lookup against a hard-set table
  during that window inherits the same last-row-wins ambiguity the relaxed set has permanently — it
  is bounded in time (until resolved) rather than permanent, and the spec's success predicate already
  requires the collision to be loud, which bounds how long a director leaves it unresolved. Not fixed
  by this design; named so Maker does not treat the hard set's by-name lookups as automatically safe
  during an open conflict.
- **`UNIQUE_FIELD_ENTITIES`'s six-table gap** (above) is pre-existing and out of this ADR's scope, but
  a Maker or Red Hat pass on this work will likely notice it and should not conflate fixing it with
  this ADR's success predicate.
- **Table rebuild correctness is the highest-risk mechanical step.** Nine rebuilds in one migration,
  each needing every foreign key, trigger, and secondary index the original table had reproduced
  exactly, is meaningfully more moving parts than the spec's assumed nine-index swap. The
  fresh-vs-migrated equivalence test (Correction 3) is the load-bearing check here, and it should be
  written and passing before any of the nine rebuild bodies are considered done, not after.

## Open questions for Governor

1. **Does `special_days` join the relaxed set as a tenth table?** This is a product-shape question
   (does the owner's "duplicates allowed and flagged, resolved by rename/delete" rule extend to
   special days the same way it does to locations/activities/etc.), not a technical one — the
   technical case for treating it identically to the other nine is strong (same trust model, same
   document-projection shape, same missing single-row-lookup risk profile), but it changes the
   spec's stated scope and should get the same owner sign-off the original nine got.
2. **Is the `UNIQUE_FIELD_ENTITIES` six-table gap (groups/cohorts/tiers/time_blocks/schedule_weeks/
   special_days never registered for the local-write advisory pre-check) in scope for this ticket, or
   a separate follow-up?** It is not required to satisfy this ADR's success predicate — the merge
   path is what was broken — but leaving it means those six tables' local-write races still crash
   ungracefully today and will continue to after this ships.
3. **The per-screen duplicate-flag IPC/read wiring for ten screens is left to Maker/Designer as
   mechanical, per-screen work** rather than designed as a shared abstraction here — confirm that is
   the right altitude for this ADR, or whether Governor wants a shared `listDuplicates(entity,
   field)` IPC method specified now to avoid ten slightly-divergent implementations. This ADR's
   default (per karpathy-guidelines: don't build the shared abstraction before real instances justify
   it) is to let Maker build the first two or three screens' worth and factor if and when duplication
   actually shows up, but this is a coordination call, not purely technical.
