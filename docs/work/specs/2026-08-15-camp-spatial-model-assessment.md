---
title: "Camp Spatial Model — M0 Architecture Assessment"
document_type: discovery
status: draft
created: 2026-08-15
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_adrs: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md, docs/adr/2026-08-09-s1b-host-local-aliases.md, docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md, docs/adr/2026-08-08-s5-readiness-six-state-model.md, docs/adr/2026-08-10-ingestion-evidence-persistence.md, docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md, docs/adr/2026-08-02-schedule-weeks-first-class.md, docs/adr/2026-08-08-export-formula-injection-sanitizer.md]
related_specs: [docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md]
archive_when: superseded by an accepted spatial-model ADR, or the initiative is abandoned
---

# Camp Spatial Model — M0 Architecture Assessment

**Read-only architecture audit. No production code was written or modified in M0.** One temporary
probe test was created, executed, and deleted; its output is quoted verbatim in §3.

**Document type note.** Filed as `document_type: discovery` rather than `spec`, following the
precedent of `docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md`: this is a dated
point-in-time read-only report answering an architecture question, not a document that scopes
implementation. `WORK_RECORD_STANDARD.md` §2 exempts `discovery` from `archive_when`; one is
supplied anyway, matching the Phase A precedent.

---

## 0. The single most important framing (read first)

**The handoff's premise is false, and correcting it changes the shape of the whole initiative.**

The handoff asserts that "locations are already present in Shoresh and have recently been moving
toward first-class status." Neither half holds.

There is no location entity, and there never has been. `location` is a nullable free-text `TEXT`
column on `activities` (`electron/db/schema.sql:267`). There is no `locations` table, no location
id, no foreign key, no index, no uniqueness constraint, and no UI beyond one bare `<input>`.
Grepping `src/`, `electron/`, and `schema.sql` for `room|facility|venue|zone|court|site|space`
returns zero place entities — `bunk` is always a camper *group*, `room` appears only in the ingest
parser's discard logic, and `area` appears only as readiness *categories*.

Nor has anything "recently moved toward" first-class status. The most recent architectural decision
on this exact question moved the other way, deliberately:
`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md` D7 records
*"No `locations` table now (Q10/Q11). Keep `activities.location` as free text… First-classing
(`activity_locations` + nullable `location_id` soft-migrate) is the prior program's slice S3 —
deferred, not pulled forward."*

So the correct framing is: **this is a create, not a correction, and it will amend a standing ADR.**
The handoff's M1, "Location model corrections," is misnamed — see §11.

Two things *are* genuinely true and are the reason this work is well-timed:

1. The repository deliberately left a named, wired seam open for exactly this. `location` is one of
   two `FORWARD_AREAS` in `src/engine/readiness.js:137-140` — *"real areas the app will grow into
   but that carry no collection binding today."* It already has a label, a screen target, a
   readiness row, and a reconciliation chip. §4 treats this as the primary integration point.
2. The free-text column is already load-bearing in the scheduling engine, and **it is carrying a
   live, director-visible defect** (§3). That defect, not the map, is the strongest argument for
   doing this now.

---

## 1. Current-state location ontology

### What "location" actually is today

A **string typed by a human into one text box**, used by the schedule engine as a room key by
string equality, and cosmetic everywhere else.

| Fact | Evidence |
|---|---|
| Nullable free-text column on `activities` | `electron/db/schema.sql:267` — `location TEXT,` |
| Added by ALTER TABLE, no default, no constraint | `electron/db/localDb.js:574` — `addColumnIfMissing('activities', 'location', 'TEXT')` (v15 block) |
| No `locations` table, no `location_id`, no FK | absence across `electron/db/schema.sql` |
| Entered as bare free text, no autocomplete, no dedupe | `src/screens/ActivitiesScreen.jsx:123` — `<input value={location} … placeholder="e.g. Pool, Gym" />`; zero `datalist`/`autoComplete`/typeahead hits in that file |
| Only normalization is `.trim()` on save | `src/screens/ActivitiesScreen.jsx:88` — `location: location.trim() \|\| null` |
| Place identity is raw string concatenation | `src/engine/buildSchedule.js:202` — ``locationKey(location, dayId, blockId) { return `${location}|${dayId}|${blockId}` }`` — no case folding, no trim, and a location containing `\|` collides |
| Replicated as an activity field through the op log | `electron/ops/projections.js:128`; `electron/sync/syncClient.js:59`; `src/localClient.mock.js:268` |
| Exported and re-importable as a workbook column | `src/utils/exportWorkbook.js:55` — `{ key: 'location' }` on the Activities sheet |
| Diffable on re-import | `electron/ops/ingest.js:180` — `COMPARABLE_COLUMNS.activities` includes `'location'`; mirrored `src/localClient.mock.js:37` |
| Director-facing label | `src/ingest/fieldLabels.js:8` — `location: 'where it happens'`; `src/screens/recordLabels.js:38` — `location: 'Location'` |

`"Pool"`, `"pool"`, and `"Pool Deck"` are three unrelated places to this system. Nothing in the app
can tell a director that, and nothing offers to reconcile them.

### `is_outdoor` is on the activity, not on any place

`electron/db/schema.sql:268` — `is_outdoor INTEGER` on `activities`. It has **no engine effect at
all**: `src/engine/buildSchedule.js:18` records that *"exposure is read at render time from
`activity.is_outdoor`"*, pinned by `src/engine/buildSchedule.test.js:63-65`
(`it('is no longer emitted anywhere in flags…')`). Its only consumers are Weather Mode's cell
highlight (`src/components/schedule/SlotCell.jsx:204-206`) and an `OUTDOOR` badge
(`ScheduleActivityView.jsx:47,76`). `weather_alternative_id` is likewise UI-and-referential-integrity
only — **no rain-plan swap logic exists anywhere.**

This matters ontologically: "outdoor" is a property of a *place*, and today it is stored on the
*activity*. That is the same category error as capacity (§3), one step less severe because nothing
schedules on it. See owner question Q5.

### The one honest counter-example to "there is no location concept"

`src/engine/readiness.js:137-140`:

```js
export const FORWARD_AREAS = [
  { key: 'location', label: 'Locations', screen: 'camp' },
  { key: 'staffing', label: 'Staffing', screen: null },
]
```

`kind: 'forward'` categories can structurally never reach `missing` (`readiness.js:198-201`, gated
on `kind === 'required'`; `REQUIRED_AREAS` never grows) and fall through to `'optional'`
(`readiness.js:209-211`). The director sees **"Locations — not started"** with a Review button
(`src/screens/readinessHubModel.js:63`, `statusWord()` `:31-41`).

**That Review button is a dead end today.** `screen: 'camp'` navigates to
`src/screens/CampScreen.jsx`, which per its own header contains only the camp *name* and has no
location concept whatsoever. Staffing was given `doors: 'none'` for precisely this reason; Locations
was not. This is a live, small, director-visible defect independent of everything else in this
document.

---

## 2. Relevant paths, components, schema

**Schema and persistence**
- `electron/db/schema.sql:260-279` — `activities` table (`location` :267, `is_outdoor` :268, `max_groups_per_slot` :269, `same_tier_only` :271, `weather_alternative_id` :277)
- `electron/db/schema.sql:165-195` — `operations` (field-level op log); `:206-217` — `conflicts`
- `electron/db/schema.sql:452-459` — `schedule_weeks` (v27); `:550-561` — `week_activity_exclusions` / `week_group_exclusions` (v28)
- `electron/db/localDb.js:16` — `CURRENT_SCHEMA_VERSION = 31`; `:574-584` — v15 ALTER block; `:1377-1419` — v30/v31 blocks (the both-places-DDL pattern for a new table)
- `electron/db/rollback/v30_down.js`, `v31_down.js` — per-version rollback precedent

**Sync / op-log registries a new entity must enter**
- `electron/ops/projections.js:122-152` — `PROJECTIONS.activities` (`location` at :128); `:452-496` — `applyProjection` (unregistered entity = silent discard at :453)
- `electron/ops/operations.js:91-129` — `appendOp` (throws on unlisted field for a registered entity, :96); `:92-94` — the host-local refusal for `source_aliases`
- `electron/ops/campScopedEntities.js:16-28` — `DIRECT_CAMP_ENTITIES` (drives both `list()` IPC and first-pairing `full_sync`)
- `electron/sync/syncClient.js:32-51`, `:52-95` — `DOMAIN_SNAPSHOT_TABLES` / `DOMAIN_TABLE_COLUMNS`
- `electron/ops/restore.js:18-41` — `RESTORE_DECISIONS` (a missing entry fails `restore.test.js:109`)
- `electron/auth/permissions.js:15-29` — `ENTITIES` (omission silently makes an entity admin-only)
- `electron/ops/projectionsCoverage.test.js` — the 838-line static scanner + live-db column audit

**Engine and schedule**
- `src/engine/buildSchedule.js:186,202,224-236,243-274` — the entire spatial reasoning of the app
- `src/utils/computeOverlaps.js` (58 lines) — the manual route's OVERLAP derivation
- `src/screens/schedule/useSlotMutations.js:419-420,433` — manual placement's `locationFull`; `:99-170` — the per-cell write queue (`cellQueueRef` :119, `claimAndRun` :154-170)

**Ingestion**
- `src/engine/readiness.js:132-149` — the readiness spine; `src/screens/readinessHubModel.js:61-65`; `src/screens/ReconciliationSummary.jsx:31-45`; `src/screens/importOutcomeModel.js:22-35`
- `src/ingest/reconciliationReport.js:320,340-344` — the four report buckets and the `notInSource` rule
- `electron/ops/ingest.js:28-30,154,158,174-181,199-206,245` — the ingest entity registries
- `src/ingest/textGrid.js:194-200,301-303,349-380` — the parser that **discards** printed locations
- `electron/ops/confirmAlias.js` — the single alias writer; `electron/db/schema.sql:104-122` — `source_aliases`

**Setup CRUD / UI**
- `src/data/setupCrudRepository.js:15-76` — `writeFields` / `createRecord` / `deleteAllRecords`; entity is a **call argument**, so the repository needs zero change for an 8th entity
- `src/hooks/useCrudScreen.js:15-134`; seven consuming setup screens
- `src/localClient.mock.js:204-210` (`UNIQUE_KEYS`), `:249-306` (`MOCK_WRITE_ALLOWLIST`, hand-transcribed by design, drift-guarded by `electron/ipcSurfaceParity.test.js:280-315`)

**Export**
- `src/utils/exportWorkbook.js:50-57,99-109,150-156,162` — the Activities sheet, its `_shoresh_meta` baseline, and the sanitizer boundary
- `src/ingest/workbookToSource.js:99-155` — the re-import allowlist parse

---

## 3. Existing scheduling ↔ location relationships

### 3.1 The engine treats `location` as a shared room key — correctly in shape, incorrectly in enforcement

`src/engine/buildSchedule.js:186` declares `locationUsage`, a `Map` keyed
`"location|dayId|blockId"` → `[{ groupId, tierId }]`. `place()` (`:269-274`, and `:259-264` for
span tails) pushes an occupant onto that key **for every activity that has a location**. So the map
is genuinely shared across activities: it is a de facto room-occupancy ledger.

The *check*, however, is not shared. `canPlace()` (`:224-236`):

```js
if (act.location && act.max_groups_per_slot > 1) {
  const occupants = locationUsage.get(lk) || []
  if (occupants.length >= act.max_groups_per_slot) return false
  …same_tier_only checked ONLY inside this branch…
} else if (act.location && act.max_groups_per_slot === 1) {
  if ((locationUsage.get(lk) || []).length >= 1) return false
}
```

The occupancy pool is per-place; the cap applied to it is **whichever activity is currently being
placed**. That is the defect.

### 3.2 The capacity finding — deterministic evidence

I ran a temporary probe (four groups, one day, one time block, two activities both at location
`"Pool"`) through the real engine under Vitest, then deleted it. Verbatim output:

```
CASE A (a1 "Swim Lessons" cap=1 high, a2 "Free Swim" cap=3 low)
  -> g1:a1, g2:a2, g3:a2, g4:(unplaced)

CASE B (a1 "Free Swim" cap=3 high, a2 "Swim Lessons" cap=1 low)
  -> g1:a1, g2:a1, g3:a1, g4:(unplaced)

CASE C (single activity, max_groups_per_slot = null)
  -> g1:a1, g2:a1, g3:a1, g4:a1

CASE D (single activity, cap = 1 — control)
  -> g1:a1, g2:(unplaced), g3:(unplaced), g4:(unplaced)

CASE E (single activity, cap = 0)
  -> g1:a1, g2:a1, g3:a1, g4:a1
```

Three distinct defects, all confirmed:

**(i) Asymmetric, order-dependent enforcement — CASE A.** Swim Lessons declares that only **one**
group can be at the Pool at a time. It is placed first, taking the single slot it believes exists.
Free Swim then places two more groups at the same Pool in the same block, because it only checks its
own cap of 3 against a pool of 1 occupant. **Result: three groups at the Pool, in a place one
activity explicitly capped at one.** Reverse the priorities (CASE B) and the cap-1 activity is
starved out entirely instead. The effective capacity of a place is a function of placement order,
not of anything the director stated.

**(ii) A null cap means unlimited, not one — CASE C.** `null > 1` is false and `null === 1` is
false, so *neither branch runs* and the location constraint vanishes. Four groups at a one-lane
pool, silently.

**(iii) Zero means unlimited — CASE E.** Same boolean gap. A director who types `0` to mean "closed"
gets "unrestricted."

**Is (ii) reachable in a real camp database?** Yes, by two independent routes:
- The v15 migration added `max_groups_per_slot` via `ALTER TABLE … ADD COLUMN … INTEGER`
  (`electron/db/localDb.js:576`), which leaves **NULL on every pre-existing activity row**.
- Nothing in ingest ever writes `max_groups_per_slot` — grep across `src/ingest/` and
  `electron/ops/ingest.js` returns no write site. Imported activities are born with a NULL cap.

The UI paths do default to 1 (`ActivitiesScreen.jsx:45,60,487,578`; `useSlotMutations.js:766`), and
`normalizeActivityEligibility.js:15-18` deliberately declines to default it, documenting that
`null` means "no cap" to `ScheduleScreen`'s `!= null` checks. So the null state is intentional in
one route and a latent bug in the other.

**Verdict: (i) is a live director-visible defect today**, not latent — any camp with two activities
sharing a location string and different caps is exposed, silently, with no flag raised. **(ii) and
(iii) are live for migrated and imported camps** and latent for camps whose activities were all
created through the modal.

**No test covers any of this.** In `src/engine/buildSchedule.test.js`, `location` is non-null in
exactly one test (`:242-266`, one activity, `location: 'pool'`, cap 2). There is no test anywhere —
engine, utils, or screens — in which two activities share one location string. `same_tier_only` is
never exercised with a location at all, so the only branch that reads it (`:229-232`) is untested.

### 3.3 The two routes disagree about what a location is

- **Generated route** (`buildSchedule.js`): buckets occupancy by **location**, with the broken cap.
- **Manual route** (`computeOverlaps.js:23,27`): buckets by **`"dayId|blockId|activityId"`** —
  location is *not in the key*. Location appears at `:40` only as a noun for the message string:
  `const where = act?.location || act?.name || 'this activity'`.

So on the manual route, three groups in "Swim @ Pool" and three in "Free Swim @ Pool" are two
independent buckets, neither over capacity, and **no OVERLAP is raised at any group count**. The
manual route is completely place-blind while its warning text says *"3 groups booked into Pool."*

`useSlotMutations.js:419-420` has the same mismatch, in a variable literally named `locationFull`
that is computed per `activity_id`. `ScheduleScreen.test.jsx:665` — *"locationFull
(max_groups_per_slot reached) still flags UNFILLABLE"* — sets no location at all.

Per `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`, per-slot flags differing by route
is by design and both routes are legitimate. **Differing on what a physical place is, is not a route
difference — it is a domain-model gap showing through in two places.**

### 3.4 What breaks if location becomes an entity

| Surface | What breaks | Severity |
|---|---|---|
| `buildSchedule.js:224-236` | Reads `act.location` (string) and `act.max_groups_per_slot`. Must read the resolved location row's capacity. Generated schedules for camps with null/0 caps **will change** (unlimited → 1). | High — behavior change, disclose to director (Q2) |
| `computeOverlaps.js` | Must re-key by location to be honest. That makes OVERLAP fire in cases it never fired before, on existing manual schedules. | High — new warnings appear on untouched schedules |
| `exportWorkbook.js:55` + `workbookToSource.js` | The `location` column and its `_shoresh_meta` baseline must emit/parse the location **name**, resolved through `location_id`. The `<clear>` sentinel path (`workbookToSource.test.js:75-81`) must keep working. | Medium — round-trip contract |
| `ActivitiesScreen.jsx:123` | Free-text input becomes a picker. The CSV/XLSX template (`:533-536`) and its import parse (`:576`) must resolve names to rows or create them. | Medium |
| `deleteRecord.js` / Trash | Deleting a location that activities point at needs a `previewDelete` story, per `docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md`. | Medium |
| `same_tier_only` | Only meaningful during shared occupancy. Stays on the activity in the minimum design; see §8. | Low — documented wrinkle |
| Historical op-log replay | Ops with `entity='activities', field='location'` must remain projectable forever. See §9. | High if mishandled |

---

## 4. Ingestion ↔ location relationships

### 4.1 Ingest carries location; it never learns it — and that is deliberate

`location` is *carried* through the pipeline (created, updated, diffed, labelled, exported) but is
**originated only by a human**: typing into `ActivitiesScreen.jsx:123`, or editing a cell in a
Shoresh-exported enrichment workbook (`exportWorkbook.js:55` → `workbookToSource.js:99-155`).

Foreign sources are parsed and their locations **actively discarded**. `src/ingest/textGrid.js:301-303`:

```js
// The new family prints a location line under each activity; strip it (spec §3b).
const stripLocations = !labeled
```

with the strip at `:349-380` and room-number recognition at `:194-200` (`isBareNumbers`). The parser
recognises location text *in order to throw it away* so it never becomes a phantom activity. That
matches the standing instruction in
`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md:251`: *"never infer-and-write location
from a schedule grid."*

Two smaller findings:
- `src/ingest/fieldUpdate.js:71-73` folds `rule.location` into an activity's fields — but **nothing
  ever sets `.location` on an activity rule**. `src/ingest/activityRules.js` has no location key and
  `ImportScreen.jsx` never sets one. The code is unreachable and the docblock at `:26` overstates it.
- `electron/ops/ingest.js:180` lists `location` in `COMPARABLE_COLUMNS.activities`, so a workbook
  re-import that changes it produces a real reconciliation decision reading *"Kayak's where it
  happens will change from Dock to Field"* (`src/ingest/fieldLabels.js:8`).

### 4.2 The FORWARD_AREA seam — the primary integration point

`readiness.js:137-140` already gives Locations a key, a label, a screen target, a readiness row, a
Readiness Hub entry, a post-import optional-gaps sentence
(`importOutcomeModel.js:22-35` → `ImportScreen.jsx:1955-1961`), and a reconciliation chip
(`ReconciliationSummary.jsx:35`, `'Resources — Locations, Staffing'`).

Promoting `location` from `FORWARD_AREAS` to `OPTIONAL_AREAS` and giving it a `COLLECTION_FOR`
binding (`readiness.js:156-164`) is a **~6-line change** that lights up every one of those surfaces
at once. `REQUIRED_AREAS` must not grow — locations must never block building a week
(`docs/adr/2026-08-08-s5-readiness-six-state-model.md` §3, and the "map must be optional" constraint).

### 4.3 The honesty problem, and how to fix it without redesigning the ingestion UI

The vocabulary already exists. `docs/adr/2026-08-10-ingestion-reconciliation-semantics.md` D1
defines four information states, derived at read time with **no `state` column**:

| State | Derivation |
|---|---|
| CONFIRMED | field's latest op has `source='human'` (`operations.source`, v29) |
| INFERRED | `source='import'` and the value came from a heuristic (`import_evidence.tag='inferred'`) |
| OBSERVED | `source='import'` and the value is a literal fact from the source (`tag='observed'`) |
| UNKNOWN | field never written — column NULL, no op |

And the ADR states the principle outright at `:30`: *"UNKNOWN is valid and Shoresh must never
manufacture certainty."*

**Three gaps stand between that principle and an honest answer for locations:**

1. **UNKNOWN has no positive representation.** It is *absence* — a NULL column and no op. There is a
   per-decision `unknowns: []` channel, but it is hardcoded empty at six sites
   (`reconciliationReport.js:95,120,157,187,234,445`), each commented *"C1 does not build
   UNKNOWN-field detection — deferred."*
2. **`tag: 'observed'` is defined and never emitted.** The enum is at `electron/ops/ingest.js:246`;
   the only two writers (`ingest.js:655`, `:1321`) both write `'inferred'`. The
   observed-vs-inferred distinction is currently degenerate.
3. **`notInSource` has a permanent floor of 2 and does not measure the source at all.**
   `reconciliationReport.js:340-344`:
   ```js
   // Rule 6: readiness rows with state 'optional' contribute to notInSource
   // ONLY — zero decisions, by design (see ADR "Bucketing" rule 6).
   for (const row of readiness) {
     if (row.state === 'optional') buckets.notInSource += 1
   }
   ```
   Because `FORWARD_AREAS` are structurally `'optional'` forever, Locations and Staffing each add 1
   on **every** import, whatever the source contained.

**The honest representation, and it needs no new UI.** "This source did not tell me enough about
your locations" is already the `notInSource` bucket — dim `--anchor`, never red, never a decision,
copy reading *"optional areas not in this source."* It reads as a gap, not a failure, which is
correct. The minimal seam is to make that count **earned rather than constant**:

- Bind `location` to a real collection so its readiness state becomes `ready` when the camp has
  location rows and `optional` when it does not. `notInSource` then drops from a floor of 2 to a
  measurement — a camp with locations set up stops being told its source did not mention them.
- When the parser *does* see room text (it already recognises it, `textGrid.js:194-200`), the honest
  move is to propose it as a reviewable location with `tag: 'observed'` — not to write it. That is a
  visible, reversible review decision, exactly the pattern
  `docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md` established for fixed
  events. It is also owner question Q8, because today's "throw it away" is a deliberate choice.

**Do not couple ingestion to the map.** Nothing in ingest should read geometry. The dependency arrow
runs one way: geometry references locations; locations know nothing about geometry.

### 4.4 Aliases — locations plug in with no schema change

`source_aliases` (`electron/db/schema.sql:104-122`, v30) is host-local and polymorphic:
`entity_type` is a bare `TEXT` validated against a frozen JS set, and `entity_id` is deliberately
**not** a foreign key precisely because it is polymorphic (`schema.sql:114`).

The same ADR that deferred the locations table already blessed this path
(`2026-08-10-ingestion-reconciliation-semantics.md:253-254`): *"a future `locations` ingestible type
grows at `source_aliases.entity_type` / `INGESTIBLE_ENTITIES`."*

Adding locations to the alias mechanism requires **no protocol change and no table change** — only
registry additions, and each of the two deliberately-duplicated copies must be updated together or
its parity test fails:
`INGESTIBLE_ENTITIES` (`electron/ops/ingest.js:28-30` **and** `src/ingest/extractEntities.js:22-24`),
`ALIAS_ENTITY_TABLE` (`electron/ops/ingest.js:199-206` **and** `electron/ops/confirmAlias.js:21-28`),
plus `COMPARABLE_COLUMNS` (`ingest.js:174-181` and `src/localClient.mock.js:37`) and
`REPLACEABLE_ENTITIES` (`ingest.js:41-43`).

Locations are camp-scoped, not cohort-scoped — `COHORT_SCOPED` is `{tiers, time_blocks}` only
(`ingest.js:158`, mirrored `src/screens/importAliasScope.js:8`). So `cohort_id` must stay NULL or
`confirmAlias` returns `cohort_id_not_allowed` (`confirmAlias.js:56-65`).

### 4.5 Provenance and hand-edit protection — already entity-agnostic

Both mechanisms need **zero per-kind registration**:

- **`operations.source`** (`'import' | 'human' | NULL`, v29, `schema.sql:153-162`) is a column on the
  op log, not a per-entity table. `buildFieldProvenanceMap` (`ingest.js:365-378`) walks whatever
  plan items contain. `NULL` decodes as `'human'` — absence of evidence resolves to "protect it."
  `docs/adr/2026-08-10-ingestion-reconciliation-semantics.md` B3 records that the
  "broaden the activities-only list" premise was already stale: the Policy-A gate is field-agnostic
  and every named entity is already protected.
- **`_humanFields`** is transport-only metadata on the commit payload
  (`buildPlan.js:255,275,322` → `ingest.js:873,885,910,920`), never persisted as a field. Its only
  job is choosing which `source` value goes into the op. **Mock parity is the repeat failure mode
  here** — `src/localClient.mock.js:744-765` carries the twin and has been missed before.

Only **`import_evidence`** is kind-scoped: `EVIDENCE_ENTITY_TYPES = new Set(['activities',
'anchor_activities'])` (`ingest.js:245`), and `writeEvidence` *silently returns* for anything else
(`:257`). Adding `'locations'` to that set is a one-line change the evidence ADR pre-blesses
(`2026-08-10-ingestion-evidence-persistence.md:260-264`: *"the same table extends by adding a value
to `entity_type`, no new table"*).

---

## 5. Gaps

**Domain-model gaps**
1. No place entity. Place identity is string equality on unnormalized free text (§1).
2. Capacity of a place is stored on the activity, producing order-dependent enforcement (§3.2).
3. A null or zero cap disables place capacity entirely rather than meaning one or none (§3.2).
4. The two schedule routes disagree about what a place is; the manual route is place-blind while its
   copy claims otherwise (§3.3).
5. `same_tier_only` is dead unless a location string is set **and** the cap is > 1, and is untested.
6. "Outdoor" is a property of a place stored on the activity (§1).
7. No representation of a place being unavailable for part of the summer.
8. No containment: a field and its Upper/Lower halves cannot both exist as schedulable places.

**Ingestion gaps**
9. `notInSource` has a permanent floor of 2 and does not measure the source (§4.3).
10. Per-decision UNKNOWN is a hardcoded empty array at six sites (§4.3).
11. `tag: 'observed'` is defined and never emitted (§4.3).
12. Recognised location text in foreign sources is discarded with no reviewable trace (§4.1).
13. `src/ingest/fieldUpdate.js:71-73` is unreachable code with a docblock that overstates it.

**Surface gaps**
14. The Readiness Hub's Locations "Review" button navigates to a screen with no location UI (§1).
15. No test anywhere covers two activities sharing one location string (§3.2).

**Pre-existing gap found in passing, out of scope for this initiative**
16. `electron/auth/permissions.js:15-29` `ENTITIES` claims to be `DIRECT_CAMP_ENTITIES ∪
    PARENT_SCOPED_ENTITIES` (`permissions.js:5`) but no longer is: `schedule_weeks`,
    `week_activity_exclusions`, and `week_group_exclusions` are missing from it, silently making
    them admin-only. There is no drift test between `permissions.ENTITIES` and the entity
    registries, unlike the guarded `PROJECTIONS`↔`MOCK_WRITE_ALLOWLIST` pair. A new `locations`
    entity would fall into the same hole if not explicitly added.

---

## 6. Candidate spatial models

Generated under five isolated divergent frames (regulator, hostile-competitor, inversion,
one-hour-budget, biology), then scored and clustered. Thirty candidates collapsed into six angles.
Only the angles are reproduced; scores are `[Novelty Viability Fit]`.

### A — One entity: `locations`, geometry optional on the row `[N4 V9 F9]` ★

A camp-scoped `locations` table (`id, camp_id, name, capacity, notes, sort_order`), a nullable
`activities.location_id`, and a **nullable** geometry field on the same row. A camp that never draws
a map has geometry NULL on every row and is taxed nothing. The map is a *view* over rows that already
exist for scheduling reasons.

*Key assumption:* a physical place and a schedulable location are the same thing in a summer camp,
and the "seasonal" cases are handled by other primitives the app already has.

### B — Two entities: physical space vs. schedulable location, with a mapping `[N7 V5 F6]`

A `places` table (permanent, physical) and a `location_seasons` / `location_availability` table
(everything mutable and seasonal), joined at scheduling time. The regulator frame pushed this to
three (place / bookable-slot-source / claim), arguing each merge point destroys a specific
provability guarantee.

*Key assumption:* the camp needs the physical record to survive changes to how a space is used —
i.e. that "what Room 201 was in 2025" is a question the app must answer.

*Rejected.* The third entity, "claim," already exists: it is `template_slots`. And the second
entity's whole justification is a season concept — **which this app does not have.** There is no
`season` or `year` anywhere in `electron/db/schema.sql`. A prior year is not live data; it arrives
as an imported *source document*. B would require inventing a season entity that would then apply to
groups, tiers, activities, and time blocks too — a redesign of the app's time model to solve a
locations problem. That is precisely the premature generality
`ARCHITECTURE_STANDARD.md` §9 forbids.

### C — Background facility image + structured overlays `[N5 V7 F7]`

A facility photo or site plan as a background, with rectangles as a separate overlay table
referencing location ids. Inversion and biology frames both independently produced the same
constraint: *the dependency arrow must run one way* — geometry points at locations, locations carry
no reference to geometry, so pixel-blindness is structural rather than a convention people can
forget.

*Assessment:* this is not an alternative to A — it is A's map layer, and its one-way-arrow
discipline is worth adopting. Whether geometry lives in a separate table or as a nullable field on
the location row is decided in §8 on sync grounds, not ontological ones. The trap variant, which
several frames produced, is *"rectangles carry a label string and render by string equality"* — that
perpetuates the exact identity bug this whole initiative exists to fix.

### D — Time-versioned locations: leases, effective_from/to, or an append-only fact log `[N8 V3 F4]` — TRAP

Every frame reached for a time dimension: date-bounded lease rows, `available_from`/`available_until`
columns, or an append-only location fact log whose current state is a derived projection.

*Trap, for two reasons.* First, date ranges are a **second time model** parallel to the one the app
already has. Shoresh's time axis is `schedule_weeks` (v27) and cohort session-week ranges — not
calendar dates. Adding `effective_from`/`effective_to` means two answers to "when," which will
disagree. Second, the append-only fact log is a **re-implementation of the op log inside the domain
model**. `operations` already gives append-only history, replay, and restore-from-trash for free
(`docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md`). Building a second one violates
the "do not invent a second sync architecture" constraint outright.

### E — No entity: controlled vocabulary, or an activity self-reference `[N6 V6 F3]` — TRAP

Keep the free-text column but validate it against a known set; or add
`activities.location_group_id` so two activities can declare "we share a space" without any place
existing.

*Trap.* It leaves capacity on the activity, so the §3.2 defect survives untouched — which is the
one thing that is definitely broken today. It also gives a headless CLI nothing to write: there is
no addressable place object, only a string convention.

### F — Hierarchy: `parent_location_id`, Upper/Lower as children `[N5 V8 F6]` — DEFER, do not preclude

Three frames independently produced self-reference for the field-splits case.

*Assessment:* correct eventually, unnecessary now. Containment only earns its keep when the parent
remains schedulable *while* the children are — i.e. when the engine must know that booking "Field"
consumes "Upper Field." If the director simply stops using "Field" and uses the two halves, two flat
rows are sufficient. Adding a nullable `parent_location_id` later is a one-column migration, so
choosing A now precludes nothing. This is owner question Q6.

### The synthesis none of the frames produced — and the actual answer to the ontology question

**"Unavailable part of the summer" does not need a time model. It needs the one the app already has.**

Schema v27 made weeks first-class (`schedule_weeks`,
`docs/adr/2026-08-02-schedule-weeks-first-class.md`). Schema v28 added
`week_activity_exclusions (id, week_id, activity_id)` and
`week_group_exclusions (id, week_id, group_id)` — an established, registered, replicated primitive
whose entire meaning is *"this thing does not apply during this week"*
(`electron/db/schema.sql:550-561`, `electron/ops/projections.js:205-226`).

"The lake is closed for weeks 1 and 2" is `week_location_exclusions (id, week_id, location_id)` —
the third instance of a pattern that already exists twice, in the vocabulary a director already
uses. It requires no dates, no seasons, no versioning, and no second entity.

**So: can one entity honestly carry physical-place, schedulable-location, and seasonal-configuration?
Yes — because the third is not a property of the entity at all.** Working the handoff's own cases:

| Case | Handled by | Needs a second entity? |
|---|---|---|
| Two activities share one space | `locations.capacity` — one number, one place, order-independent | **No.** This is the case that *demands* the entity |
| A space is unavailable part of the summer | `week_location_exclusions`, reusing the v28 primitive | **No** |
| A temporary archery range | An ordinary location row, created and later deleted (Trash + restore-from-op-log already exist) | **No** |
| A field splits into Upper/Lower | Two rows now; `parent_location_id` later **only if** the whole field stays schedulable (Q6) | **No** at M1 |
| Room 201 changes use between summers | "Use" is the `activities.location_id` binding, not a property of the room. Re-point the activities. The app has no season concept, and inventing one to answer this is a redesign of the time model (Q3) | **No** — and this case is out of scope until the owner says summers are a thing Shoresh knows about |

---

## 7. Tradeoffs, in operational consequences

Stated as what a camp director would actually experience.

**Choosing A (one entity) over B (two entities)**
- *You get:* one list called "Locations." You add "Pool," say four groups fit, and you are done.
  Nothing asks you to distinguish a building from a bookable space.
- *You give up:* Shoresh will not remember what a room *used to be for*. If you re-point Arts from
  Room 201 to the Barn, the app knows Arts is now in the Barn; it does not keep a record that Room
  201 was the arts room in 2025.
- *If that turns out to matter:* it is a real migration, not a small one. That is why it is owner
  question Q3, asked before the ADR rather than after.

**Making capacity a property of the place**
- *You get:* "how many groups fit at the Pool" is answered once, in one place, and every activity at
  the Pool respects it. Today the answer depends on which activity the computer happened to place
  first — which is why you can currently end up with three groups at a pool you told Shoresh holds
  one.
- *You give up:* nothing you have deliberately set. But some existing camps' generated weeks **will
  change**, because a place with no stated capacity currently means "unlimited" and will start
  meaning "one at a time." That is Q2, and it must be told to the director in plain words, not
  discovered.

**Reusing weeks for "closed part of the summer" instead of dates**
- *You get:* it works exactly like excluding an activity or a group from a week, which you already
  do. No new calendar, no date pickers.
- *You give up:* you cannot say "the lake is closed Tuesday the 14th only." The smallest unit is a
  week. If mid-week closures are common, that is a real limitation and Q4 asks about it.

**Making the map optional rather than central**
- *You get:* a camp that only wants a list of named places is never asked to draw anything. Every
  scheduling behaviour works identically with zero map.
- *You give up:* the map cannot be the place you *define* locations — you name them in a list first,
  then optionally position them. Slightly less magical; the alternative makes a drawing tool a
  prerequisite for scheduling, which the constraints forbid.

**Doing the domain model before the map**
- *You get:* the broken capacity behaviour is fixed in the first slice, and every later slice
  (import, export, map) builds on a real entity.
- *You give up:* nothing visible for a while. The first slice ships no new screen.

---

## 8. Recommended minimum architecture

**Recommendation: Approach A — one `locations` entity, camp-scoped, with capacity as a property of
the place, week-scoped exclusions for availability, and nullable geometry reserved on the same row.
The map is a later, optional view over rows that already exist.**

**Confidence: high** on the entity shape, capacity placement, and the week-exclusion mechanism.
**Medium** on the geometry storage decision (§10), which is the one piece with a genuinely close
call. **Low confidence is confined to the product questions in §13**, which is why they are asked
rather than assumed.

*Evidence behind it:* the deterministic engine probe in §3.2 (capacity is provably order-dependent
today); the absence of any season or date concept in `electron/db/schema.sql` (which removes B's
justification); the existence of `week_activity_exclusions`/`week_group_exclusions` as a working,
registered, replicated precedent for exactly the availability semantics required; and the standing
sketch in `2026-08-10-ingestion-reconciliation-semantics.md` D7, which anticipated this shape.

### 8.1 Schema (v32)

```sql
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,   -- how many GROUPS fit here at once
  notes TEXT,
  sort_order INTEGER,
  map_geometry TEXT,                     -- nullable JSON {x,y,w,h}, fractions 0..1; NULL = not placed on a map
  UNIQUE(camp_id, name)
);

ALTER TABLE activities ADD COLUMN location_id TEXT;   -- nullable, no DB-level FK (matches weather_alternative_id precedent)

CREATE TABLE IF NOT EXISTS week_location_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  location_id TEXT NOT NULL
);
```

Per `electron/db/schema.sql:21-33`, indexes on ALTER-added columns go in `localDb.js`, not
`schema.sql`. DDL follows the v30/v31 both-places pattern: an exported byte-identical constant in
`localDb.js` plus the same text in `schema.sql`, with a fresh-vs-migrated equivalence test
(`sourceAliases.migration.test.js:85` is the template).

**Deviation from the D7 sketch, and why.** D7 sketched the table as `activity_locations`. I recommend
`locations`. `activity_locations` reads as a join table between activities and locations; the entity
is a place, and places will later be referenced by things that are not activities (fixed events, and
eventually staffing). Naming it for its first consumer would need renaming at the second. This
deviation should be recorded in the ADR that amends D7.

### 8.2 The core architectural statement

> **One column is currently trying to answer two different questions at one key. Split the questions;
> give each its own home and its own key.**

- **"How many groups fit in this place at once?"** → `locations.capacity`, checked against the
  shared per-`(location, day, block)` occupancy pool. This is the fix for §3.2 (i), (ii), and (iii):
  one place has one number, `NOT NULL DEFAULT 1` removes the null/zero holes, and enforcement stops
  depending on placement order.
- **"How many groups can do this activity at once?"** → `activities.max_groups_per_slot`, checked
  per `(activity, day, block)` — which is exactly what `computeOverlaps.js:23` already does. This
  stays where it is; it is an instructor/equipment cap, not a place cap.

The engine checks both. They are not competing caps requiring a `min()`; they are different
constraints at different keys. `activities.max_groups_per_slot` stops being dead when no location is
set — today it does nothing at all in the engine unless `act.location` is truthy.

`same_tier_only` stays on `activities` and continues to be evaluated against location occupants, as
today. It is the activity's own rule about whom it will share a space with. Do **not** add a
location-level twin — two flags answering one question is the shape this recommendation exists to
remove. Note it as a known wrinkle for the ADR.

### 8.3 What this deliberately does not add

No `parent_location_id` (§6F, Q6). No `effective_from`/`effective_to`. No season entity. No
`locations.is_outdoor` (Q5). No second capacity flag. Each is a nullable-column migration away if
the owner's answers require it.

### 8.4 Registry checklist (every one of these is required; several fail silently)

Ordered by failure mode, worst first.

| # | Registry | File | Failure if omitted |
|---|---|---|---|
| 1 | `PROJECTIONS` | `electron/ops/projections.js` | **Writes append to the op log and are silently discarded** (`:453-454`). Has cost this project real debugging time twice — `ARCHITECTURE_STANDARD.md` §2 |
| 2 | `DIRECT_CAMP_ENTITIES` | `electron/ops/campScopedEntities.js:16` | `list()` throws `Unrecognized entity`; rows absent from first-pairing `full_sync` |
| 3 | `DOMAIN_SNAPSHOT_TABLES` + `DOMAIN_TABLE_COLUMNS` | `electron/sync/syncClient.js:32,52` | First-pairing clients never receive the rows (FK-safe order matters) |
| 4 | `ENTITIES` | `electron/auth/permissions.js:15` | **Silently admin-only** — staff cannot read or write locations. Not caught by any test (gap 16) |
| 5 | `RESTORE_DECISIONS` | `electron/ops/restore.js:18` | `restore.test.js:109` fails the build |
| 6 | `MOCK_WRITE_ALLOWLIST` + `UNIQUE_KEYS` | `src/localClient.mock.js:249,204` | `ipcSurfaceParity.test.js:280-315` fails; dev-mock diverges from the real path. **Hand-transcribed by design — do not import from `electron/`** (`mock.js:224-232`) |
| 7 | `PROJECTION_FIELD_EXCEPTIONS` | `electron/ops/projectionsCoverage.test.js:263` | The live-db column audit (`:784-837`) fails on any table column not in `fields` |
| 8 | `ENTITY_LABEL` | `src/screens/recordLabels.js:8` | Trash/history shows a raw table name |
| 9 | ingest registries (§4.4) | `ingest.js` / `extractEntities.js` / `confirmAlias.js` | Only needed when locations become ingestible (M4) |

**Not required:** `setupCrudRepository` (entity is a call argument, `src/data/setupCrudRepository.js:15-18`),
`preload.js`, `main.js` handler registration, the `operations`/`conflicts` schema, and the drag write
queue — all entity-generic.

The `projectionsCoverage` scanner has been blinded by persistence-seam refactors before (fixed in
PR #57 by teaching it new call shapes, never by lowering its floor). A new setup screen using
`createRecord`/`writeFields` is already a recognised pattern (`projectionsCoverage.test.js:490-507`),
so this should not recur — but verify rather than assume.

---

## 9. Migration implications

Every camp today has free-text location strings on activities. Schema v31 → v32.

### 9.1 Backfill

Deterministic, inside one `db.transaction()`, in the v32 block gated `>= 31 && < 32`:

1. `SELECT DISTINCT TRIM(location) FROM activities WHERE location IS NOT NULL AND TRIM(location) <> ''`
2. Insert one `locations` row per distinct trimmed value, `name` = the trimmed string,
   `sort_order` by name.
3. Seed capacity:
   `capacity = MAX(COALESCE(NULLIF(a.max_groups_per_slot, 0), 1))` over the activities that used
   that string — the most permissive **declared** value, with NULL and 0 read as 1 rather than as
   today's accidental "unlimited."
4. `UPDATE activities SET location_id = <row id>` by trimmed-string match.
5. Record, per location, whether its contributing activities disagreed about capacity.

### 9.2 Normalization and dedupe — what is *not* done automatically

**Dedupe on exact `TRIM` only. Do not case-fold, do not fuzzy-match, do not merge.**

`CONSTITUTION.md` Article V forbids silent merging. Folding `"Pool"` and `"pool"` into one row is an
irreversible merge of director-authored data performed by a migration the director never saw. `"Gym"`
and `"gym"` are almost certainly the same place; `"Field A"` and `"field a"` almost certainly are
too — but "almost certainly" is not the standard this repository holds itself to elsewhere.

Instead: surface near-duplicates as a **reviewable item on the Locations screen**, in the same shape
the reconciliation program already uses — *"Pool and pool look like the same place. Merge them?"* —
with an explicit merge action. Non-blocking, dismissible, reversible.

The same applies to disagreed capacity: *"Pool — Swim Lessons says 1 group, Free Swim says 3. How
many groups fit at the Pool?"* The migration picks the permissive value so nothing gets tighter
without consent, and asks. This is Q1.

### 9.3 What happens to a string that no longer matches

**`activities.location` is retained, kept in `PROJECTIONS.activities.fields`, and stops being
written.** Three reasons, and they are all load-bearing:

1. **Op-log replay must not break.** Historical ops carry `entity='activities', field='location'`.
   Removing the field from the projection allowlist would make `applyProjection` silently skip them
   (`projections.js:461`), so a full replay or a fresh Client's `full_sync` would reconstruct a
   different database than the one it replayed from. That is the worst possible outcome in this
   architecture.
2. **It is the rollback anchor** (§9.4).
3. **It costs nothing.** A frozen column that nothing reads is not a second source of truth; a column
   that something *writes* would be. Enforce that distinction with a test asserting no code path
   writes `activities.location` after v32, and a header comment on the column in `schema.sql`.

A string that no longer matches any activity is not a problem — the location row persists
independently. That is the point of an entity. Deleting a location that activities still point at
goes through the existing `previewDelete`/Trash flow
(`docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md`), which already handles this class.

**The export round-trip must move with the schema.** `exportWorkbook.js:55` and its `_shoresh_meta`
baseline must emit the location *name* resolved via `location_id`; `workbookToSource.js:99-155` must
resolve a name back to a row, and the `<clear>` sentinel path (`workbookToSource.test.js:75-81`) must
keep clearing the binding. All string cells continue through `aoaToSanitizedSheet`
(`docs/adr/2026-08-08-export-formula-injection-sanitizer.md`) — a location named `=cmd` is a real
input and the shared boundary already covers it.

### 9.4 Rollback

`electron/db/rollback/v32_down.js`, following the `v30_down.js`/`v31_down.js` precedent:

1. `UPDATE activities SET location = (SELECT name FROM locations WHERE id = activities.location_id) WHERE location_id IS NOT NULL`
   — repopulate the frozen column from the entity, so **rollback is lossless for location names**,
   including names created or renamed after the upgrade.
2. Drop `week_location_exclusions`, `locations`, and `activities.location_id`.
3. Delete the v32 row from `schema_migrations`.

**Disclosed rollback losses:** per-location capacity, geometry, week exclusions, and any merge
decisions. Names survive; structure does not. This is inherent to rolling back a
structure-introducing migration and should be stated in the ADR rather than discovered.

### 9.5 Fresh-vs-migrated equivalence — mandatory

`electron/db/schema.sql:1-33` states plainly that it is base schema only and that `localDb.js`
migrations are authoritative. Five existing tests assert fresh/migrated `PRAGMA table_info`
equivalence (`localDb.migrations.test.js:496-548`, `:1234-1275`;
`sourceAliases.migration.test.js:85`; `importEvidence.migration.test.js:102`;
`pendingRestores.migration.test.js:89`), plus idempotency twins.

v32 needs the same pair. **Column order is the trap**, and this repo has been bitten by it once
already: `operations.source` was deliberately kept out of the `CREATE TABLE` (`schema.sql:148-164`)
because declaring it would place it *before* `host_seq` on a fresh install and *after* on a migrated
one. `activities.location_id` is ALTER-added and must therefore go **last** in the `activities`
column order on a fresh install too — or it must be omitted from `schema.sql`'s `CREATE TABLE` with
the same recorded reasoning. Decide this explicitly in the ADR; do not leave it to the Maker.

---

## 10. Sync implications

**Constraint honoured: there is exactly one sync architecture here, and this adds nothing to it.**

### 10.1 Location rows

`locations` and `week_location_exclusions` are ordinary camp-scoped replicated entities. Field-level
ops, `client_write_id` idempotency, conflicts recorded in `conflicts` and resolved explicitly —
`ARCHITECTURE_STANDARD.md` §2 unchanged. `week_location_exclusions` is the third instance of a shape
that already works twice (`projections.js:205-226`), including its `ensureExists` gated on the
parent key.

Nothing about locations is host-local. The `source_aliases` precedent
(`docs/adr/2026-08-09-s1b-host-local-aliases.md`) explicitly justifies host-local by there being
**one writer, one reader, one copy** — import is already host-only and admin-only, so divergence is
structurally impossible. Locations have none of those properties: they are camp domain data any
authorized device may edit. Making them host-local would be misapplying that precedent.

### 10.2 Does moving a box on a map generate an op per drag?

**No. One op per gesture, on release.**

The precedent is directly on point.
`docs/adr/2026-08-12-drag-live-write-serialization.md` records that the token-only v1 was **reversed
by a Red Hat pass** because it fired `repo.writeSlotFields` unconditionally before any recency check
— and since op replay is seq/arrival-ordered, a slower older gesture could land at a higher seq and
become the value every peer converged on, diverging screen from database with no visible symptom
until reload.

The shipped mechanism is a per-cell write queue: `cellQueueRef` (`useSlotMutations.js:119`), keyed
`` `${route}|${templateId}|${groupId}|${dayId}|${blockId}` ``, with `claimAndRun` (`:154-170`)
chaining on prior tails and dropping superseded claims. The map takes the same shape, keyed by
`location.id`:

- **No write during pointer-move.** Position is renderer state until the gesture ends.
- **One write on release**, carrying a `gestureId`, serialized per location id through the same
  claim-and-run pattern.
- **Do not extract a shared abstraction** between the schedule grid and the map on the first pass —
  two similar call sites beat a generalized helper built for a third case that does not exist
  (`ARCHITECTURE_STANDARD.md` §9). Copy the pattern, cite the ADR.
- **Do not reintroduce a queue clear.** `useSlotMutations.js:99-118` records that a clear-on-route-
  switch revision reopened the exact race it fixed, and ends *"Do NOT reintroduce a clear-on-route-
  switch here."*

### 10.3 Does geometry belong in the op log at all?

**Yes — and as ONE field, not four.**

Geometry is camp domain data that a headless CLI must be able to read and write, so it cannot be
renderer-only or a serialized canvas blob. It is not host-local: unlike aliases and evidence, there
is no single-writer property to lean on.

The genuinely close call is **one JSON field versus four columns**, and it is decided by conflict
semantics, not by taste:

- **Four columns (`x`, `y`, `w`, `h`)** — ops are field-level, so two directors dragging the same box
  produce independent per-field conflicts. Resolving them independently can yield a rectangle at one
  device's `x` and the other's `y`: **a box in a place neither director put it.** That is the same
  class of silent divergence the drag ADR's v1 reversal was about.
- **One `map_geometry TEXT` column holding `{"x":…,"y":…,"w":…,"h":…}`** — the rectangle is atomic.
  One op per gesture. A conflict is a whole-rectangle conflict, which is the only kind a director can
  actually reason about, and it lands in `conflicts` for explicit resolution like everything else.

JSON-in-a-column is established here (`template_slots.flags`, `import_evidence.support`,
`schedule_snapshots.slots`). The engine-purity constraint is unaffected: `buildSchedule.js` never
reads geometry, and after T69 it contains no `JSON.parse` — parsing happens at the IPC read boundary
as `ARCHITECTURE_STANDARD.md` §8 and `useScheduleData.js:117-122` establish.

**Coordinates are fractions of the background image (0..1), not pixels.** Replacing the site plan at
a different resolution then does not move every box. This is not a coordinate system in the GIS
sense — it is four numbers between zero and one.

### 10.4 The background image — the one place I recommend host-local, and it is deferred

Recommendation for M6, **not decided now**: the facility image is a **host-local asset** — a file in
userData plus a host-local row — following `host_signing_key` / `source_aliases` / `import_evidence`
(`schema.sql:104-107`, `:124-146`).

*Why:* the op log is a field-level text-op log that a fresh Client replays in full at first pairing.
A multi-megabyte base64 value in one op row is not what it is for, and it would be replayed on every
`full_sync`.

*Operational consequence, and it is real:* the map renders on the Host only. Geometry still syncs, so
a Client has every location and every rectangle — it just has no picture to draw them on, and
degrades to the named-location list, which is the zero-map state that must work anyway. Whether that
is acceptable is **Q7**, and it is a product question, not a technical one. The alternative — sync
the image once as a size-capped op after downscaling — is viable and should be reconsidered at M6
with the owner's answer in hand.

---

## 11. Proposed ticket decomposition

The handoff sketched M0–M6 and invited revision. Two changes, both grounded in §0 and §3:

- **M1 is renamed.** "Location model corrections" → **"Location model creation."** There is nothing
  to correct; there is no model.
- **The engine fix is pulled forward into its own early slice.** The handoff implied it followed the
  schema work. It is the only *live defect* in this initiative and it should not wait behind
  screens.

| Slice | Scope | Gate notes |
|---|---|---|
| **M1 — Create the entity** | Schema v32 (`locations`, `activities.location_id`, `week_location_exclusions`), backfill, `v32_down.js`, all nine registries in §8.4, mock parity. **No UI.** | Red Hat mandatory (stored shape + migration + op log). Fresh-vs-migrated equivalence test + idempotency twin. Integration scenario for first-pairing `full_sync` of the new tables |
| **M2 — Fix place capacity in the engine** | Characterization tests **first** for the §3.2 cases (they do not exist today). Then: engine reads `locations.capacity` at the location key; `activities.max_groups_per_slot` moves to a per-activity key; null/zero holes closed. Re-key `computeOverlaps` by location so the manual route stops being place-blind | Test-first is non-negotiable — this changes generated output. Determinism preserved (`ARCHITECTURE_STANDARD.md` §8). Disclose the behavior change (Q2) |
| **M3 — Locations setup screen** | 8th setup entity on `setupCrudRepository`. Name, capacity, notes. Near-duplicate review and capacity-disagreement review from the M1 backfill. Activities' location input becomes a picker (create-new inline). Promote `location` out of `FORWARD_AREAS` into `OPTIONAL_AREAS` with a `COLLECTION_FOR` binding — never `REQUIRED_AREAS`. Fixes the dead Review button (gap 14) | Designer required. Verify whether `useCrudScreen` fits or repository-only is right — the ADR flags this as unproven for an 8th screen |
| **M4 — Import/export round-trip** | Export emits location *name*; re-import resolves name → row. Locations join `INGESTIBLE_ENTITIES` + the alias registries (§4.4) and `EVIDENCE_ENTITY_TYPES`. Parser stops silently discarding recognised room text and proposes it as a reviewable `observed` location — **subject to Q8** | Do not redesign the ingestion UI. Reuse the fixed-event reviewable-unit pattern |
| **M5 — Week-scoped availability** | "The lake is closed weeks 1–2" via `week_location_exclusions`, using the existing week-exclusion UI shape. Engine honours it | Small if M1 landed the table. **Subject to Q4** |
| **M6 — The optional map** | Background image (host-local, Q7), `map_geometry` as one JSON field, drag-to-position with commit-on-release serialized per location id. A camp with no map is unaffected in every respect | Only after M1–M3. Red Hat on the write path, citing the drag ADR |
| **Deferred, not scheduled** | `parent_location_id` containment (Q6); `is_outdoor` on the place (Q5); staffing; any season concept (Q3) | Each is a nullable-column migration away |

**Separate from this initiative:** gap 16 (`permissions.ENTITIES` drift) is a pre-existing defect
found in passing. It should be its own ticket, not folded in here — but M1 must remember to add
`locations` to that list, since no test will catch its absence.

---

## 12. Explicit non-goals

Deliberately not built, at any milestone in this plan:

1. **No GIS.** No coordinate reference systems, no projections, no latitude/longitude, no map tiles.
2. **No pathfinding, routing, or travel-time.** The engine will not know that the Lake is far from
   the Barn, and will not try to minimise walking.
3. **No CAD.** No polygons, no rotation, no snapping, no layers, no measurement, no floor plans, no
   multi-storey buildings. Rectangles only.
4. **No general-purpose drawing engine.** If the design ever requires one, that is a stop condition,
   not a feature.
5. **No cloud, no external map provider, no internet requirement.** Local-first throughout.
6. **No season or year entity.** Not in this initiative. If the owner needs one (Q3), it is a
   separate program affecting the whole time model.
7. **No calendar dates for availability.** Weeks are the unit.
8. **No map dependency anywhere.** Not in scheduling, not in ingestion, not in export, not in
   readiness. A camp with zero map drawn loses no capability except seeing a picture.
9. **No domain state in the renderer or in a serialized canvas blob.** Every spatial fact is a row a
   headless CLI can read and write.
10. **No location inference written without director review.** A parser may propose; only a human
    confirms.
11. **No location hierarchy in M1–M6.**
12. **No engine rewrite.** `buildSchedule.js` stays a pure, seeded, deterministic function; this
    changes which value it reads at an existing check, not its structure.
13. **No second sync architecture.** No new replication path, no new conflict mechanism, no
    domain-level event log.

---

## 13. Unresolved decisions requiring the product owner's judgement

Product questions with operational consequences. **The ADR should not be filed until Q1–Q5 are
answered** — Q6–Q8 can be answered later without changing the M1 schema.

**Q1 — Capacity disagreements found during migration.**
Some camps will have two activities at one place declaring different numbers of groups. The
migration keeps the more permissive number and puts a question on the Locations screen. Do you want
to be asked, or should Shoresh just take the permissive number and stay quiet?
*Consequence:* being asked means a short review list the first time you open Locations. Staying quiet
means some places may be more crowded than you intended and you will never be told.

**Q2 — Places with no stated capacity.**
Today a place with no number lets in unlimited groups. After this change the default is one group at
a time. Some generated weeks will place fewer groups than they used to.
*Consequence:* if we grandfather existing camps to "unlimited," the bug survives for them
indefinitely and the two behaviours diverge. If we do not, a director may regenerate and find their
week has changed. Either way the app must say so in plain words before regenerating.

**Q3 — Does Shoresh know what a summer is?**
"Room 201 is the arts room this summer and the drama room next summer." Is a summer something the app
should track, or is next summer a fresh setup?
*Consequence:* this is the single biggest fork in this document. Shoresh has no concept of a season
or a year anywhere today. If summers become a thing the app knows about, that affects groups, units,
days, activities, and time blocks — not just locations — and it is a separate program. If they do
not, "changing use" simply means re-pointing activities at a different place, which needs nothing new.

**Q4 — How precisely do you need to say a place is closed?**
"The lake is closed weeks 1 and 2" versus "the lake is closed Tuesday the 14th."
*Consequence:* per-week reuses machinery that already exists and works. Per-date requires a calendar
the app does not have, and a second answer to "when," which will eventually disagree with the first.

**Q5 — Is "outdoor" about the place or the activity?**
Today it is on the activity and drives Weather Mode's highlight.
*Consequence:* if it belongs to the place, Weather Mode gets more accurate for free (a place is
outdoors regardless of what is happening in it) but every existing activity's setting must be
re-derived. If it belongs to the activity, nothing changes and a picnic in the gym stays marked
outdoors.

**Q6 — When a field splits into Upper and Lower, does anything still happen on the whole field?**
*Consequence:* if yes, Shoresh must understand that booking the whole field uses up both halves —
that is real machinery. If no, Upper and Lower are simply two places in the list and nothing extra is
needed.

**Q7 — Should the map be visible on staff tablets, or is it a director tool on the main computer?**
*Consequence:* the named places and their positions sync to every device either way. The background
picture is a large file; sending it over the camp network is a different piece of work. If tablets
only need the list, we skip that entirely.

**Q8 — When an imported schedule prints room numbers, what should Shoresh do?**
Today it recognises them and deliberately throws them away, so a room number never becomes a fake
activity.
*Consequence:* proposing them for your review means a longer import review the first time, and a
head start on your locations list. Continuing to ignore them means you type your places in once,
yourself.

---

## Appendix — divergence record

Approach candidates were generated by five isolated parallel branches under distinct cognitive
frames, per the `adhd` protocol, then scored, clustered into the six angles in §6, and converged.
Traps identified and rejected: time-versioned location rows (§6D — a second time model and a
domain-level re-implementation of the op log), controlled-vocabulary-only (§6E — leaves the live
capacity defect untouched), name-matched map rectangles (perpetuates string identity), and a
three-entity place/bookable/claim split (the "claim" entity already exists as `template_slots`).

The recommended synthesis — reusing `week_*_exclusions` for availability, which is what makes the
one-entity answer honest — was **not** produced by any frame. It came from repository evidence
(schema v27/v28) after divergence closed. That is consistent with the standing lesson in
`feedback_reference_research_before_divergence`: frames widen the answer space, but they do not know
what is already in the building.

---

## Post-review addendum — Red Hat findings (2026-08-15, appended by Governor)

The recommendation was put through an adversarial pass against the eight vectors the handoff named.
**It survived: the one-entity shape, capacity-on-the-place, the `week_location_exclusions` reuse,
the JSON geometry field, the frozen `activities.location` column, and the "scheduling stays optional"
and "`is_outdoor` deferral is clean" claims were all confirmed against the code, not merely left
un-attacked.** Three defects were found. None overturns the recommendation; all three become
**invariants the ADR must state before any code is written**, and they are engineering invariants,
not product questions — the owner is not asked about them.

**INV-1 (blocks the ADR) — the backfill row id must be deterministic and device-identical.**
Each device runs its own local v32 migration; the backfill emits no op (it is a DDL-time side effect,
like v30/v31). If the `locations.id` were `randomUUID()` (the codebase's default instinct,
`operations.js:100`) or `${deviceId}`-scoped (the only row-creating precedent, v26 at
`localDb.js:1161`), an already-paired Host and its tablets would mint *different* ids for the same
"Pool". The director's later `capacity` edit is an op targeting the Host's id; on every tablet it
matches zero rows or spawns an orphan, and the capacity is silently unenforced everywhere but the
Host — the exact double-booking defect this initiative exists to remove, now invisible.
*Required:* `locations.id` derived only from replicated inputs (`camp_id` + normalized `name`),
backfill emits no op, guarded by a two-db cross-device migration test asserting identical
`locations.id` and `activities.location_id` from identical pre-state. This is the single most
important addition.

**INV-2 (ADR note + M1) — restore must re-resolve `location_id` from the frozen string.**
`location_id` is a migration side effect that exists nowhere in the op log, so restoring a
pre-v32 activity from Trash (`restore.js:84-96`) re-emits the frozen `location` string and leaves
`location_id` NULL — silently un-binding the activity from its place. The frozen column is the right
call; the assessment reached it via the wrong mechanism (it cited fresh-client full_sync, which is a
snapshot and never replays these ops — restore is the path that does). Keeping the column is
necessary but not sufficient: restore must additionally resolve the string back to a row.

**INV-3 (ADR note + M1) — both new entities enter `permissions.ENTITIES`, and gap 16 should be
fixed first.** `week_activity_exclusions` — the natural template to copy — is itself missing from
`permissions.ENTITIES` (gap 16), so copying it reproduces the silent admin-only defect for
`week_location_exclusions`. M1 adds **both** `locations` and `week_location_exclusions`; fixing gap 16
first makes the copied template correct.

**Two migration sharpenings folded into the owner questions:**
- The null→1 tightening raises a review flag only when activities *disagree* about capacity. The
  highest-impact case — a place that was effectively *unlimited* (all-null caps) becoming 1 — has no
  disagreement and therefore no flag. The migration must flag "was effectively unlimited, now capped
  at 1" too. Folded into **Q2**.
- `TRIM`-only dedupe leaves "Pool"/"pool" as two rows with independent capacity pools. This is not a
  regression (the engine string-keys today), but post-migration `capacity` becomes a *trusted,
  director-set* number the engine will under-enforce across the split. The near-duplicate merge review
  must be impossible to miss and presented at/before first regeneration, not as dismissible chrome.
  Folded into **Q1**.

**Deferred to M6 with geometry (Maker/Designer note, not a blocker):** the conflict-resolution UI
would render a raw geometry JSON blob (`{"x":…,"y":…}`) a director cannot reason about; and a
`locations`/`location_id` snapshot is only coherent once the whole fleet is on v32 (staggered-update
version skew silently drops the column on a v31 receiver — the version-skew variant of the
already-named registry-#3 discard mode).

Resilience score for Grader: **3/5** — sound architecture, four of eight vectors clean, but a silent
cross-device migration hole that the assessment's own framing mislocated. All three defects are
fixable with ADR-level invariants before a line of code; proceed once they are written in.
