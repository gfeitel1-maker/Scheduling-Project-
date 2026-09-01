---
title: "Current Ingestion Capabilities — What Exists and Must Be Preserved"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Current Ingestion Capabilities

Verified against the code on `main` (repo `~/dev/shoresh`) on 2026-08-08.
This document establishes the load-bearing behaviour the onboarding/reconciliation program
**inherits and must not break**. It is the counterpart to `SOURCE_FAMILIES.md` (which adapters
feed this pipeline) — every source family emits into the machinery described here, and every
future slice (S0 onward) must preserve the guarantees below or re-earn them with an ADR.

The governing framing: the current importer is a *strangler-fig host*, not scaffolding to be
replaced. The `ReconciliationPlan` spine is being grown **inside** this pipeline precisely
because these guarantees already hold and re-inventing them would re-pay costs the codebase
already paid (see ADR `2026-08-01-ingesting-a-prior-year-schedule.md`).

---

## 1. What EXISTS today (preserve; do not rebuild)

### 1.1 The four-stage pipeline
`read → propose → NON-SKIPPABLE preview → atomic single-transaction commit.`

- The **shape of the screen is the decision**: there is no code path from a file to the
  database that skips proposal + preview. `ImportScreen.jsx` states this explicitly
  (`src/screens/ImportScreen.jsx:14-24`) — every row arrives pre-checked but the director's
  approval is a real act, not a formality. This is the ADR §1 guarantee that "a wrong guess
  written silently into a camp's setup is the failure this feature must not have."
- Preserve this pipeline whole. The program adds identity/merge/provenance/staleness *within*
  read→propose→preview→commit; it does not add a bypass. The workbook round-trip (S4) and any
  in-app editor are **renderings of the same plan through the same non-skippable preview + atomic
  commit**, never a shortcut.

### 1.2 Entity whitelist — six setup entities, never placements
- `INGESTIBLE_ENTITIES = ['cohorts','tiers','groups','days_of_operation','time_blocks','activities']`
  is frozen and enforced twice: at the renderer (`extractEntities.js`) and again as a hard error
  at the write boundary (`electron/ops/ingest.js:25-27`, `commitIngest` guard at `:232-236`).
- Placements are deliberately *not* ingestible even though the parsed grid contains them
  (`ingest.js:6-11`). A request to ingest anything off-whitelist is a hard throw, not a silent
  skip (`ingest.js:200-206`, `fieldsFor` default at `:100-104`) — "entities only" is a scope
  decision that must be reopened deliberately, never by accident.

### 1.3 Shared grid intermediate; parser is the only format-specific part
- All formats normalize to a **grid-of-cells** before extraction. `extractEntities` consumes
  `{ pages }` regardless of source format (`ImportScreen.jsx:143`). Excel goes through
  `workbookToPages` (`sheetGrid.js`), text/CSV/TSV through `parseTextGrid` (`textGrid.js`),
  selected in `readFiles` (`ImportScreen.jsx:121-134`).
- Formats supported: **Excel (.xlsx/.xlsm/.xls) + text/CSV/TSV** (`ImportScreen.jsx:373`).
  PDF is expected as **pre-extracted text** — there is **no OCR** and **no paste/clipboard UI**
  in the import path today. A scan with no text layer is rejected with an honest message
  (`ImportScreen.jsx:137-141`).
- Extraction is layout-aware: orientation is **auto-detected** (`detectOrientation`,
  `extractEntities.js:236,250`), units inferred from bunk-name / positional codes, wrapped cells
  reassembled (`textGrid.js:340-366`), across **4 real layouts**. Preserving the grid seam is
  what lets a new source family be *just a new parser* (see `SOURCE_FAMILIES.md`).

### 1.4 Inference lives in the PREVIEW layer only — never persisted
- Confidence/inference signals — `_inferred`, `confidence` (high/low), `eligibility_known`,
  seen-counts — exist only while the director is reviewing. `buildPreview` computes
  `lowConfidence` and `counts` (`preview.js:95-113`); the screen holds `_inferred` /
  `eligibility_known` in React state and **clears `_inferred` on edit** so styling flips from
  proposal to director-owned value (`ImportScreen.jsx:220-241,698-706`).
- After commit, rows are **ordinary records** — no confidence column, no provenance, no
  "still inferred" marker survives (`ImportScreen.jsx:335-336`: "They are ordinary records now").
  This is the ancestor of the persisted-provenance work (spine C): the *concept* of
  inferred/confirmed/unknown already exists in preview; it simply evaporates at commit today.

### 1.5 Atomic, op-log commit — one transaction, field-level ops, restorable tombstones
- `commitIngest` runs the **entire import inside one `db.transaction()`** (`ingest.js:302-457`):
  a partial ingest that half-populates a camp is worse than a clean failure (T16), so any throw
  rolls back every op and every projected row together.
- Every write is a **field-level `appendOp`** (`ingest.js:374-386`), never raw SQL and never a
  single `bulk_replace` op. Deletes (in replace mode) are `__deleted__` tombstone ops that stay
  **Trash-restorable and replicate to peers** (`replaceScope`, `ingest.js:107-197`, esp.
  `:117-136`) — deliberately not `ON DELETE CASCADE`, because a cascade writes no ops and the
  op-log *is* the replication mechanism.
- **Host-only.** The atomic multi-op transaction can only be expressed on the main computer;
  a Client cannot express a multi-op atomic tx over `submit_op`. Admin-gated + host-only refusals
  surface as director-readable messages (`ImportScreen.jsx:299-309`; enforced in
  `electron/main.js:238`, IPC `shoresh:ingest-commit` at `main.js:1009`, `preload.js:58`).
- **This single-transaction, 1-op-per-field shape is the invariant the `ReconciliationPlan` must
  respect.** The plan is a decision layer whose items translate 1:1 into `appendOp` calls inside
  *this* transaction; a coarser plan shape re-creates the bulk_replace parallel-write mess the
  codebase already paid for. Preserve the field-level granularity.

### 1.6 The `add` vs `replace` modes — and the replace-scope footgun
- `commitIngest` takes `mode` (`ingest.js:228`). Anything not the literal string `'replace'`
  is treated as `add` (`ingest.js:309`), so every pre-T61 caller keeps working.
- **`add`** — append-only. Name-matches are **skipped, never updated** (`buildPreview` emits
  `create` / `skip` only, `preview.js:74-89`). There is **no update path in add mode**: a
  re-imported, corrected row does not update its live counterpart; it is skipped as a duplicate.
- **`replace`** — runs `replaceScope` *first*, inside the same transaction, then recreates
  (`ingest.js:309-312`). **FOOTGUN:** `replaceScope` deletes `WHERE camp_id = ?` **with no cohort
  filter** — it wipes the **whole camp scope, every Program, ignoring the active-Program filter**
  the rest of the screen respects (`ingest.js:181-185`; the UI compensates by counting camp-wide,
  `ImportScreen.jsx:66-72,94-97,555-565`). It is mitigated — admin-gated, host-only, atomic,
  FK-checked (`ingest.js:191-194`), and every deletion is a restorable tombstone — but a
  multi-Program camp can still lose every Program's setup from a single confirm. Saved schedule
  **snapshots are the one item Replace makes permanently unrestorable** (they name ids that no
  longer exist, `ImportScreen.jsx:612-618`).
- **Decision already recorded (§2 of synthesis source):** the replace footgun is fixed as a
  **standalone hardening ticket, independent of this program**. This doc names it so no slice
  silently depends on the current whole-camp blast radius.

### 1.7 Two divergent import paths — no shared reconciliation layer
There are already **two ways data enters a camp**, and they do **not** share a reconciliation layer:

1. **The schedule importer** described above (`ImportScreen.jsx` → `commitIngest`).
2. **Per-screen `downloadTemplate` xlsx + upload**, present on Groups, Activities, Time Blocks,
   Tiers/Units, Days, and Anchors/Fixed Events (`TiersScreen.jsx`, `GroupsScreen.jsx`,
   `DaysScreen.jsx`, `TimeBlocksScreen.jsx`, `ActivitiesScreen.jsx`, `AnchorsScreen.jsx`).
   `exportSchedule.js` exports a built schedule to xlsx; `useClipboardSelection.js` does
   schedule copy/paste.

Both paths use the same `normalizeName` rule (`preview.js:44-46`) — "or the same file imported two
ways gives two different camps." **The current per-screen templates are the prior art** the program
builds on; the owner has decided *not* to source the retired original scheduler repo (`legacy/`
holds only the retired Supabase code). Unifying these two paths behind one `ReconciliationPlan`
is the point of S4.

### 1.8 Matching semantics that exist today
- Matching is **normalized-NAME only**. `normalizeName` = trim / lowercase / collapse-whitespace
  (`preview.js:44-46`); resolution maps at commit are keyed on it (`seedNameMaps`,
  `ingest.js:269-284`). No stable IDs are surfaced, no alias table, no fuzzy ranking.
- Preview is **New-vs-Skip only** — `create` and `skip` buckets, the latter carrying `matched`
  and a `reason` of `already-in-camp` or `repeated-in-file` (`preview.js:74-89`). There is **no**
  Updated / Unchanged / Clear / Conflict bucket and **no field-level diff**.
- Matching is only ever **name→id at commit against the live DB** (`seedNameMaps`,
  scoped by cohort for Program-scoped entities, `ingest.js:270-283`). This is the embryo the
  spine's `ReconciliationPlan` extends (name→id / alias resolution at commit).

---

## 2. What is ABSENT today (the gap the program fills)

None of the following exist in the current code. Each is a first-class deliverable of the program;
listed here so a reviewer can confirm "not built" rather than "hidden somewhere":

- **Stable identity / synced `source_aliases`.** Matching is name-only; there is no UUID→source-id
  →alias hierarchy, no alias table, no revocable/reviewable alias record. (Spine A.)
- **Alias / cross-source label reconciliation.** No `source_label`↔entity mapping exists.
- **Field-merge on re-import.** `add` mode cannot update a matched row at all; there is no
  field-level `{from,to,source}` merge. (Spine B.)
- **Updated / Unchanged / Clear / Conflict preview states.** Preview is New-vs-Skip only
  (`preview.js:74-89`). No field-level before→after diff; no dry-run diff object that re-runs
  verbatim at commit; no idempotent all-Unchanged / zero-op outcome.
- **Multi-source / cross-source authority.** One import reads one set of files into one proposal;
  there is no per-field authority by source family and no first-class Conflict holding competing
  values. (See `SOURCE_FAMILIES.md`.)
- **Location as an entity.** `location` is a free `TEXT` column on `activities`
  (`electron/db/schema.sql:211`); **`activity_locations` does not exist** (confirmed: zero
  references in `electron/` or `src/`). Note the engine *already uses* the location string for
  simultaneous-use contention (`locationKey`, `buildSchedule.js:186,202,225-226`), and
  `is_outdoor` is a **separate** boolean that must not be absorbed into a Location entity.
  Location text under activities is currently **stripped and discarded** by the 4th-layout parser
  (`textGrid.js:301,349-366`) — the data is thrown away today.
- **Staffing model of any kind.** `users.role` is auth-only (admin/staff); no requirement,
  assignment, or availability concept exists.
- **Persisted provenance.** No `confirmed` / `source` per-row columns; inference signals live only
  in preview and vanish at commit (§1.4). No staleness / happens-before mechanism — there is no
  way for a re-import to detect that a supplied value is older than the field's last authoritative
  write, so a stale source would silently overwrite a director's hand-edit if an update path
  existed at all.

---

## 3. Preservation checklist for every future slice

A slice is only allowed to land if it keeps all of these true (the S0 "behaviour provably
unchanged / golden-ops" gate exists to prove exactly this):

1. Read→propose→**non-skippable** preview→**single-transaction** commit stays intact.
2. Only the six whitelisted entities are created by import; placements never are.
3. Every write is a field-level `appendOp` inside one transaction; deletes stay restorable
   tombstones; commit stays host-only. No `bulk_replace`, no raw SQL, no cascade.
4. `normalizeName` remains identical across both import paths.
5. Inference/provenance is honest — absence of evidence never renders as a muted confident default.
6. The replace blast radius is only ever *narrowed* by the standalone hardening ticket, never
   widened by a program slice.

See `SOURCE_FAMILIES.md` for how each kind of source feeds this pipeline and what each can and
cannot tell Shoresh.
