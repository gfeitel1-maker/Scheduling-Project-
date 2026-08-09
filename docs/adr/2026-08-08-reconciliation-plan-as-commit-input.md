---
title: "ReconciliationPlan as the input commit consumes"
document_type: adr
authority: normative
status: proposed
date: 2026-08-08
supersedes: []
implementation_state: not_started
affects:
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_ARCHITECTURE.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
  - docs/work/onboarding-reconciliation/IMPLEMENTATION_SEQUENCE.md
---

# ReconciliationPlan as the input commit consumes

**Status: PROPOSED.** This is the S0 design ADR of the approved Onboarding & Reconciliation
program. It records the S0 decision — a pure refactor that inserts a `ReconciliationPlan` between
proposal and commit — and it fixes, on day one, the *shape* of that object so the later slices
(S1–S6) do not have to re-cut it under live commit code. No production behavior changes at S0.

This ADR governs S0 only. The four foundations it depends on (stable identity + `source_aliases`,
persisted provenance, happens-before/staleness) are designed in
`RECONCILIATION_ARCHITECTURE.md` and land in their own later slices with their own gates; this ADR
commits only to a Plan *type* wide enough to hold them.

---

## Context

The current importer (ADR 2026-08-01) is a pipeline: **read → propose → non-skippable preview →
atomic single-transaction commit.** `commitIngest` (`electron/ops/ingest.js`) is the writer; it is
the only code in the ingest path that calls `appendOp`, and it does so field-by-field inside one
`db.transaction()`. The preview embryo, `buildPreview` (`src/ingest/preview.js`), is already a pure
function that returns a New-vs-Skip decision object and writes nothing.

Two facts about that importer set up this decision:

1. **It has no update path.** Its two modes are `add` (append; a name-match is *skipped*, never
   updated) and `replace` (`replaceScope`, which wipes the whole camp scope — every Program,
   ignoring the cohort filter — then recreates). A director who fixes one field in a source file
   and re-imports either duplicates (add) or loses everything else (replace). The program's success
   predicate — *re-importing a corrected source UPDATES rather than duplicates or wipes* — is
   unreachable without a third path.

2. **The codebase has already been burned by a coarse write-carrying op.** `bulk_replace`
   (`electron/ops/operations.js`) is a wholesale delete-all-rows-in-scope-then-reinsert carried as
   one op whose `value` is `JSON.stringify(rows)`. It does not fit `detectConflict`'s
   `(entity, entity_id, field)` model, so an entire parallel conflict mechanism
   (`detectBulkReplaceConflict` / `latestScopeOpSeq` / `based_on_seq`) had to be built beside it;
   that mechanism is deliberately coarser than field-level ("any newer op anywhere in the scope
   counts as a conflict, even if it were possible for it to logically not overlap" — its own
   comment); and round 1 of its design tried to have it *bypass conflict detection entirely* and
   was rejected by GOVERNOR as a CRITICAL finding.

The program needs a middle path (per-field, per-entity update, reviewed before commit, safe against
overwriting newer work). The pre-S0 design question this ADR answers is: **what object carries that
decision from preview to commit, and what shape must it have so it maps onto the existing writer
without re-creating the bulk_replace mess?**

Per `docs/governance/constitution/CONSTITUTION.md`, this clears the ADR bar: it changes the input
contract of `commitIngest` (a function other code calls) and fixes a serializable data shape
(`ReconciliationPlan`) that S1–S6 and a future MCP/CLI seam will all depend on.

### Alternatives considered

The design space was widened by the program's approved 7-agent synthesis pass and reference
research (synthesis §3–§4), not re-opened here; the genuine candidates it produced were:

- **A. Coarse "replace-these-N-rows" Plan (bulk_replace-shaped).** One decision unit per entity or
  per scope; commit reinserts the row set. *Rejected:* this is the shape the codebase already
  regrets. It cannot express "update field X, leave field Y alone, refuse if someone touched X more
  recently," and it forces a separate scope-level conflict machinery. See Decision §2.
- **B. Entity-delta Plan (whole-row upsert).** One decision unit per entity, carrying the full
  proposed row. *Rejected:* coarser than the writer. `appendOp` and `detectConflict` are
  field-level; an entity-grain Plan would either lose per-field conflict detection or have to be
  re-expanded into fields at commit — reintroducing the impedance the field-delta shape removes for
  free. It also cannot hold a per-field cross-source conflict (value A from schedule, value B from
  facility) without inventing sub-structure that is just the field-delta shape by another name.
- **C. Field-delta Plan (chosen).** One decision unit per entity, whose `fields` map carries one
  `{from, to, source}` triple per touched field. Maps 1:1 onto `appendOp`: one `fields` entry → one
  `appendOp` call, inside the transaction `commitIngest` already opens. **Selected** — it is the
  smallest shape that fits the existing writer with no impedance and can hold every hard case
  (conflict+clock, clear, cross-source) without reshape. See `RECONCILIATION_PLAN_TYPE.md` for the
  walk against all eight hardest consumers.

A parallel value-vs-time question (should staleness be a `confirmed` bit or a happens-before clock?)
was resolved to time-shaped in the architecture doc §8; this ADR inherits that as the reason the
Plan's `conflict` op must carry a clock, not just a value.

---

## Decision

### 1. The ReconciliationPlan becomes the input `commitIngest` consumes; it is a pure DECISION layer, never a write layer

S0 inserts one object between proposal and commit. `buildPlan(source) → Plan` is a **pure function
in `src/ingest/`** — it grows out of `buildPreview` — that returns a serializable
`ReconciliationPlan` and holds no database handle and performs no write. `commitPlan(Plan) →
outcome` is the **single privileged committer**: it walks the Plan and writes via `appendOp`, and it
is the only `appendOp` caller in the reconciliation path.

State the invariant normatively:

> **The ReconciliationPlan is a pure, serializable decision object produced by a pure function. It
> holds no DB handle and performs no writes. `commitPlan` translates a Plan into `appendOp` calls
> inside one transaction, and it is the only writer. Every source is an adapter that emits a Plan;
> no adapter ever writes SQLite.**

This makes the layer a safe seam for the future (non-goal now) MCP/CLI: an automated caller can only
ever produce a Plan and hand it to the one committer, inheriting atomicity, conflict detection,
provenance, and staleness by construction — it cannot route around the committer to reach the DB.

### 2. The field-delta invariant (load-bearing)

**The Plan is field-delta shaped so `commitPlan` translates it 1:1 into `appendOp`.** Each Plan item
is one entity decision whose `fields` map carries, per touched field, a `{from, to, source}` triple.
One `fields` entry becomes exactly one `appendOp` call, inside the single `db.transaction()`
`commitIngest` already opens; its inner loop already iterates `Object.entries(fields)` and calls
`appendOp` per field (`ingest.js` ~374–386). The Plan hands that loop a *reviewed delta* in place of
a freshly-derived create-only field set.

**Anything coarser is forbidden — this is a hard architectural constraint, not a preference.** The
cautionary tale is `bulk_replace`: a coarse "replace these N rows" op targets no single field, so it
does not fit `detectConflict`'s `(entity, entity_id, field)` key; it required a separate,
deliberately-coarser conflict mechanism; and its round-1 design tried to bypass conflict detection
and was GOVERNOR-rejected as CRITICAL because it would silently clobber a concurrent field-level
edit. A field-delta Plan gets per-field conflict detection *for free* by mapping onto `appendOp`. A
coarser Plan re-creates the parallel-write machinery the project already paid to survive.

### 3. The type must represent all six ops on DAY ONE, even though S0 only exercises `create`

The Plan item's `op` is one of **`create` | `update` | `unchanged` | `clear` | `conflict`**, and the
type must be able to represent each — including `conflict(reason + clock + competing-source)` — from
the first commit, even though S0 exercises only the all-`create` path. This is the PRE-S0 mandate
(synthesis §10): if the type is cut to fit only the easy all-New path, S1/S2/S4/S6 would have to
re-cut it *under live commit code*, which is exactly the expensive reshape this paper-design step
exists to prevent. `RECONCILIATION_PLAN_TYPE.md` walks the type against the eight hardest consumers
and shows each is representable with no reshape.

### 4. Resolution (name→id, alias) stays at commit against the live DB; the Plan is a reviewed proposal re-validated at commit

A Plan computed at preview can go stale before the director clicks commit (a peer op lands, another
device edits a row). Therefore **name→id resolution, alias resolution, and the staleness check all
run at commit, inside the transaction, against the authoritative current rows** — extending the
existing `seedNameMaps()`, which already runs inside `commitIngest`'s transaction *after* any
teardown and reads the live DB to build name→id maps (`ingest.js` ~269–312). The Plan carries
`entity_id: null` on a `create` and defers the binding-to-live-id to this one late, in-transaction
resolution.

This is what satisfies **Constitution Article V**: the Plan is a *reviewed proposal re-validated at
commit*, not a stale snapshot trusted blindly. A Plan that carried pre-bound row ids or DB handles
would be a snapshot masquerading as a decision and would violate Article V the first time a
concurrent op landed in the preview window.

### 5. S0 makes NO schema change (pure refactor); rollback = revert

S0 introduces `buildPlan`/`commitPlan` and routes the existing importer through them. It adds **no
table, no column, no projection, no new op type, no IPC shape change.** The Plan is in-memory
serializable data; the writer is the existing `appendOp` path. The foundations that *do* touch
stored data — `source_aliases` (a new synced entity), the per-row `confirmed`/`source` provenance
columns, `activity_locations` — are **explicitly out of S0** and land in their own later slices with
their own migration/rollback gates.

**Rollback plan: revert the commit.** Because S0 changes no stored shape, withdrawing it is a code
revert; every op it wrote is byte-identical to what today's importer writes (see Completion
evidence), so there is nothing at the data layer to undo. This mirrors ADR 2026-08-01 §3's "no
schema change, therefore no migration" risk reduction, and inherits it.

---

## Consequences

- The importer gains a named, serializable intermediate (`ReconciliationPlan`) that the director's
  preview renders and the committer consumes — the same object across both, so preview and commit
  are provably the same computation.
- The write surface narrows: after S0, `commitPlan` is the single privileged `appendOp` caller in
  the reconciliation path, and the "adapters are pure producers" discipline becomes a structural
  property rather than a convention. This is the seam a future MCP/CLI (non-goal now) would attach
  to without a rewrite.
- The Plan type is fixed wider than S0 needs. This is deliberate: the cost of an unused `conflict`
  arm at S0 is a few dead branches; the cost of re-cutting the type at S2 under live commit code is
  a schema-adjacent migration of an object every slice depends on. The synthesis PRE-S0 mandate
  makes this trade explicitly.
- An emitted-but-unconsumed Plan would be busywork that drifts from the real write path. Therefore
  S0 emits **and** consumes the Plan together — the GOLDEN-OPS test (below) is what proves the two
  halves agree.
- Captured-but-not-yet-enforced data (locations, staffing) is a later-slice concern and does not
  arise at S0; when it does, the UI must label it honestly (architecture doc §9).

---

## Completion evidence

1. **GOLDEN-OPS characterization test.** A test proves the op sequence `commitPlan` emits is
   **byte-identical** to today's `commitIngest` output for **both real camp corpora**, in **both**
   `add` and `replace` modes — same ops, same fields, same order, same values (`client_write_id`
   normalized, since it is a fresh UUID per op by construction — `ingest.js` ~384). This is the
   proof that S0 is a behavior-preserving refactor. It is the S0 regression anchor (fixture family
   F2, redacted).
2. **The existing ingest suite stays green** — no test in `ingest.test.js` / `operations.test.js` /
   `preview.test.js` changes behavior; S0 is additive plumbing beneath them.
3. **`buildPlan(source) → Plan` and `commitPlan(Plan) → outcome` boundary methods exist**, with
   `buildPlan` pure (no DB handle) and `commitPlan` the resolver-and-writer.
4. **The single-privileged-committer invariant holds in code:** `commitPlan` is the only `appendOp`
   caller in the reconciliation path (grep-checkable), and `buildPlan` performs no write.
5. **No schema diff:** `schema.sql` is unchanged; a fresh-vs-migrated equivalence check is
   untouched because there is no migration (inherited from ADR 2026-08-01 §3).

---

## Open questions for the product owner / follow-up ADRs

These are **not** S0 blockers — the Plan type is designed wide enough to hold each answer — but each
needs a resolved policy before the slice that first *exercises* that arm ships. They are the
synthesis §12 decision-gate items, restated as the ADRs they will need:

1. **Staleness authority mechanism (needed before S2).** The exact base-generation stamp carried on
   exported sources/workbooks, and the precise rule that turns "proposed value's base is older than
   the field's last-authoritative write" into a `conflict`. The Plan holds `clock` today; the
   mechanism that fills it is its own ADR.
2. **Alias-conflict policy (needed before S1).** Divergent cross-device confirmations of the same
   `source_label` do **not** collide under `detectConflict` (it keys on `entity_id`/field); policy
   must be reviewable-conflict, not last-writer-wins. Own ADR with `source_aliases`.
3. **Explicit-clear encoding (needed before S4).** A plain `.xlsx` empty cell is *both* blank and
   clear; the workbook needs an explicit `<clear>` sentinel/column. The Plan's `clear` op exists;
   its wire encoding in the workbook is undecided.
4. **Cross-source per-field authority (needed before multi-source S7).** Which source family is
   authoritative for which field, and how a first-class cross-source `conflict` is surfaced. The
   Plan can hold competing values today; the authority table is a product decision.
5. **Per-row `confirmed`/`source` provenance columns (needed before S1/C).** Their addition is a
   schema change with its own migration/rollback gate — out of S0 by §5.

None of these blocks S0. S0's job is the refactor and the type; these are the policies the type is
built to receive.
