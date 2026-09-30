---
title: "Every setup import door is format-agnostic"
document_type: adr
status: accepted
approved: 2026-09-30 (owner, via the organizer session: "go for it" — accepted with ONE AMENDMENT: the atomic multi-row import (§4.9) is a decision item and part 2 of the same ticket; §13 resolved to the ADR's own defaults)
authority: normative
implementation_state: not-started (part 1 — the binder; part 2 — atomic multi-row import)
date: 2026-09-30
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_adrs:
  - docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
  - docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md
related_tickets:
  - docs/work/tickets/T278-import-agnostic-elective-preferences.md
  - docs/work/tickets/T279-preference-etl-canonical-record-and-residue.md
  - docs/work/tickets/T285-preference-shape-adapters.md
  - docs/work/tickets/T312-a-camps-column-mapping-is-remembered-and-re-proposed.md
  - docs/work/tickets/T314-the-import-panel-reads-every-tab-of-a-workbook.md
  - docs/work/tickets/T315-every-setup-importer-reads-its-own-tab.md
---

# Every setup import door is format-agnostic

## 0. Owner ruling — verbatim, binding

Board item `q-export-columns-do-not-round-trip`, 2026-09-29:

> "that is fucking absurd. i thought that we dealt with importing agnostic frameworks before this.
> it shouldn't matter what format it is in, the same principles apply - extract the data, transform
> it into a readable state for shoresh, read it, parse it, load it, infer things, let the person know
> what was missed or needs an eye on"

This ADR is that ruling applied to the seven setup doors: Days, Groups, Activities, Anchors (fixed
events), Tiers, TimeBlocks, Locations.

## 1. The measured defect

Every setup door hardcodes the exact column names it will read. Confirmed by reading each screen's
import handler (`onFileChange` in `src/screens/{Days,Groups,Activities,Anchors,Tiers,TimeBlocks,
Locations}Screen.jsx`):

| Door | `requiredColumns` gate | Fields read straight off the raw header text |
|---|---|---|
| Days | `['label']` | `label`, `day_of_week`, `sort_order` |
| Groups | `['name', 'tier_name']` | `name`, `tier_name`, `availability` |
| Activities | `['name']` | `name`, `location`, `eligible_tiers`, `weather_alternative`, `is_outdoor`, `same_tier_only`, `priority`, `prefer_before_day`, `prefer_before_day_min`, `max_groups_per_slot`, `min_per_week`, `max_per_week`, `notes` |
| Anchors | `['name', 'day_label']` | `name`, `day_label`, `time_block_name`, `is_all_tiers`, `tier_names`, `notes` |
| Tiers | `['name']` | `name` |
| TimeBlocks | `['name', 'start_time']` | `name`, `start_time`, `end_time` |
| Locations | `['name', 'capacity']` | `name`, `capacity`, `kind` |

The app's own read-only export (`src/utils/buildCampDataWorkbook.js`, T292) writes different,
human-facing headers for the same data — Days: `Name`, `Day of Week`; Groups: `Name`, `Age Division`,
`Availability`; Activities: `Name`, `Place`, `Age Divisions`, `Weather Alternative`, … . None of those
match the raw keys the importers require, so **a director who exports the camp's own data and
re-imports it gets zero rows**, silently, on the correct tab (T314/T315 already fixed the
wrong-tab failure mode; this is a different failure, on the right tab).

A third-party file — a camp's own spreadsheet, a prior system's export — fares no better: any header
spelling other than the one literal string each screen expects is either misread (`Groups` requires
exactly `tier_name`, so `Division` or `Bunk Age Group` imports every row with no age division and no
warning) or excluded from the tab-selection gate entirely.

**Root cause:** these seven readers never adopted the agnostic ETL pattern this codebase already
built and proved for elective preferences (T278/T279/T285/T312) — inference from header text against
a known vocabulary, director confirmation of anything ambiguous, a remembered mapping keyed to the
camp and the file's header shape, and a residue report of what was not understood. They still do
what the preference importer did before that program: hardcode one spelling and fail closed or fail
silent on anything else.

## 2. What already exists — the reuse survey

Three things this ADR builds on rather than re-invents, each read at the source before this design
was drafted:

1. **Tab selection is already solved and stays untouched.** `readEntitySheet`
   (`src/utils/exportSanitize.js:155`) picks the right sheet by name, then by required columns, then
   falls back to the first sheet (T314/T315). It returns rows as plain objects keyed by whatever
   header text the sheet actually has. This ADR's new layer sits **downstream** of `readEntitySheet`
   — it does not touch tab selection, sheet-name matching, or the size/complexity caps
   (`readWorkbookSafely`, `assertWorkbookComplexity`).

2. **Header-role inference, director confirmation, and residue reporting already exist for
   preferences**, in `src/ingest/preferenceSheet.js`: `inferPreferenceMapping` proposes which column
   plays which role from header-text pattern matching; `describeCoverage` turns unclaimed columns
   into `unrecognisedColumns` (residue) and missing required roles into `unmapped` (the confirm-gate
   block); `mappingWithDirectorOverride` re-derives both after a hand correction;
   `describeMappingReadiness` is the confirm button's enable/disable predicate. This is real,
   shipped, tested machinery — but it is **hardcoded to the five fixed preference roles** (name,
   external id, division, day, period, ranks) via regex constants (`NAME_HEADER`,
   `DIVISION_HEADER`, …). It is not, today, parameterized by an arbitrary field list, so it cannot be
   called for Days or Groups as written.

3. **A remembered mapping already exists and is entity-shape-agnostic in its mechanics.**
   `src/ingest/mappingSeedling.js` — `headerMatchKey` (a stable token over the sorted set of
   *claimed* header text, not the whole sheet), `bindingFromMapping` / `mappingFromBinding` (stores
   and recalls a mapping **by header text**, never by column index or cell content), and
   `recallColumnMapping` (re-runs a recalled binding through the same readiness gates a fresh
   inference gets, and returns `null` — "ask the director" — the moment any named header is missing
   or ambiguous). T312 persists this as a replicated entity in the existing decision-record table,
   id-derived from `(camp_id, kind, match_key)` so two devices confirming different readings produce
   a `conflicts` row rather than an arbitrary winner. The privacy constraint is structural: every
   function here takes header strings and role indices, **none takes row/cell data** (ADR
   2026-09-27 §6.0) — a fingerprint over cell contents would cache children's names into a table
   that exists to be a layout memo. `SINGLE_ROLES` (`name`/`externalId`/`division`) is the one part
   that is preference-specific; everything else already operates on an arbitrary role list.

4. **Explicitly a separate, non-goal contract:** `exportWorkbook.js` (S4a) / `commitIngest`'s
   `commitPlan` (S4b) is a **different family** — an id-matched, baseline-diff *enrichment*
   round-trip for an *existing* camp's already-entered data (`shoresh_id` + `Status` columns, hidden
   metadata sheet, staleness gate against `base_generation`). It already round-trips correctly for
   the six entities it covers. This ADR does not touch it. The setup doors solve a different job —
   first-time or incremental *bulk creation* from a file the director did not produce inside this
   app — and conflating the two contracts (e.g. by copying S4a's hidden metadata sheet onto the
   setup doors) would blur a distinction that is currently clean.

## 3. Candidate approaches considered

Generated by parallel divergent ideation (`adhd`, 4 frames: hardware/systems, regulator/auditor,
inversion, remove-the-load-bearing-assumption — 24 raw ideas), then clustered and scored on novelty,
viability, and fit. Six clusters; three converged into the design below, three rejected with reasons.

**Adopted (merged into one design, §4):**

- **Entity-agnostic field catalogue + inference binder** `[N7 V8 F9]` — generalize
  `inferPreferenceMapping`'s mechanism (not its five hardcoded roles) into a binder driven by a
  per-entity declarative field list (key, required?, synonym header strings), reusing
  `describeCoverage`/`mappingWithDirectorOverride`/`describeMappingReadiness`'s shape. ★ This is the
  non-obvious-but-viable pick: it is the smallest change that actually unifies all seven doors,
  because it keeps every entity's existing FK-resolution, validation, dedup, and commit code
  (`tier_name` → `tier_id`, `weather_alternative` → activity id, etc.) completely unchanged — only
  the "which raw column is which field" step moves from hardcoded property access into the binder.
- **Export headers as first-class synonyms** `[N6 V8 F9]` — seed each entity's catalogue with the
  literal header strings both exports already write (`buildCampDataWorkbook.js`'s human headers and
  `exportWorkbook.js`'s raw keys), alongside the screens' own raw field names and a few obvious
  third-party synonyms. This is what actually fixes the reported defect: it is not a separate
  mechanism, it is what the catalogue's synonym lists are seeded with.
- **Remembered mapping reused as-is** `[N5 V8 F8]` — `mappingSeedling.js`'s binding/recall functions
  generalize by construction (they already take header text and a role-index object); this ADR adds
  one `kind` value per entity (`setup_column_roles:<entity>`) to the existing `import_decisions`
  table T312 already writes to. No new schema, no new persistence mechanism.

**Considered and rejected:**

- **Governance ledger with versioned inference rules, mandatory low-confidence sign-off, two-stage
  finalization** `[N6 V4 F4]` — TRAP. This project already has a decision ledger
  (`src/ingest/decisionJournal.js`, `import_decisions`) and a residue-kind vocabulary
  (`src/ingest/residueKinds.js`) that separate "the director must decide" from "an acknowledgment
  with no action available." Building a second, parallel governance layer for setup imports
  duplicates a solved problem and is scope well beyond what the owner asked for.
- **One unified whole-workbook importer that infers entity types from header clusters across the
  whole file and replaces the seven per-screen "Import from Excel" doors with one central screen**
  `[N8 V4 F5]` — TRAP for this ticket, even though it scores highest on novelty. It rewrites the
  navigation model T314/T315 just finished making correct (one importer per screen, each reading its
  own tab), for a defect that does not require it. Recorded as a legitimate future direction (§13,
  open question 3), not adopted here.
- **Content/type-based column matching from sample row values** (match a column by inferred data
  type plus name, not header text alone) `[N7 V3 F4]` — TRAP. This directly contradicts the standing
  privacy invariant recorded in `mappingSeedling.js` and ADR 2026-09-27 §6.0: the match/recall key
  must be derivable from **header text and geometry only**, never cell contents, because a
  fingerprint over cells is exactly how a layout memo becomes a covert roster. Setup data is
  structural (day names, group names, capacities) rather than camper PII, so the privacy stakes are
  lower here — but there is no stated need this solves that header-text synonym matching does not
  already solve, so it is dropped rather than carved out as a narrow exception.
- **Embed the confirmed mapping as a hidden metadata sheet in the exported file itself** (the S4a
  pattern, borrowed) `[N4 V6 F6]` — TRAP. Redundant once export headers are catalogue synonyms (the
  round-trip already auto-infers with zero ambiguity), and it would blur the S4a/S4b enrichment
  contract into the setup-door contract that §2.4 above keeps deliberately separate.

## 4. Decision — one entity-agnostic column binder, shared by all seven doors

**New module: `src/ingest/entityColumnMapping.js`.**

### 4.1 The field catalogue

One declarative entry per setup entity — the only genuinely new, entity-specific artifact this ADR
introduces:

```js
export const ENTITY_FIELD_CATALOGS = {
  days_of_operation: {
    sheet: 'Days', // matches readEntitySheet's sheetName + the export's own tab name
    fields: [
      { key: 'label', required: true, synonyms: ['label', 'name', 'day'] },
      { key: 'day_of_week', required: true, synonyms: ['day_of_week', 'day of week', 'dow'] },
      { key: 'sort_order', required: false, synonyms: ['sort_order', 'order'] },
    ],
  },
  groups: {
    sheet: 'Groups',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      { key: 'tier_name', required: false, synonyms: ['tier_name', 'age division', 'unit', 'division'] },
      { key: 'availability', required: false, synonyms: ['availability'] },
    ],
  },
  // ... tiers, time_blocks, activities, fixed_events (Anchors), locations — one entry each,
  // fields exactly matching what each screen's onFileChange already destructures off `r`.
}
```

Synonym lists are seeded from three sources, all already read at the source for this design:
each screen's own raw field name (today's hardcoded expectation, kept so nothing regresses),
`buildCampDataWorkbook.js`'s human-facing header for that field, and `exportWorkbook.js`'s raw key
where the entity is one of the six S4a covers. A field catalogue entry is the smallest new surface
that answers "what does this entity's importer need" without inventing a schema for it — it is data,
not a new abstraction layer.

### 4.2 Inference (generalizes `inferPreferenceMapping`)

```js
export function inferEntityMapping(header = [], catalog) {
  // fold: same normalize-and-compare rule readEntitySheet and mappingSeedling already use
  // (trim, lowercase, collapse whitespace) — reused, not re-implemented.
  // For each header cell, find the ONE catalog field whose synonym list matches (folded, exact).
  // Two cells matching the same field's synonyms → collision (not silently last-wins).
  // Two catalog fields whose synonym lists BOTH match one cell → the ambiguity is on the catalog
  //   side and must not happen (a catalog authoring gate, not a runtime state); a unit test per
  //   entity asserts each entity's synonym lists are pairwise disjoint.
  // Returns { roles: { [fieldKey]: headerIndex }, unrecognisedColumns, unmapped, collision }
  // — same four-part shape describeCoverage/describeMappingReadiness already produce for preferences.
}
```

This is `inferPreferenceMapping` with the five hardcoded regex roles replaced by an arbitrary
`catalog.fields` list and exact (folded) synonym matching instead of regex. Regex matching is
preference-specific (`#N` rank headers, "Monday #1" scoped ranks) and has no analogue in setup data,
so the generalized binder is simpler than the function it generalizes, not more complex.

### 4.3 Director confirmation

Each of the seven screens' existing preview step (`importStep === 'preview'`) gains the same
role-correction affordance the preference importer already has: an inferred mapping under an
`unmapped` or `collision` state disables `confirmImport` (already the shape of
`describeMappingReadiness`'s contract) and shows a corrector where the director points a role at a
different column. **This is a UI-touching change to seven screens** — see §7.

### 4.4 Residue

`unrecognisedColumns` (columns present in the file but claimed by no field) surfaces exactly like
preference residue does today: an ACKNOWLEDGMENT per `residueKinds.js`'s existing vocabulary (a true
statement, nothing to decide) unless the column's text matches a *near*-synonym worth asking about,
which stays out of scope for this ADR (see §11) rather than inventing fuzzy matching now.

### 4.5 Remembered mapping

`mappingSeedling.js`'s `bindingFromMapping` / `mappingFromBinding` / `headerMatchKey` /
`recallColumnMapping` are reused unmodified in mechanism; the one change is that `SINGLE_ROLES`
(hardcoded to `name`/`externalId`/`division`) becomes a parameter — the catalog's field-key list —
so the same four functions serve both preferences and all seven setup entities. Persisted via the
existing `import_decisions` table (T312's schema, unchanged), one new `kind` value per entity:
`setup_column_roles:days_of_operation`, `setup_column_roles:groups`, etc. — seven new constants, zero
new tables, zero new columns. `headerMatchKey` already hashes the sorted set of *claimed* header
text, so a Days-shaped binding and a Groups-shaped binding cannot collide even though both catalogs
use a `name`-like field — the key is over the whole claimed set, not any single field.

### 4.6 What does not change

Every screen's FK-name-resolution, per-row validation, `mapWithCollisions`-based same-name-collision
handling, existing-row dedup (`existingNames`/`existingLabels`), and the per-row
`repository.createRecord` commit loop stay exactly as they are today. The binder's output shape is
deliberately the same shape each screen's parser already consumes (`r.tier_name`, `r.day_of_week`,
`r.eligible_tiers`, …) — a row object keyed by canonical field key instead of raw header text — so
each screen's `rows.map(r => { ... })` block changes only its **input source** (`applyEntityMapping`
output instead of `readEntitySheet`'s raw rows), not its body.

### 4.9 Decision item (owner amendment, 2026-09-30): a setup import commits all rows or none

A multi-row setup import through any of the seven doors is **atomic**: either every row the
director confirmed is written, or none is, and a failure says so in the door's own residue/report
surface rather than leaving half a sheet loaded with no way to tell. Today `confirmImport`'s loop
isolates each row (try/catch, `skipped++`), which protects against a bad row but not against a crash
between rows. The mechanism: wrap the confirmed row set in the existing `runAtomic` transaction seam
that `electron/ops/commitElectiveRun.js` and `finalizeElectiveRun.js` already use for exactly this
guarantee, so a thrown error rolls back every op of that import. Per-row *skips* the director was
shown in the preview remain skips (they are decisions, not failures); an *unexpected* failure aborts
the whole import and is reported as one line naming the row it failed on. Red Hat reviews the
write path (§8). This is **part 2** of the ticket; part 1 (the binder, §4.1–4.8) lands first.

Acceptance for part 2: a fixture import with an injected failure on row N leaves the database
byte-identical to before the import (proven by test), and the door reports the failure and the row.

## 5. Acceptance criterion 1 — export → re-import → identical state

**Test:** build a fixture camp's entities in memory, run `buildCampDataWorkbook` (or
`exportWorkbook` for the six entities it covers — both header vocabularies must round-trip, so the
test exercises both) to produce a workbook, feed that workbook through each of the seven doors'
`readEntitySheet` → `inferEntityMapping` → `applyEntityMapping` → existing per-screen parse/commit
path against a **fresh** camp, and assert the result.

**"Identical" — precisely, because generated ids make byte-for-byte equality wrong:**

- **Compared by natural key, not by database id.** Import always mints new ids
  (`crypto.randomUUID()` in every screen's `confirmImport`); a re-import test asserting id equality
  would be asserting something the write path was never designed to preserve. The natural key is the
  same one each screen's existing dedup logic already uses: `label` (Days), `name` (Groups, Tiers,
  Activities, Locations, Anchors/fixed events by name), `name` (TimeBlocks).
- **Fields compared:** every field the entity's field catalogue names as a role (§4.1) — i.e. every
  field the export writes and the import reads. Not compared: `id`, `camp_id`, `created_at`/
  `updated_at`, `deleted_at`, and any field the export deliberately omits (buildCampDataWorkbook.js
  is explicitly a read-only document view and does not claim to carry every column).
- **Foreign keys compared by the NAME they resolve to, not the numeric id** — `tier_id` on a
  re-imported Group must resolve to a Tier with the same `name` as the source camp's Tier, not the
  same `id` (ids differ by construction). Same rule for `location_id`, `weather_alternative_id`,
  `eligible_tier_ids`/`eligible_group_ids` (compared as name sets), `time_block_id`, `day_id`.
- **Ordering:** for the four `ordered: true` entities (Tiers, TimeBlocks, Locations, Days), the
  re-imported rows' relative order (by `sort_order`) matches the source, since `sort_order` is an
  exported, re-imported field, not a derived row index (this repeats an existing constraint —
  "RISK E" in both `exportWorkbook.js` and `buildCampDataWorkbook.js`'s own comments — the test
  merely holds importers to the same rule the exporters already state).
- **Row count and row set:** the set of natural keys after re-import equals the set before export —
  no row silently dropped, no row silently duplicated.

**Predicate a Verifier runs:** a new integration test (see §12) that performs exactly the sequence
above and fails loudly (assertion message names the entity and field) on any mismatch. Existing unit
tests for each screen's parse/commit logic are unaffected (they exercise logic downstream of the
binder, which is unchanged) — they are evidence, not proof, that this criterion holds; the new
round-trip test is the proof.

## 6. Acceptance criterion 2 — foreign headers, per door

**Test, one fixture per entity (seven total):** a workbook whose header row uses column names that
are in none of that entity's catalogue synonym lists for its *required* fields, but recognizable for
its optional fields (a realistic "close but not exact" third-party file). Assert:

- the confirm gate is disabled (or the screen shows the corrector) until the director supplies the
  missing required role(s) by hand, reusing `describeMappingReadiness`'s existing contract;
- after a hand-supplied mapping, `confirmImport` proceeds and writes exactly the rows the mapping
  describes;
- the residue report names every column the mapping did not claim, by header text (not a count —
  `residueKinds.js`'s existing distinction between "you can act on this" and "this is a statement of
  fact" applies unchanged).

## 7. Interface-contract checklist

Per `org-interface-contracts`, applied to the new/changed surfaces:

- **Idempotency.** Unchanged: each screen's commit loop already dedups against `existingNames`/
  `existingLabels` (by natural key) before calling `createRecord`, so re-running an import after a
  partial failure skips rows already written. The binder does not touch this loop.
- **Concurrent retries / two devices.** Unchanged and out of scope: setup-door writes are per-row
  `createRecord` calls, replicated by Automerge exactly as they are today; this ADR changes column
  recognition upstream of that write, not the write or its conflict behavior.
- **Unknown outcomes.** Unchanged: `confirmImport`'s existing try/catch-per-row and
  `added`/`skipped` counters are untouched.
- **Error shape.** The binder's output (`{ roles, unrecognisedColumns, unmapped, collision }`) is a
  plain, documented shape mirroring `describeCoverage`'s existing contract — a caller reads
  `unmapped`/`collision` to decide whether to gate the confirm button, exactly as the preference
  importer's caller already does.
- **Scope/authority boundary.** No new IPC handler, no new `PROJECTIONS` entry, no new write path —
  the binder is a pure, renderer-side transform between `readEntitySheet`'s output and each screen's
  existing parse function. The remembered-mapping persistence reuses T312's existing write path
  (`import_decisions`, already `authorize()`-gated and already camp-scoped) unchanged apart from the
  new `kind` values.
- **Trust boundary validation.** The imported file is the trust boundary (already true today); the
  binder validates header text against a declared catalogue and never trusts a column's role without
  either an exact synonym match or an explicit director confirmation. This is a strictly stronger
  validation than today's `requiredColumns` exact-string gate, not a weaker one.

## 8. Write-path risk (Red Hat)

The commit loop this ADR feeds is `repository.createRecord`, called once per row from the renderer,
**not** `commitPlan`/`commitIngest` (`electron/ops/ingest.js`) — the setup doors have never gone
through the privileged committer S4b uses; they write directly, screen by screen, as they do today.
Named risks, all pre-existing and unchanged by this design, flagged because increasing how many
files successfully match (this ADR's entire point) increases how often the existing risk surface is
exercised:

- **No transaction across a multi-row import.** A failure partway through `confirmImport`'s loop
  leaves a partially-imported set; the loop already isolates each row (try/catch, `skipped++`) so a
  bad row does not wedge the whole import, but a crash between rows is not recoverable atomically.
  _Prior: this ADR first marked that out of scope._ **Owner amendment (2026-09-30): IN SCOPE, as
  part 2 of the same ticket — see §4.9.** It is a director-facing defect at the very seam this ADR
  changes, and because the binder makes imports succeed far more often, it will be hit more.
- **No idempotency key on the import itself.** Re-running a failed import relies entirely on
  name-based dedup being correct and stable; the binder does not change what "the same row" means to
  any screen, so this risk is unchanged, but it is worth stating plainly rather than assuming it away
  because the binder now succeeds where it used to silently do nothing.
- **A remembered mapping applied silently is not a new blind write.** The recalled mapping still
  feeds the same preview-then-confirm UI every screen already has; nothing commits without the
  director clicking confirm, whether the mapping came from fresh inference, a hand correction, or
  recall. If the owner wants a self-export/self-import round trip to skip the preview step entirely
  when the mapping is unambiguous, that is a product decision, not assumed here (§13, open question
  1 addresses the adjacent question of shared header vocabulary, not this one — the design as
  written always shows the preview).
- **Cross-entity synonym collision in the remembered-mapping key** was checked directly:
  `headerMatchKey` hashes the sorted set of every header the binding *claims*, not one field alone,
  so a Days-shaped binding (claiming `label`+`day_of_week`+`sort_order`-ish text) cannot be recalled
  against a Groups-shaped file even though both catalogs contain a `name`-like field. Confirmed by
  reading `headerMatchKey`'s implementation (§2.3); no new test needed beyond the existing
  `mappingSeedling.test.js` coverage of this property, extended to a second entity's shape.

## 9. Design-standard obligations (UI-touching)

Per `docs/governance/standards/DESIGN_STANDARD.md`, this change adds a confirm/residue affordance to
seven existing setup screens' import preview step. It must satisfy:

- **§5 States spec** — the mapping corrector and residue list are new content within the existing
  `importStep === 'preview'` state, not a new top-level screen state; they need their own empty
  state (no residue → say nothing, per the existing "otherSheets.length > 0" precedent of only
  speaking when there is something to say), and the existing fatal/error states (`describeWriteFailure`)
  already cover a file that cannot be read at all — unchanged.
- **§8 Motion tokens** — the corrector/residue panel appearing under a preview row is new
  UI, not a route change, so it should use the existing shared enter-transition token
  (`useEnterTransition`, already imported by every one of the seven screens) rather than an
  unanimated appear/disappear. A reduced-motion viewer must still receive the same *information* —
  which columns are unmapped, which are residue — even if the transition itself is suppressed; this
  is a Designer/Maker-level detail once this ADR is accepted, not decided further here.

## 10. Migration / back-compat posture

**Pre-production, no live users (per `CLAUDE.md`, repeated house rule).** No shim, no dual-read
period, no deprecation window. The seven screens' current hardcoded `requiredColumns` behavior is
replaced outright by the catalogue-driven binder in the same change; there is no prior camp data or
external integration depending on the old exact-string behavior to preserve.

## 11. Out of scope

- Changing `exportWorkbook.js` / `commitPlan` / the S4a/S4b enrichment round-trip contract at all.
- Changing `buildCampDataWorkbook.js`'s own behavior — it stays a read-only document view; only its
  *header text* becomes a recognized synonym in the new catalogues.
- The preference-import pipeline (`preferenceSheet.js`, `preferenceImport.js`,
  `mappingSeedling.js`'s preference-specific call sites) — untouched; this ADR reuses its pattern and
  its remembered-mapping table, not its code path.
- Fuzzy/near-synonym matching (Levenshtein-distance-style "did you mean") for residue columns —
  exact folded-synonym matching only, per §4.2; a near-miss is reported as residue and left to the
  director, not guessed at.
- A single, cross-entity, whole-workbook importer replacing the seven per-screen doors (§3, rejected
  cluster) — a legitimate future direction, not this ADR.
- Content/type-based column inference from sample row values (§3, rejected cluster) — excluded on
  the standing header-text-only privacy invariant.

## 12. Files/modules affected

New:
- `src/ingest/entityColumnMapping.js` — `ENTITY_FIELD_CATALOGS`, `inferEntityMapping`,
  `applyEntityMapping`, reusing `describeCoverage`-equivalent residue/unmapped/collision logic
  generalized off `preferenceSheet.js`.
- A round-trip integration test exercising §5's predicate (exact location left to Maker/Verifier;
  natural home is alongside `src/utils/buildCampDataWorkbook.test.js` and
  `src/utils/exportWorkbook.test.js`, or `test/integration/` if it needs the full commit path).
- Seven foreign-header fixtures + tests for §6's predicate, one per entity.

Changed:
- `src/ingest/mappingSeedling.js` — `SINGLE_ROLES` becomes a parameter instead of a hardcoded
  preference-specific constant; `bindingFromMapping`/`mappingFromBinding`/`recallColumnMapping`
  signatures gain a `fieldKeys`/`catalog` parameter. Existing preference call sites pass the current
  hardcoded list so behavior there is unchanged.
- `src/screens/DaysScreen.jsx`, `GroupsScreen.jsx`, `ActivitiesScreen.jsx`, `AnchorsScreen.jsx`,
  `TiersScreen.jsx`, `TimeBlocksScreen.jsx`, `LocationsScreen.jsx` — `onFileChange` calls
  `inferEntityMapping`/`applyEntityMapping` on `readEntitySheet`'s output before the existing
  per-row parse block; the preview step renders the mapping corrector when `unmapped`/`collision` is
  non-empty; `confirmImport` gains the same enable/disable gate `describeMappingReadiness` already
  gives the preference importer.
- `electron/ops/rememberColumnMapping.js` — extended (or a sibling added) to write/read the seven new
  `setup_column_roles:<entity>` `kind` values through the existing `import_decisions` write path.
- Possibly a shared corrector component, if the preference importer's existing mapping-correction UI
  is extractable rather than duplicated seven times — a Designer/Maker decision, not architecturally
  load-bearing either way (§13 does not need to gate on this).

Unchanged (read, not modified, to ground this design):
- `src/utils/exportSanitize.js` (`readEntitySheet`, `readWorkbookSafely`) — reused as-is.
- `src/utils/buildCampDataWorkbook.js`, `src/utils/exportWorkbook.js` — reused as header sources
  only.
- `electron/ops/ingest.js` (`commitPlan`, `commitIngest`) — confirmed untouched; setup doors do not
  route through it.
- `src/ingest/residueKinds.js`, `src/ingest/decisionJournal.js` — reused vocabulary/pattern, no
  change needed.

## 13. Open questions for the owner

**Resolved 2026-09-30 (owner, "go for it", via the organizer): all three to this ADR's own defaults — (1) bridged synonyms now, no vocabulary convergence; (2) remembered mapping stays per camp as T312; (3) a whole-workbook importer is a future ticket, not this one.** The questions are kept below as asked.

1. **Should the export headers and the import catalogue converge on one canonical human-readable
   vocabulary** (i.e., also rename `exportWorkbook.js`'s raw-key headers like `unit`/`label` to match
   `buildCampDataWorkbook.js`'s human headers like `Age Division`/`Day of Week`), or is it acceptable
   for both existing header spellings to remain synonyms the catalogue bridges, as designed above?
   The design as written needs no product decision to proceed — it treats both as synonyms — but a
   single vocabulary would be a smaller catalogue and a cleaner story if the owner wants it.
2. **Is a remembered column mapping scoped per camp only** (T312's existing precedent, which this
   ADR reuses unchanged), **or should some mappings also be recognized camp-agnostically** — e.g. a
   common third-party camp-management product's export shape, recognized for any camp that uploads
   it? The design as written is per-camp only; a camp-agnostic library would be new schema and a
   privacy question (whose header vocabulary is being fingerprinted and shared across camps) worth a
   separate ruling if wanted.
3. **Is the single, cross-entity, whole-workbook importer** (rejected in §3 as out of scope for this
   ADR) **worth its own future ticket**, replacing the seven per-screen "Import from Excel" entry
   points with one upload that infers which rows belong to which entity? Recorded here so it is not
   lost, not because this ADR needs an answer to proceed.
