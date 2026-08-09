---
title: "Field-level update with hand-edit protection (S2b)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: implemented
affects:
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
  - electron/main.js
---

# Field-level update with hand-edit protection (S2b)

**Status: PROPOSED.** This is the payoff of the Onboarding & Reconciliation program: re-importing a
corrected source **updates** the fields that changed and **preserves** everything else — and a stale
source can **never silently revert a director's hand-edit** (fixture F6, "most likely quietly broken").

S2b is pure merge/conflict logic in `buildPlan` and `commitPlan`. It **consumes** the per-field
import-vs-human signal S2a persists on the op-log and adds **no schema change**. It sits on S0 (the Plan
type), S1a (recognition + commit-time re-resolution + hold-the-whole atomicity), and S2a (the `source`
marker). It turns two of the Plan's still-throwing arms **live**: `op:"update"` and
`op:"conflict", reason:"stale"`.

This ADR clears the ADR bar by changing what `commitPlan` does with a plan (`update`/`stale` go from
"reaching one is a bug" to real, reviewed behavior) and by making a not-obviously-reversible policy
choice (which fields a re-import may overwrite).

---

## Context

Three facts from the landed code set up S2b:

1. **S1a stops at recognition, never updates.** `buildPlan` (`src/ingest/buildPlan.js` ~144) makes a
   name-matched entity `op:"unchanged"` with `fields:{}` — it recognizes the row but never looks at
   whether any field *differs*. `commitPlan`'s `update`/`clear` arms throw "not implemented at S1a"
   (`electron/ops/ingest.js` ~467–471), and `conflict` is live only for `reason:"ambiguous_identity"`
   (~464). So today a director who fixes one field in a source file and re-imports gets an all-`unchanged`
   plan: the fix is silently dropped (S1a §5 states this plainly).

2. **The Plan type already holds `update` and `stale` with no reshape.** `RECONCILIATION_PLAN_TYPE.md`
   §2(c) is the `update` walk (a non-null `from`, a non-null `entity_id`, one `FieldDelta`), and §2(e)
   is the `stale` conflict walk (a `FieldConflict` carrying `reason:"stale"`, a `clock`, and the
   competing values). S2b fills these arms; it invents no new shape.

3. **The clock is inert for S2's raw-schedule input; S2a's provenance bit is the live mechanism.** Per
   S2a §Context, a raw schedule has no `base_generation`, so `source_base_seq = 0` and the happens-before
   clock cannot tell a re-importable field from a hand-edited one. What *can* tell them apart is
   `latestOp(field).source`: `'import'` (or a field with no prior op) = safe to update; `'human'`/`NULL`
   = a person authored it, protect it.

### Candidate approaches considered

The open question is **what a differing field on a recognized entity becomes, and when it is refused.**

- **A. Update every differing field; protect nothing (last-writer-wins).** *Rejected* — this is exactly
  the trust-killer the program exists to stop. A workbook exported Monday re-imported Thursday would
  silently revert Tuesday's hand-edit (F6). Article V forbids the silent overwrite.
- **B. Refuse every differing field (protect everything previously set) — "Policy B".** *Viable, safe,
  noisy.* Any change to any field that has a prior value is a conflict. Never loses a hand-edit, but
  buries the director in conflicts on fields only the import ever touched, so re-import is barely better
  than today's skip-or-wipe. Does not need S2a's per-field bit (per-row, or "has any prior op", suffices).
- **C. Update fields the import owns; refuse fields a human owns — "Policy A" (chosen).** A differing
  field whose last authoritative write was an *import* (`latestOp(field).source === 'import'`), or which
  has no prior write at all, becomes `op:"update"` and updates freely. A differing field a human authored
  (`source` is `'human'` or `NULL`) becomes a gated `op:"conflict", reason:"stale"` — surfaced, never
  written. **Selected** — it delivers the payoff (corrected schedules quietly update the import-owned
  fields) while making a hand-edit un-clobberable, and it degrades safely: because S2a defines
  `NULL = human`, all pre-S2 history is protected by default (§"The protection policy").

---

## Decision

### 1. `buildPlan` diffs fields for a recognized entity (the `update` arm goes live)

S1a's `buildPlan` recognizes a name-match and stops. S2b extends it to a **field diff**, which requires
the `existing` snapshot to carry field **values**, not just `{id, name}`:

- **Widen the snapshot.** `buildExistingSnapshot` (`ingest.js` ~160) is extended to select the
  comparable columns per ingestible entity (the same fields `commitCreate` would write), so `buildPlan`
  can compare proposed against live. This is the only structural change to the snapshot; it stays a
  read-only projection built the same way `ImportScreen` builds the preview snapshot.
- **Per matched entity, per field:**
  - proposed value **equals** live value → the field is not in the delta (`op:"unchanged"` contribution,
    zero ops) — unchanged idempotency (F4) preserved.
  - proposed value **differs** from live → the field enters `fields` as a `FieldDelta`
    `{ from: <live>, to: <proposed>, source: 'import' }`, and the item's `op` becomes `"update"`.
  - field **absent/blank** in the source → **not in `fields` at all** → preserved, no op. This is the
    load-bearing blank-vs-clear default (`MATCH_AND_MERGE_SEMANTICS.md` §3): a raw source's empty cell
    means "I don't carry this", never "remove this".
- An entity all of whose fields equal live stays `op:"unchanged"` exactly as S1a. An entity with at
  least one differing field is `op:"update"`, carrying **only** the changed fields.

`buildPlan` remains **pure** and cannot read the op-log, so it proposes `update` from *values only*. The
human-vs-import **protection gate is applied at commit** (§2), against the authoritative op-log — which
is where Article V requires the re-validation to happen anyway.

### 2. `commitPlan` applies the protection gate and makes `stale` live

Inside the existing transaction, in the S1a commit-time re-resolution loop (`ingest.js` ~434), the
`update` arm is handled **per field**, after recognition confirms the entity still resolves to its live
id:

For each `FieldDelta` in an `op:"update"` item:

1. Read `latestOp(db, entity, entity_id, field)`.
2. **Protected** iff `latestOp` exists **and** its `source` is not `'import'` (i.e. `'human'` or `NULL`
   — the S2a `NULL = human` rule). A field with **no** prior op, or whose last op is `source:'import'`,
   is **unprotected**.
3. **Unprotected** → write the update: one `appendOp` with `value: delta.to`, `source: 'import'`, and
   `parent_op_id: latestOp?.id ?? null` (recording the causal parent). (`parent_op_id` is `null` only
   when the field had no prior op.) **Concurrency note (R6):** `commitPlan` writes via **direct
   `appendOp`, which does NOT call `detectConflict`** — that guard runs only on the WS `submit_op` path,
   not on the host-local committer. Safety against a concurrent peer edit rests instead on: (a)
   better-sqlite3's **single-threaded transaction** — the whole commit is serialized; (b) the
   **`latestOp` re-read inside that transaction** (step 1) — the gate reads the field's true latest state
   at commit time, not the stale preview; and (c) **post-hoc `detectConflict` on the LOSING peer's later
   `submit_op`** — if a peer edit races, whichever `submit_op` lands after the import commit sees the
   import op as its new base and `detectConflict` fires on *that* path. `parent_op_id` is carried for
   causal correctness and that downstream detection, not because the import write itself is
   `detectConflict`-guarded.
4. **Protected** → do **not** write. Convert the field to a gated conflict and collect it into the same
   `conflicts` array S1a already uses:

   ```js
   { op: "conflict", entity, entity_id,
     reason: "stale",
     fields: { [field]: {
       from: <live human value>, to: <proposed import value>, source: "import",
       conflict: { reason: "stale",
         clock: { field_last_seq: latestOp.seq, source_base_seq: plan.base_generation /* 0 for raw */ },
         competing: [
           { value: <live>,     source: "human", seq: latestOp.seq },
           { value: <proposed>, source: "import" } ] } } },
     evidence: { tier: "exact_name", matched_name } }
   ```

   This is the `FieldConflict` shape from `RECONCILIATION_PLAN_TYPE.md` §2(e), unchanged. The **decision**
   for a raw source is made by provenance (step 2); the **clock is still carried** as evidence
   (`field_last_seq` shows *when* the human wrote), so the record is forward-compatible with S4, where a
   workbook's real `source_base_seq` will additionally participate. The shape is identical either way —
   only which signal *fires* differs by source family.

The `stale` arm in `commitPlan` therefore stops throwing and becomes **collect-into-conflicts, emit no
op** — the same disposition S1a gave `ambiguous_identity`.

### 3. Reconcile with S1a's hold-the-whole-import atomicity

S1a resolved (product owner, 2026-08-08) that **any** conflict holds the *entire* import: the transaction
writes nothing, all conflicts are returned for review, the director resolves and re-commits. S2b's
`stale` conflicts are **collected into the identical `conflicts` array** and trip the **identical `HELD`
sentinel** (`ingest.js` ~481–485). No new atomicity mechanism: a re-import that would clobber even one
hand-edit holds the whole import for review, just as an ambiguous identity does. A director never ends up
with a half-updated camp. This is the direct extension of S1a's decision to the new conflict reason, and
it keeps the "an unbuilt arm is a bug" discipline for the arms S2b does **not** turn on.

### 3a. Escaping the `NULL` trap: the resolution path stamps `'import'` (R1 — CRITICAL)

**Striking the "decays / one review click" framing.** An earlier draft (and S2a) implied a pre-S2a
camp's protection "decays as the data acquires provenance." That was materially misleading and is
**struck.** Walk the pre-S2a re-import honestly:

1. Every pre-S2a field is `NULL` = human = **protected** (S2a §3).
2. The first corrected re-import diffs by value → changed fields become `op:"update"` → the commit gate
   (§2 step 2) reads `latestOp.source = NULL` = human = **protected** → each becomes a `stale` conflict.
3. Hold-the-whole (§3) trips → the import writes **nothing**, all conflicts returned for review.
4. The director resolves by accepting the import value.

**The trap the fix closes:** if that acceptance were written through the *generic human seam*
(`main.js` `resolveConflict` ~661, which appends with no `source` → `NULL` = human), the field would be
re-tagged human and `source:'import'` would **never** be stamped. Because the update was HELD (step 3),
it also never got stamped at commit. Result: the field is human forever, the *next* re-import re-conflicts
on it, and the camp can **never** escape Policy-B-like friction — it re-conflicts on the same fields
every import, forever.

**The fix (design carefully):** **resolving a `stale` conflict by ACCEPTING the import value MUST stamp
`source:'import'` on the resulting write** — a *resolution-path* provenance, distinct from the generic
human edit seam. Concretely:

- The `stale`-accept resolution writes the accepted import value with `source:'import'` (the value came
  from the import; recording it as import-owned is truthful and makes the director's acceptance stick).
- This is **not** the generic `resolveConflict` human seam. See the implementation-surface note below —
  `main.js` `resolveConflict` is an existing host handler and needs a **source-aware variant** (or a
  parameter) so a `stale`-accept routes to `source:'import'` while other resolutions (e.g. a director
  typing a *third* corrected value by hand) stay `source:'human'`.
- **Reconcile with hold-the-whole (§3):** the held items commit on resolution. When the director resolves
  the held import, each accepted `stale` field is written with `source:'import'` in the same commit that
  releases the hold. A field the director instead overrides with their own typed value is written
  `source:'human'` (they just hand-authored it).
- **No blanket backfill.** Provenance is acquired one resolved conflict at a time, only for fields the
  director explicitly accepted from the import. Blanket-backfilling existing fields to `'import'` would
  strip protection from genuine pre-S2a hand-edits — the dangerous direction — and is explicitly rejected.

**The honest user-facing story:**

- A **new** (post-S2a) camp gets Policy A immediately — its imports write `source:'import'` from day one,
  so re-imports quietly update import-owned fields with no review.
- An **existing** (pre-S2a) camp's **FIRST** corrected re-import surfaces its changed fields for a
  **one-time** review. Once the director accepts them, those fields become import-owned and every later
  re-import is quiet. Genuine hand-edits stay protected throughout.

**Implementation surface (in scope for S2b).** R1's resolution-path change means `main.js`
`resolveConflict` (~661) — an existing host handler, therefore in scope — needs a **source-aware
variant**: a `stale`-accept resolution must write `source:'import'`, not fall through the generic human
seam. This is the one host-handler touch S2b adds beyond `buildPlan`/`ingest.js`. S2b is otherwise
pure logic; this handler change is called out so the Maker does not route `stale`-accept through the
provenance-erasing generic path.

### 4. What stays deferred (scope fence)

- **`op:"clear"` stays throwing (deferred to S4).** A raw schedule/PDF/xlsx **cannot express an explicit
  clear**: an empty cell is both blank and clear, and the tri-state has no encoding in a plain file
  (`MATCH_AND_MERGE_SEMANTICS.md` §3). So S2's raw-source `buildPlan` **never produces** a `clear`, and a
  blank is always the "preserve, no op" arm (§1). The `clear` op becomes live only at **S4**, when the
  enrichment workbook ships the explicit `<clear>` token. `commitPlan`'s `clear` arm therefore keeps
  throwing through S2 — reaching it from a raw source would be a bug.
- **`reason:"cross_source"` stays throwing (deferred to S7).** S2 is single-source (schedule). Competing
  values across source families are an S7 concern; the arm keeps throwing.
- **The clock as a *deciding* mechanism stays dormant** until S4 supplies a real `base_generation`. S2b
  carries the clock but decides by provenance.

### 5. No schema change; rollback = revert

S2b touches `src/ingest/buildPlan.js` (field diff + widened snapshot use), `electron/ops/ingest.js` (the
`update` write and the `stale` gate), and `electron/main.js` `resolveConflict` (~661 — the source-aware
`stale`-accept variant, §3a). No table, no column, no projection, no sync-wire change — those all belong
to S2a. The `main.js` change is host-handler logic, not a schema or contract change. **Rollback is a code
revert**: without S2b, recognized entities return to S1a's `unchanged`, no field is updated, no `stale`
conflict is produced, `resolveConflict` returns to its generic human-seam behavior, and the S2a `source`
column sits inert. Nothing at the data layer needs undoing.

---

## The protection policy — DECIDED: Policy A (product owner, 2026-08-08)

**DECISION (product owner, 2026-08-08): Policy A.** On a schedule re-import that would change a field
already holding a value, protect **only human-authored fields**; let the import freely update fields it
owns (or that were never set). This is no longer an open question — it is recorded here as decided.

- **Policy A (CHOSEN) — protect only hand-edited fields.** A change to a field a *human* authored
  (`latestOp(field).source` is `'human'` or `NULL`) is a `stale` conflict; a change to a field the
  *import* wrote (`source:'import'`) or that was never set updates freely. Precise and quiet: the
  director's hand-edits are inviolate, and everything else about a corrected schedule flows in without
  friction. This is the payoff the program promised. It **requires** S2a's per-field `source` bit.
- **Policy B (documented fallback, NOT chosen) — protect everything previously set.** Any change to any
  prior value is a conflict. Strictly safer but noisy. **Retained here as a tighten-later fallback:**
  because Policy A is a pure `commitPlan` predicate (step 2 of §2), the project can move A→B later
  without a schema change if the first release proves A too permissive. No code is written for B now.

**Why A, not B (the rationale behind the decision).** (1) B's noise directly undercuts the program's
success predicate — a re-import that conflicts on dozens of import-owned fields is barely an improvement
over skip-or-wipe; (2) A is not less safe in practice, because S2a's `NULL = human` default makes A
**degrade to B for any field lacking provenance** — all pre-S2 history and every untagged write are
protected exactly as B would, so A is strictly a *refinement* that relaxes protection **only** on fields
provably written by an import; (3) a false "protect" costs one review, a false "overwrite" costs a
silently lost hand-edit — A's failure mode is biased entirely toward the cheap error. The residual risk
in A is a field mistagged `'import'`; S2a's Security V1 invariant (`'import'` producible only by
host-local `commitPlan`, never by a submitted op) plus the `NULL = human` default make that path narrow.

---

## Consequences

- Re-importing a corrected schedule finally **updates**: the changed, import-owned fields flow in; blank
  fields are preserved; hand-edited fields are protected. The program's first usable version (handoff
  Q11 / fixture F5) is reached.
- A stale source that would revert a hand-edit produces a **reviewable conflict, never a silent write**,
  and — via S1a's hold-the-whole rule — holds the entire import until the director resolves it (F6).
- Two Plan arms (`update`, `stale`) go live with **no reshape** of the type S0 fixed; `clear` and
  `cross_source` stay fenced off for S4/S7. The "an unbuilt arm is a bug" discipline is preserved for the
  arms not yet turned on.
- Idempotency (F4) is preserved: an identical re-import diffs to all-equal, every item stays `unchanged`,
  zero ops.

---

## Completion evidence

1. **F5 — partial enrichment (THE success scenario).** A re-import where some fields are supplied with
   new values and others are blank: supplied-and-differing import-owned fields become `op:"update"` and
   write; blank fields are absent from the delta and **preserve** the live value (zero ops); an unchanged
   field stays `unchanged`. Asserted at both `buildPlan` (the diff) and `commitPlan` (the writes).
2. **F6 — stale over newer hand-edit (MOST LIKELY QUIETLY BROKEN).** A field is import-written
   (`source:'import'`), then hand-edited (`source:'human'`/`NULL`); a later re-import proposes a value
   differing from the hand-edit. Result: `op:"conflict", reason:"stale"`, **no op for that field**, the
   `FieldConflict` carries `from`=hand-edit / `to`=import / `clock.field_last_seq`=the hand-edit's seq;
   and — per hold-the-whole — the **whole import writes nothing** and returns the conflict. A re-commit
   after the director resolves it succeeds.
2a. **The NULL trap is escapable (R1 — CRITICAL).** Start with a pre-S2a field (`source:NULL`). First
   re-import → `stale` conflict, whole import held (evidence #2). The director **accepts the import
   value**; the resolution write carries `source:'import'` (the source-aware `resolveConflict` variant,
   §3a), **not** `NULL`/human. A **second** re-import proposing a further change to that field now sees
   `latestOp.source === 'import'` → `op:"update"`, writes quietly, **no conflict**. The test asserts the
   field's provenance flips to `'import'` on acceptance and that the second import does not re-conflict —
   i.e. the camp escapes the trap after a one-time review. A companion assertion: accepting the import
   value does NOT blanket-backfill any *other* pre-S2a field (they stay `NULL`/protected).
3. **Import-owned field updates freely (concurrency mechanism corrected — R6).** A field whose latest op
   is `source:'import'` and whose proposed value differs becomes `op:"update"` and writes via direct
   `appendOp` with `parent_op_id` = that op's id. The test asserts the write happens **and** that its
   safety does not depend on `detectConflict` on the commit path (which is never called there): it relies
   on the single-threaded transaction + the in-txn `latestOp` re-read, with `detectConflict` firing only
   on a racing peer's later `submit_op`. (A test that patched `detectConflict` to assert it guards the
   import write would be asserting a false mechanism — evidence #3 explicitly does not.)
4. **Never-set field fills.** A field with no prior op and a supplied value becomes `op:"update"`,
   `from:null`, `parent_op_id:null`, and writes — enrichment of a blank.
5. **`clear` and `cross_source` still throw; blank never clears.** A test asserts a blank source cell
   produces no op (preserve), `commitPlan`'s `clear` arm still throws if reached, and `reason:"stale"`
   emits no op / does not throw while `reason:"cross_source"` still throws.
6. **F4 idempotency and the S0/S1a anchors stay green.** An identical re-import is all-`unchanged`, zero
   ops (six ingestible entities); the S0 GOLDEN-OPS all-`create` corpus and the S1a recognition/ambiguity
   tests are unchanged.

---

## Open questions for the product owner / follow-up

1. **Policy A vs B — RESOLVED.** Product owner chose **Policy A** (2026-08-08). Recorded in §"The
   protection policy". Policy B is retained only as a documented, no-code tighten-later fallback. No
   product question remains here.
2. **Preview fidelity vs commit authority.** `buildPlan` proposes `update` from values only; the
   protection gate runs at commit. So the *preview* may show an `update` that commit reclassifies to a
   `stale` conflict (a peer hand-edit landed, or the snapshot lacked provenance). Per S0/S1a this is
   correct (commit re-validates, hold-the-whole re-surfaces), but the Designer (S5) should decide whether
   the preview should *also* carry provenance to pre-classify protected fields for a quieter first look —
   an enhancement, not a correctness requirement. Filed for S5, not blocking S2b.
