---
title: "Enrichment-workbook round-trip (S4)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: implemented
program: onboarding-reconciliation
depends_on:
  - docs/adr/2026-08-08-export-formula-injection-sanitizer.md
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
  - docs/adr/2026-08-08-s2c-activity-and-group-field-update.md
  - docs/adr/2026-08-08-t73-held-import-resolution-recommit.md
affects:
  - src/utils/exportSchedule.js
  - src/ingest/buildPlan.js
  - src/ingest/preview.js
  - electron/ops/ingest.js
  - src/screens/ImportScreen.jsx
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
---

# Enrichment-workbook round-trip (S4)

> **RE-SCOPED 2026-08-08 after Red Hat (Resilience 2/5) + Security review.** The original premise —
> "one new tier + one live arm on landed machinery" — was **false against the code**: the field-update
> seam the round-trip rides did not exist for the high-value fields (now **[S2c](2026-08-08-s2c-activity-and-group-field-update.md)**,
> a foundational prerequisite), and the diff-vs-live approach mis-held on untouched drifted cells. This
> ADR now (a) **depends on S2c** for all field diffing/writing, (b) replaces workbook-vs-live diffing
> with **baseline diffing**, (c) makes `base_generation` an **active gate**, (d) hardens the read adapter
> with an **allowlist**, and (e) wires `missing_target` + a **real `clear` arm** into `commitPlan` as
> HELD-not-throw. Every Red Hat/Security finding is resolved in §2–§6 below.

**Status: PROPOSED.** S4 is the slice that **unifies the two import paths**. Shoresh exports an xlsx
pre-populated with what it already knows — one sheet per ingestible entity, a stable **`shoresh_id`**
column, and the director-editable fields — the director fills/corrects it, and it re-enters through the
**same** `buildPlan → preview → held/T73 → commitPlan` pipeline the clipboard/schedule path uses. The
workbook is a **rendering of the `ReconciliationPlan`, never a bypass** (ONBOARDING_UX_OPTIONS §7,
invariant 2).

S4 turns on the two remaining fenced-off capabilities the prior slices deliberately left inert:

1. The **identity-by-id match** at the top of the hierarchy (`buildPlan`), so a row carrying a Shoresh
   id matches its entity directly and never re-ambiguates.
2. The **`op:"clear"` arm** in `commitPlan`, driven by an explicit **`<clear>` token** — the tri-state
   encoding that a raw file could not express (S2b §4; MATCH_AND_MERGE_SEMANTICS §3).

It clears the ADR bar by (a) defining a new persistent-ish artifact contract (the workbook column/sheet
layout other code and directors depend on), (b) making a not-obviously-reversible product decision (the
clear-token encoding), and (c) turning two typed-but-throwing commit arms into real behavior.

---

## Context — what already exists to build on

- **`buildPlan`** (`src/ingest/buildPlan.js`) already emits `create / unchanged / update / conflict`
  and already carries a `CLEAR` sentinel (line 22) and an `evidence.tier` field. It matches **by
  normalized name only** today — it has no id-match tier.
- **`commitPlan`** (`electron/ops/ingest.js`) already writes `create`/`update`, gates `stale`/`ambiguous`
  conflicts through the **hold-the-whole-import** sentinel, honors **T73 resolutions**, and stamps
  `source:'import'`. Its `clear` arm **throws** ("not implemented at S1a", ~645).
- **The Plan type** (`RECONCILIATION_PLAN_TYPE.md`) already specifies the `clear` op walk §2(d), the
  `uuid`/`source_id` evidence tiers §(evidence), and `to: CLEAR` as the distinct clear sentinel §3.
- **The xlsx machinery**: `exportSchedule.js` (schedule export) and six per-screen `downloadTemplate`s
  build sheets with `XLSX.utils.aoa_to_sheet`; `ImportScreen.jsx` reads workbooks with `XLSX.read` /
  `sheet_to_json` and builds the `existing` snapshot + `buildPreview`. S4 reuses all of it.
- **The sanitizer** (companion ADR) is a hard precondition — the workbook must be written through it.

So S4 adds **one new export module, one hardened read adapter, one new matching tier, and two live
commit arms (`missing_target`, `clear`)** on top of **S2c's field-update seam** — it invents no new
pipeline, and it no longer pretends the field-diff machinery already covers the rule fields (it does not;
that is S2c).

### Candidate approaches considered

- **A. Workbook writes directly to the DB (a second commit path optimized for bulk).** *Rejected* —
  violates the program's load-bearing invariant (one reconciliation layer, workbook is never a bypass).
  It would re-introduce the two-paths-disagree bug the program exists to kill.
- **B. Workbook re-enters through `buildPlan`/`commitPlan`, matching by a stable id column (chosen).**
  One layer, two faces. The id column makes re-import unambiguous (no re-running the name hierarchy on
  data Shoresh itself emitted); the identical preview/held/commit path guarantees the two faces cannot
  diverge. **Selected.**
- **C. Match the re-imported workbook by name (reuse the existing tier, no id column).** *Rejected* —
  throws away the one advantage a Shoresh-generated file has (it knows the exact entity), forcing every
  round-trip back through name-ambiguity resolution and making a director's rename in the sheet look like
  a delete+create instead of an update. The id column is the whole point.

---

## Decision

### 1. Export — the enrichment workbook

A new renderer module **`src/utils/exportWorkbook.js`**, built **on the shared sanitizer** (companion
ADR), produces one workbook with **one sheet per ingestible entity** plus a hidden metadata sheet.

**Sheet layout** (columns left-to-right; `shoresh_id` is always first and frozen):

| Entity (sheet)      | Columns                                                                 |
|---------------------|------------------------------------------------------------------------|
| Programs (cohorts)  | `shoresh_id`, `name`, `Status`                                          |
| Units (tiers)       | `shoresh_id`, `name`, `Status`                                          |
| Groups              | `shoresh_id`, `name`, `unit`, `availability`, `Status`                 |
| Days                | `shoresh_id`, `label`, `Status`                                        |
| Time Blocks         | `shoresh_id`, `name`, `start_time`, `end_time`, `Status`              |
| Activities          | `shoresh_id`, `name`, `priority`, `min_per_week`, `max_per_week`, `eligible_groups`, `location`†, `Status` |

† `location` column ships only once S3 lands `activities.location_id`; until then it is omitted, not blank.

- **`shoresh_id`** is the entity's live Shoresh **UUID**, pre-filled for every existing row. It is the
  match key on re-import (§2). A director who adds a **new** row leaves it **blank** → that row is a
  `create`. The column is labeled with a plain-language note ("Do not edit — Shoresh uses this to match
  your changes") and, where the xlsx build supports it, locked/greyed.
- **Editable fields** are exactly the director-editable ones the synthesis names (frequency =
  `min_per_week`/`max_per_week`, `priority`, `location`, eligibility = `eligible_groups`). Structural
  facts the director should not free-type (foreign ids) are rendered as **human labels** (`unit` name,
  `eligible_groups` as a comma-separated list of group names), resolved back to ids on re-import through
  the same name maps `commitPlan` already builds.
- **Inferred-vs-confirmed is conveyed by the `Status` column** carrying the three-look vocabulary as
  **words**: `Inferred` / `Confirmed` / `Unknown` (ONBOARDING_UX_OPTIONS §7/§9). The Status column is the
  **load-bearing, portable** conveyance — it survives any spreadsheet app. Cell **fill/greying** that
  mirrors the on-screen muted/full/worth-checking treatment is a **best-effort visual enhancement** layered
  on top **only where the project's `xlsx` build emits cell styles**, and — per sanitizer ADR §2a (F3) —
  **the styling mutates an already-`aoaToSanitizedSheet`-built worksheet** (`!cols`/`!protect`/existing
  cells' `.s` only), **never a hand-built `.v` cell object** that would bypass the sanitizer. `Status` is
  **read-only metadata** on re-import — never a field, never diffed.
- **`sort_order` is exported as the PERSISTED value** read from the DB, never a row index (RISK E). If a
  sheet column surfaces order at all it carries the stored `sort_order`; the export never re-derives it
  from position. (S2c already guarantees a recognized diff ignores index-derived fields; S4a's obligation
  is to *emit* the persisted value so an untouched order round-trips to no delta.)
- **Time columns are canonical and text (RISK F).** `start_time`/`end_time` are written in the DB's
  canonical `HH:MM:SS` form (matching what the DB stores, `"08:40:00"`), and their columns are forced to
  **text** (`ws['!cols'][i] = { … }` + cell type `s`) so Excel cannot coerce `08:40` into a time serial
  (number/Date). The importer canonicalizes both sides identically (S4b) so a round-tripped block diffs
  to `unchanged`.
- **Read-only structural columns.** `shoresh_id`, `Status`, and the group **`unit`** column are marked
  read-only in the export (locked/greyed where styles emit; always documented in the header note).
  `unit` **edits ARE in scope** for update (S2c makes `groups.tier_id` diffable) — but the export renders
  it as a **validated label**, and S4b's header allowlist treats a changed `unit` label as an update while
  `shoresh_id`/`Status` are **never** read as fields (Security F1).
- **The export ships the BASELINE (RISK D).** Alongside `shoresh_id`, the hidden metadata sheet records,
  per row+column, the **exact value the export wrote** (the baseline snapshot, keyed by `shoresh_id`).
  This is what lets re-import diff **workbook-cell-vs-baseline** (what the director actually *changed*)
  rather than workbook-cell-vs-live — so a cell the director never touched produces **no delta even if
  the live value drifted** under a concurrent edit. Without it, one drifted untouched cell holds the whole
  import. The baseline is transient workbook metadata, not persisted DB state.
- **Metadata sheet** (hidden): `plan_version`, `camp_id`, `cohort_id`, the per-row **baseline** (above),
  and a **`base_generation` stamp** (foundation D "pin to base version-vector, warn on drift"). This is
  what lets a workbook filled against a stale export be caught at re-import (§4). The metadata sheet is
  **required**: a re-import whose metadata is missing, unparseable, or camp-mismatched **fails closed**
  (§4), never defaults.

### 2. Re-import — the id-match tier goes live in `buildPlan`

A new read adapter **`workbookToSource(workbook)`** (in `src/ingest/`) parses each entity sheet back into
the **S2c per-row record** `{ id?, name, fields:{}, clears:[] }` (it fills the `id` and `clears` slots
S2c cut for exactly this). It applies the sanitizer's **conditional** apostrophe unescape
(`unescapeCell`, companion ADR §3 — strips only an apostrophe guarding a trigger char, never one guarding
ordinary text), maps `unit`/`eligible_groups` labels through, and carries each row's **`shoresh_id`** and
its **per-field `<clear>` tokens**.

**Hardening — sheet→entity and header→field ALLOWLIST (Security F1, CRITICAL).** The entity name flows
into interpolated SQL (`buildExistingSnapshot` ~191, `seedRecognitionMaps` ~356, `replaceScope`,
`idExists` ~369) — today safe *only* because the entity comes from the frozen `INGESTIBLE_ENTITIES`. A
crafted **sheet name** would be an identifier/SQL-injection vector, and a crafted **header** would write
to a privileged column (which `<clear>` could then null). `workbookToSource` therefore:

- Maps each sheet to an entity through a **hardcoded sheet→entity table**; an unknown sheet is **dropped**
  (never interpolated).
- Reads only headers in a **per-entity field allowlist** (exactly the editable columns S4a exports);
  an unknown header is **dropped**.
- Treats `shoresh_id` and `Status` as **read-only** — `shoresh_id` is the match key, `Status` is ignored;
  neither is ever a field or a clear target.

**Baseline diff (RISK D).** `workbookToSource` reads the per-row **baseline** from the metadata sheet and
puts into `record.fields` **only the cells whose current workbook value differs from the baseline** — i.e.
what the director actually changed. An untouched cell contributes **nothing** to `fields`, so it can never
diff against a drifted live value. (S2c then diffs those changed cells against live for the Policy-A gate;
an unchanged-by-director cell is simply absent.)

**Force `mode:'add'` (RISK L).** The workbook path **hard-forces `mode:'add'`** and rejects any replace
signal, so `replaceScope`'s delete-by-row-omission can never be triggered by a workbook (a bulk-enrichment
file that happens to omit rows must never delete them). A test asserts a workbook cannot reach
`replaceScope`.

**Intra-sheet id hazards (RISK J/K).**
- **Duplicate `shoresh_id` across two rows** → detected in `workbookToSource` and surfaced as a
  `duplicate_id` conflict (held), never two silent LWW updates to one entity.
- **Blank `shoresh_id` on a row whose `name` matches an existing entity** → flagged as a
  `possible_lost_id` conflict (held), not a confident create — a director who cleared the id column and
  renamed nothing should not silently duplicate an entity.

`buildPlan` gains a **top-of-hierarchy id match**, ahead of the existing name tiers:

- **Row carries a `shoresh_id` that exists in the `existing` snapshot** → matched directly to that entity,
  `evidence.tier: "uuid"`. It runs the **same field diff S2b already implements** → `unchanged` (zero ops)
  or `update` (changed fields only). **No name-ambiguity is ever run** for an id-matched row — that is the
  round-trip guarantee.
- **Row carries a `shoresh_id` that is NOT in the snapshot** (the entity was deleted in the review window,
  or the id is foreign/hand-mangled) → **`op:"conflict"`, reason `missing_target`** — surfaced, never
  silently downgraded to a `create` (a silent create would duplicate an entity the director meant to
  edit). This is a new conflict reason; it is gated exactly like the others (collected into `conflicts`,
  trips hold-the-whole, no op).

  **This MUST be wired into `commitPlan` before `buildPlan` can emit it (RISK H).** Today the
  `case 'conflict'` gate (`ingest.js` ~639) accepts only `ambiguous_identity`/`stale` and **throws** on
  any other reason → an emitted `missing_target` would **crash** the import instead of holding (the `:750`
  catch only recognizes the `HELD` sentinel). S4b adds `'missing_target'` (and S2c's `'validation'` /
  `'eligibility_unresolved'`, and `'duplicate_id'` / `'possible_lost_id'` above) to the accepted set so
  they route to `conflicts` → HELD, no throw. The commit-time id re-check (`idExists`) also re-emits
  `missing_target` if the row's target was deleted in the review window.
- **Row with a blank `shoresh_id`** → falls through to the **existing** name hierarchy unchanged
  (exact-name → create). A director's new row behaves exactly like a clipboard/schedule new row.

**On the tier naming (open question #1 for Governor).** MATCH_AND_MERGE_SEMANTICS §1 lists the workbook
under **tier 2 "source_id"**, while also defining **tier 1 "uuid"** as "the item already carries a stable
Shoresh id (round-trip case)." Because the workbook carries Shoresh's **own UUID**, the truthful match is
**tier 1 (uuid)**. This ADR designs it as the **uuid tier** and recommends **reserving tier 2 (source_id)
for genuinely foreign source-system ids** (a future integration). Functionally identical either way (both
are the top, deterministic, id-based tiers); the recommendation is to record the workbook as `uuid`, not
`source_id`, so the evidence tag is not misleading. Flagged for Governor to ratify against the synthesis.

Everything else is **untouched**: the plan flows into `commitPlan`, hits the same commit-time
re-resolution, the same **T73 held/resolution/recommit** loop, the same atomic transaction. **The workbook
is not a bypass** — it produces the same `New/Updated/Unchanged/Clear/Conflict` diff and the same preview
(invariant 2).

### 3. The `<clear>` token and the live `op:"clear"` arm

**The canonical `<clear>` rule.** A cell is a clear **iff**, after `trim()`, it exactly equals the literal
`<clear>` (case-sensitive, exact). `workbookToSource` records that field name in `record.clears`; S2c's
per-row record already carries the `clears` slot. Rules:

- **Empty cell is always "blank = preserve"** (no delta, no op), per MATCH_AND_MERGE_SEMANTICS §3 — never
  a clear. Only the explicit `<clear>` token clears.
- **`<clear>` on a never-set field is a NO-OP** — not a spurious `null` op. If the field has no live value
  (and no prior op), there is nothing to remove; the clear produces no delta. (Prevents a wall of empty
  clears turning into empty ops.)
- **`<clear>` maps to a `FieldDelta` `to: CLEAR`** (the sentinel already in `buildPlan.js` ~22). A row
  whose only deltas are clears is `op:"clear"`; a row mixing edits and clears carries both and stays
  `op:"update"` — either way each `to: CLEAR` delta is a clear write, gated **per field**.
- **Free-text literal limitation (documented).** A field whose intended literal *value* is the text
  `<clear>` cannot be entered (it will be read as the token). This is a non-issue for camp data (no
  activity/group is named `<clear>`); documented in the in-sheet instruction and here so it is a known
  limitation, not a surprise.

`commitPlan`'s `clear` arm **stops throwing** and becomes real, and — critically (RISK I) — the CLEAR
sentinel must **never leak through `commitUpdate` as a value**:

- **`commitUpdate` special-cases `delta.to === CLEAR`.** Today `commitUpdate` writes `value: delta.to`
  raw — for a CLEAR that would append a **Symbol** as the op value, corrupting the op. S4b makes
  `commitUpdate` translate `CLEAR → null` and write **one field-null `appendOp`** (the same field-null
  path `replaceScope` uses for `weather_alternative_id`, `ingest.js` ~117; `value: null`,
  `source:'import'`, `parent_op_id` = the field's `latestOp().id`). Trash-restorable, replicates like any
  other write (RECONCILIATION_PLAN_TYPE §2(d)). A per-field gate handles a **mixed edit+clear row**: each
  field is independently written-or-held.
- **The Policy-A protection gate applies to clears too — gated ≥ update.** Clearing a field a **human**
  authored is the *most* destructive delta, so it must be **at least as protected** as an update: a clear
  on a human-owned field (`latestOp.source !== 'import'`) is a **gated `stale` conflict**, held, never a
  silent wipe. This is stated explicitly because a clear must not be the delta that skips the gate.
- Clear gets its **own firmer preview treatment** (ONBOARDING_UX_OPTIONS §5: "This removes data. Confirm
  you meant to clear it.") — `buildPreview`/`describePreview` widen to surface the clear state distinctly.

### 4. Staleness pin (foundation D activated for the workbook)

The workbook is exactly the artifact foundation D was designed for, and — per Red Hat (RISK C) —
`base_generation` must be an **ACTIVE GATE in S4b, not deferred to a follow-up.** The reason is decisive:
Policy-A (S2b) only protects fields whose latest op is **non-import** (`human`/`NULL`). An
**import-over-import** write is *unprotected* — so a Tuesday schedule re-import (`source:'import'`) would
be **silently overwritten** by a Wednesday **stale workbook** that was exported before Tuesday's change.
Provenance alone does **not** catch this; the clock must.

- The export stamps `base_generation` in the metadata sheet (the export's version-vector / max op seq at
  export time). `workbookToSource` carries it into `plan.base_generation`.
- At commit, for **every** field the workbook proposes — including import-owned fields Policy-A would wave
  through — S4b compares the field's `latestOp.seq` against the workbook's `base_generation`. If the
  field was **written after** the workbook was exported (`field_last_seq > base_generation`), the workbook
  is **stale for that field** → **`stale` conflict, held**, *even though the field is import-owned*. This
  is the gate that stops import-over-import clobber.
- This rides the **existing** `makeStaleConflict` clock shape (`ingest.js` ~390): the clock field
  (`source_base_seq`) simply becomes **non-zero** for a workbook source where it was inert (0) for a raw
  schedule (S2b §4). The mechanism exists; S4b turns it on.

**Fail closed on metadata (RISK / EDGE).** `base_generation` is read **only** from a present, parseable
metadata sheet whose `camp_id` matches the target camp. If the metadata sheet is **missing, unparseable,
or camp/cohort-mismatched**, the re-import is **rejected before matching** — it must **never** default
`base_generation` to 0 (which would silently disable the gate and re-open the import-over-import hole).
Camp/cohort mismatch is a **hard reject**, not a held import.

---

## Schema — NONE required (confirmed)

**No schema change.** Ids already exist (every entity has its UUID); the workbook is a **transient
artifact** generated on demand and never stored. `base_generation` is read from data the op-log already
carries (op `seq`), not a new column. No source-id **mapping needs persisting**: the workbook carries
Shoresh's own UUIDs, so there is nothing foreign to remember — the match is direct id→entity, which is why
the tier-2 `source_aliases` machinery (S1b) is **not** needed here. Rollback of S4 is a **code revert**;
no data-layer undo. (If a future *foreign*-id integration ever lands, remembering its id→entity crosswalk
would justify persistence then — explicitly out of scope now.)

---

## Scope / split — PREREQUISITE S2c, then sanitizer, then S4a + S4b

The **build order is: S2c → sanitizer → S4a → S4b.** Each is bounded and independently testable.

- **PREREQUISITE — [S2c](2026-08-08-s2c-activity-and-group-field-update.md)** (its own ADR). Completes the
  field-update seam (activity rules, group unit, per-row record, validation on the update path). S4 rides
  it entirely and **cannot ship without it**. S2c is testable and useful on its own via the schedule
  re-import (T35).
- **STANDALONE — the sanitizer** (its own ADR, now carrying F3/F4/F5 + the conditional strip). Lands
  before S4a ships a round-trip workbook.
- **S4a — Export the enrichment workbook.** `exportWorkbook.js` (on the sanitizer, styling-over-sanitized
  per F3), the sheet/column layout, the `shoresh_id` + `Status` columns, **persisted `sort_order`**,
  **canonical text time columns**, read-only `id`/`Status` (and label-validated `unit`), the **baseline**
  + `base_generation` metadata, and the ImportScreen/hub "Download worksheet" entry point. **Bounded, zero
  commit-path risk** — it only *reads* the camp and writes a file.
- **S4b — Re-import via the id tier + live `missing_target`/`clear` + active `base_generation`.** The
  hardened `workbookToSource` adapter (allowlist, conditional unescape, baseline diff, dup-id/blank-id
  detection, forced add-mode, fail-closed metadata), the **uuid match tier** + `missing_target` **wired
  into `commitPlan`'s accepted conflict set (not throwing)**, the live `op:"clear"` arm with `commitUpdate`
  translating `CLEAR → null` (Policy-A-gated), the **active `base_generation` gate** (import-over-import
  staleness), and the preview's clear treatment. Sits on S2c + S1a/S2b/T73.

This ordering means the director gets a **pre-populated, safe-to-open worksheet** (S4a) before the
round-trip write path exists, and S4b is a logic slice on a field-update seam (S2c) that is already
proven by the schedule path.

---

## Completion evidence + test seams

The north-star is the **round-trip**: export → edit a value → re-import updates the right entity **by id**;
blank **preserves**; the clear-token **removes**.

1. **Round-trip update (THE scenario).** Export a camp; change one activity's `max_per_week` in the sheet;
   `workbookToSource` → `buildPlan` matches by `shoresh_id` (`evidence.tier:"uuid"`), emits `op:"update"`
   with only that field; `commitPlan` writes one op; every other row is `unchanged` (zero ops). Fixture:
   a saved exported workbook + an edited copy.
2. **Blank preserves (F5 via the workbook path).** A supplied-blank editable cell on an id-matched row →
   **not in `fields`** → zero ops; the live value survives. Asserted at `buildPlan` and `commitPlan`.
3. **`<clear>` removes.** An id-matched row with `<clear>` in an **import-owned** cell → `to: CLEAR` →
   one field-null `appendOp`; the value is gone and Trash-restorable. A `<clear>` on a **human**-authored
   cell → gated `stale` conflict, **no op**, whole import held (Policy-A applies to clears).
4. **F6 via the workbook path.** Import-write a field, hand-edit it, then re-import a workbook proposing a
   different value → `stale` conflict, no op, held; T73 resolution recommits. (Reuses S2b's F6 anchor,
   driven through the workbook adapter instead of a raw schedule.)
5. **`shoresh_id` integrity.** A row whose `shoresh_id` is absent from the snapshot → `missing_target`
   conflict (never a silent create/duplicate). A blank `shoresh_id` → falls to the name hierarchy →
   `create`. A tampered/foreign id → `missing_target`, held.
6. **Idempotency (F4).** Export then re-import **unedited** → all-`unchanged`, **zero ops** — the
   round-trip is a provable no-op, including that the sanitizer's apostrophe escape did not manufacture a
   spurious diff (ties to sanitizer evidence #3).
7. **Not a bypass.** A workbook re-import producing a conflict is **held** exactly like a clipboard import
   (same `HELD` sentinel, same `conflicts` return shape) — asserted by routing the same conflicting input
   through both faces and comparing the outcome.
8. **Baseline diff (RISK D).** Export; a **peer** drifts an untouched cell's live value; re-import the
   **unedited** workbook → the drifted cell contributes **no delta** (workbook-vs-baseline, not vs-live) →
   all-`unchanged`, zero ops, not held.
9. **Import-over-import staleness (RISK C).** Export Monday (`base_generation = M`); a Tuesday schedule
   re-import writes an **import-owned** field (seq > M); re-import the Monday workbook proposing a
   different value for that field → **`stale` conflict, held**, even though the field is import-owned.
   Proves the active `base_generation` gate, not just provenance.
10. **`missing_target` holds, never crashes (RISK H).** A row whose `shoresh_id` is absent from the
    snapshot → `missing_target` conflict routed to `conflicts` → **HELD** (not a thrown crash). Asserted
    against the `case 'conflict'` accepted-reason set.
11. **CLEAR never leaks as a Symbol (RISK I).** `<clear>` on an import-owned field → `commitUpdate` writes
    a field-**null** op (`value === null`), never a Symbol; a `<clear>` on a **human** field → held; a
    `<clear>` on a **never-set** field → **no op**; a mixed edit+clear row gates each field independently.
12. **Allowlist + forced add-mode + id hazards (Security F1 / RISK L/J/K).** A crafted sheet name / header
    is **dropped** (never interpolated, never written); a workbook can never reach `replaceScope`
    (add-mode forced); duplicate `shoresh_id` → `duplicate_id` held; a blank-id row matching an existing
    name → `possible_lost_id` held. Metadata missing/camp-mismatch → **rejected before matching**.
13. **Canonical time round-trip (RISK F).** A time_block exported as `"08:40:00"` in a text column and
    re-imported unedited → `unchanged`, zero ops (no coercion-driven phantom diff).

Test seams: `buildPlan` (pure — id tier, clear delta, missing_target) and `commitPlan` (clear write +
Policy-A gate) are both directly unit-testable with fixtures, no UI. `exportWorkbook` is asserted by
parsing its own output back (`XLSX.read`) and checking columns/ids/Status/sanitization.

---

## Consequences

- The two import paths are **unified**: the workbook and the clipboard/schedule import are two renderings
  of one `ReconciliationPlan`, sharing preview, held-resolution, and atomic commit. A source imported two
  ways can no longer produce two different camps.
- Directors get **bulk enrichment** (the T35 highest-value gap) without a second, unreviewed write path.
- The tri-state is finally encodable: blank = preserve, `<clear>` = remove — with clears gated by the
  same hand-edit protection as updates.
- No schema, no migration, no new persisted state. S4 is code-reversible.

---

## The clear-token decision — framed for the product owner

**The problem, in one sentence.** In a spreadsheet, an empty cell is ambiguous: it can mean *"I didn't
touch this — leave it as it is"* or *"I want this erased."* Shoresh must never guess wrong, because
guessing "erase" would silently delete a director's data, and guessing "leave" would ignore a director
who genuinely wanted something removed. So Shoresh treats **empty = leave it alone, always**, and needs a
**separate, deliberate way** for a director to say "actually, erase this."

The options, each judged for a **non-technical director**:

- **Option 1 — Type `<clear>` in the cell (RECOMMENDED).** To erase a value, the director replaces it
  with the word `<clear>`. Empty still means "leave alone."
  - *Pros:* Nothing to learn beyond one word; visible right in the cell they're editing; works in every
    spreadsheet app; self-documenting (the exported sheet can pre-print the instruction). Erasing is
    **rare** in enrichment (directors mostly fill and correct, seldom delete), so the small friction lands
    exactly where we *want* friction — on the destructive action.
  - *Cons:* A director could mistype it; a value that literally needs to be the text "<clear>" can't be
    entered (a non-issue for camp data — no activity is named `<clear>`).
  - *Confidence: HIGH.* This is the pattern the synthesis already anticipated and the one that fails safe.
- **Option 2 — A dedicated "Clear?" column per field.** A separate checkbox/column beside each editable
  field; tick it to erase.
  - *Pros:* Unambiguous; no typing.
  - *Cons:* **Doubles the columns** on the Activities sheet (already the widest), making the worksheet
    visually overwhelming for exactly the non-technical director we're designing for. High clutter cost
    for a rare action.
- **Option 3 — A reserved value (e.g. the number `0`, or the word `none`).** Overload an in-band value to
  mean "erase."
  - *Cons:* **Dangerous** — `0` is a legitimate value for `min_per_week`; `none` could be a real label.
    Overloading a real value to also mean "delete" is precisely the silent-data-loss trap the whole
    program exists to avoid. *Rejected.*

**Recommendation: Option 1 (`<clear>` token), HIGH confidence.** It is the least to learn, the most
portable, keeps the worksheet uncluttered, and — most important — it makes *erasing* a distinct, visible,
deliberate act while leaving the safe default (empty = preserve) untouched. Evidence behind the
recommendation: it is the encoding MATCH_AND_MERGE_SEMANTICS §3 and RECONCILIATION_PLAN_TYPE §2(d) were
written against, and clears additionally pass the same hand-edit protection gate as any other change (§3),
so even a mistyped-into-the-wrong-row `<clear>` on a human-authored field is *held for review*, never
silently applied.

---

## Open questions for Governor (product decisions, not technical)

**1. The clear-token encoding — THE decision to bring the owner.** See the framed writeup below.

**2. `uuid` vs `source_id` tier tag** (§2). Recommend recording the workbook match as **tier 1 `uuid`**
(it carries Shoresh's own UUID) and reserving `source_id` for future foreign ids. Needs ratification
against MATCH_AND_MERGE_SEMANTICS §1, which currently files the workbook under `source_id`. Purely a
labeling/consistency call; no behavior rides on it.

**3. `base_generation` activation scope** (§4) — **RESOLVED by the Red Hat review (RISK C):** the
staleness pin is an **active gate IN S4b**, not deferred. Without it, import-over-import silently
clobbers. No longer optional; recorded here as decided.

**4. Baseline storage in the workbook** (§1, RISK D). The baseline is carried in the hidden metadata
sheet (transient, not persisted DB state). Recommend a compact per-row keyed form; confirm no objection
to the metadata sheet growing to hold it (still well under the F4 size cap).
