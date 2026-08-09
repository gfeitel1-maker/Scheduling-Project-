---
title: "ReconciliationPlan — the type design"
document_type: design
status: draft
created: 2026-08-08
governing_docs: [docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# ReconciliationPlan — the type design

This is the PRE-S0 paper design of the `ReconciliationPlan` type, mandated by synthesis §10: the type
must be able to hold `create / update / unchanged / clear / conflict(reason + clock + competing-source)`
on **day one**, walked against the hardest consumers *before* S0 locks — otherwise S0 proves only the
easy all-New path and S1/S2/S4/S6 re-cut the type under live commit code.

The codebase is JavaScript, so the type is given as JSDoc typedefs plus a pseudo-schema. It is
serializable pure data — no methods, no DB handles, no functions. It is the object `buildPlan` returns
and `commitPlan` consumes (ADR 2026-08-08).

Everything here is consistent with `RECONCILIATION_ARCHITECTURE.md` (the object and its transaction) and
`MATCH_AND_MERGE_SEMANTICS.md` (the rules that populate it), and re-confirmed against `ingest.js`,
`operations.js`, `preview.js`, and `schema.sql`.

---

## 1. The type (JSDoc / pseudo-schema)

```js
/**
 * A ReconciliationPlan is pure, serializable data describing what an import WOULD do.
 * It decides; it does not write. commitPlan translates it 1:1 into appendOp calls.
 *
 * @typedef {Object} ReconciliationPlan
 * @property {number}            plan_version   Type-schema version, for forward migration of stored/serialized plans.
 * @property {string}            camp_id        The camp this plan targets.
 * @property {string|null}       cohort_id      Active Program, for Program-scoped entities (tiers, time_blocks); null = camp-scoped only.
 * @property {number}            base_generation The op-log generation the plan was computed against (foundation D staleness pin).
 * @property {SourceRef[]}       sources        The source families that fed this plan (adapter provenance).
 * @property {PlanItem[]}        items          One decision per resolved entity.
 * @property {UnresolvedRef[]}   unresolved     Relationship references that did not resolve (their own error bucket; never a silent drop).
 */

/**
 * @typedef {Object} SourceRef
 * @property {string} source           Stable label for this source family instance, e.g. "schedule:campA-2025.xlsx".
 * @property {"schedule"|"facility"|"location_config"|"staffing"|"workbook"|"paste"} family
 * @property {number} [base_generation] Generation this specific source was derived from (S4 workbook round-trip stamp).
 */

/**
 * One entity's decision. The `fields` map is the field-delta — the load-bearing shape (ADR §2).
 *
 * @typedef {Object} PlanItem
 * @property {"create"|"update"|"unchanged"|"clear"|"conflict"} op
 * @property {string}        entity      Ingestible entity type, e.g. "activities" (always entity-typed; matching is entity-scoped).
 * @property {string|null}   entity_id   null on create; the live id on update/unchanged/clear/conflict (bound at commit, may be provisional at preview).
 * @property {Object<string, FieldDelta>} fields   Only the fields this op touches. Empty {} for a pure `unchanged` item.
 * @property {Evidence}      evidence    Why the matcher decided this op (identity tier, ranker score, etc.).
 * @property {Provenance}    [provenance] Row-level trust state to persist (foundation C). Absent until the C slice.
 */

/**
 * A single field's before/after, tagged with the source family that asserted `to`.
 * One FieldDelta -> one appendOp call at commit (except op:"unchanged", which emits none).
 *
 * @typedef {Object} FieldDelta
 * @property {*}       from     Current live value (null if the field is currently unset). What staleness compares against.
 * @property {*}       to       Proposed value. The CLEAR sentinel (see §3) means "remove"; absent field => not in the map at all.
 * @property {string}  source   Which SourceRef.source asserted `to`.
 * @property {FieldConflict} [conflict] Present only when this field is the reason op === "conflict".
 */

/**
 * Present on a conflicting field. Carries WHY (reason), WHEN (clock), and the COMPETING value(s).
 * `clock` is what makes conflict time-shaped, not value-shaped (foundation D).
 *
 * @typedef {Object} FieldConflict
 * @property {"stale"|"cross_source"|"ambiguous_identity"|"alias_divergence"} reason
 * @property {Object}  clock                 Happens-before evidence from the op-log.
 * @property {number}  clock.field_last_seq  operations.seq of the field's current last-authoritative write (from latestOp).
 * @property {number}  clock.source_base_seq base_generation the proposed value was derived from.
 * @property {CompetingValue[]} competing    Every value in contention, each with its source and clock (>=2 for cross_source).
 */

/**
 * @typedef {Object} CompetingValue
 * @property {*}      value
 * @property {string} source
 * @property {number} [seq]   op-log seq of this value's authoritative write, when it has one.
 */

/**
 * @typedef {Object} Evidence
 * @property {"uuid"|"source_id"|"confirmed_alias"|"exact_name"|"human_confirmed"|"new"} tier  Which identity-hierarchy tier resolved this.
 * @property {string}   [matched_name]  The live entity name matched against (for a name/alias tier).
 * @property {number}   [ranker_score]  Fuzzy similarity, SUGGESTION ONLY — never drives the op (ranks human-confirm candidates).
 * @property {string[]} [candidates]    Other plausible entity_ids, when tier === "human_confirmed" (ambiguity, never auto-merged).
 */

/**
 * Row-level trust state (foundation C). Enum, not score.
 * @typedef {Object} Provenance
 * @property {"inferred"|"confirmed"|"unknown"} confirmed   Drives the three visual looks (muted / full / full+worth-checking).
 * @property {string} source                                Which family last authored the row.
 */

/**
 * @typedef {Object} UnresolvedRef
 * @property {string} entity        The child entity whose reference did not resolve.
 * @property {string} field         The relationship field (e.g. "tier_id").
 * @property {string} raw           The unresolved source value (e.g. the unit name with no matching tier).
 * @property {string} reason        Why (e.g. "no matching tier in this Program").
 */
```

### Boundary-method signatures

```js
/**
 * PURE. No DB handle, no writes. Given a normalized source (from any adapter) plus a read-only
 * snapshot of what the camp already has, returns a serializable ReconciliationPlan.
 * Grows out of buildPreview (preview.js): from two verbs (create/skip) to six ops.
 *
 * @param {NormalizedSource} source          Adapter output (parsed grid -> entities/fields).
 * @param {CampSnapshot}     existing         Read-only current-state snapshot (names, ids, field values, base_generation).
 * @returns {ReconciliationPlan}
 */
function buildPlan(source, existing) { /* pure */ }

/**
 * The SINGLE privileged committer — the only appendOp caller in the reconciliation path.
 * Resolves the plan against the LIVE db (extends seedNameMaps: name->id, alias, staleness) and
 * writes each FieldDelta via appendOp, inside one db.transaction(). Re-validates the plan against
 * live state (Article V): a resolution that changed since buildPlan can flip an item to conflict.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReconciliationPlan} plan
 * @param {{author_user_id: string|null, device_id: string}} actor
 * @returns {CommitOutcome}   { created, updated, unchanged, cleared, conflicts, unresolved, ops_written }
 */
function commitPlan(db, plan, actor) { /* the only writer */ }
```

**Mapping to the existing writer (ADR §2, the 1:1 invariant):** `commitPlan`'s inner loop is the loop
`commitIngest` already runs (`ingest.js` ~374–386): `for (const [field, delta] of
Object.entries(item.fields)) appendOp(db, { entity: item.entity, entity_id, field, value: delta.to,
... })`, inside the one `db.transaction()`. `op:"create"` uses `parent_op_id: null` (as today);
`op:"update"`/`"clear"` set `parent_op_id` to the field's current `latestOp().id` so `detectConflict`
guards it; `op:"unchanged"` emits nothing; `op:"conflict"` emits nothing and is surfaced for review
(commit is gated on it — synthesis §9).

---

## 2. The walk — every hardest consumer, represented with NO reshape

Each case below shows the concrete Plan-item instance. Values are illustrative; the point is that the
**shape never changes** — only which arms of the one type are populated.

### (a) All-New, single source — the S0 path (today)

A brand-new activity from a schedule import. This is the *only* case S0 exercises.

```js
{ op: "create", entity: "activities", entity_id: null,
  fields: { name: { from: null, to: "Archery", source: "schedule:campA-2025.xlsx" } },
  evidence: { tier: "new" } }
```

Commit: one `appendOp` (name), `parent_op_id: null`, fresh `client_write_id` — byte-identical to what
`commitIngest` writes today (this is the GOLDEN-OPS anchor). No `conflict`, `provenance`, or `clock`
arm is touched — they simply stay absent. **No reshape.**

### (b) Idempotent unchanged → zero ops

The same file re-imported; the activity already exists and every field already equals the proposal.

```js
{ op: "unchanged", entity: "activities", entity_id: "act_9f...",
  fields: {},
  evidence: { tier: "exact_name", matched_name: "Archery" } }
```

Commit: `Object.entries(fields)` is empty → **zero `appendOp` calls**. An all-`unchanged` plan writes
nothing (fixture F4, 0 rows). The `unchanged` op is the natural encoding of "resolved to a live entity,
nothing to write" — the same `isNoOp` truth `buildPreview` already computes, widened. **No reshape.**

### (c) Field update

Director fixed the max-per-week in the source and re-imported; identity resolves by exact name.

```js
{ op: "update", entity: "activities", entity_id: "act_9f...",
  fields: { max_per_week: { from: 3, to: 5, source: "schedule:campA-2026.xlsx" } },
  evidence: { tier: "exact_name", matched_name: "Archery" } }
```

Commit: one `appendOp` for `max_per_week`, `parent_op_id` = current `latestOp(db,"activities","act_9f...","max_per_week").id`,
so `detectConflict` guards it. `name` is not in `fields` (unchanged) → not written, cannot clobber.
Only-changed-fields-render is exactly the diff the preview needs. **No reshape** — `update` is `create`
with a non-null `entity_id` and a non-null `from`.

### (d) Explicit clear

Director affirmatively cleared the location cell via the `<clear>` token (never an empty cell — §3).

```js
{ op: "clear", entity: "activities", entity_id: "act_9f...",
  fields: { location: { from: "Pool", to: CLEAR, source: "workbook:enrichment-v3" } },
  evidence: { tier: "exact_name", matched_name: "Archery" } }
```

Commit: one field-null / `__deleted__`-path `appendOp` (Trash-restorable, replicates). `CLEAR` is a
distinct sentinel so `to: null`/absent (blank, leave untouched) is never confused with `to: CLEAR`
(remove). Clear gets its own firmer preview treatment because it removes data. **No reshape** — `clear`
is an `op` value + a sentinel `to`, not a new field.

### (e) Stale value older than the field's last write → conflict-with-clock

A workbook exported Monday (base_generation 1040) is re-imported Thursday, but the director hand-edited
`location` on Tuesday (that write is seq 1102). The proposed value is *older* than the field's current
authoritative write → `conflict`, never a silent update (foundation D; fixture F6, "most likely quietly
broken").

```js
{ op: "conflict", entity: "activities", entity_id: "act_9f...",
  fields: { location: {
    from: "Field House",                       // Tuesday's hand-edit, current live value
    to: "Pool",                                // the stale workbook's value
    source: "workbook:enrichment-monday",
    conflict: { reason: "stale",
      clock: { field_last_seq: 1102, source_base_seq: 1040 },
      competing: [
        { value: "Field House", source: "director-edit", seq: 1102 },
        { value: "Pool",        source: "workbook:enrichment-monday", seq: 1040 } ] } } },
  evidence: { tier: "exact_name", matched_name: "Archery" } }
```

Commit: emits **no** write for this field; surfaced for review, commit gated. The `clock` carries WHEN
(not just the value), which is precisely what a value-only `confirmed` bit structurally cannot do
(architecture §8). **No reshape** — `conflict` reuses `FieldDelta` + its optional `conflict` sub-object.

### (f) Ambiguous identity

The source label "Ropes" plausibly matches two live activities ("Low Ropes", "High Ropes"); the resolver
must not pick (never auto-merge). It produces a human-confirm item.

```js
{ op: "conflict", entity: "activities", entity_id: null,
  fields: { name: { from: null, to: "Ropes", source: "schedule:campB-2026.xlsx",
    conflict: { reason: "ambiguous_identity",
      clock: { field_last_seq: 0, source_base_seq: 1040 },
      competing: [
        { value: "Low Ropes",  source: "live:act_11..." },
        { value: "High Ropes", source: "live:act_22..." } ] } } },
  evidence: { tier: "human_confirmed", ranker_score: 0.72,
              candidates: ["act_11...", "act_22..."] } }
```

Commit: no write; surfaced as the confirm-identity card (two named entities, `≟` not `=`). The fuzzy
`ranker_score` only *orders* the candidates — it never drives the op (semantics §2). A director's answer
may become a `source_aliases` row (foundation A, later slice). **No reshape** — `entity_id: null` +
`reason: "ambiguous_identity"` + `evidence.candidates`.

### (g) Cross-source competing values

The schedule says an activity's location is "Pool"; a facility/location-config source says "Aquatics
Center". Per-field authority disagrees → first-class `conflict` holding *both* competing values.

```js
{ op: "conflict", entity: "activities", entity_id: "act_9f...",
  fields: { location: {
    from: "Pool", to: "Aquatics Center", source: "location_config:facilities.xlsx",
    conflict: { reason: "cross_source",
      clock: { field_last_seq: 1090, source_base_seq: 1090 },
      competing: [
        { value: "Pool",            source: "schedule:campA-2026.xlsx" },
        { value: "Aquatics Center", source: "location_config:facilities.xlsx" } ] } } },
  evidence: { tier: "exact_name", matched_name: "Archery" } }
```

Commit: no write; surfaced with both values and their source families for the director to pick authority.
The `plan.sources` array records that two families fed this plan. This is exactly why `FieldDelta`
carries `source` per field and `competing` is an array (semantics §6). **No reshape.**

### (h) Temporal / soft staffing

A staffing requirement that is durable (a role need) plus a *temporary* availability marker ("lifeguard
out week 4"). Temporal validity is a program non-goal, so the type must be able to REPRESENT the
temporary marker in order to REJECT it honestly (flag, don't flatten — Red Hat R7), rather than silently
importing it as permanent.

```js
// The durable requirement — a normal create on the (later-slice) staffing entity:
{ op: "create", entity: "activity_staffing_requirements", entity_id: null,
  fields: {
    role:          { from: null, to: "Lifeguard", source: "staffing:staff-2026.xlsx" },
    count:         { from: null, to: 1,           source: "staffing:staff-2026.xlsx" },
    enforcement:   { from: null, to: "soft_flag", source: "staffing:staff-2026.xlsx" } },
  evidence: { tier: "new" } }

// The temporary availability marker — REJECTED into the unresolved bucket, not written as permanent:
// plan.unresolved += 
{ entity: "activity_staffing_requirements", field: "availability_window",
  raw: "Lifeguard out week 4",
  reason: "temporal validity is out of scope; rejected rather than flattened to permanent" }
```

Commit: the durable requirement is a normal field-delta create (soft-flag default, never a blocking
readiness category). The temporary marker is surfaced in `plan.unresolved` — captured, flagged, not
flattened. **No reshape** — durable facts are ordinary `create` items; the temporal marker uses the
existing `unresolved` bucket the relationship-import case (semantics §5) already needs.

---

## 3. Cross-cutting encoding decisions the type bakes in

- **Blank vs clear (the tri-state).** *Blank/absent* = the field is simply **not present in the `fields`
  map** → no `appendOp`, cannot clobber a concurrent edit (maps to the field being `unchanged`). *Clear*
  = the field IS in the map with `to: CLEAR` (a distinct exported sentinel). An empty `.xlsx` cell is
  both blank and clear and has no tri-state encoding, so the S4 workbook needs an explicit clear token —
  a named decision-gate item, out of this type's scope but the reason `CLEAR !== null !== absent`.
- **`from` is load-bearing twice.** It is the muted "before" the preview renders, AND the value
  foundation-D staleness compares against at commit. It is always the *current live* value, populated by
  `buildPlan` from the `existing` snapshot and re-read at commit.
- **`clock` makes conflict time-shaped.** `field_last_seq` comes from `latestOp`; `source_base_seq` from
  the source's `base_generation`. A `confirmed` bit answers WHO, not WHEN, and cannot do overwrite
  protection (architecture §8) — the clock is why `conflict` is a distinct arm, not a flavor of update.
- **`plan_version`.** Serialized/stored plans (workbook round-trip, future MCP/CLI) carry a schema
  version so the type can migrate forward without breaking a plan authored under an older shape.
- **Entity-scoped matching.** `entity` is on every item and `Evidence.tier` records the identity tier;
  a location label never matches an activity name because matching is always within `entity` (semantics
  §1). The type cannot express a cross-entity match — that is a deliberate structural guard.

---

## 4. Why this is the smallest type that holds all eight

Every hard case above populates a *different subset of the same fields*; none required a new field, a
new nesting level, or a reshape. The type is exactly:

- one `op` enum (5 values),
- a field-keyed `fields` map of `{from, to, source}` triples (the field-delta invariant),
- an optional per-field `conflict` sub-object carrying `reason` + `clock` + `competing`,
- an `evidence` object recording the identity tier (+ optional ranker/candidates),
- an optional row-level `provenance` enum (later slice),
- plan-level `base_generation` + `sources` + an `unresolved` bucket.

Anything smaller drops a hard case (e.g. removing `clock` reopens F6 silent-clobber; removing
`competing` cannot hold cross-source; collapsing `fields` to an entity-grain row reintroduces the
bulk_replace impedance). Anything larger is speculative generality `karpathy` rejects. This is the
smallest responsible shape that lets S0 ship the all-New path while guaranteeing S1–S6 never re-cut the
type under live commit code.
