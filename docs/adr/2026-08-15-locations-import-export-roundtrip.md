---
title: "ADR: Locations import/export round-trip — ingest resolve-or-create, provenance, Q8 propose (M4)"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-15
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_specs: []
related_adrs:
  - docs/adr/2026-08-15-camp-locations-entity.md
  - docs/adr/2026-08-15-locations-concurrent-create-collision.md
  - docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
  - docs/adr/2026-08-10-ingestion-reconciliation-semantics.md
  - docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md
  - docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md
  - docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md
  - docs/adr/2026-08-09-s1b-host-local-aliases.md
  - docs/adr/2026-08-10-ingestion-evidence-persistence.md
  - docs/adr/2026-08-08-export-formula-injection-sanitizer.md
supersedes: []
affects:
  - docs/adr/2026-08-15-camp-locations-entity.md
---

# ADR: Locations import/export round-trip (M4)

**Status: PROPOSED.** This ADR **amends** the parent v32 ADR's M4 row (`docs/adr/2026-08-15-camp-locations-entity.md`, "Export round-trip moves with the schema" + ticket table row M4) with the concrete design. It does not re-decide the one-entity model, capacity-on-place, or any other settled v32 decision. Owner decision Q8 = **PROPOSE** (recorded in the parent ADR's open questions) is the one product input this document consumes; everything else below is a technical design.

## Context

M1–M3c shipped the `locations` entity, engine enforcement, the setup screen, and the concurrent-create/merge machinery. Ingest (`electron/ops/ingest.js`, `src/ingest/buildPlan.js`, `src/ingest/fieldUpdate.js`) has **zero `location_id` references** — it still writes free-text `activities.location` wherever a location value flows through it today (only the S4 enrichment-workbook re-import path actually populates that field; the raw schedule-grid parser currently **discards** recognized room text entirely, in `textGrid.js`'s `stripLocations` behavior). Export (`exportWorkbook.js`) emits that same free-text value verbatim. None of this binds `location_id`, so a place a director assigns does not survive export→edit→re-import, and a hand-set location is not protected from a re-import's stale value the way every other hand-edited field already is.

## Candidate approaches considered

The overall shape (ingest resolves place names against the `locations` table; export/re-import round-trips the name; Q8 reuses the existing reviewable-tick mechanism) is fixed by the run brief and the parent ADR's own forward note (D7 amendment: "a future `locations` ingestible type grows at `source_aliases.entity_type` / `INGESTIBLE_ENTITIES`"). The one genuinely open structural question is **where location resolution lives relative to the six existing ingestible entities** — three real candidates:

- **A — `locations` becomes a genuine 7th `INGESTIBLE_ENTITIES` member, reusing buildPlan/commitPlan's ordinary create/unchanged machinery, with one explicit deviation (case-sensitive recognition + deterministic id minting). ★ CHOSEN.** Reuses the most existing machinery: `buildExistingSnapshot`'s per-entity scan, `seedRecognitionMaps`, `ALIAS_ENTITY_TABLE`/`confirmAlias` (already gated by `INGESTIBLE_ENTITIES`), and — the deciding factor — ImportScreen's **existing generic tick-list UI** (`chosen[entity]`, seeded from `INGESTIBLE_ENTITIES` at `ImportScreen.jsx:347`), so Q8's "reviewable, ticked, one-click-reversible" proposal needs no new UI component. The ordering guarantee (locations before activities) falls out of `INGESTIBLE_ENTITIES`' existing array order for free — no bespoke scheduling code.
- **B — A dedicated side-payload, structurally parallel to `fixedEvents`/`activityRules` (never a key in `approved`, its own resolve/write loop).** *Rejected.* This is architecturally closer to what "the fixed-event reviewable-unit pattern" evokes literally, but fixed events need a bespoke payload because they fan out per-day with a non-entity identity (`anchorSlotKey`) that has no analogue here — a location is just a name, exactly the shape the six existing entities already handle. Choosing B would mean either building a **second** tick-list UI (the "do not redesign the ingestion UI" constraint cuts against this) or awkwardly wiring `approved.locations` into ImportScreen anyway while keeping the entity machinery separate — two mechanisms answering the same question. Also fails the run brief's own registry checklist, which names `INGESTIBLE_ENTITIES`/`ALIAS_ENTITY_TABLE` as things locations must **join**.
- **C — Pure commit-time side resolution only (no plan item at all): a `locationIdByName` map exactly like `tierIdByName`/`groupIdByName`, with Q8's proposal UI writing directly into `activityRules[name].location` and nothing else.** *Rejected.* This makes location creation invisible to `buildExistingSnapshot`/recognition entirely — a location proposed and approved in one import round would not be **recognized** on the very next import of the same file (every location would either re-resolve by luck against the live table or, worse, need its own bespoke recognition scan duplicated outside buildPlan). It also gives Q8 no natural "this is a create, tick it" review row — the tick-list would have to be invented from scratch for locations only, which is the parallel-mechanism problem C1 above rejects, just relocated.

Candidate A costs one deliberate, narrow deviation (D3 below) inside otherwise-shared machinery; candidates B and C each cost a **second parallel mechanism** somewhere in the pipeline. A is the smallest responsible choice.

## Decision

### D1 — Host-side resolve-or-create: two distinct resolution rules, not one

There are **two different places** `location` resolves to `location_id`, and they behave differently on purpose — this mirrors the existing split between a `tiers`/`groups` **entity create** (which mints a new row) and an activity's `unit` **field resolution** (which only ever looks up, never mints — `resolveFieldWrite('unit', ...)` holds `unit_unresolved` rather than auto-creating a tier).

**D1a — `locations` entity create (new row).** When a `locations` plan item is `op:'create'` (a name buildPlan's recognition — D3 below — found no live row for), `commitCreate` mints its id via **`deriveLocationId(camp_id, trimmedName)`**, never `crypto.randomUUID()` — the one line that differs from every other entity's `commitCreate` branch (`electron/ops/ingest.js:819`, `const entityId = randomUUID()`, becomes `entity === 'locations' ? deriveLocationId(camp_id, name) : randomUUID()`). `name` here is already the buildPlan-trimmed value (`buildPlan.js:183`, `String(record?.name ?? '').trim()`), matching `deriveLocationId`'s own normalization contract (TRIM-only, case-sensitive — `locationId.js`'s header comment) exactly. `fieldsFor('locations', name, campId, ...)` (new `buildPlan.js` case) returns `{ camp_id: campId, name }` only — capacity/notes/sort_order/map_geometry are left to the schema's `NOT NULL DEFAULT 1` / nullable defaults, matching every other bare-minimum entity create (`cohorts`).

**D1b — an `activities.location` field resolving to `location_id` (existing activity, or a location referenced but never separately proposed as its own create).** This is `resolveFieldWrite('location', rawTo, { locationIdByName })` (new branch in `src/ingest/fieldUpdate.js`, the shared, **pure** helper): a lookup **only** — `locationIdByName.get(String(rawTo).trim())` (exact, case-sensitive key). Not found → `{ ok:false, reason:'location_unresolved', detail:{ unresolved:[rawTo] } }`, held exactly like `unit_unresolved` (`commitPlan`'s accepted-conflict-reason allowlist, `ingest.js:1098`, gains `'location_unresolved'`). This function stays pure — it cannot mint a row itself, and it deliberately doesn't try to.

**Why D1b never mints, and D1a's ordering makes that safe in the common case.** Because `locations` precedes `activities` in `INGESTIBLE_ENTITIES` (D2 below), any location a director actually **approved as a create in this same import** (Q8's own gated flow, or an ordinary new-camp import) is already a live row — and already in `locationIdByName` — by the time any activity's field resolution runs. `resolveFieldWrite`'s lookup-only design for D1b is therefore not a gap for the common path; it is the same, already-proven-safe pattern `unit` uses, kept pure and DB-agnostic on purpose (this function is shared verbatim with `src/localClient.mock.js`, which has no DB to write to).

**D1c — the one place an activity's location genuinely needs resolve-**or**-create inline: a brand-new activity created via `commitCreate`, whose `location` value was never separately proposed as its own `locations` entity item.** This is the S4 enrichment-workbook path's real shape (§D4): a director types a room name directly into an editable `location` cell with no corresponding "Locations" sheet or review row at all. For this one call site — `commitCreate`'s new `entity === 'activities'` location branch — a **new, impure, DB-aware** helper does the resolve-or-create:

```js
// electron/ops/ingest.js, new helper, called only from commitCreate's activities branch
function resolveOrCreateLocationId(db, { camp_id, name, locationIdByName, author_user_id, device_id }) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return null
  const cached = locationIdByName.get(trimmed)
  if (cached) return cached
  const id = deriveLocationId(camp_id, trimmed)
  if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id)) {
    appendOp(db, { entity: 'locations', entity_id: id, field: 'camp_id', value: camp_id, author_user_id, device_id, parent_op_id: null, client_write_id: randomUUID(), source: IMPORT_SOURCE })
    appendOp(db, { entity: 'locations', entity_id: id, field: 'name', value: trimmed, author_user_id, device_id, parent_op_id: null, client_write_id: randomUUID(), source: IMPORT_SOURCE })
  }
  locationIdByName.set(trimmed, id)
  return id
}
```

Called from `commitCreate`'s new `if (entity === 'activities') { if (fields.location) { fields.location_id = resolveOrCreateLocationId(db, { camp_id, name: fields.location, locationIdByName, author_user_id, device_id }); delete fields.location } }`. This is genuinely a **create** (a brand-new activity is being minted this same transaction; there is no live activity row whose hand-set location this could clobber), so silently minting a not-yet-seen room name is the same posture the `unit`/tier auto-mint-from-typed-text precedent already established for a director-typed value in an editable review column (`docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md` Decision 2, "a typed unit name that matches no existing/proposed tier is unioned into `approved.tiers` at commit time").

**Q8's own "propose, never auto-create" constraint is enforced one layer up, not here.** ImportScreen (renderer) only ever includes `fields.location = <name>` on a schedule-grid-parsed activity's record when that exact name is present in the director's **ticked** `chosen.locations` set (§D5) — so `resolveOrCreateLocationId`'s mint branch is reachable from Q8-sourced text **only after** the director has approved that name, at which point D1a's own create has already run first (same-import ordering) and the mint branch is a cache hit, not an actual create. The mint branch's real, load-bearing job is the S4 workbook path, where no separate proposal step exists and the value is already a director-typed, reviewed string — see D4.

**Cross-device determinism (INV-1 compliance).** `deriveLocationId` is a pure function of `(camp_id, trimmedName)` — both `D1a` and `D1c` compute the same id for the same name on any device that runs the same import against the same pre-state, exactly mirroring `restore.js`'s INV-2 rebind (`electron/ops/restore.js:234-243`). Neither path ever calls `crypto.randomUUID()` for a location.

**Confidence: high.** This is the smallest change that satisfies "resolve by exact name first, reusing any existing row; mint only when truly absent, via `deriveLocationId`" — it is a narrow generalization of the `tiers`-create / `unit`-resolve split that already exists in this exact file, not a new resolution shape.

### D2 — Ordering: entity-array position, not bespoke scheduling code

`locations` is inserted into **both** `INGESTIBLE_ENTITIES` arrays (`electron/ops/ingest.js:28-30` and `src/ingest/extractEntities.js:22`) **immediately after `time_blocks`, before `activities`**:

```js
['cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities']
```

`ingest.test.js:40` already asserts the two arrays agree as **sets** (`[...INGESTIBLE_ENTITIES].sort()`), not order — order is each file's own concern, and both must place `locations` before `activities` for the reason below. `buildPlan` builds `plan.items` by iterating `INGESTIBLE_ENTITIES` in array order (`buildPlan.js:152`); `commitPlan` processes `toCreate` in `plan.items` order (`ingest.js:1120`, `for (const item of toCreate) commitCreate(item)`). Because entity iteration order places `locations` before `activities`, **every `locations` create in this commit runs, and populates `locationIdByName`, before any `activities` create runs** — the exact "create/resolve the location op BEFORE the activity's location_id op" ordering the run brief requires, obtained for free from an array position rather than new scheduling logic. This is the same mechanism that already orders `tiers` before `groups` (so a group's unit resolves against a tier created moments earlier in the same commit) — no new pattern, one more entry in an existing one.

**Replace mode: locations are explicitly excluded from `REPLACEABLE_ENTITIES` and are recognized in every mode, not just `add`.**

`REPLACEABLE_ENTITIES` (`ingest.js:40-42`) tears down `activities, groups, time_blocks, days_of_operation, tiers` — schedule **content** for one cohort's rebuild. `locations` are durable camp infrastructure, exactly like `cohorts` (also excluded, "never deleted — tiers and time_blocks reference it"): a "Pool" is real independent of which schedule references it, and a replace-mode re-import rebuilding one cohort's schedule must not delete or duplicate places another cohort's schedule also uses. **`locations` stays out of `REPLACEABLE_ENTITIES`.**

This creates a real hazard the parent ADR's own "Replace mode" note flags: `commitIngest`'s existing `const existing = mode === 'replace' ? null : buildExistingSnapshot(...)` (`ingest.js:474`) treats **every** entity as blind-create in replace mode, on the documented rationale that the pre-teardown rows are "about to be deleted anyway." That rationale is **false for locations**, which are never deleted by replace mode — a blind-create in replace mode would attempt to mint `deriveLocationId(camp_id, "Pool")` for an "Pool" that **still exists**, landing on a `PRIMARY KEY` collision path (`ensureExists`'s `INSERT OR IGNORE` no-ops, then the field UPDATEs silently overwrite the *existing* row's fields with whatever this import happens to propose — the exact "silent overwrite of a mutable-key row" failure mode `docs/adr/2026-08-15-locations-concurrent-create-collision.md`'s option (d) rejection already identified for a different reason).

**Fix — `buildExistingSnapshot` gains a mode-aware carve-out: `locations` is always scanned from the live DB; the six schedule-content entities are scanned only in `add` mode.**

```js
function buildExistingSnapshot(db, camp_id, cohort_id, mode) {
  const entitiesToScan = mode === 'replace' ? ['locations'] : INGESTIBLE_ENTITIES
  // ...same per-entity query loop, restricted to entitiesToScan...
  if (mode !== 'replace') existing.aliases = listAliasMap(db, camp_id, cohort_id)
  return existing
}
```

`commitIngest` calls `buildExistingSnapshot(db, camp_id, cohort_id, mode)` unconditionally (no more `mode === 'replace' ? null : ...` ternary). For the six original entities this is **behavior-preserving**: `existing[entity]` absent/`[]` in replace mode is exactly what `buildPlan`'s `Array.isArray(have[entity]) ? have[entity] : []` already treats as "nothing recognized," identical to today's `existing === null` path (`buildPlan.js` defaults `have = existing ?? {}` either way). For `locations`, replace mode now genuinely recognizes live rows — a re-import of the same cohort's file resolves "Pool" to the same existing row every time, in every mode.

**Confidence: high** that this is required (the PK-collision failure mode is real and traced against the actual `ensureExists` code); **medium-high** on the exact carve-out shape — Red Hat should confirm no other replace-mode assumption elsewhere in `commitPlan` implicitly relies on `existing` being either fully `null` or fully populated (a quick grep of `existing`/`have` inside `commitPlan`'s closure did not surface one, but this is exactly the kind of edge a targeted replace-mode-with-locations integration test should pin).

### D3 — Recognition must be case-sensitive/exact for `locations`, unlike every other entity

The six existing entities recognize a proposed name against the live snapshot via `normalizeName` (`src/ingest/preview.js:45-47` — trim, lowercase, collapse whitespace) — a proposed "art " matches a live "Art". This is **wrong for locations**: `deriveLocationId`'s id (and the `UNIQUE(camp_id, name)` constraint it's built to match) is **TRIM-only, case-sensitive** (INV-1, `docs/adr/2026-08-15-camp-locations-entity.md`) — "Pool" and "pool" are two legitimate rows the M3c merge gate can heal, not one entity two spellings of. If `locations` recognition case-folded like every other entity, a schedule-grid "pool" would silently resolve to an existing "Pool" row instead of proposing (or minting) a second one — **inconsistent with the migration's own dedupe key** and with M3c's stated premise that case variants are real, mergeable rows.

**Fix — one shared, exported recognition-key function, used everywhere a name becomes a lookup key for entity identity:**

```js
// src/ingest/preview.js, alongside normalizeName
export function recognitionKey(entity, name) {
  return entity === 'locations' ? String(name ?? '').trim() : normalizeName(name)
}
```

Every call site that currently builds a recognition map key or does a recognition lookup with `normalizeName(name)` switches to `recognitionKey(entity, name)`:

1. `buildPlan.js` — the `already` map build (`normalizeName(r.name)` at line 169) and every lookup against it (`normalizeName(name)` at lines 439, 446 and the `resolutionFor` key at line 148 — note `resolutionFor` keys on `entity` already, so this becomes `recognitionKey(entity, name)` there too).
2. `electron/ops/ingest.js` — `seedRecognitionMaps`'s `add(entity, normalizeName(row.name), row.id)` (`ingest.js:620`), and the commit-time re-resolution lookups in `decideFieldItem`/the `create`/`unchanged` cases (`ingest.js:997, 1044, 1077`).
3. `src/ingest/preview.js` — `buildPreview`'s own existing-vs-create matching (wherever it keys off `normalizeName` to decide whether a name is `create` vs. recognized — this is what feeds ImportScreen's `preview.perEntity.locations.create` list, so if this one is missed, ImportScreen's UI and buildPlan's actual commit would recognize **differently**, a real and easy-to-miss inconsistency).
4. `src/localClient.mock.js` — the mock's own parallel `ingestCommit` re-resolution (mirrors #2, dual-copy discipline).

**One structural consequence worth stating as an invariant, not just a side effect:** because recognition is exact-string, `locations` can **never** produce an `ambiguous_identity` conflict from two live rows both matching one proposed name (`UNIQUE(camp_id, name)` already guarantees at most one live row can hold any exact string) — the `matches.length > 1` branch in `buildPlan.js:440` is structurally unreachable for this entity. `alias_divergence` (a confirmed alias pointing at a different row than a now-existing exact-name match) remains reachable and is handled identically to every other entity (§D5's alias registration).

**This is the single riskiest piece of this design** — four call sites across two files (plus the mock) must all agree, and disagreement would surface as a confusing, hard-to-reproduce bug (ImportScreen previews a location as "new," but committing it resolves to an existing row, or vice versa). **Confidence: medium-high** on the necessity and the shape; **the call-site enumeration above should be treated as a starting list, not a final one — Maker must grep `normalizeName(` across `src/ingest/` and `electron/ops/ingest.js` and audit every hit that is a recognition-map key or lookup (not every `normalizeName` call needs this — e.g. `anchorSlotKey`'s day/time-block/name key for fixed events is unrelated).** A required test: a two-layer characterization (buildPreview's tick-seeding AND buildPlan's actual plan) both agree on "Pool" vs "pool" against the same live snapshot, for both directions (recognized vs. two-created).

### D4 — Re-import provenance survival (COMPARABLE_COLUMNS, `_humanFields`, both copies)

`location_id` joins `COMPARABLE_COLUMNS.activities`, **replacing** `'location'` (not alongside it) — nothing writes the frozen column anymore (D5 of the parent ADR), so diffing against it is pointless and would compare a re-import's fresh proposal against a value frozen since v32, which can only ever be stale.

```js
// electron/ops/ingest.js COMPARABLE_COLUMNS, and the verbatim copy in
// src/localClient.mock.js's MOCK_COMPARABLE_COLUMNS — BOTH, per the standing
// dual-copy discipline (ipcSurfaceParity.test.js is the drift gate)
activities: ['priority', 'min_per_week', 'max_per_week', 'location_id', 'eligible_group_ids'],
locations: [],  // no comparable fields — a location item is only ever create/unchanged
```

**The FK-label diff shape, mirroring `unit`/`tier_id` exactly:**
- `src/ingest/fieldUpdate.js` `DB_FIELD` gains `location: 'location_id'` (source speaks the label `location`, the stored column is `location_id`).
- `src/ingest/buildPlan.js` `SNAPSHOT_KEY` gains `location: 'location_name'` (buildPlan diffs the proposed label against the snapshot's resolved current name, never the raw id).
- `enrichSnapshotRow` (`fieldUpdate.js`, shared verbatim by both callers) gains a third id→name map parameter, `locationNameById`, and a new branch: `if (entity === 'activities') row.location_name = row.location_id != null ? (locationNameById.get(row.location_id) ?? null) : null`. **Both callers** build and pass this map: `electron/ops/ingest.js`'s `buildExistingSnapshot` (`SELECT id, name FROM locations WHERE camp_id = ?`, mirroring the existing `tierNameById`/`groupNameById` construction at `ingest.js:383-390`) and `src/localClient.mock.js`'s equivalent snapshot builder (`state.locations`, mirroring its own `tierNameById`/`groupNameById` at `localClient.mock.js:535-538`).

**Provenance (`_humanFields`) needs no new mechanism** — `commitCreate`/`commitUpdate` already stamp `source: isHuman ? 'human' : IMPORT_SOURCE` per-field, keyed by the **stored** column name (`ingest.js:873, 906-910`), and `buildPlan.js`'s `humanFieldsFor` already normalizes via `dbFieldFor` (`buildPlan.js:139-140`) — once `DB_FIELD.location = 'location_id'` exists, a director's hand-picked location (via a future ImportScreen location-review control, out of scope for M4 unless Q8's own review counts — see §D5) is protected by the **exact same channel** `unit` already uses. **The frozen `activities.location` column is retained, never written after v32 — this ADR does not touch that; it simply stops being the diff target.**

**Policy A protection composes correctly with D1's two resolution rules.** `decideFieldItem`'s existing `isProtected` gate (`ingest.js:1020`, `latest.source !== 'import'`) runs on the **stored column** `location_id` before `resolveFieldWrite` is ever called for a protected field — a hand-set `location_id` (`source:'human'`) is held as `stale` on a differing re-import proposal exactly like every other protected field, **before** D1b's lookup-only resolution ever runs. No special-casing needed here; this is the existing gate operating on a newly-comparable column.

### D5 — Q8 parser design: capture, tally, and route through the ordinary entity tick-list

**`textGrid.js`: strip → capture, not strip → discard.** `stripLocations`'s current behavior (`textGrid.js:377-380`, `if (prevHadData && (isValueRow(tokens) || isBareNumbers(dataTokens))) continue`) silently drops the location line's tokens. Change the `continue` to **capture**: the dropped line's per-column values are assigned via the same `columnFor` mechanism the activity `cells` array already uses, into a **new, parallel `locations` array on the row** (`row.locations[i]` aligned index-for-index with `row.cells[i]`), populated **only** on `!labeled` pages (the same gate `stripLocations` itself is already scoped to — the two labelled-time camp families are untouched, zero regression risk to their pinned behavior). `parseTextGrid`'s return shape gains this field; a row with no captured location line simply has `locations: undefined` or an all-empty array, and every existing consumer that doesn't look for it is unaffected.

**`extractEntities.js`: tally candidate location names, correlated to the activity they sit under.** Reuse the existing `tally`/`dedupe` helpers (`extractEntities.js:172-211`, already used identically for activities/groups) over every non-empty `row.locations[i]` value, producing `entities.locations` (a deduped, counted candidate list — the same shape `entities.activities` already has via `tally(activities).map(v=>v.name)`) **and** a per-activity-name → location-name side-channel (mirroring `groupUnits`/`activityPages`'s existing per-name-keyed shape) so ImportScreen can later pair "Swim" with "Pool" the same way it already pairs a group with its unit. Majority-vote per activity name if the same activity appears at multiple captured locations across the file (mirrors the existing single-value-per-name convention `groupUnits` already uses) — this is a **presentation simplification** for M4, not a data-model claim that an activity can only ever have one place; a future slice could carry ambiguity forward if a real camp needs it, and nothing here forecloses that.

**Locations join `INGESTIBLE_ENTITIES` + `ALIAS_ENTITY_TABLE` — the registry entries this section needs:**
- `INGESTIBLE_ENTITIES` — §D2 above.
- `ALIAS_ENTITY_TABLE` (`ingest.js:199-206`) gains `locations: 'locations'` — enables T73's "remember this" confirmed-alias resolution for a location label that doesn't exact-match any live row (e.g. "Pool Deck" in a file, aliased by a director to the existing "Pool" row) — the exact same mechanism every other entity already has, no new code beyond the map entry (`confirmAlias.js:57` already validates against `INGESTIBLE_ENTITIES`, so `locations` is automatically a legal `entity_type` once added there).
- `EVIDENCE_ENTITY_TYPES` (`ingest.js:245`) is **not** changed — a location's mere existence as a `create`/`unchanged` plan item is already visible in the plan itself, needing no evidence row of its own (the parent reconciliation ADR's own stated rule: "the raw fact 'this name appeared' ... needs no evidence row of its own"). **Recommended, not required:** one additional `writeEvidence` call, tag `'observed'`, on the **existing** `activities`/`location` field (already an allowed `entity_type`/no new registry entry), giving the future "why?" panel the captured-text support for *this activity's* location the same way `eligible_group_names`/`min_per_week` already get it. Cheap (reuses `writeEvidence` verbatim) and consistent, but the M4 success predicate does not require it — flagged as a should-ship-if-cheap item, not a blocker.

**The review surface: reuse ImportScreen's existing generic tick-list, with one Q8-specific default.** Because `locations` is now an ordinary `INGESTIBLE_ENTITIES` member, `ImportScreen.jsx:347-353`'s existing generic seeding loop (`for (const entity of INGESTIBLE_ENTITIES) { initial[entity] = new Set(create.filter(...)) }`) **already** produces a `chosen.locations` tick set and an ordinary review row for each candidate, using the exact same list/note/checkbox UI every other entity's create candidates already render — **no new UI component**, satisfying "do not redesign the ingestion UI." The **one** Q8-specific deviation, mirroring the fixed-event pin-only-unticked precedent (`docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md` Decision 1, C2): a `locations` create candidate defaults **unticked** (every other entity's create candidates default ticked unless low-confidence) — one extra line in the same seeding loop, `entity === 'locations' ? new Set() : new Set(create.filter(...))`, with a note on the row ("Seen in this file as a room — not a place Shoresh yet knows. Add it?" — exact copy is a Designer/product call, not decided here). A **recognized** location (already exists — resolved via §D3's exact-match, so it's `unchanged`, not in the `create` list at all) needs no tick and no review at all, exactly like a recognized activity or group today.

**Gating an activity's `location` field on the ticked location set.** `ImportScreen.buildCommitInputs` includes `record.fields.location = <name>` on an activity's record **only when `name` is present in `chosen.locations`** (whether recognized-and-always-included or newly-approved-this-round) — mirroring exactly how a group's `unit` field is only proposed when `groupUnitOverrides`/`preview.groupUnits` resolves it. If the director leaves a captured location unticked, the associated activity's `location` field is simply **omitted** — absent, not diffed, not cleared — the same "preserve" semantics `buildPlan` already gives any field the source doesn't carry. This is what keeps Q8 genuinely "propose, never auto-create": no location row is ever minted, and no activity is ever bound to one, without an explicit tick.

**Confidence: medium-high.** The tick-list reuse and the gating mechanism are direct applications of already-proven patterns (dual-use/pin-only defaults, group-unit gating). The textGrid.js capture change is new surface on a hand-tuned, corpus-fit parser — the "0.6 majority"/"full-width value row" heuristics that already gate `stripLocations` are unchanged (this ADR only changes what happens to a line the *existing* logic already decided is a location line), so the risk is scoped to "does the captured text pair with the right activity/column," not "does the parser now misclassify more lines as locations."

### D6 — Export id→name, re-import name→row

`exportWorkbook.js`'s `SHEET_LAYOUT` activities entry (`exportWorkbook.js:52-57`) changes its `location` column from plain text to a resolved label, mirroring `unit` exactly:

```js
columns: [
  { key: 'name' }, { key: 'priority' }, { key: 'min_per_week' }, { key: 'max_per_week' },
  { key: 'eligible_groups', labelList: true }, { key: 'location', label: true },
],
```

`cellValueFor` (`exportWorkbook.js:99-109`) gains a branch: `if (col.label && col.key === 'location') return row.location_id != null ? (maps.locationNameById.get(row.location_id) ?? '') : ''`. `exportWorkbook()`'s top-level signature gains `locations = []`, and builds `locationNameById: new Map(locations.map(l => [l.id, l.name]))` alongside the existing `tierNameById`/`groupNameById` (`exportWorkbook.js:129-131`). **No new sheet** — `SHEET_LAYOUT` stays six entries; `locations` is an extra input used only to resolve the `activities` sheet's `location` column, not a sheet of its own (a "Locations" sheet in the workbook is out of scope — the workbook round-trips activity assignments, not the place catalog itself, which lives on `LocationsScreen`).

**Both existing callers need zero code changes.** `ImportScreen.jsx:421-427` and `ReadinessHub.jsx:71-79` already build their `entities` object generically via `for (const entity of INGESTIBLE_ENTITIES) { entities[entity] = await localClient.list(entity) }` and spread `...entities` into `downloadWorkbook(...)` — once `locations` joins `INGESTIBLE_ENTITIES` (§D2), both call sites automatically fetch and pass it through. This is the same payoff §D2's ordering decision already produces elsewhere: joining the registry once, correctly, cascades for free through every generic consumer of it.

**`workbookToSource.js` needs no changes at all.** It reads every `layout.columns` entry generically as a trimmed string into `fields[col.key]` (`workbookToSource.js:151`) with no awareness of `label`/`labelList` beyond `labelList`'s comma-split — exactly how `unit` already round-trips today with zero special-casing in this file. `fields.location` arrives as plain text; §D1/§D4's resolution (`SNAPSHOT_KEY`/`DB_FIELD`/`resolveFieldWrite`) does the rest, generically, the same way it already does for `unit`. Confirmed by reading the file: no `col.key === 'unit'` branch exists here today, so none is needed for `location` either.

**`<clear>` sentinel.** Unaffected — `workbookToSource.js`'s clear-token handling (`isClearToken`, line 25) operates on the raw cell string before any field-specific logic, exactly as it already does for `unit`; a `<clear>` on the `location` column folds into `record.clears` and flows through the existing S4b clear path (`buildPlan.js:238-241`) with `to: CLEAR`, resolved to a `location_id = null` write at commit — no new code.

**Sanitizer boundary — confirmed, no gap.** Every string cell in `exportWorkbook.js` already routes through `aoaToSanitizedSheet` (`exportWorkbook.js:163`, the shared boundary from `docs/adr/2026-08-08-export-formula-injection-sanitizer.md`) — a location named `=cmd` is sanitized identically to an activity or group name today; the `label:true` change only affects **which value** is written into the cell (a resolved name instead of raw `row.location`), not **how** it's written. No new security surface.

### D7 — Display cleanup: remove the M3b interim fallback

`ScheduleActivityView.jsx`'s `placeNameFor` (`ScheduleActivityView.jsx:19-22`) currently falls back to the frozen `act.location` string when `location_id` is null. Confirmed by reading `D5`/`M3`'s completion state (the app-wide "no code path writes `activities.location`" test already exists per the parent ADR's M3 ticket, and this M4 ADR closes the **last** writer of that field — ingest): once M4 lands, every activity's `location_id` is either correctly bound (M1's migration backfill re-pointed every pre-v32 activity; every post-v32 create/update goes through `location_id` exclusively) or genuinely unset (never assigned a place). The fallback is not merely dead — it is actively **misleading** in one case: a location that is later **deleted** (`docs/adr/2026-08-15-locations-merge-and-delete-rehome.md` D1) clears `location_id` to `null` but, per D5 of the parent ADR, never touches the frozen `location` string — so a deleted place's activities would show the **stale, deleted place's name** as if still assigned. Removing the fallback (`return act?.location_id ? locMap.get(act.location_id)?.name || null : null`) is a correctness fix, not just cleanup.

`grep -rn "\.location\b" src/screens src/components` (excluding `.location_id`/test files) turns up exactly two other free-text reads: `ActivitiesScreen.jsx:825,870-876` — the M3b **template importer** (`confirmImport`, a bespoke CSV-template create path, separate from `electron/ops/ingest.js`, already using its own case-insensitive `randomUUID()` create by design, per the run brief's own note that "the picker's own client-side inline-create... stays random-UUID/case-insensitive by design — only the Host ingest path is deterministic"). This is **out of scope for M4** — it is a different, pre-existing entry point this ADR does not touch, and its `location`-typed free text there is a separate, not-yet-migrated surface (flagged, not fixed, here).

**Confidence: high** on the `placeNameFor` removal (traced against the actual delete/merge behavior); **high** that `ActivitiesScreen.jsx`'s template importer is correctly out of scope (matches the run brief's explicit non-goal).

## Registry checklist — every entry to add, both copies where a dual-copy discipline exists

| # | Registry / function | File(s) | Change |
|---|---|---|---|
| 1 | `INGESTIBLE_ENTITIES` | `electron/ops/ingest.js:28-30`, `src/ingest/extractEntities.js:22` | Add `'locations'` after `'time_blocks'`, before `'activities'`, **in both, same relative order** (set-equality test already exists; order is this ADR's own new requirement, §D2) |
| 2 | `ALIAS_ENTITY_TABLE` | `electron/ops/ingest.js:199-206` | Add `locations: 'locations'` |
| 3 | `COMPARABLE_COLUMNS` | `electron/ops/ingest.js:174-181`, `src/localClient.mock.js` `MOCK_COMPARABLE_COLUMNS` | `activities`: replace `'location'` with `'location_id'`. Add `locations: []` |
| 4 | `DB_FIELD` | `src/ingest/fieldUpdate.js:20` | Add `location: 'location_id'` |
| 5 | `SNAPSHOT_KEY` | `src/ingest/buildPlan.js:34-37` | Add `location: 'location_name'` |
| 6 | `enrichSnapshotRow` | `src/ingest/fieldUpdate.js:90-102` (shared) | New `locationNameById` param + `activities.location_name` resolution branch |
| 7 | callers of `enrichSnapshotRow` | `electron/ops/ingest.js` `buildExistingSnapshot` (~383-405), `src/localClient.mock.js` (~533-547) | Build + pass `locationNameById` (mirrors `tierNameById`/`groupNameById`) |
| 8 | `resolveFieldWrite` | `src/ingest/fieldUpdate.js:114-152` (shared) | New `location` branch (pure lookup via `locationIdByName`, hold `location_unresolved`) |
| 9 | callers of `resolveFieldWrite` | `electron/ops/ingest.js` `decideFieldItem` (~1025), `src/localClient.mock.js` (~701) | Thread `locationIdByName` into the maps argument |
| 10 | `fieldsFor` | `src/ingest/buildPlan.js:69-95` | Add `case 'locations': return { camp_id: campId, name }` |
| 11 | `commitCreate` | `electron/ops/ingest.js:817-890` | (a) `deriveLocationId` id-mint for `entity==='locations'`; (b) `locationIdByName.set(name, entityId)` registration on a locations create; (c) new `activities` branch resolving `fields.location` → `fields.location_id` via `resolveOrCreateLocationId` (D1c) |
| 12 | mock's `ingestCommit` | `src/localClient.mock.js` (~496-870) | Mirror #11 in full — dual-copy discipline, own `locationIdByName` map, own `deriveLocationId`-based mint (import from `electron/ops/locationId.js`, an already-established `src/`-may-import-this exception, per `src/screens/locationMigrationReview.js`'s existing precedent) |
| 13 | `seedNameMaps` | `electron/ops/ingest.js:583-598` | New `locationIdByName` map, seeded `SELECT id, name FROM locations WHERE camp_id = ?`, keyed by `String(row.name).trim()` — **not** `normalizeName` |
| 14 | conflict-reason allowlist | `electron/ops/ingest.js:1098` | Add `'location_unresolved'` |
| 15 | `REPLACEABLE_ENTITIES` | `electron/ops/ingest.js:40-42` | **Explicitly excluded** — locations are durable, never torn down by replace mode (§D2) |
| 16 | `buildExistingSnapshot` | `electron/ops/ingest.js:380-414` | Mode-aware carve-out: `locations` always scanned; the six schedule-content entities scanned only in `add` mode (§D2) |
| 17 | recognition key | New `recognitionKey(entity, name)` in `src/ingest/preview.js` | Case-sensitive/exact for `locations`, `normalizeName` for everything else — applied at every recognition map-build/lookup site (§D3, non-exhaustive starting list of 4+ call sites) |
| 18 | `exportWorkbook.js` | `SHEET_LAYOUT` activities columns, `cellValueFor`, top-level signature | `location` becomes `label:true`; new `locations` param + `locationNameById` map; **no new sheet** |
| 19 | `workbookToSource.js` | — | **No change** (confirmed generic) |
| 20 | `ScheduleActivityView.jsx` | `placeNameFor` (`:19-22`) | Remove the `act.location` fallback (§D7) |
| 21 | `textGrid.js` | `stripLocations` branch (`:377-380`) | Strip → capture into parallel `row.locations[]`, gated identically to today's `!labeled` scope |
| 22 | `extractEntities.js` | new location tally | Reuse `tally`/`dedupe`; produce `entities.locations` + a per-activity-name location side-channel |
| 23 | `ImportScreen.jsx` | tick-seeding loop (`:347-353`), `buildCommitInputs` | `locations` create candidates default **unticked**; an activity's `fields.location` is included only when its paired name is in `chosen.locations` |
| 24 | evidence (recommended, not required) | `writeEvidence` call for `entity_type:'activities', field:'location', tag:'observed'` | Reuses the existing `activities` `EVIDENCE_ENTITY_TYPES` entry — no registry change, just an additional call site |

**Already done (M1, no M4 work):** `PROJECTIONS`, `DIRECT_CAMP_ENTITIES`, `DOMAIN_SNAPSHOT_TABLES`, `permissions.ENTITIES`, `MOCK_WRITE_ALLOWLIST` — `locations` and `activities.location_id` are already fully wired for ordinary sync/CRUD. `projectionsCoverage.test.js` should need no change (no new columns; confirm as a regression check, not a new gate).

## Invariants — normative, each needs a test

1. **Cross-device deterministic ingest id (extends INV-1).** A location minted by ingest (either D1a's `commitCreate` path or D1c's `resolveOrCreateLocationId`) derives its id **only** from `(camp_id, trimmedName)` via `deriveLocationId`, never `crypto.randomUUID()`. **Required test:** two independent databases, identical pre-import state, run the identical import on each independently, assert resulting `locations.id` **and** `activities.location_id` are byte-identical across both — the same two-db pattern INV-1's own migration test already established, now for the ingest write path.
2. **Ordering-before-`location_id`.** Within one `commitPlan` transaction, every `locations` create the plan contains is written **before** any `activities` create/update that references it, by `INGESTIBLE_ENTITIES` array order (§D2) — never a `location_id` write dangling ahead of its `locations` row's own creation, even though there is no DB-level FK to enforce it. **Required test:** a single import proposing both a brand-new location and a brand-new activity referencing it, asserting the location's `name`/`camp_id` ops carry a lower `seq` than the activity's `location_id` op.
3. **The frozen `activities.location` column is retained, never written after v32.** M4 does not touch this invariant — it only stops `location` from being a **diff target** (§D4); the column itself is untouched by this ADR, per the parent ADR's D5.
4. **Recognition-key consistency (§D3).** `preview.js`'s `buildPreview`, `buildPlan.js`'s plan-build recognition, and `ingest.js`'s commit-time re-resolution must agree on whether a given location name is recognized. **Required test:** the same "Pool" vs "pool" fixture checked against all three layers in one test, asserting identical create/unchanged verdicts.
5. **Replace mode never touches `locations`.** **Required test:** a replace-mode re-import of a cohort whose activities reference an existing location asserts the location row is untouched (same id, same `capacity`, no new ops) and is correctly **recognized** (not blind-created) by the same name.

## What Red Hat must adversarially verify

- **The D3 recognition-key call-site enumeration is explicitly not guaranteed exhaustive** in this document — Red Hat should grep `normalizeName(` across `src/ingest/`, `electron/ops/ingest.js`, and `src/localClient.mock.js` independently and confirm every recognition-map key/lookup (not every `normalizeName` use) is covered, then run the cross-layer consistency test in Invariant 4 against the actual implementation.
- **The replace-mode carve-out (§D2)** for a hazard this document traces but does not exercise against running code — the PK-collision/silent-overwrite failure mode for a blind-create of an already-existing location in replace mode.
- **`resolveOrCreateLocationId`'s (D1c) double-check-then-write** (`SELECT 1 ... ; if not found, appendOp x2`) for a genuine same-transaction race: can two *different* activities in the *same* commit, both referencing a *new* location name for the first time, ever reach this function before either has updated `locationIdByName` — i.e., is the cache-then-write sequence actually safe against double-minting within one single-threaded `db.transaction()` closure, or does it need the same defensive `INSERT OR IGNORE`-then-verify pattern `ensureExists` itself uses at the projection layer?
- **The dual-copy parity between `electron/ops/ingest.js` and `src/localClient.mock.js`** — this ADR touches an unusually large number of shared/dual-copy surfaces (COMPARABLE_COLUMNS, resolveFieldWrite callers, enrichSnapshotRow callers, the full `commitCreate`/`ingestCommit` mirror) in one slice; `ipcSurfaceParity.test.js` is the existing drift gate but was not designed with this many simultaneous touch points in mind.
- **`textGrid.js`'s capture change (§D5)** against the real corpus (Camp A/B/Shemesh fixtures) — confirm the `!labeled`-gated capture never fires on the two labelled-time families (zero regression to their pinned golden output) and that the captured `row.locations[]` values pair with the correct column/activity on at least one real unlabeled-family fixture.
- **`resolveOrCreateLocationId`'s ordering interaction with Q8's gating** — confirm empirically (not just by design argument) that a Q8-sourced activity's `location` field, when its paired location name IS ticked, always finds `locationIdByName` already populated by D1a's earlier same-transaction create, so D1c's mint branch is exercised **only** by the workbook path in practice — the theoretical mint-branch-would-cache-hit argument in §D1c should be a passing assertion, not an assumption.

## ADR required: yes

This amends the parent v32 ADR's M4 row with a concrete, code-level design that: introduces a new resolve-or-create write path with its own cross-device determinism obligation (extends INV-1); changes an existing contract (`COMPARABLE_COLUMNS.activities`, `resolveFieldWrite`'s signature, `enrichSnapshotRow`'s signature — all shared functions other code calls); and makes a not-obviously-reversible design choice (case-sensitive recognition for one entity, diverging from the codebase-wide `normalizeName` convention). All three independently clear the constitution's ADR bar.

## Open questions for Governor

1. **Q8 review-row copy** ("Seen in this file as a room — not a place Shoresh yet knows. Add it?" or equivalent) is a Designer/product wording call, not decided here — flagged so it isn't silently decided in code, per the fixed-event ADR's own precedent for the identical situation.
2. **The recommended (not required) `writeEvidence` call for `activities`/`location` (§D5, registry row 24)** — confirm whether this ships in M4 or is deferred; it is cheap and consistent but not required by the M4 success predicate, and Governor should make the call rather than have it silently included or silently dropped.
3. **§D3's case-sensitive recognition deviation is a genuine, owner-relevant product fact, not just an implementation detail:** a director whose file says "pool" when the camp already has "Pool" will get a **second row proposed** (or minted), not silent reuse of the existing one — consistent with M3c's stated design ("case variants legitimately become two rows the merge gate can heal") but worth Governor confirming this reads correctly to the owner as *intended* behavior for the ingest path specifically, not only for the one-time v32 migration it was originally decided for.
4. **`ActivitiesScreen.jsx`'s M3b template importer (§D7)** is confirmed out of scope for M4 (a separate, already-known non-deterministic create path) but remains a live, unaddressed inconsistency with the Host ingest path's new determinism — Governor should decide whether this needs its own follow-up ticket now or stays a known, accepted gap.
