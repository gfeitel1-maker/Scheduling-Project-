---
title: "Import recognizes existing entities (S1a)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: not_started
affects:
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
  - docs/work/onboarding-reconciliation/IMPLEMENTATION_SEQUENCE.md
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
---

# Import recognizes existing entities (S1a)

**Status: ACCEPTED by the product owner, 2026-08-08** (direction approved; the one open behavior
question — commit atomicity — resolved to hold-the-whole-import, see Resolved decisions). This is the
first of two ADRs that the original S1 design was split into after adversarial (Red Hat) + Security
review found real, code-verified problems in the combined slice. The split follows the Governor
directive of 2026-08-08:

- **S1a (this ADR) — Recognition.** Make re-import *recognize* entities the camp already has, as a
  provable property of the plan at commit. **No `source_aliases`, no schema change, no sync/migration,
  no new synced entity.** Exact-normalized-name tier only. Shippable safely on its own.
- **S1b (`2026-08-08-s1b-source-aliases.md`, design not yet complete) — Alias memory.** The
  `source_aliases` table, the confirmed-alias tier, and alias-divergence detection/resolution, with
  all the sync/migration/atomicity/permission fixes the review raised. Parked as its own round.

S1a sits on top of the landed S0 ADR (`2026-08-08-reconciliation-plan-as-commit-input.md`), which
fixed the `ReconciliationPlan` type wide enough to hold `create / update / unchanged / clear /
conflict` on day one but exercised only `create`/`unchanged` at commit.

**S1a does not clear the "new persistent data shape" ADR bar** (it adds no table). It clears the
"changes an existing contract" bar: it changes what `commitPlan` does with a plan — recognition and
commit-time re-resolution are new commit behavior other tests and callers depend on — and it makes a
not-obviously-reversible tradeoff (commit-time re-resolution can now *gate* individual items instead
of aborting the whole import). Those warrant a durable, dated record; hence this ADR.

---

## Context

The S0 refactor routes the importer through `buildPlan(source, existing) → Plan` and
`commitPlan(db, plan, actor)`. Three facts from the merged S0 code set up S1a:

1. **`buildPlan` already emits `unchanged` when a name matches `existing`** (`src/ingest/buildPlan.js`
   ~118–129, `evidence.tier: 'exact_name'`) — but `commitIngest` calls `buildPlan(..., null)`
   (`electron/ops/ingest.js`), so at commit *every* approved name is a `create`. Re-import recognition
   works only in the preview UI (`ImportScreen.jsx` ~144–156 builds a real `existing` for
   `buildPreview`, cohort-filtered for `tiers`/`time_blocks`), and is enforced at commit only by the
   `UNIQUE(camp_id, name)` constraint plus the fact that the director's approved set has already had
   duplicates filtered out. The plan itself does not *say* "unchanged" at commit; it relies on an
   out-of-band UI filter. That is exactly the "snapshot masquerading as a decision" Article V and S0 §4
   warn against, and it means the idempotency guarantee (F4) is not provable at the plan/commit layer.

2. **`commitPlan` runs `seedNameMaps` for REFERENCE resolution only** (`ingest.js` ~234–249): it seeds
   `tierIdByName` / `blockIdByName` / `dayIdByName` / `groupIdByName` so a fixed event or a group→unit
   link can bind by name to a row born earlier this run or already live. It does **not** use these maps
   to *recognize* an incoming create as an existing entity — `commitCreate` (~260) blindly mints a new
   `randomUUID()` and `appendOp`s. A concurrent same-name row created in the review window therefore
   hits `UNIQUE(camp_id, name)` and **throws inside the transaction, aborting the entire import**
   (`ingest.js` ~326). This is the Red Hat R4 finding: Article-V commit-time re-validation is *asserted*
   by S0 but was never *built* for recognition.

3. **Matching today is exact-normalized-name only.** `normalizeName` (in `preview.js`) trims,
   lowercases, and collapses whitespace. `UNIQUE(camp_id, name)` is on the **raw** `name`. So two live
   rows whose raw names differ but normalize to the same string — `"Art"` and `"art "` — are both legal
   in the DB, and both normalize-match a single incoming label `"Art"`. That is a genuine ambiguity that
   exists **in S1a, without any alias machinery**, purely from the normalize/UNIQUE mismatch.

### Candidate approaches considered

Divergence was directed by the Governor split (the two-slice decomposition is the chosen shape), so
the open technical question inside S1a is narrow: **how does commit-time re-resolution behave when the
world changed under the plan?** Three candidates:

- **A. Keep the S0 behavior (rely on `UNIQUE` to catch collisions).** *Rejected — this is the R4 bug.*
  A collision aborts the whole transaction, so one concurrently-created same-name row throws away an
  otherwise-good multi-entity import. Recognition is also never expressed in the plan, so F4 stays
  unprovable.
- **B. Auto-resolve at commit (a colliding create silently becomes `unchanged` against the live row;
  a vanished `unchanged`'s row is silently re-created).** *Rejected.* This is last-writer-wins by
  another name and violates Article V — a concurrently-created row of the same *name* is not
  necessarily the *same entity*, and silently adopting it (or silently re-minting a deleted one) makes
  an identity decision no human saw. The normalize/UNIQUE ambiguity (fact 3) makes auto-pick outright
  unsafe: which of `"Art"`/`"art "` does the importer adopt?
- **C. Re-resolve inside the transaction and convert changed items to a *gated* `conflict` (chosen).**
  Re-evaluate each item's identity against freshly-seeded live name maps; a `create` that now collides,
  and an `unchanged` whose row vanished, both become a surfaced-for-review `conflict` that **emits no
  op** — never a `UNIQUE` throw, never an auto-pick. **Selected:** it is the smallest change that fixes
  R4 (no abort), keeps Article V (no silent identity decision), and handles the normalize/UNIQUE
  ambiguity (fact 3) as an explicit `ambiguous_identity` conflict rather than a coin flip.

---

## Decision

### 1. Scope of S1a: RECOGNIZE, nothing else

S1a delivers exactly four things:

1. **Wire the real `existing` snapshot into `buildPlan` at commit.** `commitIngest` builds the same
   `existing` map `ImportScreen` already builds for preview — per ingestible entity, cohort-filtered to
   the active Program for `tiers`/`time_blocks` exactly as `ImportScreen.jsx` ~150–153 does, camp-wide
   otherwise — and passes it as `buildPlan`'s second argument instead of `null`. An exact-normalized-name
   match then becomes `op:"unchanged"` (zero ops) **in the plan**, not a blind `create` de-duped
   downstream. Recognition becomes a property of the plan, which is what makes F4 machine-checkable.

2. **Commit-time re-resolution inside the transaction (resolves R4).** See §2.

3. **The `ambiguous_identity` conflict, live in S1a without aliases (resolves the normalize/UNIQUE
   ambiguity).** See §3.

4. **Gate `conflict` items at commit instead of throwing (resolves the S0 unreachable-arm boundary for
   the two S1a-live reasons).** See §4.

S1a **defers to S1b**: `source_aliases`, the confirmed-alias tier, `alias_divergence`. It **defers to
S2+**: field-level `update`/`clear` and the staleness `clock`. The `update`/`clear` arms in
`commitPlan` continue to throw; `conflict` with an S2+ reason (`stale`, `cross_source`) still throws if
reached. `buildPlan` still writes no field updates — a recognized entity is `unchanged`, never
`update`, in S1a.

### 2. Commit-time re-resolution (resolves RISK 4 / R4)

`buildPlan` decides tiers purely and sets a *provisional* `entity_id` from the `existing` snapshot it
was handed at emit time. **Final identity binding stays at commit**, because the review window between
preview and commit is exactly where a peer device can create or delete a same-name row.

Inside the existing `db.transaction()` in `commitPlan`, after teardown and after `seedNameMaps()`:

- **Seed a recognition map for all six ingestible entities**, keyed on `normalizeName(name)` (or the
  `label` column for `days_of_operation`), cohort-scoped to the active Program for `tiers`/`time_blocks`
  exactly as the snapshot builder scopes them. This *extends the existing `seedNameMaps` idea* to the
  recognition path — it reuses `groupIdByName`/`tierIdByName`/`blockIdByName`/`dayIdByName` where the
  scope matches, and adds `activities` and `cohorts` maps (which `seedNameMaps` does not build today,
  because reference-resolution never needed them). Each map value is the **set** of live row ids whose
  name normalizes to that key (a set, not a single id, so fact 3's `"Art"`/`"art "` case is visible).

- **Re-resolve each plan item against the freshly-seeded maps:**
  - **`create`** whose `normalizeName(_name)` now matches **exactly one** live row → the world changed
    under the plan (a peer created this same-name entity in the window). Do **not** `commitCreate`
    (that would throw at `UNIQUE`). Convert to a gated `conflict`, `reason:"ambiguous_identity"`,
    carrying the incoming label and the now-colliding live entity as competing candidates. Emit no op.
  - **`create`** whose `normalizeName(_name)` matches **more than one** live row → `ambiguous_identity`
    (§3), all colliding rows as candidates. Emit no op.
  - **`create`** that still matches nothing → `commitCreate` as today.
  - **`unchanged`** whose provisional `entity_id` still names a live row → nothing to write, as today.
  - **`unchanged`** whose `entity_id` **no longer names a live row** (deleted in the window) → convert
    to a gated `conflict`, `reason:"ambiguous_identity"` (the recognized identity vanished; whether to
    re-create is a human decision, never a silent re-mint). Emit no op. *(If, after the delete, its
    `normalizeName(name)` now matches a different single live row, that competing row is carried as a
    candidate; if it matches none, the conflict simply reports the entity is gone.)*

  Re-resolution uses the **same `normalizeName` predicate** as `buildPlan`, so the two layers cannot
  disagree about what "the same name" means.

- **A converted `conflict` never throws and never emits an op.** The `UNIQUE(camp_id, name)` constraint
  is thereby never reached by a recognized/colliding item — it remains only a last-resort backstop, and
  reaching it would be a genuine bug (a name we failed to re-resolve), preserved as a throw.

**Hold-the-whole-import behavior (product-owner decision, 2026-08-08).** If commit-time re-resolution
produces **any** `conflict`, the transaction **commits nothing** — every item is held. All conflicts are
collected and **returned in the outcome for review**; the director resolves them (in the preview) and
re-commits. This preserves the strict all-or-nothing guarantee of ADR 2026-08-01 §4 ("a partial ingest
that half-populates a camp is worse than one that fails cleanly"): a director never ends up with a
half-populated camp and unnoticed held items.

This still resolves R4. R4's defect was that a concurrent same-name row hit `UNIQUE(camp_id, name)` and
threw *inside* the transaction — an ugly crash. The fix is to **detect the collision before it reaches
`UNIQUE` and surface it as a reviewable conflict** instead of crashing. Whether the good items then
commit (partial) or wait (hold-the-whole) is a separate product choice; the product owner chose
hold-the-whole. So the mechanism is: re-resolution runs first; if it yields any conflict, the transaction
rolls back (nothing written) and returns the conflicts; if it yields none, the plan commits in full. The
`UNIQUE` throw is never the surfacing mechanism, and a real error (a failed `appendOp`, a projection
throw) still rolls back atomically as before.

### 3. `ambiguous_identity` is live in S1a — even without aliases

The review claimed this conflict needed the alias machinery. It does not. `normalizeName` collapses
case and whitespace, but `UNIQUE(camp_id, name)` is on the raw `name`, so a camp can legitimately hold
two live rows — `"Art"` and `"art "` — that both normalize-match a single incoming label. That is an
ambiguity in S1a's *only* tier (exact name), and it must **never be auto-picked**.

- In `buildPlan`: when a single incoming label's `normalizeName` matches **more than one** row in the
  `existing` snapshot for that entity type, emit `op:"conflict", reason:"ambiguous_identity",
  entity_id:null`, with all matching rows as `evidence.candidates`. (Today `buildPlan` builds `already`
  as a `Map`, so a second same-normalized name silently overwrites the first — S1a must detect the
  collision instead of letting the last one win.)
- At commit: the §2 re-resolution produces the same conflict when the ambiguity only appears against the
  *live* DB (a peer added the second normalize-colliding row after preview).

`ambiguous_identity` is the **only** conflict reason S1a introduces. `alias_divergence` is S1b's; it is
not reachable in S1a because there are no aliases.

### 4. `conflict` gates commit; it does not throw (for S1a-live reasons)

S0 left `update`/`clear`/`conflict` as throwing arms ("reaching one is a bug"). S1a refines only the
`conflict` arm, and only for its one live reason:

- `reason:"ambiguous_identity"` → **gated**: collected into the outcome for review, emits no op, does
  not throw. Because the product owner chose hold-the-whole-import (§2), the presence of any such
  conflict means the whole commit rolls back (nothing written) and the conflicts are returned for
  review — not a partial commit.
- `reason:"stale"` and `reason:"cross_source"` → **remain S2+**; still throw "not implemented" if
  reached (they cannot be produced by S1a's `buildPlan`).
- `op:"update"` and `op:"clear"` → **unchanged**; still throw. S1a writes no field updates.

This keeps S0's "an unbuilt arm is a bug" discipline while letting S1a's own conflicts flow to the
review surface.

### 5. F4 scope correction (resolves RISK 5 / R5)

The original F4 claim — "identical re-import → zero ops" — is **false as stated**, because the
fixed-event loop (`ingest.js` ~363–420) runs **unconditionally**: every re-import mints fresh
`randomUUID()` anchors and `appendOp`s them, producing duplicate `anchor_activities`. S1a does **not**
fix that. Accordingly:

- **F4 is scoped to the six ingestible entities only** (`cohorts`, `tiers`, `groups`,
  `days_of_operation`, `time_blocks`, `activities`). For those, an identical re-import of an
  already-present camp produces an all-`unchanged` plan and **zero ops**. This is the machine-checkable
  guarantee S1a actually delivers.
- **Fixed events still re-emit on every import.** This is stated plainly as a known, pre-existing
  behavior, not silently claimed as fixed. Anchor identity-matching (making the fixed-event loop
  idempotent by recognizing an already-created anchor rather than minting a new one) is filed as a
  **separate ticket, `docs/work/tickets/T72-fixed-event-reimport-idempotency.md`**, to be designed and
  built on its own.
- **Activity-rule floor writes only on `create`.** A corrected rule on an entity that recognizes as
  `unchanged` is therefore silently dropped in S1a. This is **acceptable for a recognize-not-update
  slice** (updating fields is S2's job) but is **stated here** so no reader mistakes it for a bug.

### 6. The S0 GOLDEN-OPS anchor stays green

Wiring a non-null `existing` must **not** change the op sequence for a genuinely-new import. For an
all-`create` corpus (nothing in the camp yet), `existing` is empty, no item matches, every item stays a
`create`, and the `appendOp` sequence is byte-identical to S0's characterization test (fixture F2). The
*only* behavioral change is that items which *match* an existing row become `unchanged` (zero ops)
instead of blind creates de-duped downstream. The golden-ops anchor is confirmed to stay green.

---

## Consequences

- Re-import recognition becomes a property of the **plan**, provable at the commit boundary, not an
  out-of-band UI filter plus a `UNIQUE` constraint. F4 (scoped to the six ingestible entities) is
  machine-checkable.
- A concurrently-created same-name row in the review window no longer **crashes the import** on the
  `UNIQUE(camp_id, name)` constraint. It is detected first and surfaced as a reviewable conflict; per the
  product owner's atomicity decision (§2) the whole commit is then held (nothing written) until the
  director resolves it. The `UNIQUE` throw becomes an unreachable backstop, not the surfacing mechanism.
- `ambiguous_identity` conflicts (from the `normalizeName`/raw-`UNIQUE` mismatch) are surfaced, never
  auto-picked. This is a real behavior in S1a with no alias machinery.
- **No new table, no schema/migration, no sync change, no new synced entity.** S1a touches only
  `src/ingest/buildPlan.js` and `electron/ops/ingest.js` (plus tests). `schema.sql`, `localDb.js`,
  `projections.js`, `campScopedEntities.js`, and the sync client/server are **not** touched — that is
  what makes S1a independent of `source_aliases` and safely shippable alone.
- Fixed-event re-import still duplicates anchors (pre-existing); tracked by T72, not by S1a.

---

## Completion evidence

1. **`existing` snapshot wired at commit.** `commitIngest` builds an `existing` map (names,
   cohort-filtered for `tiers`/`time_blocks` exactly as `ImportScreen` does) and passes it to
   `buildPlan`; a re-import of an already-present camp produces an all-`unchanged` plan and **zero ops**
   across the six ingestible entities (fixture **F4**, scoped to those six, machine-checkable).
2. **Exact-name recognition resolves in `buildPlan`.** A test proves an exact normalized-name match →
   `op:"unchanged"`, `evidence.tier:"exact_name"`; a genuinely-new label → `op:"create"`,
   `evidence.tier:"new"`.
3. **`ambiguous_identity` from the normalize/UNIQUE mismatch.** A test with two live rows `"Art"` and
   `"art "` and one incoming `"Art"` yields `op:"conflict", reason:"ambiguous_identity"` with **both**
   rows as `candidates` and **no auto-pick** — asserted in `buildPlan` and, via a peer-added second row,
   in commit-time re-resolution.
4. **Commit-time re-resolution holds the import gracefully, never crashes it (R4).** A fixture where a
   peer creates a same-name row in the review window: the colliding item becomes a gated `conflict`
   (**no op**, **no `UNIQUE` throw**), and — per the hold-the-whole decision — **the whole commit rolls
   back (zero rows written) and returns the conflict for review**; a re-commit after the director resolves
   it succeeds. A second fixture: an `unchanged` whose row was deleted in the window becomes a gated
   `conflict`, not a silent re-create, and likewise holds the import.
5. **`conflict` gates, `update`/`clear` still throw.** A test asserts `reason:"ambiguous_identity"`
   emits no op and does not throw; `op:"update"`/`op:"clear"` and `reason:"stale"`/`"cross_source"`
   still throw if reached.
6. **F4 does not claim fixed-event idempotency.** The re-worded F4/golden obligation covers only the six
   ingestible entities; a test documents that fixed events re-emit on re-import (the T72 behavior), so no
   test falsely asserts anchor idempotency.
7. **The GOLDEN-OPS S0 anchor stays green.** An all-`create` corpus with a non-null (empty) `existing`
   yields the byte-identical `appendOp` sequence of S0's fixture F2.

---

## Resolved decisions

1. **Partial commit vs. hold-the-whole-import — RESOLVED 2026-08-08 (product owner): hold the whole
   import.** If commit-time re-resolution yields any conflict, the transaction commits nothing; all
   conflicts are surfaced for review and the director resolves them before a full re-commit. This upholds
   the ADR 2026-08-01 §4 atomicity principle over the partial-commit friction reduction (§2, §4,
   Completion #4 reflect this). The Needs-Attention presentation of the held conflicts remains a Designer
   detail for the S5 hub, but the commit *behavior* is fixed: all-or-nothing.
