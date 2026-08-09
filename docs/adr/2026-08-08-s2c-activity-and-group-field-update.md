---
title: "Complete the field-update seam — activity-rule & group fields (S2c)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: implemented
program: onboarding-reconciliation
depends_on:
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
affects:
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
  - docs/work/onboarding-reconciliation/IMPLEMENTATION_SEQUENCE.md
---

# Complete the field-update seam — activity-rule & group fields (S2c)

**Status: PROPOSED.** This is a NEW foundational slice, inserted **before S4**, that the S4 review
(Red Hat 2/5, Resilience) proved is missing. S2b claimed "re-import updates the fields that changed",
but against the landed code that claim is **false for the high-value fields**: `fieldsFor('activities')`
returns only `{camp_id, name}` (`buildPlan.js` ~65) and `COMPARABLE_COLUMNS.activities = []` /
`cohorts = []` (`ingest.js` ~164–171). So `min_per_week`, `max_per_week`, `priority`,
`eligible_group_ids`, and `location` are **never diffed** — a director who edits `max_per_week` and
re-imports gets **zero ops, silently**. Those fields reach the DB **only** through the create-path
`_rule` payload (`commitCreate` ~456–482), which does not run for a recognized row.

S2c completes the update seam so a recognized entity can actually be **updated** in its rule fields, and
groups can be updated in their `tier_id` (unit). It is deliberately **workbook-independent**: it is
consumed by the existing **schedule / clipboard re-import** (feeding the `activityRules` payload through
the update path) and later by the S4 workbook, from the *same* seam. It is what actually delivers **T35
bulk enrichment** — and it ships and is testable with **no workbook, no xlsx, no export**.

It clears the ADR bar by changing an existing contract other modules already call: the `source` shape
`buildPlan` consumes (RISK B), the columns `buildExistingSnapshot` projects, and what `commitUpdate`
does with a delta (validation, FK resolution, set semantics).

---

## Context — what the landed code actually does

- **`source.approved` is `{ [entity]: string[] }`** — bare name arrays (`buildPlan.js` ~120). There is
  **no slot** for a stable id, per-field values, or clear tokens (RISK B). Activity rules ride a
  *side-channel* (`source.activityRules[name]`) consumed **only** by `commitCreate`.
- **The recognized-entity diff** (`emitRecognized`, ~147) diffs `fieldsFor(...)` output against the
  snapshot. For activities `fieldsFor` yields only `{camp_id, name}`, and `COMPARABLE_COLUMNS.activities`
  is empty, so **no rule field is ever comparable** (RISK A).
- **`fieldsFor` derives `sort_order` from the row `index`** (~49, 63). For a *recognized* row this is
  poison: re-ordering/inserting a row shifts every index → phantom `sort_order` deltas → held import
  (RISK E). Index-derived fields must never enter a **recognized** diff.
- **`commitUpdate`** (~509) writes `value: delta.to` **raw** — no int/enum validation (the create path
  has it at ~465–467; the update path does not → `"3 "` writes into an integer field, RISK M), no FK
  resolution, no set semantics.
- **`groups` update** can't change `tier_id`: it is absent from `COMPARABLE_COLUMNS.groups` (RISK O).
- **`eligible_group_ids`** is a JSON array of ids; nothing compares it as an order-independent set, and
  an unresolvable label is silently dropped (create path ~473) (RISK N).

### Candidate approaches considered

- **A. Keep the rule side-channel; special-case activities in the update path.** *Rejected* — leaves two
  shapes for "a field's proposed value" (side-channel for rules, `fields` for everything else); the
  workbook, clipboard, and schedule paths would each wire rules differently and the next field regrows
  the gap. It also can't carry a clear token or an id.
- **B. One per-row source record `{id?, name, fields:{}, clears:[]}` that every adapter produces, and a
  single field-diff/validate/write seam that consumes it (chosen).** The schedule/clipboard adapter
  folds `activityRules`/`links` into `fields`; the workbook adapter (S4b) fills `id`/`clears` too. One
  diff, one validated write, one place to add the next field. **Selected** — it is the smallest shape
  that makes rules first-class *and* leaves a slot for S4's id + clears without another reshape.
- **C. Resolve FK labels (unit, eligible_groups) to ids inside `buildPlan`.** *Rejected* — `buildPlan`
  is pure and holds no DB handle; it cannot map a group name to an id. Resolution must stay at commit
  (where the name maps live), so the diff compares **label forms**, not ids (see §3).

---

## Decision

### 1. The per-row source record (RISK B)

`source.approved[entity]` becomes an array whose elements are **records**, not bare strings:

```
{ id?: string,            // stable Shoresh UUID when the source knows it (workbook); absent otherwise
  name: string,           // the identity label (or `label` for days)
  fields?: { [field]: value },   // explicit proposed values the source actually carries
  clears?: string[] }            // field names the source explicitly clears (S4b only; empty here)
```

- **Degradation of the name-based path (schedule / clipboard).** These sources carry no id and no
  clears. The `commitIngest` adapter (`ingest.js` ~224) normalizes each element: a bare **string**
  becomes `{ name }`; then it **folds the existing side-channels into `fields`** — `activityRules[name]`
  → `fields.{min_per_week,max_per_week,priority,eligible_groups,location}`, and `links.groups[name]` →
  `fields.unit`. `buildPlan` accepts **either** a string element or a record (string → `{name}`), so the
  golden-ops create corpus and every existing caller keep working unchanged. The side-channel payloads
  (`activityRules`, `links`) stay accepted at the `commitIngest` boundary for back-compat and are
  translated into records there; **`buildPlan` sees only records.**
- `fields` carries only what the source **actually supplies**. A field absent from `fields` is
  "preserve" (no delta) — the load-bearing blank-vs-clear default (MATCH_AND_MERGE_SEMANTICS §3) is now
  encoded structurally: absent = preserve; a name in `clears` = remove (S4b); present in `fields` =
  set/compare.

### 2. `fieldsFor` splits derived-vs-supplied; index-derived fields leave the recognized diff (RISK E)

`fieldsFor` keeps producing the **create-time** field set (including `sort_order: index`, `day_of_week`,
name-range `start_time`/`end_time`) — creates still need it, and the golden-ops create sequence is
unchanged. But the **recognized diff no longer calls `fieldsFor`**. `emitRecognized` builds its proposed
map from `record.fields` **only** — the values the source explicitly carries — so:

- No index-derived field (`sort_order`) can ever enter a recognized diff. A director re-ordering rows in
  a source produces **no** `sort_order` delta (RISK E resolved). `sort_order` is diffable/updatable
  **only** when a source carries an *explicit* `sort_order` value in `fields` (the workbook will carry
  the persisted value, S4a — never a row index).
- `time_blocks` `start_time`/`end_time` similarly diff only when explicitly supplied (canonicalized —
  see S4a/S4b RISK F), not re-parsed from the name on every recognized row.

### 3. Widen the snapshot and the comparable set; diff FK fields by label (RISK A/O/N)

`COMPARABLE_COLUMNS` and `buildExistingSnapshot` are extended so the snapshot carries the values the new
fields need — and, for foreign-key fields, carries them in the **label form** the source speaks, so the
pure `buildPlan` can compare without a DB:

| Entity     | Added comparable data in the snapshot |
|------------|----------------------------------------|
| activities | `priority`, `min_per_week`, `max_per_week`, `location`, and `eligible_group_ids` **resolved to a set of live group *names*** (`eligible_group_names`) |
| groups     | `tier_id` **resolved to the live unit *name*** (`unit_name`) |

- **Scalar fields** (`priority`, `min_per_week`, `max_per_week`, `location`) diff directly:
  proposed-vs-live, with `min/max` compared as integers and `priority` as the enum.
- **`eligible_groups`** diffs as an **order-independent, normalized-name SET** (RISK N): the snapshot
  exposes the live group names; the source carries a list of group-name labels; equal sets → no delta.
  The `to` of the delta carries the **labels** (not ids) — commit resolves them (§4).
- **`unit`** (groups) diffs the source's unit label against the snapshot's `unit_name`; the delta's `to`
  is the unit **label**, resolved at commit (§4). This makes `groups.tier_id` updatable (RISK O).
- `location` is diffed as **text** here (the free-text `location` column; S3's `location_id` is a
  separate later concern and out of scope — the workbook omits the column until S3 lands, S4a).

`buildPlan` stays pure: it compares the label/scalar forms the snapshot hands it against the label/scalar
forms the record carries. Id resolution never happens in `buildPlan`.

### 4. `commitUpdate` validates, resolves FKs, and writes as a set (RISK M/N/O)

`commitUpdate` (`ingest.js` ~509) gains the **same guard rails the create path already has**, now on the
update path, applied per FieldDelta before it writes:

- **Int fields** (`min_per_week`, `max_per_week`, `sort_order`): trim and coerce; accept only a positive
  integer (`Number.isInteger` ≥ 1, matching create ~465). `"3 "` → `3`; `"abc"`, `2.5`, `0`, negative →
  **rejected** as a `validation` conflict (held, no op — RISK M), never written raw.
- **Enum field** (`priority`): accept only `'high'`/`'low'` (matching create ~467); anything else →
  `validation` conflict, held.
- **`eligible_groups`**: resolve each label through the **same `groupIdByName` map create uses**
  (~468–476) to a set of ids, write `JSON.stringify(sortedIds)` (canonical order so re-writes are
  idempotent). A label that **fails to resolve** is **surfaced, not silently dropped** (RISK N): the row
  becomes an `eligibility_unresolved` conflict naming the offending label(s), held for review. (Create's
  silent-drop behavior is left as-is for the create path; the *update* path must not lose an eligibility
  the director typed.)
- **`unit`**: resolve the label through `tierIdByName`, write `tier_id`. Unresolvable unit → conflict,
  held (never a silent no-op — RISK O).

A **new `validation` and `eligibility_unresolved` conflict reason** is added to the accepted set in the
`case 'conflict'` gate (`ingest.js` ~639) so it collects into `conflicts` and trips hold-the-whole,
exactly like `stale`/`ambiguous_identity` — never throws.

### 5. The Policy-A gate and hold-the-whole are unchanged

Every new field rides the **existing** S2b Policy-A protection gate (`ingest.js` ~610): a differing
field whose latest op is human-authored (`source !== 'import'`) becomes a gated `stale` conflict; an
import-owned or never-set field updates freely. Eligibility/unit/rules are protected identically to any
other field. No new atomicity mechanism; the same `HELD` sentinel.

---

## Schema — NONE

No table, column, projection, or sync change. `COMPARABLE_COLUMNS` and the snapshot projection are
read-only reads of columns that already exist (`activities.priority/min_per_week/max_per_week/location/
eligible_group_ids`, `groups.tier_id`). Rollback is a code revert: `buildPlan` returns to name-only
diffs, `commitUpdate` to the raw write. The rule side-channel keeps working throughout (it is translated
into records at the adapter, not removed).

---

## Completion evidence + test seams

All at `buildPlan` (pure) and `commitPlan`/`commitUpdate` (fixtured DB) — no UI, no xlsx.

1. **Activity rule update (THE gap this closes).** A schedule re-import (via `activityRules`) changing
   `max_per_week` 2→3 on a recognized activity → `op:"update"` with only `max_per_week`; `commitUpdate`
   writes one op; the value changes. Proves RISK A is closed.
2. **Priority / min / eligibility.** `priority` low→high, `min_per_week` 1→2, and an added eligible
   group each diff and write; an unchanged rule set is `unchanged` (zero ops) — idempotent (F4).
3. **Eligibility is a set.** Re-importing the same eligible groups in a **different order** → **no
   delta**. An eligibility referencing a group that no longer exists → `eligibility_unresolved` conflict,
   held, **no silent drop** (RISK N).
4. **Group unit update.** Moving a group to a different unit → `tier_id` update via label resolution
   (RISK O). An unresolvable unit → conflict, held.
5. **Validation on the update path.** `"3 "` → coerced to `3` and written; `"abc"`, `0`, `2.5`,
   `priority:"medium"` → `validation` conflict, held, **never written raw** (RISK M).
6. **Row-reorder is a no-op.** Re-importing the same entities in a different order produces **no**
   `sort_order` delta (RISK E) — recognized diff never reads a row index.
7. **String-element back-compat.** A caller passing `approved[entity]` as a `string[]` still produces the
   byte-identical create sequence (golden-ops corpus green); the adapter's string→`{name}` normalization
   is transparent.
8. **Policy-A still governs.** A hand-edited (`source:human`) rule field re-imported with a different
   value → `stale` conflict, held (S2b F6 anchor, driven through a rule field).

---

## Consequences

- Re-importing a corrected **schedule** now updates activity rules and group units — **T35 bulk
  enrichment is delivered here**, without the workbook.
- The per-row record `{id?, name, fields, clears}` is the shape S4b fills with `id` (uuid match) and
  `clears` (`<clear>` token) — S4 adds *no* new source reshape, it populates two slots this slice cut.
- The update path is now as safe as the create path (same int/enum validation), and eligibility/unit are
  first-class, set-compared, and never silently lost.

## Open questions for Governor

- **Create-path eligibility silent-drop parity.** S2c makes the *update* path surface an unresolvable
  eligibility label. The *create* path still silently drops it (~473). Recommend leaving create as-is
  (a create with no prior state has less to lose) and revisiting only if it proves confusing; flagged so
  the asymmetry is a decision, not an oversight.
</content>
</invoke>
