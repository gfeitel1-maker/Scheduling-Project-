---
title: "T194 technical design — the participant data substrate (schema v66)"
document_type: spec
status: draft
created: 2026-09-17
task_class: database-sync
archive_when: T194 ships and the seven entities are recorded in PLATFORM_STATE, or the ADR is rejected
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_tickets: [docs/work/tickets/T194-participant-data-substrate.md]
---

# T194 — technical design for the participant data substrate

Designs **only** slice 2 of `docs/adr/2026-09-17-individual-elective-scheduling.md`. No import
service (T195), no solver (T196), no export (T197), no MCP/CLI (T198), no UI beyond what the
substrate requires. Every decision here sits **inside** the accepted ADR; where the ADR, the spec
and the ticket disagree with each other, §9 reports the disagreement rather than resolving it.

Verified against branch `claude/shoresh-elective-scheduling-b3bec8` at `4ac2ef5`, 2026-09-17.
Every registry claim below was made by opening the file, not by inferring from its name.

---

## 0. Candidate approaches considered

`adhd` was run (five isolated frames: regulator, hostile competitor, 3am on-call, inversion,
biology; 30 candidates, clustered and scored). The two genuinely open shapes were the derived-id
scheme and the capacity representation. The clusters that survived:

**Derived ids**

| # | Candidate | Score `[N V F]` | Verdict |
|---|---|---|---|
| A | Plain delimiter concatenation, exactly as `deriveScheduleTemplateId` | `[2 9 7]` | Rejected — not injective; see §2.3 |
| B | SHA-256 (or truncated) hash of the joined key | `[4 7 7]` | Rejected — see §2.3 |
| C | **Length-prefixed concatenation of opaque ids, version-tagged prefix** | `[7 9 9]` | ★ **Chosen** |
| D | Human-readable key + short hash suffix (`…:rock-climbing#4f2a`) | `[7 6 6]` | Rejected — requires human strings in the key, which §2.2 removes |
| E | Store a `derived_from` column and recompute at read time to detect drift | `[8 7 8]` | **Partly adopted** — as a test and a projection-health check (§8.2), not as a column |

Traps flagged and rejected: salting the id with the camp's document id (adds a genesis coupling to
a function the migration must call before any document exists, and buys nothing — the app is
single-camp-per-device-db); an "epigenetic" capacity overlay separating imported from
human-edited capacity (premature abstraction, no second writer exists yet); an apoptosis/sweeper
phase for superseded rows (ADR D5 already specifies *inert, not deleted*, and the sweep is T196's
concern at the earliest); mismatch-repair strand discrimination (Automerge's per-field LWW plus the
existing `conflicts` row already is this, and re-implementing it would be a second conflict system).

**Capacity**

| # | Candidate | Score `[N V F]` | Verdict |
|---|---|---|---|
| F | Sentinel integer (`-1` = unlimited) | `[1 6 3]` | Rejected — this is the ambiguity D3 exists to remove, relocated |
| G | **Two columns: `capacity_mode` enum + `capacity_limit` integer, with DB CHECKs** | `[5 9 10]` | ★ **Chosen** — converged on independently by four of five frames |
| H | G, plus a third `'unreviewed'` mode that blocks generation on legacy rows | `[7 6 4]` | Rejected — **the survey (§3.3) found zero legacy rows anywhere**; this would block on data that provably does not exist |
| I | Strict cross-column CHECK pairing mode and limit | `[6 3 8]` | **Rejected on evidence** — incompatible with per-field op-log writes; see §3.2. This is the design's least obvious finding |

Candidate H is the clearest case of the survey earning a simpler design: without running the query
it would have been the responsible choice.

---

## 1. Exact DDL

Seven new tables, appended to `electron/db/schema.sql` after the `events` family. All are new
tables, so column order is free to choose — but it is **fixed here and normative**, because the
migration creates them with `CREATE TABLE` (identical statement, §7.1) and the parity test compares
order (§7.3).

Reference conventions taken from the existing tree, not invented:

- `REFERENCES` is declared only where the repo declares it. `activity_id`, `time_block_id`,
  `group_id` and `location_id` are **soft references by convention with no SQL `REFERENCES`
  clause** throughout this schema (`schema.sql:1018` `elective_set_activities.activity_id`, and its
  comment at `:1012-1015`; `template_slots` likewise). Following that keeps `foreign_keys = ON`
  from rejecting a legitimate out-of-order op-log replay.
- Every table's own parent link **does** get a real `REFERENCES`, matching
  `elective_set_activities.elective_set_id` (`schema.sql:1018`).
- Booleans are `INTEGER NOT NULL DEFAULT`, matching `elective_sets.is_reusable`.

```sql
-- campers (schema v66, ADR 2026-09-17-individual-elective-scheduling D8).
-- The WHOLE participant footprint: display name, group membership, optional
-- external id. No contact details, no medical data, no date of birth, no
-- household or parent records — D8 states that as a design constraint, and a
-- future column here is an ADR-level change, not a field addition.
-- Admin-only: deliberately absent from permissions.js ENTITIES (D9).
CREATE TABLE IF NOT EXISTS campers (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  display_name TEXT NOT NULL,
  group_id TEXT,
  external_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- elective_assignment_runs (v66). One director-initiated assignment attempt.
-- `status` is the run lifecycle; `solver_generation` is ADR D5's marker (this
-- slice stores it; T196 enforces it). source_sha256 is the hash of the imported
-- preference file, NOT of any camper value.
CREATE TABLE IF NOT EXISTS elective_assignment_runs (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  schedule_week_id TEXT REFERENCES schedule_weeks(id),
  schedule_template_id TEXT,
  tier_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'final')),
  source_filename TEXT,
  source_sha256 TEXT,
  solver_version TEXT,
  solver_generation TEXT
);

-- elective_occurrences (v66). A concrete (set, day, block, tier) cell the run
-- assigns into, re-derived from live template_slots on every generation (D6).
-- Derived id (§2).
CREATE TABLE IF NOT EXISTS elective_occurrences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES elective_assignment_runs(id),
  elective_set_id TEXT,
  day_id TEXT,
  time_block_id TEXT,
  tier_id TEXT
);

-- elective_choices (v66, ADR D12). The thing a camper ranks. A single-period
-- choice is the degenerate one-member case, so there is ONE code path.
-- Derived id (§2) — see §9.2 for the open question on its key.
CREATE TABLE IF NOT EXISTS elective_choices (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES elective_assignment_runs(id),
  label TEXT NOT NULL,
  is_linked INTEGER NOT NULL DEFAULT 0
);

-- elective_choice_offerings (v66, ADR D12). A choice's member occurrences.
-- Assignment expands a chosen choice atomically across every row here.
CREATE TABLE IF NOT EXISTS elective_choice_offerings (
  id TEXT PRIMARY KEY,
  choice_id TEXT NOT NULL REFERENCES elective_choices(id),
  occurrence_id TEXT,
  activity_id TEXT
);

-- elective_preferences (v66). A camper's ranked choice. PII-adjacent: a row
-- here plus a campers row is "this child wants this activity".
CREATE TABLE IF NOT EXISTS elective_preferences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES elective_assignment_runs(id),
  camper_id TEXT,
  choice_id TEXT,
  rank INTEGER
);

-- elective_assignments (v66). The output. Its derived id IS the uniqueness
-- invariant (ADR D4) — see §2, the single most important thing in this slice.
-- solver_generation stored here; D5 inertness is enforced in T196.
CREATE TABLE IF NOT EXISTS elective_assignments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES elective_assignment_runs(id),
  occurrence_id TEXT,
  camper_id TEXT,
  activity_id TEXT,
  choice_id TEXT,
  preference_rank INTEGER,
  source TEXT NOT NULL DEFAULT 'solver'
    CHECK (source IN ('solver', 'manual')),
  is_locked INTEGER NOT NULL DEFAULT 0,
  solver_generation TEXT
);
```

### 1.1 No `UNIQUE` index on any composite

Deliberate, and the point of the whole slice. A `UNIQUE(run_id, camper_id, occurrence_id)` index
would be the *wrong* mechanism: op-log replay and Automerge merge apply rows in arbitrary order, so
a UNIQUE violation surfaces as a **projection apply failure on the receiving device** — a crash on
the device that did nothing wrong — rather than as a conflict. ADR D4's derived id makes the
duplicate unrepresentable *before* it reaches SQLite, which is why no index is needed. This is
stated here so a future reviewer does not "fix" the missing index.

### 1.2 FK-safe ordering rationale

`openLocalDb` sets `foreign_keys = ON`, which makes `DOMAIN_SNAPSHOT_ORDER`'s order load-bearing
(`electron/ops/campScopedEntities.js`, the comment above `DOMAIN_SNAPSHOT_ORDER`). A table must
appear after every table whose id it references **by a declared `REFERENCES`** — soft references
impose no ordering.

Declared references among the seven: `campers.camp_id`→`camps`;
`elective_assignment_runs.{camp_id, schedule_week_id}`→`camps`,`schedule_weeks`;
`elective_occurrences.run_id`, `elective_choices.run_id`, `elective_preferences.run_id`,
`elective_assignments.run_id`→`elective_assignment_runs`;
`elective_choice_offerings.choice_id`→`elective_choices`.

Appended to `DOMAIN_SNAPSHOT_ORDER` **in this order**, at the end of the existing array:

```
'campers',                    // camps only (declared); group_id is soft. Safe anywhere after camps.
'elective_assignment_runs',   // MUST follow 'schedule_weeks' (declared FK). It does.
'elective_occurrences',       // MUST follow elective_assignment_runs
'elective_choices',           // MUST follow elective_assignment_runs
'elective_choice_offerings',  // MUST follow elective_choices
'elective_preferences',       // MUST follow elective_assignment_runs
'elective_assignments',       // MUST follow elective_assignment_runs
```

`elective_preferences.camper_id` / `.choice_id` and `elective_assignments.*` are soft, so they
impose no further constraint — but the order above is also topologically correct if any of them is
later hardened, which is why it is written this way rather than minimally.

---

## 2. The derived-id module

### 2.1 Location and packaging constraint

**New module: `electron/ops/electiveDerivedIds.js`.** Pure, dependency-free, zero imports.

It lives under `electron/` for the reason `electron/ops/scheduleTemplateId.js` states in its own
header (lines 6-13), verified: electron-builder's `files` list ships `electron/**`, `dist/**` and
`package.json` — **`src/` is not packaged**. An electron-side import of a `src/` module works under
`npm run electron:dev` and fails in the installed app *at migration time, on a real database*. The
v66 migration will call this module, so the same constraint binds. The renderer may import it
safely in the other direction (Vite bundles it into `dist/`).

It is a **separate module from `scheduleTemplateId.js`**, not an addition to it: that file's header
carries a load-bearing back-compat contract about its one-argument form that the v21 migration
depends on, and adding five unrelated exports to it invites an edit that breaks that contract.

### 2.2 Every key component is an opaque surrogate id — by construction

The hostile-competitor and inversion frames both landed on the same attack: delimiter injection and
Unicode-normalization skew in human-typed key components. **That attack surface is closed at the
source rather than mitigated**: of the five derivations, every component is an opaque id minted by
`crypto.randomUUID()` (or itself derived), with exactly one exception —
`elective_choices`, whose spec §2 key includes the human string `label`. That exception is §9.2,
an open question, not a decision taken here.

A module-level invariant enforces it:

```
deriveElectiveId(kind, components)
  throws if any component is not a non-empty string
  throws if any component contains a character outside [A-Za-z0-9_-]   // uuid + slug alphabet
```

Throwing rather than escaping is deliberate (inversion frame): an escape function is a second
normalization rule that can drift between app versions; a throw cannot. The importer (T195) is
responsible for resolving human input to ids **before** an id is derived.

### 2.3 Chosen scheme: length-prefixed concatenation, version-tagged. Not a hash.

```js
const V = 1 // derivation version; bump = deliberate, visible re-keying

function join(components) {
  return components.map((c) => `${c.length}.${c}`).join('')
}

export function deriveElectiveOccurrenceId(runId, electiveSetId, dayId, timeBlockId, tierId)
  //  -> `eocc${V}:${join([runId, electiveSetId, dayId, timeBlockId, tierId])}`

export function deriveElectiveChoiceId(runId, labelKey)
  //  -> `echo${V}:${join([runId, labelKey])}`            // see §9.2

export function deriveElectiveChoiceOfferingId(choiceId, occurrenceId, activityId)
  //  -> `ecof${V}:${join([choiceId, occurrenceId, activityId])}`

export function deriveElectivePreferenceId(runId, camperId, choiceId)
  //  -> `epref${V}:${join([runId, camperId, choiceId])}`  // see §9.1

export function deriveElectiveAssignmentId(runId, camperId, occurrenceId)
  //  -> `easgn${V}:${join([runId, camperId, occurrenceId])}`
```

Argument order in each signature matches the ADR/spec's stated key order and is itself part of the
contract — a test pins the exact output string for a frozen input vector, in the style of
`electron/sync/campIdHash.test.js`.

**Why concatenation and not a hash — the tradeoff, stated.**

| Axis | Length-prefixed concat (chosen) | SHA-256 hash |
|---|---|---|
| Collision surface | **Zero.** Length-prefixing is provably injective: `join` is uniquely decodable, so distinct component tuples cannot produce the same string. Plain `:`-joining (the `deriveScheduleTemplateId` precedent) is *not* injective in general | Non-zero, however small. A duplicate-assignment bug caused by a hash collision is the least debuggable failure in this feature |
| Debuggability | `SELECT * FROM elective_assignments WHERE id LIKE 'easgn1:%'` and the run/camper/occurrence ids are legible in a SQLite shell with no joins — the 3am-on-call requirement | Opaque. Diagnosis requires recomputing candidate hashes |
| Length | ~130 chars for the 3-component keys, ~200 for the 5-component one. SQLite `TEXT PRIMARY KEY` has no practical limit; these are never rendered | 64 chars |
| Dependency | None. The module stays importable by the migration with zero imports | `node:crypto` in a module the migration loads |
| Version drift | Visible: `easgn1:` vs `easgn2:` (regulator + biology frames both asked for this independently) | Equally available, and equally necessary |
| Parsing risk | **Higher** — the id *looks* parseable | Lower |

The last row is the real cost, and it is paid deliberately. `scheduleTemplateId.js`'s header sets
the precedent explicitly: *"The `':manual'` suffix is an id, not a parsing contract. Nothing may
recover a route by inspecting the string."* The new module carries the same paragraph, naming the
columns that are the only authority. A hash would enforce that by making parsing impossible — but it
would buy that enforcement with a collision surface and a loss of shell-debuggability, on a key
whose components are already opaque ids that reveal nothing when read. Concatenation is the smaller
responsible answer; the parsing prohibition is a comment plus a code review, and that is the same
discipline this repo already runs for `schedule_templates`.

**Length-prefixing is the one improvement over the precedent.** `deriveScheduleTemplateId` is plain
`:`-joining, which is injective only because its components happen never to contain `:`. That is an
accident, not a property. `join` above makes it a property, at the cost of six characters per
component.

### 2.4 What the module does *not* do

No `derived_from` column (candidate E). Storing the input tuple alongside the id would duplicate
columns the row already has — `elective_assignments` carries `run_id`, `camper_id` and
`occurrence_id` as ordinary columns, so the id is recomputable from the row itself with no extra
storage. The drift check that E wanted is therefore free, and lands as a test plus a
projection-health assertion (§8.2) rather than a column.

---

## 3. Capacity

### 3.1 Chosen representation

Two columns added to the **existing** `elective_set_activities` table:

```sql
ALTER TABLE elective_set_activities
  ADD COLUMN capacity_mode TEXT NOT NULL DEFAULT 'unlimited'
    CHECK (capacity_mode IN ('unlimited', 'limited'));

ALTER TABLE elective_set_activities
  ADD COLUMN capacity_limit INTEGER
    CHECK (capacity_limit IS NULL
           OR (typeof(capacity_limit) = 'integer' AND capacity_limit >= 0));
```

Read discipline, normative for T196/T197: **`capacity_mode` is the authority.** When
`capacity_mode = 'unlimited'`, `capacity_limit` is ignored entirely — never coerced, never compared
against. When `capacity_mode = 'limited'`, `capacity_limit IS NULL` is `INVALID_CAPACITY` (a
finding, per spec §3), and `0` is a genuinely closed offering.

`camper_headcount` is **retained in place and retired from the write path** — removed from
`PROJECTIONS.elective_set_activities.fields`, so no write can reach it. It is not dropped: dropping
it requires a table rebuild, and a rebuild on this table is exactly the class that produced T189's
lost index. Its removal is a later slice's business, not this one's.

### 3.2 Why the strict pairing CHECK was rejected — verified, not assumed

The obvious CHECK, which four of five divergence frames proposed, is the cross-column pairing:

```sql
CHECK ((capacity_mode = 'unlimited' AND capacity_limit IS NULL)
    OR (capacity_mode = 'limited'   AND capacity_limit IS NOT NULL AND capacity_limit >= 0))
```

It works. It was executed against `better-sqlite3@12.11.1` (SQLite 3.53.2, resolved from
`package-lock.json`, not the semver range), added via `ALTER TABLE ... ADD COLUMN` with no table
rebuild, and every case behaved as designed: `unlimited`+`NULL` accepted, `unlimited`+`5` rejected,
`limited`+`0` accepted, `limited`+`NULL` rejected, `limited`+`-1` rejected, `limited`+`2.5`
rejected, and a legacy insert naming neither column accepted via the default.

**And it must not be used, because the projection writes one field per op.**
`applyProjection` (`electron/ops/projections.js:825-836` and the `UPDATE` that follows) applies a
single `entity/field/value` triple per operation. Changing an offering from unlimited to a cap of 12
is two ops in some order, and **both orders traverse a state the pairing CHECK forbids**:

- `capacity_mode := 'limited'` first → row is `('limited', NULL)` → rejected.
- `capacity_limit := 12` first → row is `('unlimited', 12)` → rejected.

The write fails on the *second* device during replay as readily as on the first, so this would
manifest as a sync-time projection failure, not a local validation error. Neither
`REQUIRED_FIRST_ON_WRITE` (`src/data/setupCrudRepository.js:51-53`) nor any field ordering rescues
it, because both orders are illegal. The constraint is simply incompatible with the op-log's write
granularity.

The relaxed CHECKs in §3.1 are exactly the predicates that are **invariant under any single-field
transition**: the mode enum, and the limit's own domain. The pairing becomes a read-time rule, which
is the tagged-union discipline the divergence branches wanted anyway ("every read site destructures
the mode first"), with a bonus: toggling to unlimited and back no longer needs to null the limit, so
the director's previous cap survives the round trip instead of being destroyed by a constraint.

This is the finding in this design most likely to be re-broken by a well-meaning reviewer. §8.1
names the test that pins it.

### 3.3 Survey report — what is actually in `camper_headcount` today

Run 2026-09-17 against every SQLite file on this machine, with `?immutable=1` so nothing was
mutated.

**Scope of the measurement**, stated because a zero is a claim about the measurement:

| Source | Files | Files with the table | `elective_set_activities` rows |
|---|---|---|---|
| Live dev db (`~/Library/Application Support/shoresh-dev/shoresh.sqlite`, schema v53) | 1 | 1 | **0** |
| Live packaged db (`~/Library/Application Support/shoresh/shoresh.sqlite`, schema v64) | 1 | 1 | **0** |
| `.pre-migration-*.bak` + `backups/*.db` across both directories | 41 scanned | 3 | **0** |

`elective_sets` is likewise 0 rows in both live databases. Distinct `camper_headcount` values across
every database found: **none — the column has never held a row.**

Corroborating the survey rather than relying on it alone: the only code path that creates an
offering, `src/ingest/electiveSetPopulate.js:60`, writes `camper_headcount: null`
unconditionally, and every fixture in the tree (`electron/automerge/docNativeEnsureExists.test.js:121`,
`src/ingest/electiveSetPopulate.test.js:60`, `src/screens/ScheduleElectivesScreen.test.jsx:68`)
uses `null`. The one non-null value anywhere is `12` in
`electron/db/electiveCapacity.migration.test.js:127`, a synthetic migration fixture.

**Nothing was rewritten.** No `UPDATE` was issued against any database.

### 3.4 Migration mapping for existing rows — stated, not inferred

Every existing row gets a defined meaning, and the mapping is **documented in the schema, not
guessed**. `schema.sql:1010` declares of `camper_headcount`: *"Nullable — NULL means no cap, never
'zero campers'."* That is the prior semantics in writing, so the mapping is a translation:

| Legacy `camper_headcount` | v66 `capacity_mode` | v66 `capacity_limit` | Basis |
|---|---|---|---|
| `NULL` | `'unlimited'` | `NULL` | `schema.sql:1010` — NULL *is* "no cap" |
| `>= 0` integer | `'limited'` | same value | The number was always the cap |
| negative or non-integer | `'limited'` | same value, preserved as-is | Preserved so `INVALID_CAPACITY` (spec §3) can fire on it at generation time. **Note:** the §3.1 `CHECK` would reject such a value on a *new* write, but `ALTER TABLE ADD COLUMN` does not re-validate existing rows, so a legacy bad value survives the migration and is reported rather than laundered. Zero such rows exist (§3.3) |

Backfill, run once inside the v66 migration:

```sql
UPDATE elective_set_activities
   SET capacity_mode  = CASE WHEN camper_headcount IS NULL THEN 'unlimited' ELSE 'limited' END,
       capacity_limit = camper_headcount;
```

Given §3.3 this is provably a no-op on every database that exists. It is written anyway, because
this design cannot see a database it has not been shown, and a migration that is correct only for
the databases the author happened to have is the failure this project has hit before.

The ADR's D3 instruction — *survey and report, do not rewrite* — is satisfied: `camper_headcount`
is not modified; the two new columns are populated from it.

**Not built here:** D3's "the UI must make the distinction unmissable". That is authoring UI, and
T194 is the substrate. It belongs to the elective-authoring surface and is named in §9.5.

---

## 4. Registration table

One row per registry, with a decision and a reason. Every file was opened.

| # | Registry | Decision | Reason |
|---|---|---|---|
| 1 | `electron/db/schema.sql` | **Register all 7** + 2 capacity columns on `elective_set_activities` | §1, §3.1 |
| 2 | v66 block in `electron/db/localDb.js` | **Register all 7** + the 2 `ALTER`s + backfill | §7.1. Guard is banded (`>= 65 && < 66`), matching v65 at `localDb.js:2519` |
| 3 | `electron/db/rollback/v66_down.js` | **New file** | §7.2 |
| 4 | `PROJECTIONS` (`electron/ops/projections.js`) | **Register all 7.** Also **remove** `camper_headcount` from `elective_set_activities.fields` and **add** `capacity_mode`, `capacity_limit` | An entity absent here has its writes silently discarded — `applyProjection` returns early on an unknown entity. `ensureExists` modelled on `events` (`:476-487`) for the camp-scoped pair, on `elective_set_activities` (`:438-472`) for the parent-scoped five. Two existing tests assert the old `fields` array verbatim (`electivesRegistries.test.js:56`, `electives.projections.test.js:51`) and **must** be updated in the same commit |
| 5 | `DIRECT_CAMP_ENTITIES` | **Register 2**: `campers`, `elective_assignment_runs` | Both carry a real `camp_id` column |
| 6 | `PARENT_SCOPED_ENTITIES` | **Register 5**: `elective_occurrences`/`elective_choices`/`elective_preferences`/`elective_assignments` → parent `elective_assignment_runs` by `run_id`; `elective_choice_offerings` → parent `elective_choices` by `choice_id` | None of the five has a `camp_id` column; they scope by JOIN, exactly like `elective_set_activities` |
| 7 | `DOMAIN_SNAPSHOT_ORDER` | **Register all 7**, in the order at §1.2 | `foreign_keys = ON` makes it load-bearing. `assertDirectEntityParity` throws at module load if 5 and 7 disagree |
| 8 | `MODELED_ENTITIES` (`campDocument.js:85`) | **Automatic — no edit** | Derived from `DIRECT_CAMP_ENTITIES ∪ PARENT_SCOPED_ENTITIES`. Registering 5 and 6 expands it, which trips the subset guard — that is the intended forcing function, §6 |
| 9 | `GENESIS_ENTITIES` + `GENESIS_B64` | **Register all 7 + regenerate the bytes** | §6. Editing `GENESIS_ENTITIES` alone is explicitly prohibited by that file's own comment |
| 10 | `ENTITIES` (`permissions.js:21`) | **Deliberately EXCLUDE all 7** | §5. `permissions.js:74` flatMaps into `.read` **and** `.write` with no opt-in |
| 11 | `PERMISSIONS.staff` | **No entries for any of the 7** | §5 — admin-only via `admin: ['*']` and default-deny |
| 12 | `PERMISSIONS_ADMIN_ONLY_EXCEPTIONS` (`permissionsEntityParity.test.js`) | **Register all 7** | The parity test fails otherwise. `camp_maps` is the precedent |
| 13 | `RESTORE_DECISIONS` (`restore.js`) | **Register all 7, all `'refused: …'`** | `restore.test.js` fails if a `PROJECTIONS` key is missing here. Value must not be the literal `'restorable'`. Reasons differ — §5.2 |
| 14 | `UNDO_REFERENCE_CHECKS` (`undoReferences.js`) | **Register or allowlist ~16 columns** | `undoReferences.schemaParity.test.js` enumerates every `*_id`/`*_ids` column via `PRAGMA table_info` and fails on any unregistered one. §4.1 — **the largest and most forgettable surface in the slice** |
| 15 | `U2_DELETABLE_ENTITIES` | **Deliberately EXCLUDE all 7** | That set is pinned equal to `INGESTIBLE_ENTITIES + anchor_activities` by the same parity test. None of the 7 is ingestible |
| 16 | `SLOT_OCCUPANT_CASCADES` (`slotOccupants.js:74`) | **No change** | T194 adds **no column to `template_slots`**. The registry is keyed by `template_slots` columns; with none added, `slotOccupantCascadeParity.test.js` is unaffected. Verified rather than assumed |
| 17 | `MUTUALLY_EXCLUSIVE_FIELDS` (`projections.js:792`) | **No change** | Same reason as 16 |
| 18 | `deleteRecord.js` | **Register `campers.group_id`** in the group-delete reference report | `groups` is in `DESTRUCTIVE`. Deleting a group today does not know campers exist; after v66, it would orphan them silently. Soft reference, so `'dangle'` semantics — but the delete report must *name* the count |
| 19 | `deleteElectiveSet.js` | **No change** | Its cascade is `elective_sets` → `elective_set_activities`. `elective_occurrences.elective_set_id` is soft and run-scoped; a dangling occurrence in a *draft* run is re-derived on the next generation (ADR D6), and in a *final* run is covered by the finalization snapshot (D6). Deliberate no-op, stated so it is not read as an oversight |
| 20 | `deleteWeek.js` | **Needs a new step — and a product ruling** | `elective_assignment_runs.schedule_week_id` is a **declared** `REFERENCES schedule_weeks(id)`. Under `foreign_keys = ON`, deleting a week with runs attached **hard-fails with a FOREIGN KEY error** unless a step handles it. §9.3 — this is an owner ruling, not mine |
| 21 | `UNIQUE_FIELD_ENTITIES` (`operations.js:568`) | **Deliberately EXCLUDE all 7** | It expresses single-column uniqueness only — the exact limitation ADR D4 exists to route around. `elective_assignment_runs.name` is a director label, not required unique |
| 22 | `src/localClient.mock.js` `MOCK_WRITE_ALLOWLIST` | **Register all 7** + the capacity field change | `write()` **throws** on an unregistered entity or field. `electron/ipcSurfaceParity.test.js` fails on drift. This is a parity mirror, not a UI list — absence of a screen is not a reason to skip it |
| 23 | `src/localClient.mock.js` `UNIQUE_KEYS` | **Deliberately EXCLUDE all 7** | None has a `UNIQUE(camp_id, name)` |
| 24 | `src/data/setupCrudRepository.js` `UNIQUE_FIRST_FIELD` | **Deliberately EXCLUDE all 7** | It mirrors `UNIQUE_FIELD_ENTITIES` (row 21), which excludes them. Adding here would fail `uniqueFirstFieldRegistryParity.test.js` |
| 25 | `src/data/scheduleRepository.js` | **Deliberately EXCLUDE all 7** | Module is scoped to "every read/write ScheduleScreen makes". No participant entity is read by the group grid. Adding them costs a round trip on every grid load for nothing |
| 26 | `src/components/layout/navSections.js` (`NAV_SECTIONS`, `AREA_TABLE`) | **Deliberately EXCLUDE all 7** | T194 ships no screen. An `AREA_TABLE` row with no nav item to attach a badge to is dead weight. When a screen lands (T197/T199) the precedent to follow is `ADMIN_ONLY_MENU_ITEMS` (`:155-157`), the role-gated list — **not** `NAV_SECTIONS`, which is staff-visible |
| 27 | `src/components/reconciliation/domainRollup.js` (`DOMAIN_OF`, `CHILD_OF`) | **Deliberately EXCLUDE all 7** | Drives the director-facing Roots census. An admin-only entity with no setup UI can never be "set up", so it would render a permanently `not_set_up` child with nowhere to click |
| 28 | `src/ingest/existingSnapshot.js` `CENSUS_ENTITIES` (`:69-72`) | **Deliberately EXCLUDE all 7** | Must stay keyed exactly to `CHILD_OF`/`DOMAIN_OF` (its own comment, `:60-68`). Excluding from 27 and including here would desynchronize the roster from the census |
| 29 | `src/ingest/reconciliationReport.js` | **No change** | It has **no entity registry** — entity names ride in on plan items, with hard-coded blocks only for inference side channels. The seven produce no reconciliation decisions in this slice |
| 30 | `INGESTIBLE_ENTITIES` (`src/ingest/extractEntities.js:35`) | **Deliberately EXCLUDE all 7** | Preference import is T195 and is a *different* importer; the ADR re-affirms `elective_sets`' exclusion from this list and the same reasoning applies |
| 31 | `scripts/mcp/tools.js` `ENTITY_MAP` (`:31-40`) | **Deliberately EXCLUDE all 7 — this is the decision** | Spec §Success predicate lists "generic `list_entities` returning camper rows" as *does not count as done*. No test guards this map, so the exclusion needs its own **negative** test (§8.4). T198 revisits |
| 32 | `SECURITY.md` | **Amend** | ADR D8's at-rest-encryption precondition and a pointer to D10/T202's purge limits. Required by the ticket |
| 33 | `docs/current/PLATFORM_STATE.md` | **Amend** | `check:governance` treats `src/screens` and schema changes as STRUCTURAL; a v66 with seven tables and no PLATFORM_STATE note fails the platform-state-stale gate |
| 34 | `docs/work/INDEX.md` | **Regenerate** (`npm run index:work`) | index-stale gate |

### 4.1 Row 14 expanded — the `undoReferences` surface

`undoReferences.schemaParity.test.js` walks `PRAGMA table_info` over the migrated database and
fails for **every** `*_id`/`*_ids` column not present either in `UNDO_REFERENCE_CHECKS` or in that
test's `ACCEPTED_NON_REFERENCES` allowlist. The seven tables introduce these:

`campers.camp_id`, `campers.group_id`, `campers.external_id`;
`elective_assignment_runs.camp_id`, `.schedule_week_id`, `.schedule_template_id`, `.tier_id`;
`elective_occurrences.run_id`, `.elective_set_id`, `.day_id`, `.time_block_id`, `.tier_id`;
`elective_choices.run_id`;
`elective_choice_offerings.choice_id`, `.occurrence_id`, `.activity_id`;
`elective_preferences.run_id`, `.camper_id`, `.choice_id`;
`elective_assignments.run_id`, `.occurrence_id`, `.camper_id`, `.activity_id`, `.choice_id`.

Twenty-four columns. Registration rule, applied mechanically:

- Pointing at a **U2-deletable** entity (`groups`, `days_of_operation`, `time_blocks`, `tiers`,
  `activities`, `locations`, `cohorts`) → a real `UNDO_REFERENCE_CHECKS` entry with
  `kind: 'scalar'`, `enforced: false` (soft reference). That is `campers.group_id`,
  `elective_assignment_runs.tier_id`, `elective_occurrences.{day_id, time_block_id, tier_id}`,
  `elective_choice_offerings.activity_id`, `elective_assignments.activity_id` — **eight entries**.
- Pointing at a **non-U2-deletable** entity (`camps`, `schedule_weeks`, `schedule_templates`,
  `elective_sets`, and the six new tables themselves) → `ACCEPTED_NON_REFERENCES`, following the
  `template_slots.elective_set_id` precedent recorded at `undoReferences.schemaParity.test.js:88-92`
  — **fifteen entries**.
- `campers.external_id` → `ACCEPTED_NON_REFERENCES`. It is an *opaque string from the camp's own
  roster system*, not a reference to any Shoresh entity, and it matches the `*_id` glob only by
  spelling. Calling this out explicitly because it is the one entry a reader will assume is a
  reference.

Getting this wrong does not produce a subtle bug — the parity test fails loudly. It is listed at
this length because it is the single largest mechanical surface in T194 and the ticket does not
enumerate it.

---

## 5. Permissions

### 5.1 Matrix

| Entity | admin | staff | history | trash |
|---|---|---|---|---|
| `campers` | full (`admin: ['*']`) | **none** | admin-only | admin-only |
| `elective_assignment_runs` | full | **none** | admin-only | admin-only |
| `elective_occurrences` | full | **none** | admin-only | admin-only |
| `elective_choices` | full | **none** | admin-only | admin-only |
| `elective_choice_offerings` | full | **none** | admin-only | admin-only |
| `elective_preferences` | full | **none** | admin-only | admin-only |
| `elective_assignments` | full | **none** | admin-only | admin-only |

Mechanism, per ADR D9: all seven stay **out of `ENTITIES`**, because `permissions.js:74` derives
`staffReadWrite` by flatMapping every entry into both `.read` and `.write` with no per-entity
opt-in. Staff therefore hold no action naming any of the seven, and `authorize()`'s default-deny
produces admin-only. All seven are added to `PERMISSIONS_ADMIN_ONLY_EXCEPTIONS` in
`permissionsEntityParity.test.js`, following `camp_maps` (`permissions.js:112-121`).

History and Trash are **staff-readable for every other entity** via the single blanket
`'trash.read'` grant (`permissions.js:104-111`). That grant is not per-entity, so it cannot be
narrowed by omission — which means **an additional guard is required, and it is not free**. See
§9.4: this is the one place where the ADR states a requirement the existing permission shape cannot
express, and I am reporting it rather than inventing a mechanism.

### 5.2 `RESTORE_DECISIONS` — all seven refused, for two different reasons

```
campers:                   'refused: PII (ADR D8/D9) — a restore re-materializes a child's
                            record from the op-log outside the D10 purge path'
elective_preferences:      'refused: PII — same as campers'
elective_assignments:      'refused: PII — same as campers'
elective_assignment_runs:  'refused: a run is regenerated, never restored (ADR D5/D6) —
                            restoring one resurrects a superseded generation'
elective_occurrences:      'refused: re-derived from live template_slots on every
                            generation (ADR D6), never restored'
elective_choices:          'refused: rebuilt with its run, not on its own'
elective_choice_offerings: 'refused: rebuilt with its choice, not on its own'
```

The string is documentation; the mechanism is that the value is not the literal `'restorable'`
(`restore.js:72`), which keeps each key out of `RESTORABLE_ENTITIES` so `restoreEntity` returns
`{ error: 'not-restorable' }` before reading any op history. That early return is what keeps a
camper's name out of a restore preview — a property worth a test, not an inference (§8.4).

### 5.3 Negative-assertion test

`electron/auth/participantEntitiesAdminOnly.test.js` — new file. The existing parity test guards
**omission** (a camp-scoped entity missing from `ENTITIES` resolving to admin-only) and by
construction cannot catch an **over-grant**. So:

```
for each of the seven entities E, and each verb V in
  [read, write, delete, restore, bulk_replace, import]:
    expect(PERMISSIONS.staff).not.toContain(`${E}.${V}`)
    expect(authorize({role:'staff', ...}, `${E}.${V}`).allowed).toBe(false)
```

plus the four the ADR and ticket name explicitly, asserted by name rather than only by loop, so a
future refactor of the loop cannot quietly drop them:

```
staff holds no 'campers.read'
staff holds no 'campers.write'
staff holds no 'elective_preferences.read'
staff holds no 'elective_assignments.read'
```

**Non-vacuity.** Per the repo's own lesson (`feedback_plant_the_defect_the_guard_cannot_see`), a
guard that only plants the defect it was designed for proves nothing. The test therefore also
asserts the **positive control** — that the same loop *does* find `activities.read` in
`PERMISSIONS.staff` — so a future change that empties `PERMISSIONS.staff` entirely, or breaks the
lookup, turns this test red instead of green.

### 5.4 The audit-log PII guard (ADR D9)

`SECRET_KEYS` (`electron/audit/auditLog.js:1-9`) is a **key-name blocklist, not a PII filter**, and
`audit_events` is append-only and survives deletion — so a camper's display name passed into
`recordAuditEvent` metadata is unrecoverable by any purge, including T202's.

A key-name blocklist cannot solve this, because the hazard is the *value*, not the key. The guard
must therefore be at the call site, and it must be structural:

**`recordAuditEvent` rejects metadata for any of the seven entities that contains a value not drawn
from a fixed safe set** — ids, integers, booleans, and the enum literals declared in §1
(`'draft'|'final'`, `'solver'|'manual'`, `'unlimited'|'limited'`). Free text is refused. Concretely:
for `entity ∈ PARTICIPANT_ENTITIES`, every metadata value must match the same
`[A-Za-z0-9_-]` alphabet the id derivation enforces (§2.2). `campers.display_name` cannot pass that
filter, and neither can a filename.

Throw rather than redact: a redacted audit row is a silent behaviour change at the exact moment a
caller made a mistake, and this repo's standing rule is to surface write failures, not swallow them.

Test: `electron/audit/participantAuditPii.test.js` asserts the throw for a display-name-shaped
value on each of the seven entities, and — non-vacuity again — that an ordinary id-shaped value on
the same entity is accepted.

---

## 6. Genesis regeneration

### 6.1 Why it is forced

`MODELED_ENTITIES` (`campDocument.js:85`) is **derived**:
`DIRECT_CAMP_ENTITIES ∪ Object.keys(PARENT_SCOPED_ENTITIES) ∪ ['camps','users']` minus
`DEFERRED_ENTITIES`. Registering rows 5 and 6 of §4 expands it automatically, and the module-load
subset guard then throws:

> `campDocument: '<entity>' is in MODELED_ENTITIES but missing from GENESIS_ENTITIES/GENESIS_B64`

That throw is the forcing function working correctly. The file's comment is explicit that it must
**not** be silenced by editing `GENESIS_ENTITIES` alone — the bytes have to be regenerated, or two
devices each running `d[entity] = {}` at runtime is a concurrent map-key create that Automerge
resolves by keeping one side and discarding the other into `A.getConflicts`, which nothing reads.

### 6.2 The procedure, verified rather than assumed

`A.from(shape)` is **not reproducible**. Verified empirically against the resolved version
(`@automerge/automerge` **3.4.1**, from `package-lock.json`): two `A.from(shape)` calls with the same
shape produce **different heads**, because the actor id is random and the change carries a
timestamp. A regeneration recipe that does not pin both is not a procedure, it is a lottery — and
the pinned head in `campDocument.test.js:176` would be unreproducible by the next person who needs
to regenerate.

The current genesis was reproduced exactly, byte for byte, with this recipe:

```js
// actor and time recovered from the CURRENT genesis:
//   A.getHistory(A.load(...))[0].change.{actor,time}
const ACTOR = '25a5dd896740165864744b9515f73f45'
const TIME  = 1788919636

let d = A.init({ actor: ACTOR })
d = A.change(d, { time: TIME }, (x) => { for (const k of GENESIS_ENTITIES) x[k] = {} })
const b64 = Buffer.from(A.save(d)).toString('base64')
```

Confirmed: this reproduces the existing `GENESIS_B64` **and** the existing pinned head
`931e7c0f93affaf864b270328491a3da4412b508547ea6174724026f6aabde8d`, and is byte-identical across
repeated runs. `A.from(shape, { actor: ACTOR })` alone does **not** reproduce it — the timestamp is
the second half, and this is exactly the kind of claim that must be executed rather than recalled.

### 6.3 Steps

1. Complete §4 rows 5 and 6. Observe the subset guard throw — **do not skip this**; it is the proof
   the guard is live.
2. Add the seven names to `GENESIS_ENTITIES`, keeping the array sorted (it is sorted today, for
   determinism).
3. Regenerate `GENESIS_B64` with §6.2's recipe, **reusing `ACTOR` and `TIME` unchanged**, so the
   only input that differs from the last regeneration is the entity list. A regeneration that also
   changes the actor or the time makes the diff unreviewable.
4. Update the pinned head in `campDocument.test.js:176` to the new value, and add a **SIXTH
   REGENERATION** paragraph to both `campDocument.js`'s `GENESIS_B64` comment and that test's
   comment, in the established form, recording: participant entities added (T194); accepted because
   the **owner confirmed on 2026-09-17 that the project is pre-production and no real camp document
   exists** (ADR D13).
5. Commit the regeneration with the registry changes, never separately — a commit where
   `MODELED_ENTITIES` and the genesis disagree does not import.

### 6.4 The ticket must state this

**Every existing `.automerge` file is invalidated.** Two such files exist on this machine
(`shoresh-dev/automerge/d4f3954d-….automerge` and `shoresh/automerge/f7329bec-….automerge`); both
must be discarded, and every paired device must re-pair. `sharesGenesis()`
(`campDocument.js:322-330`) and `syncNode.js:147-153` refuse and drop a document that does not share
genesis, so an old file does not corrupt a new one — it simply stops syncing, silently, until
someone notices. The ticket states this as a **release note**, not a footnote.

---

## 7. Migration and rollback

### 7.1 The v66 block (`electron/db/localDb.js`)

Bump `CURRENT_SCHEMA_VERSION` to `66` (`localDb.js:25`). Guard **banded**, matching v65 at `:2519`:

```js
if (getSchemaVersion(db) >= 65 && getSchemaVersion(db) < 66) { … }
```

Inside, in order:

1. The seven `CREATE TABLE IF NOT EXISTS` statements — **the exact text from §1**, shared with
   `schema.sql`. Because they are new tables created by the identical statement on both paths,
   fresh-vs-migrated column order is equal by construction, not by care. This is the one structural
   advantage of new tables over the `template_slots.elective_set_id` drift (`schema.sql:509-531`).
2. The two `ALTER TABLE elective_set_activities ADD COLUMN` statements (§3.1), **each guarded by a
   `PRAGMA table_info` presence check**, following the v39 precedent at `localDb.js:1657-1659`.
   These append, so `elective_set_activities`' migrated column order becomes
   `id, elective_set_id, activity_id, camper_headcount, capacity_mode, capacity_limit` — and
   `schema.sql` must declare them in that same trailing order, extending the "MUST be the LAST
   column" note already at `schema.sql:1007-1015`.
3. The backfill `UPDATE` (§3.4).
4. `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (66, ?)`.

**No table rebuild anywhere.** The capacity columns are added by `ALTER`, verified in §3.2 to carry
their CHECK constraints correctly, so the `UNIQUE(elective_set_id, activity_id)` index on
`elective_set_activities` is never dropped. That avoids the failure class T189 recorded (an index
that did not survive its table rebuild) by not entering it.

**No op-log rows are written by the migration.** The v39 precedent asserts this explicitly
(`electiveCapacity.migration.test.js:115`) and v66 keeps it: a migration is a schema change, not a
user write, and emitting ops would replicate a local schema action to every peer.

### 7.2 `electron/db/rollback/v66_down.js`

Following the `v35_down.js`/`v39_down.js` convention: presence-checked, reporting a discarded count,
idempotent.

1. **Count before destroying** — `campers`, `elective_preferences`, `elective_assignments` row
   counts, reported in the return value.
2. `DROP TABLE IF EXISTS` the seven, in **reverse** `DOMAIN_SNAPSHOT_ORDER` order (assignments,
   preferences, choice_offerings, choices, occurrences, runs, campers) so `foreign_keys = ON` never
   sees a dangling child.
3. `ALTER TABLE elective_set_activities DROP COLUMN capacity_limit` then `capacity_mode`, each
   presence-checked. `camper_headcount` is untouched and still holds the legacy value, so capacity
   information is **not** lost by the rollback — the §3.4 mapping is re-derivable. Stated because it
   is the one piece of good news in this section.
4. Set `schema_migrations` back to 65.

**Rollback destroys imported preference data.** Every `campers`, `elective_preferences` and
`elective_assignments` row is dropped and unrecoverable from the projection. It is recoverable in
principle from the op-log and the Automerge document, which are *not* touched by a rollback — which
means the rollback **reduces the PII footprint on disk but does not erase it**. That distinction is
load-bearing and the rollback plan must state it in exactly those terms: a rollback is not a purge,
and a director who runs one has not erased a child's record. The real purge is ADR D10 / T202.

### 7.3 Column-order parity test

`electron/db/participantSubstrate.migration.test.js` — new file, modelled on
`electron/db/electiveCapacity.migration.test.js`.

For each of the seven tables, and for `elective_set_activities`:

```
const fresh    = openFreshDbFromSchemaSql()
const migrated = openDbAtVersion(65).then(runMigrations)

expect(migrated.pragma(`table_info(${t})`).map(c => c.name))
  .toEqual(fresh.pragma(`table_info(${t})`).map(c => c.name))     // ORDER, not set
```

`.toEqual` on the **array** is what makes this an order comparison — the trap the ADR names. The
existing `electiveCapacity.migration.test.js:93-96` already uses this exact form
(`'declares elective_set_activities columns in order, camper_headcount last'`), so the pattern is
established rather than invented; T194 extends it to eight tables and adds the trailing capacity
columns to that existing assertion.

Three further assertions, because a matching name list is not a matching schema:

- **Types and NOT NULL** — compare the full `(name, type, notnull, dflt_value, pk)` tuple per
  column, not just the name. A column that is `NOT NULL` on one path and nullable on the other is
  invisible to a name comparison and is a real projection-failure source.
- **CHECK constraints** — compare `sqlite_master.sql` for `elective_set_activities` between the two
  paths. `ALTER ADD COLUMN` folds the column-level CHECK into the stored DDL (verified in §3.2), so
  the two should match; if a future SQLite ever diverges here, a migrated database silently loses a
  constraint the fresh one has, and only this assertion sees it.
- **Indexes survive** — `sqlite_master` where `type='index'` for `elective_set_activities` includes
  the `UNIQUE(elective_set_id, activity_id)` index on **both** paths. This is the direct T189
  regression guard.

---

## 8. Test plan, seam by seam, test-first

Per `GOVERNANCE_INDEX.md` §3-8, task class **Database / sync**: integration is **mandatory**, plus
fresh-vs-migrated schema equivalence, test, lint, build.

### 8.1 Migration seam

`electron/db/participantSubstrate.migration.test.js` (new)

- v66 declared on a fresh db; all seven tables present.
- Fresh-vs-migrated parity: column **order**, full column tuple, CHECK DDL, index survival (§7.3).
- Idempotency: running migrations twice leaves one `capacity_mode` column and does not re-run the
  backfill (v39 precedent, `electiveCapacity.migration.test.js:127-133`).
- **Capacity CHECK behaviour, pinned** — the accept/reject matrix from §3.1, executed:
  `('limited', 0)` accepted, `('limited', -1)` rejected, `('limited', 2.5)` rejected,
  `('unlimited', NULL)` accepted, `('bogus', …)` rejected.
- **The §3.2 finding, pinned as its own named test**: `'capacity_mode and capacity_limit can be
  written one field at a time, in either order'`. Writes each field independently through the real
  projection path and asserts both orders succeed. This is the test that stops a future reviewer
  from "tightening" the CHECK into the pairing form and breaking sync.
- Backfill mapping: rows seeded at v65 with `camper_headcount` ∈ `{NULL, 0, 12, -3}` land on the
  §3.4 mapping exactly.
- `operations` row count unchanged across the migration.

`electron/db/rollback/v66_down.test.js` (new) — drops all seven in FK-safe order with
`foreign_keys = ON`, reports the discarded counts, leaves `camper_headcount` intact, returns
`schema_migrations` to 65, and is idempotent.

### 8.2 Derived-id seam

`electron/ops/electiveDerivedIds.test.js` (new)

- **Frozen vectors**: each of the five functions pinned to an exact output string for a fixed input
  tuple, in the style of `electron/sync/campIdHash.test.js`. Changing one is then a deliberate act.
- **Injectivity, adversarially**: the component pairs that collide under plain `:`-joining
  (`('a:b','c')` vs `('a','b:c')`) produce **different** ids under length-prefixing.
- **Rejection**: a component containing `:`, a space, a combining mark, an empty string, `null`, or
  a number throws (§2.2). This is the test that keeps human strings out of keys.
- **Order sensitivity**: swapping `camperId` and `occurrenceId` yields a different id — the
  argument order is part of the contract.
- **Recomputability**: for a row shaped like an `elective_assignments` row, `derive(...)` from the
  row's own columns equals the row's `id` (candidate E's drift check, as a test rather than a
  column).

### 8.3 Sync / two-device merge seam — **mandatory, and the core of the slice**

`test/integration/scenarios/31-derived-id-convergence.automerge.js` (new), run by
`test/integration/run.automerge.js` under `npm run test:integration`.

A unit test of the id function proves the function is deterministic. It does **not** prove that the
duplicate is impossible, because the duplicate is a *merge* phenomenon. The fixture:

> Two devices, A and B, paired and then **partitioned**. Both are given the same run
> (`run-1`), the same camper (`camper-1`) and the same occurrence (`occ-1`). Each independently
> generates an assignment for that triple — device A placing `activity-swim`, device B placing
> `activity-archery` — **through the real write path**, not by hand-constructing a row. The
> partition heals and the documents merge.
>
> **Assert:** `SELECT COUNT(*) FROM elective_assignments WHERE run_id='run-1' AND camper_id='camper-1'`
> is exactly **1** on **both** devices; both devices agree on the same surviving `activity_id`; and
> a `conflicts` row exists naming `elective_assignments/<derived-id>/activity_id`.

**Why it fails without derived ids** — and this is the half that makes the test non-vacuous. With
`crypto.randomUUID()` ids, device A writes `id=uuid-A` and device B writes `id=uuid-B`. These are
two distinct map keys in the Automerge document, so the merge is not a conflict at all: both
survive, the count is **2**, no `conflicts` row is written, and the projection shows the camper
assigned to two activities in one period. The assertion `COUNT = 1` is therefore the exact
discriminator between the two designs, and a reviewer can verify the test's worth by temporarily
swapping the id function for `randomUUID` and watching it go red.

**Non-vacuity, the other direction** (the inversion frame's warning — a convergence test passes for
*any* id scheme if it merges a document with itself): the same scenario runs a second arm where
device B uses a **different** camper (`camper-2`). Assert the count is **2** — distinct keys must
stay distinct. Without this arm the test would also pass for a constant id.

`test/integration/scenarios/32-participant-substrate-sync.automerge.js` (new) — the ordinary
registration proof, modelled on `17-joining-device-domain-data.automerge.js`: a device that joins a
camp holding rows in all seven tables receives all seven (this exercises `DOMAIN_SNAPSHOT_ORDER`
with `foreign_keys = ON`, and fails loudly if the §1.2 order is wrong), and a projection rebuild
from the document restores every row.

`electron/automerge/campDocument.test.js` (extended) — the new pinned genesis head, plus a
merge-convergence case for one newly-modeled **parent-scoped** entity
(`elective_choice_offerings`), following the existing `week_activity_exclusions` case at
`:209-221`. That case exists precisely to prove the genesis fix generalizes to each collection
*shape*, and the seven add no new shape — so one representative is right, seven would be padding.

### 8.4 Authorization and exclusion seam

- `electron/auth/participantEntitiesAdminOnly.test.js` (new) — §5.3, with its positive control.
- `electron/auth/permissionsEntityParity.test.js` (extended) — the seven added to
  `PERMISSIONS_ADMIN_ONLY_EXCEPTIONS`.
- `electron/audit/participantAuditPii.test.js` (new) — §5.4, both directions.
- `electron/ops/restore.test.js` (extended) — the seven present in `RESTORE_DECISIONS`, none
  `'restorable'`, and `restoreEntity('campers', …)` returns `{ error: 'not-restorable' }`
  **without** having read op history (assert the returned shape carries no field values — §5.2).
- `scripts/mcp/entityMapExclusion.test.js` (new) — the **negative** test row 31 needs: for each of
  the seven, no key **and no value** in `ENTITY_MAP` names it, so `list_entities` cannot return a
  camper row. Nothing guards that map today; the spec's success predicate makes it a gate.
- `electron/ipcSurfaceParity.test.js`, `electron/ops/electivesRegistries.test.js`,
  `electron/ops/electives.projections.test.js` (all extended) — the `PROJECTIONS`/mock field-list
  changes from §4 row 4. These three will fail on the capacity change and **that is the signal**,
  not an obstacle.
- `electron/ops/undoReferences.schemaParity.test.js` (extended) — §4.1's eight checks and sixteen
  allowlist entries.
- `scripts/check-governance` + `npm run index:work` — §4 rows 33-34.

### 8.5 Order of work (test-first)

1. `electiveDerivedIds.test.js` → the module. It has no dependencies and is the invariant everything
   else rests on.
2. The migration test → schema + v66 + rollback.
3. `31-derived-id-convergence` → registry rows 4-9 and the genesis regeneration. The scenario cannot
   even load until the substrate is registered, which is the correct forcing order.
4. The authorization and exclusion tests → rows 10-13, 31, 32.
5. The remaining registry rows and the doc/index gates.

---

## 9. What the ADR does not decide — owner rulings needed

These are reported, not resolved. Each is a real ambiguity found by opening the files, and none is
mine to settle.

### 9.1 `elective_preferences` — three documents give two different keys

- **ADR D4** (normative): derived from `(run_id, camper_id, occurrence_id, activity_id)`.
- **T194 ticket**: same.
- **Spec §2** (table): derived from `run + camper + choice`.

The spec is the only one that is **expressible**. ADR D12 moved preferences to point at a *choice*
rather than at an occurrence+activity, and spec §2's own field list for `elective_preferences` is
`id, run_id, camper_id, choice_id, rank` — there is **no `occurrence_id` and no `activity_id`
column on the row**. D4's key names two columns that D12 deleted; D4 and D12 were written in the
same document and D12 is the later reasoning.

§2.3 above is written to the spec's key. **This needs confirming, not assuming** — it is a
normative ADR clause and I will not amend it. Recommendation: the spec's
`(run_id, camper_id, choice_id)`, with a correction note appended to D4 recording that D12
superseded its key, in the same "recorded rather than deleted" style D9 already uses.

### 9.2 `elective_choices` derives from a human string — the one key that is not opaque

Spec §2 keys `elective_choices` on `(run_id, label)`. `label` is director- or import-supplied free
text, which makes it the sole component in the whole scheme subject to the delimiter-injection and
Unicode-normalization skew that §2.2 otherwise eliminates. Two devices importing the same sheet
where one path normalizes `"Swim  Advanced"` (two spaces) differently produce two choices, two sets
of preferences, and the duplicate class D4 exists to close — reappearing one level up.

The ADR does not address this; D12 specifies the *shape* of `elective_choices`, not its key.

Three options, with the tradeoff:

- **(a) Normalized label** — one exported, version-stamped canonicalizer (NFC, trim, collapse inner
  whitespace, casefold) whose output is the key component. Keeps the spec's key. Choice identity is
  stable when members are edited, unstable when the label is retyped. Adds the one normalization
  rule §2.2 was designed to avoid needing.
- **(b) Content-addressed** — key on `(run_id, sorted member (occurrence_id, activity_id) tuples)`
  instead of the label. Not circular: the choice id is computed from the members, then each offering
  id from the choice id. Fully opaque, no normalization anywhere, and two devices importing the same
  sheet converge regardless of what label each assigned. **But** editing a choice's members re-keys
  the choice, orphaning every preference that pointed at it — which T195 would then have to handle.
- **(c) Ordinary random id**, with the duplicate-choice class accepted and surfaced as a T195
  reconciliation decision rather than prevented.

Recommendation: **(a)**, because it matches the spec as written and keeps choice identity stable
across the member edits a director will actually make; with the canonicalizer as a single exported,
version-stamped function backed by a frozen adversarial corpus (homoglyphs, NFC/NFD, RTL overrides,
the delimiter itself), per the hostile-competitor frame. But **(b) is genuinely better engineering**
and the choice between "stable under member edits" and "no human string in any key" is a product
judgement about how directors edit choices, which I do not have.

### 9.3 What happens to an assignment run when its schedule week is deleted

`elective_assignment_runs.schedule_week_id` is a **declared** `REFERENCES schedule_weeks(id)`.
`deleteWeek.js` (`:11-25`) documents an 0→8 cascade and already has to NULL
`anchor_activities.schedule_week_id` (step 0) and `elective_sets.schedule_week_id` (step 0b) for
exactly this reason. Under `foreign_keys = ON`, **deleting a week with runs attached hard-fails**
unless a step is added.

The ADR does not say what that step should do, and the three options are not equivalent:

- **NULL the link** (matching steps 0 and 0b) — the run survives, orphaned from its week, and
  `STALE_OUTER_SCHEDULE` can never resolve because the premises are gone. Cheap and wrong.
- **Delete the runs** — cascades into preferences and assignments, silently destroying a finalized
  roster and a set of imported preferences as a side effect of deleting a week. This is the D10
  purge happening by accident, without the honest copy D10 requires.
- **Block the week delete** while runs exist, with a message naming them — the precedent is
  `deleteWeek.js:38`'s last-week guard.

Recommendation: **block**, because the other two destroy or orphan a child's roster as a side effect
of an unrelated action, and a director who wants the week gone can delete the runs deliberately
first. But this is a product decision about a destructive control, which per the Constitution is an
owner gate, not an architect's call.

### 9.4 Trash/history admin-only is not expressible in the current permission shape

ADR D9 and the ticket both require: *"Per-record history and Trash on these are admin-only too."*

`'trash.read'` (`permissions.js:104-111`) is a **single blanket grant with no entity argument**. It
is not `<entity>.trash.read`. So staff hold `trash.read` for everything or for nothing, and keeping
the seven out of `ENTITIES` — which is what makes every *other* D9 requirement work — does **not**
narrow it. There is no omission that produces the required behaviour.

Satisfying D9 therefore requires a mechanism that does not exist today. The options are a per-entity
trash/history authorization (a change to an accepted authorization shape — `GOVERNANCE_INDEX.md`
marks "any change to an accepted tradeoff" as an owner gate), or filtering the seven out of the
trash/history **read handlers** for non-admin callers (narrower, but a second authorization
mechanism living outside `authorize()`, which is the drift `SECURITY.md` is built to prevent).

I am not choosing. **This is the one place in T194 where the ADR states a requirement the existing
code shape cannot express**, and it needs an owner ruling before Maker starts, because the answer
changes whether T194 touches `authorize()`.

### 9.5 Scope boundaries I am asserting, for Governor to confirm rather than discover

- **D3's authoring UI** ("a director must never be unsure whether it is uncapped or closed") is
  **not** in T194. T194 ships the representation; the unmissable UI is an elective-authoring change.
  If Governor wants it in this slice, the slice needs a Designer pass and `DESIGN_STANDARD.md` §5/§8
  become hard constraints on it. As scoped here, T194 has **no rendered surface**, so
  `DESIGN_STANDARD.md` does not bind.
- **D5's `solver_generation` split**: T194 ships the `solver_generation TEXT` column on
  `elective_assignment_runs` and on `elective_assignments`, and nothing else. The inertness rule
  (rows whose marker does not match are excluded from projection and raise
  `SUPERSEDED_GENERATION`) is **T196**. Stated because "stores the marker" and "honours the marker"
  are easy to conflate, and a T194 that quietly implements the filter would put solver policy in
  the projection layer.
- **D6's finalization snapshot** is T196/T197. No snapshot column is added here; adding one now
  would be designing a shape whose consumer does not exist.

---

## 10. Interface-contract checklist (`org-interface-contracts`)

T194 adds no new IPC handler. It registers new **op-log/projection primitives**, which is a contract
seam, so the checklist applies.

| Requirement | Status |
|---|---|
| **Idempotency** | **Satisfied by inheritance.** All seven route through the existing `write()`/`client_write_id` path; no new mutation path is introduced. A repeated `client_write_id` applies once, unchanged |
| **Concurrent retries** | **Satisfied by construction, and this is the slice's purpose.** Derived ids (§2) make two devices' concurrent creation of the same logical row the *same* Automerge key, so it converges to per-field LWW plus a `conflicts` row rather than two records. Proved by §8.3, not asserted |
| **Unknown outcomes** | **Satisfied.** A dropped connection mid-write leaves the op in the local log and the document; Automerge reconciles on reconnect. Because the ids are derived, a blind retry after an unknown outcome is safe — it targets the same key. This is a *strictly* better property than the pre-T194 status quo for composite-keyed rows |
| **Error shape** | **Satisfied, with one addition.** Projection writes keep the existing shape. The new `deriveElectiveId` throw (§2.2) and the new `recordAuditEvent` PII throw (§5.4) are both **new failure modes** and must surface through `describeWriteFailure`, not be swallowed — this repo's standing rule |
| **Scope / authority boundary** | **Satisfied and deliberately tightened.** All seven are registered in `PROJECTIONS` (or their writes vanish) and deliberately excluded from `ENTITIES` so `authorize()` default-denies staff. §9.4 flags the one D9 requirement this boundary **cannot** express |
| **Validate across trust boundaries** | **Partly deferred, deliberately.** Rows arriving by sync or migration are the trust boundary. The DB CHECKs (§1, §3.1) validate `status`, `source` and capacity at the projection write, on every device, including the receiving one. Preference-file content is T195's boundary and is explicitly not validated here |

---

## 11. Summary of what Maker builds

**New files (6):** `electron/ops/electiveDerivedIds.js` · `electron/db/rollback/v66_down.js` ·
`electron/db/participantSubstrate.migration.test.js` ·
`electron/ops/electiveDerivedIds.test.js` ·
`electron/auth/participantEntitiesAdminOnly.test.js` ·
`test/integration/scenarios/31-derived-id-convergence.automerge.js`
(plus `32-participant-substrate-sync`, `v66_down.test.js`,
`participantAuditPii.test.js`, `entityMapExclusion.test.js`).

**Changed contracts:** `PROJECTIONS` (7 additions + the `elective_set_activities` field-list
change) · `DIRECT_CAMP_ENTITIES` (+2) · `PARENT_SCOPED_ENTITIES` (+5) · `DOMAIN_SNAPSHOT_ORDER`
(+7) · `GENESIS_ENTITIES` + `GENESIS_B64` (regenerated) · `RESTORE_DECISIONS` (+7) ·
`UNDO_REFERENCE_CHECKS` (+8, +16 allowlist) · `MOCK_WRITE_ALLOWLIST` (+7) ·
`PERMISSIONS_ADMIN_ONLY_EXCEPTIONS` (+7) · `recordAuditEvent` (new refusal) · `deleteRecord.js`
(camper reference report) · `deleteWeek.js` (**pending §9.3**).

**Changed schemas:** `schema.sql` (+7 tables, +2 columns) · `CURRENT_SCHEMA_VERSION` 65 → 66.

**Blocked on owner rulings:** §9.1 (preference key), §9.2 (choice key), §9.3 (week delete),
§9.4 (trash/history). §9.1 and §9.2 block the derived-id module, which is step 1 of §8.5 — so these
two are on the critical path and cannot be deferred past the start of implementation.
