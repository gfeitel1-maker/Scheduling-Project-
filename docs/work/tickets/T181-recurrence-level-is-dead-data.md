---
title: "recurrence_level is dead data"
document_type: ticket
status: open
created: 2026-09-16
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
archive_when: the owner decides remove-vs-keep and, if removal, the v65 migration ships and PLATFORM_STATE.md line 196 is corrected
---

# T181 — `recurrence_level` is dead data

## Finding

The column `recurrence_level` exists on both `anchor_activities` and
`elective_sets`, is registered in the field-enumeration registries
(`src/localClient.mock.js`, `electron/ops/projections.js`), and is declared
in `electron/db/schema.sql` and `electron/db/localDb.js` (v42/v43
migrations). No code reads it to branch on behavior, and no code writes it
other than its schema default (`'daily'`) and raw test fixtures that set it
directly via SQL. It sits at its default forever.

What actually drives recurrence today: `kind` (`'fixed'`/`'recurring'`),
`day_id` NULL meaning every day, and `schedule_week_id` NULL meaning every
week. `recurrence_level` predates that shape (added v42/v43, before `kind`
landed in v51) and was never wired to anything once `kind` took over as the
real discriminator.

## Method

1. Build the authoritative column list by running `initSchema` from
   `electron/db/localDb.js` against a **fresh in-memory better-sqlite3 db**
   and `PRAGMA table_info` each table — not by hand-parsing `schema.sql`,
   and not against the dev database (which lags behind head).
2. For each of the two columns, grep the whole tree for any reference
   outside the registry/migration/test/rollback files, and manually
   classify every hit as read (branches on the value), write (sets it to
   something other than the schema default), or inert enumeration.

## Decision to make

1. **Remove** `recurrence_level` from both tables and every registry
   (bias-bold — pre-production, no live data, owner prefers hard cutovers).
   Requires schema migration v65 + both rollback scripts.
2. **Keep** it, documented in `schema.sql` as reserved, with a comment
   naming what actually drives recurrence (`kind`, `day_id`,
   `schedule_week_id`).

Ticket recommendation: (1), medium-high confidence.

---

## 2026-09-16 — Architect verification + decision

### Reproduction (ran, not assumed)

```
node -e "
const Database = require('better-sqlite3');
const { initSchema } = require('./electron/db/localDb.js');
const db = new Database(':memory:');
initSchema(db);
...
"
```

Raw output:

```
--- anchor_activities ---
0 id TEXT default= null
1 camp_id TEXT default= null
2 cohort_id TEXT default= null
3 day_id TEXT default= null
4 time_block_id TEXT default= null
5 name TEXT default= null
6 unit_id TEXT default= null
7 span_blocks INTEGER default= null
8 is_all_groups INTEGER default= null
9 group_ids TEXT default= null
10 notes TEXT default= null
11 schedule_week_id TEXT default= null
12 recurrence_level TEXT default= 'daily'
13 location_id TEXT default= null
14 kind TEXT default= 'fixed'
--- elective_sets ---
0 id TEXT default= null
1 camp_id TEXT default= null
2 name TEXT default= null
3 sort_order INTEGER default= null
4 is_reusable INTEGER default= 1
5 day_id TEXT default= null
6 time_block_id TEXT default= null
7 is_all_groups INTEGER default= null
8 group_ids TEXT default= null
9 schedule_week_id TEXT default= null
10 recurrence_level TEXT default= 'daily'
```

```
node -e "... db.prepare('SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 1').get() ..."
{ version: 64, applied_at: '2026-09-16T13:59:47.913Z' }
table count: 51   // 50 data tables + schema_migrations itself
```

Confirms the claimed schema state exactly: v64, 51 `sqlite_master` tables
(50 + the migrations ledger), `recurrence_level` present on both tables
with a live `NOT NULL DEFAULT 'daily'` constraint.

### Cross-repo reference sweep

`grep -rn "recurrence_level\|recurrenceLevel" src electron test docs/adr`
(full output reviewed line by line, not sampled). Every hit falls into one
of these buckets, and there are no others:

- **DDL / migrations**: `electron/db/schema.sql` (2 CREATE TABLE blocks),
  `electron/db/localDb.js` (v42/v43 `ALTER TABLE ... ADD COLUMN`, plus the
  byte-identical `ELECTIVE_SETS_DDL`/v64-era constants).
- **Rollback scripts**: `electron/db/rollback/v42_down.js`,
  `v43_down.js`, `v51_down.js` — all three only move the column's *storage*
  around (drop it, recreate-and-copy it) during an unrelated column's
  rollback (v51's rollback recreates `anchor_activities` to drop `kind`,
  and carries `recurrence_level` along because SQLite's recreate-and-copy
  pattern has to enumerate every column, not because `recurrence_level`
  is load-bearing there).
- **Registries that enumerate fields generically**: `src/localClient.mock.js`
  (two field-list arrays), `electron/ops/projections.js` (two field-list
  arrays, `PROJECTIONS`-registration style). Neither branches on the
  *value* — they just include the column name in a list of columns to
  copy/diff, identically to every other column on the row.
- **Migration/projection tests**: `anchorRecurrence.migration.test.js`,
  `electiveSetsBinding.migration.test.js`, `electivesDurability.migration.test.js`,
  `electives.migration.test.js`, `anchorKindSplit.migration.test.js`,
  `anchorEventLocation.migration.test.js`, `electivesRegistries.test.js`,
  `electives.projections.test.js`, `generalize.test.js` — all assert
  column *presence*, migration *shape*, or (in `anchorRecurrence.
  migration.test.js`'s own words) that the column "reads the DEFAULT for
  every existing anchor" and has "no backfill logic." One test
  (`mergeActivity.test.js`) inserts a literal `'week'` value directly via
  raw SQL to build a fixture row for an unrelated merge test — it does not
  exercise any application code path that writes the column.

**Not found anywhere**: `electron/auth/permissions.js`,
`electron/automerge/campDocument.js`, `src/screens/recordLabels.js` — the
finding's phrase "registered as ... permissioned/labelled" is *loose* but
not wrong in effect. Those three files operate at the **entity** level
(`anchor_activities`/`elective_sets` as a whole row), not per-field, so
`recurrence_level` rides along automatically as part of the row's flat
sync/permission/label treatment — it doesn't need its own registration,
and doesn't have one. This confirms rather than refutes the finding: there
is no field-specific special-casing of `recurrence_level` anywhere in the
runtime path, sync path, or permission path.

I also confirmed what supersedes it is real: `kind` carries a `CHECK
(kind IN ('fixed','recurring'))` plus a cross-column CHECK on
`anchor_activities` in `schema.sql` (lines 703-708) that has nothing to do
with `recurrence_level`; `day_id`/`schedule_week_id` NULL-means-unbound is
documented and load-bearing per the v42/v43 migration comments themselves.

### Verdict on (a)/(b)/(c)

- **(a) nothing reads it to branch on behavior** — CONFIRMED. Zero
  production code path (`src/`, `electron/` outside migrations/rollback)
  reads `recurrence_level` in a conditional, a filter, a query WHERE
  clause, or a UI rendering decision.
- **(b) nothing writes it other than the schema default** — CONFIRMED for
  all application code. The one place a non-default value is written is a
  raw SQL literal inside a test fixture (`mergeActivity.test.js`), not
  application code, and it exists only to populate an otherwise-required
  NOT NULL column for an unrelated test.
- **(c) same is true on `elective_sets` as `anchor_activities`** —
  CONFIRMED, identical pattern on both tables (same DDL shape, same
  registry treatment, same test-only literal-write pattern is absent
  entirely for `elective_sets` — no test ever sets it to a non-default
  value on that table).

**The finding is confirmed as stated.** This is not a refutation case.

### Decision: REMOVE (option 1)

Recommendation: **remove**, at **high confidence** (upgraded from the
ticket's medium-high — the sweep found no reference this ticket's premise
didn't already anticipate, and no CHECK-constraint entanglement the way
`kind`'s rollback had to deal with).

Rationale:
- Pre-production, zero real camp data at risk (repo-wide standing owner
  preference: bias bold, hard cutovers over back-compat — see
  `feedback_preproduction_bias_bold` memory).
- A column that exists, syncs, and is permissioned/labelled by virtue of
  riding the whole row, but carries zero information (always its schema
  default), is worse than absent: it invites a future reader (human or
  agent) to believe it means something and either build on it or debug
  around it. `KEEP-as-reserved` would require a durable comment in three
  places (`schema.sql` ×2, this doc) to keep that risk contained, forever,
  for a column with no current or announced future consumer.
- No CHECK constraint references it on either table (confirmed above), so
  the removal is a plain `DROP COLUMN`-shaped migration with **no** need
  for the recreate-and-copy dance v51's rollback needed for `kind`.
- `day_id`/`schedule_week_id`/`kind` already fully cover the semantic
  space `recurrence_level` was meant for (the v42/v43 migration comments
  say so explicitly — this was a deliberate "we're not backfilling this,
  it's superseded" note baked in at creation time, not a mystery).

Option (2) (keep-and-document) was considered and rejected: it is the
lower-effort choice today but it is not the smaller *responsible* one —
it's an unpaid debt for the next reader, not a genuine reservation for a
concrete future use. Nothing in the roadmap (`docs/current/PLATFORM_STATE.md`,
the open ticket list) names a plan to give `recurrence_level` new meaning.

### Migration plan (v65) — for Maker to execute, NOT executed here

This is a schema migration. Per `docs/governance/constitution/CONSTITUTION.md`
schema changes are a human-approval gate — **flagging for owner approval,
not executing.**

**1. `electron/db/localDb.js`**
- Bump `CURRENT_SCHEMA_VERSION` from `64` to `65`.
- Add a new migration block, guarded `getSchemaVersion(db) >= 64 &&
  getSchemaVersion(db) < 65` (the `>= N-1 && < N` form this codebase's
  migration guards use — not a bare `< N`).
- Since neither column is referenced by a CHECK constraint, this can use a
  plain `ALTER TABLE ... DROP COLUMN` (SQLite ≥ 3.35, already the version
  in use here per the v51 rollback comment's empirical note about needing
  recreate-and-copy specifically because of a CHECK reference — no CHECK
  here, so the simple path applies):
  ```sql
  ALTER TABLE anchor_activities DROP COLUMN recurrence_level;
  ALTER TABLE elective_sets DROP COLUMN recurrence_level;
  ```
- Insert the `schema_migrations` row for version 65 the same way v64's
  block does (`INSERT OR IGNORE ... VALUES (65, ?)`).
- Write the comment block the way v64's was written: name the ticket
  (T181), state what superseded the column (`kind`/`day_id`/
  `schedule_week_id`), and note explicitly that this is a **pure DDL
  removal with no data loss of consequence** — the column has never held a
  non-default value in any code path, which the T181 sweep above
  establishes as evidence, not assumption.

**2. `electron/db/schema.sql`**
- Remove the `recurrence_level TEXT NOT NULL DEFAULT 'daily',` line from
  both the `anchor_activities` and `elective_sets` CREATE TABLE blocks
  (lines ~701 and ~980 as of this writing).
- Remove the column comments that reference it (the v42/v43 preamble
  comments above each block currently explain `recurrence_level`'s
  original intent — update or delete those paragraphs so schema.sql
  doesn't describe a column that no longer exists).
- Confirm column *order* stays consistent between a fresh install
  (schema.sql) and a migrated db (localDb.js ALTER path) — same discipline
  every other migration in this file already follows. Since this is a
  drop (not an append), order preservation is automatic as long as both
  files remove the same column.

**3. Registries — remove `recurrence_level` from every field-enumeration
   list:**
   - `src/localClient.mock.js` (two arrays, lines ~388 and ~408 as of this
     writing).
   - `electron/ops/projections.js` (two arrays, lines ~291 and ~414 as of
     this writing).
   - Grep for `recurrence_level` after the edit — the only remaining hits
     should be inside `electron/db/rollback/v42_down.js`,
     `v43_down.js`, and `v51_down.js` (they reference the column as part
     of an unrelated rollback's recreate-and-copy and must stay as-is —
     rewriting history migrations is out of scope and would break anyone
     rolling back past v51), plus this ticket file and any ADR that gets
     written.

**4. New rollback script — `electron/db/rollback/v65_down.js`:**
   - Follow the v42_down.js/v43_down.js pattern (simple case: `ALTER TABLE
     ... ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'` on
     both tables — no recreate-and-copy needed since the forward migration
     didn't need one either, no CHECK constraint entanglement).
   - Report `0 rows with a recurrence level discarded` unconditionally
     (there's a structural guarantee here, not a query result: no code
     path in this repo can have written a non-default value pre-rollback,
     since removal itself proves no writer exists — document that
     reasoning inline rather than querying `COUNT(*) WHERE recurrence_level
     != 'daily'` against a column that won't exist yet at rollback time).
   - Delete the `schema_migrations` row for version 65.

**5. Existing tests to update (will break red without this, and should
   before the migration lands):**
   - `electron/db/anchorRecurrence.migration.test.js` and
     `electron/db/electiveSetsBinding.migration.test.js` are entirely
     *about* this column's arrival (v42/v43) — they test historical
     migration behavior on a db stopped at v42/v43, not head, so they
     should be **unaffected** by a v65 migration (verify this assumption
     by running them after the change — they migrate a fresh db only up
     to the version under test, not to `CURRENT_SCHEMA_VERSION`).
   - Any test that asserts the *full* column list of `anchor_activities`
     or `elective_sets` at head (`electivesRegistries.test.js`,
     `electives.projections.test.js`, `anchorKindSplit.migration.test.js`,
     `anchorEventLocation.migration.test.js`, `generalize.test.js`) needs
     `recurrence_level` removed from its expected list.
   - `mergeActivity.test.js`'s `mkSet()` helper inserts
     `recurrence_level` directly via raw SQL — drop that column from the
     INSERT (it was never meaningful to the test, just needed to satisfy
     the NOT NULL constraint that will no longer exist).
   - Add a **new** migration test for v65 mirroring the shape of
     `anchorKindSplit.migration.test.js`: start a db at v64, run to v65,
     assert the column is gone from `PRAGMA table_info` on both tables,
     assert `schema_migrations` has the v65 row, assert a fresh install
     (schema.sql) produces the same `PRAGMA table_info` shape as a
     migrated one.

**6. `docs/current/PLATFORM_STATE.md` line 196** — currently states
   anchors "carry `recurrence_level` (daily/weekly)". This is stale
   regardless of which option is chosen (even under KEEP, "carry" implies
   active use, which is false). Fix applies either way — see below.

### Doc fix (applies regardless of which option the owner picks)

`docs/current/PLATFORM_STATE.md:196` is misleading today. I did not change
line 196 in this session — it references a still-live migration decision
(remove vs keep) that the owner has not yet approved, and PLATFORM_STATE
should describe the *landed* state, not a pending one. Once the owner
approves (1) and the migration ships, update line 196 to describe the
actual drivers of recurrence (`kind`, `day_id` NULL = every day,
`schedule_week_id` NULL = every week) and drop the `recurrence_level`
mention entirely. If the owner instead picks (2) KEEP-as-reserved, line
196 should say `recurrence_level` is present but currently unused/reserved
rather than implying it drives behavior today.

### ADR required: no

This finding and its remediation don't introduce a new persistent shape or
change a contract other modules call — it *removes* an already-inert one.
The `writing-plans`-shaped migration plan above is the correct level of
durable record; a full brainstorm+design doc / ADR would be
disproportionate to a dead-column removal. (If the owner picks KEEP
instead, that's also not ADR-worthy — it's a comment, not a decision with
irreversible consequence.)

### Open questions for Governor / owner

1. **Approve or reject removal (option 1).** This is the actual
   human-approval gate — I have not touched schema.sql, localDb.js, or any
   registry in this session; only this ticket file was written.
2. If approved, should the v65 migration ship in the same PR as the
   `docs/current/PLATFORM_STATE.md:196` fix, or should the doc fix land
   immediately (describing today's actual behavior correctly, independent
   of the schema question) while the migration is scheduled separately?
   My recommendation: land the doc fix now, independent of the schema
   decision — it's correct under either option and doesn't need to wait.
3. Confirm no external tooling (the `mcp__shoresh__*` MCP surface, CLI
   export paths under machine-access) exposes `recurrence_level` to a
   consumer outside this repo. A quick grep of `electron/mcp/` (if that's
   where the MCP server lives) for `recurrence_level` turned up nothing in
   this sweep, but a Maker executing the migration should re-check that
   surface specifically since it wasn't in the original registry list this
   ticket named.
