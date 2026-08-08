---
title: "Reconciliation Architecture — the ReconciliationPlan spine"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Reconciliation Architecture

This is one of the two spine documents for the onboarding-reconciliation program. It defines the
architecture of the reconciliation layer: what the `ReconciliationPlan` is, what shape it carries,
where it sits relative to the existing commit machinery, and the four foundations (A–D) that make a
returning camp's re-import *update* rather than *duplicate or wipe*. Its companion,
`MATCH_AND_MERGE_SEMANTICS.md`, defines the identity and field-merge rules that populate a Plan; this
document defines the object those rules produce and the transaction it feeds.

Everything here is consistent with, and derived from, the synthesis source (§3 spine A–D, §10 boundary
methods). It has been re-confirmed against live code: `electron/ops/ingest.js` (`commitIngest`,
`seedNameMaps`, `appendOp`, `replaceScope`), `electron/ops/operations.js` (`appendOp`, `bulk_replace`,
`detectConflict`), `src/ingest/preview.js` (`buildPreview`), and `electron/db/schema.sql` (the
`operations` table). No production behavior is proposed here — this is a pre-approval design artifact.

---

## 1. The one-sentence success predicate this architecture must satisfy

A returning camp starts from the source materials it already keeps (a prior schedule, a facility list,
a staffing sheet), reaches a schedule-ready Shoresh setup by *reviewing and correcting proposals*
rather than opening dozens of records by hand, and — the load-bearing clause — **re-importing a
corrected source UPDATES prior work rather than duplicating or wiping it.**

The current importer cannot do this. Today's two modes are `add` (append; name-matches are *skipped*,
never updated) and `replace` (`replaceScope`, which wipes the *whole* camp scope — every Program,
ignoring the cohort filter — then recreates). There is no third path. A director who fixes one typo in
a source file and re-imports either gets a duplicate (add) or loses everything else (replace). The
reconciliation layer exists to introduce the missing middle: a per-field, per-entity *update* that is
reviewed before it commits and safe against overwriting newer work.

---

## 2. The central invariant: the Plan is a decision layer, never a write layer

The `ReconciliationPlan` is a piece of **pure, serializable data computed in `src/ingest/`** that
describes *what an import would do*. It decides; it does not write. Writing remains the exclusive job of
the existing commit path in `electron/ops/ingest.js`, which is the only code that calls `appendOp`.

This separation is the architectural spine. State it as an invariant:

> **The ReconciliationPlan is a pure decision object. It is produced by a pure function, it holds no
> handles to the database, and it performs no writes. The single privileged committer translates a
> Plan into `appendOp` calls inside one transaction, and it is the only writer.**

Two independent reasons force this shape:

1. **Constitution Article V** requires that a proposal be re-validated at commit against live state, not
   trusted as a stale snapshot. A pure Plan that is *recomputed and resolved at commit* satisfies this
   directly (see §5). A Plan that carried resolved database handles or pre-bound row ids would be a
   snapshot masquerading as a decision, and would violate the article the first time a concurrent op
   landed between preview and commit.

2. **The codebase already paid for the alternative.** `bulk_replace` (in `operations.js`) is exactly
   what a coarse, write-carrying reconciliation object looks like, and its cautionary tale is documented
   in §4 below. The field-delta shape is the deliberate, tested correction to it.

The embryo of this object already exists: `buildPreview` in `src/ingest/preview.js` is a pure function
that takes a proposal plus what the camp already has and returns a create/skip decision object with no
writes. The `ReconciliationPlan` is `buildPreview` grown up — from two verbs (create/skip) to six
(create / update / unchanged / clear / conflict, plus the identity-resolution it defers to commit).

---

## 3. The field-delta shape (exact, load-bearing)

The Plan is a list of per-item decisions. **Each item has exactly this shape** (from synthesis §3-B):

```
{
  op: "create" | "update" | "unchanged" | "clear" | "conflict",
  entity,                        // e.g. "activities", "tiers", "groups" — always entity-typed
  entity_id,                     // null on create; the live id on update/unchanged/clear/conflict
  fields: {                      // only the fields this op touches
    <field>: { from, to, source }   // from = current live value, to = proposed value,
  },                                 // source = which source family asserted it
  evidence                       // why the matcher decided this (see MATCH_AND_MERGE_SEMANTICS.md)
}
```

Why field-delta and not something coarser: because **commit must translate the Plan 1:1 into
`appendOp` calls.** `appendOp` in `operations.js` is itself field-level — one op per
`(entity, entity_id, field, value)` tuple, each with its own `client_write_id`, each subject to
per-field `detectConflict`. A Plan whose unit of decision is the *field* maps onto that machinery
without impedance: one `fields` entry becomes one `appendOp` call. `commitIngest` already writes exactly
this way — its inner loop iterates `Object.entries(fields)` and calls `appendOp` per field inside one
`db.transaction()` (`ingest.js` lines ~374–386). The Plan hands that loop a reviewed delta instead of a
freshly-derived create-only field set.

The `from`/`to`/`source` triple per field is what makes a preview honest: the UI renders `from` muted,
`to` full, an accent arrow between them, and only changed fields appear (companion doc §"three looks").
`from` is also what the staleness check (foundation D) compares against at commit.

---

## 4. FEEDS commit 1:1 inside one transaction — and the bulk_replace cautionary tale

### The commit contract

The Plan **feeds** the existing commit; it does not replace it. `commitPlan(Plan)` walks the items and,
for each `fields` entry, calls the same `appendOp` the manual screens and today's importer already use —
all inside the single `db.transaction()` that `commitIngest` already opens. The atomicity guarantee is
inherited for free: any throw rolls back every op together, so the camp is either fully reconciled or
untouched (the "all or nothing" guarantee documented at the top of `ingest.js`). Deletes/clears travel
as the existing `__deleted__` / field-null ops, which are Trash-restorable and replicate — never raw
SQL.

### Why a coarser Plan shape is forbidden

`bulk_replace` (`operations.js` lines ~124–420) is the worked example of the wrong shape, and the
architecture standard forbids reintroducing it here. A `bulk_replace` op is a wholesale
*delete-all-rows-in-scope-then-reinsert* carried as a single op whose `value` is `JSON.stringify(rows)`.
Its own source comments record the costs the codebase absorbed to make it survivable:

- It **does not fit `detectConflict`'s model** at all. Field-level conflict detection asks "does the
  incoming op's `parent_op_id` match the latest op for this exact `entity/entity_id/field`?" A
  bulk_replace targets no single field, so an entirely separate `detectBulkReplaceConflict` /
  `latestScopeOpSeq` / `based_on_seq` mechanism had to be built beside it.
- That mechanism is **deliberately coarser than field-level**: *any* newer op anywhere in the scope
  counts as a conflict, "even if it were possible for it to logically not overlap" (its own comment).
  A concurrent edit to one row forces the whole bulk replace into conflict.
- Round 1 of its design tried to have bulk_replace **bypass conflict detection entirely** and was
  rejected by GOVERNOR as a CRITICAL finding, because it would silently clobber a concurrent field-level
  edit inside the replaced scope.

That is precisely the failure mode reconciliation must avoid: a coarse "replace these N rows" object
cannot express "update field X of row R, leave field Y alone, and refuse if someone touched X more
recently." The field-delta shape gets per-field conflict detection *for free* by mapping onto
`appendOp`. Choosing anything coarser re-creates the parallel-write machinery the project already
regrets. **This is a hard architectural constraint, not a preference.**

---

## 5. Resolution happens at commit, against the live DB (extends `seedNameMaps`)

A Plan is a *proposal*, and a proposal computed at preview time can go stale before the director clicks
commit (a peer op lands, another device edits a row). The architecture handles this by **resolving the
Plan against live state at commit, not at preview.**

The extension point already exists. Inside `commitIngest`'s transaction, `seedNameMaps()` runs *after*
any teardown and reads the live DB to build name→id maps (`tierIdByName`, `blockIdByName`,
`dayIdByName`, `groupIdByName`) — see `ingest.js` lines ~269–312. Its comment already states the reason
precisely: seeding must happen inside the transaction because seeding earlier "would file a new bunk
under a unit that no longer exists." Reconciliation generalizes this: **name→id resolution, alias
resolution, and the staleness check all run at commit, inside the transaction, against the authoritative
current rows** — extending `seedNameMaps` from "existing units/blocks/days/groups" to "the identity
resolution the Plan deferred."

This is what makes the Plan a *reviewed proposal re-validated at commit* rather than a stale snapshot,
and it is how the architecture satisfies Constitution Article V. The preview the director approved and
the ops actually written are provably the same computation (companion doc §"preview = pure function"),
but the *binding to live ids* is done once, late, against real state.

---

## 6. The boundary methods and the single-privileged-committer invariant (future MCP/CLI seam)

Two methods form the whole public surface of the reconciliation layer (synthesis §3-B, §10):

- `buildPlan(source) → Plan` — a pure function in `src/ingest/`. Given a normalized source (from any
  adapter — schedule, facility, staffing, workbook), it returns a serializable `ReconciliationPlan`. No
  DB, no writes.
- `commitPlan(Plan) → outcome` — the single privileged committer. It resolves the Plan against the live
  DB and writes via `appendOp`, inside one transaction.

The invariant that makes this a safe seam for a future MCP/CLI (a hard non-goal *now*, but the seam is
designed so it can arrive without a rewrite):

> **`commitPlan` is the only caller of `appendOp` in the reconciliation path. Every source is an adapter
> that emits a Plan; no adapter ever writes SQLite. By construction, an MCP tool or CLI command can only
> ever produce a Plan and hand it to the one committer — it cannot reach the database directly.**

This is the same discipline the codebase already enforces informally (all writes to synced entities go
through the op-log, never a direct bypass — stated in `operations.js`'s `DELETE_FIELD` comment).
Reconciliation makes it a structural property: adapters are pure producers, `commitPlan` is the sole
consumer-that-writes, and the Plan is the serializable contract between them. A future automated caller
inherits every guarantee (atomicity, conflict detection, provenance, staleness) because it cannot
route around the one committer.

---

## 7. The four foundations and where each one lives

The spine is four foundations. Their homes in the codebase are deliberately different, because they are
different *kinds* of fact:

| Foundation | What it is | Where it lives |
|---|---|---|
| **A. Stable identity + `source_aliases`** | A synced, projected entity `{id, camp_id, entity_type, source_label, entity_id, confirmed_by, confirmed_at, status}` recording that a source label maps to a Shoresh entity. Reviewable, revocable, append-only supersede/tombstone. | A **synced entity** registered in PROJECTIONS and written via `appendOp`, exactly like every other replicated row. Populated by the matcher (companion doc §identity hierarchy). |
| **B. The `ReconciliationPlan`** | The pure field-delta decision object of §2–§5. | **Pure `src/ingest/`** — no DB handle, serializable. Grows out of `buildPreview`. |
| **C. Persisted provenance** | Two per-row columns, `confirmed` and `source`, an enum not a score, written through `appendOp`. Drives the three visual "looks": inferred (muted) / confirmed (full) / unknown (full + "worth checking"). | **Per-row columns** on the existing setup entities, written via `appendOp`. *Not* a separate per-field confidence table — the op-log already persists field-level author/device/timestamp, so field-level provenance is already there; only the row-level trust state is new. |
| **D. Happens-before / staleness** | A time-shaped overwrite guard: a supplied value *older* than the field's current last-authoritative write becomes a `conflict`, never a silent update. | The **op-log clock** — `operations.seq` / `timestamp` / `parent_op_id` already in `schema.sql` — plus a base-generation stamp carried on exported sources/workbooks. |

The reason A, C, and D are three different homes rather than one table: identity is a *relationship*
(synced entity), trust is a *property of a row* (per-row column), and recency is a *property of a write*
(the op-log clock). Collapsing them — e.g. trying to make `confirmed` also answer "when" — is exactly
the value-vs-time confusion foundation D corrects (next section).

---

## 8. Foundation D is the correction to a value-only design (read this before building)

The first, natural design for safe re-import is *value-shaped*: store a `confirmed` bit per row, and let
a confirmed value win. This is **structurally incapable of overwrite protection**, and foundation D is
the correction (Red Hat's key finding in synthesis §3-D).

The problem: `confirmed` answers **who** vouched for a value, not **when** it was last authoritatively
written. Overwrite protection is a *temporal* question — "is the value I'm about to write based on a
view of the world that is now out of date?" — and no amount of value-state can answer a time question. A
director hand-edits an activity's location on Tuesday; a stale workbook exported Monday is re-imported
Thursday. A value-only design sees a non-empty proposed value and writes it, silently clobbering
Tuesday's edit. This is fixture F6 in the test plan, flagged as the case **most likely to be quietly
broken.**

The mechanism (reusing existing material, no new infrastructure):

1. **The clock already exists.** `operations.seq` is a monotonic `INTEGER PRIMARY KEY AUTOINCREMENT`;
   every op carries `timestamp` and `parent_op_id` (`schema.sql` lines ~109–120). The last-authoritative
   write to a field is already discoverable — `latestOp(db, entity, entity_id, field)` in
   `operations.js` returns exactly it.
2. **Sources carry a base-generation stamp.** An exported source or workbook is stamped with the op-log
   generation it was derived from (the "pin to base version-vector, warn on drift" pattern — a recurrence
   of this project's own diff-against-pinned-base lesson).
3. **The rule at commit:** if the proposed value's base generation is *older* than the field's current
   last-authoritative write, the item's `op` is `conflict` (reason + clock + competing source), never a
   silent `update`. This is a per-field extension of the same "did something newer land since your
   snapshot?" check that `detectBulkReplaceConflict`/`based_on_seq` already performs per-scope.
4. **The edit path must stamp the clock.** When a director hand-edits a row, that write flips
   `confirmed = true` *and* advances the op-log clock (it is a normal `appendOp`, so `seq`/`timestamp`
   advance automatically). That is what makes a director's hand-edit authoritative on the next re-import
   — the stale source loses the happens-before comparison.

Build order implication (from synthesis §10 PRE-S0): the Plan *type* must be able to hold
`conflict(reason + clock + competing-source)` on day one, paper-designed against the hardest consumers
(conflict+clock, clear, temporal staffing, cross-source) *before* S0 locks, or S0 proves only the easy
all-New path.

---

## 9. What this architecture explicitly does not do

Consistent with the program's hard non-goals (synthesis §0): the reconciliation layer does **not** add
MCP/CLI now (only the seam), does not schedule staff, does not do GIS/route optimization, does not
auto-merge ambiguous identities, and does not turn on engine enforcement of any new constraint
(location re-key, staffing feasibility) — those are deferred to their own tested engine slice. The Plan
*models* the box shapes; enforcement is a separate slice, and until then the UI must label
captured-but-not-yet-enforced data honestly.

---

## 10. Inconsistencies found

None. Every claim above was confirmed against `ingest.js`, `operations.js`, `preview.js`, and
`schema.sql`. The synthesis source's characterizations — field-level `appendOp` inside one transaction,
`seedNameMaps` running inside the transaction after teardown, `bulk_replace` being coarser than
field-level and having had its bypass-conflict-detection design rejected, `detectConflict` keying on
`(entity, entity_id, field)`, `buildPreview` being a pure create/skip embryo, and the `operations`
table carrying `seq`/`timestamp`/`parent_op_id` — all match the code as read on 2026-08-08.
