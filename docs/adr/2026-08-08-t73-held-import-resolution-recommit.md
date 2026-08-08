---
title: "Resolving a held import by re-submitting a resolved plan (T73)"
document_type: adr
authority: normative
status: proposed
date: 2026-08-08
supersedes: []
implementation_state: not_started
affects:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/work/tickets/T73-held-conflict-resolution-ui.md
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
  - electron/main.js
  - electron/preload.js
  - src/screens/ImportScreen.jsx
---

# Resolving a held import by re-submitting a resolved plan (T73)

**Status: PROPOSED.** S1a and S2b gave the commit path the ability to *hold* an import: any
`ambiguous_identity` or `stale` conflict trips the `HELD` sentinel, the whole transaction rolls back,
and `commitIngest` returns `{ held: true, conflicts: [...] }` having written nothing. There is today no
way to *finish* that import. This ADR defines the backend contract by which a director resolves a held
import's conflicts and re-commits it.

This is **orchestration over the existing primitives** — it reuses `buildPlan`, `commitPlan`, and the
existing `shoresh:ingest-commit` IPC handler. It adds **no schema, no migration, no new committer, no new
IPC method**. It clears the ADR bar only by changing an existing contract: `commitIngest`/`commitPlan`
gain a `resolutions` input, and the re-resolution loop learns to honor a director's per-conflict decision.
That contract change is what other code (the renderer, the tests) will depend on, so it warrants a durable
record.

---

## Context

Four facts from the landed code fix the shape of the problem:

1. **A held import persisted nothing.** `commitPlan` collects conflicts, and if `conflicts.length > 0`
   throws the `HELD` sentinel, which rolls back the whole `db.transaction()` — teardown, creates, and
   updates alike (`electron/ops/ingest.js` ~594–598, ~674–693). The director's *proposed* values were
   never written as ops. There is therefore **no persisted op to resolve against**.

2. **`resolveConflict` resolves against a persisted op, so it does not fit.** `main.js` `resolveConflict`
   (~661) looks the chosen value up by `chosen_op_id` in the `operations` table
   (`SELECT value FROM operations WHERE id = ?`), then re-writes it. A held import has no such row. Its
   S2b `stale_accept` variant (stamping `source:'import'`) is the *right semantics* but reached through
   the *wrong door* for a held import — the door needs a persisted op the held import never created. The
   ticket flags exactly this mismatch.

3. **Identity is bound at commit, against the live DB, every time.** `commitPlan` rebuilds recognition
   maps from the live DB inside the transaction (`seedRecognitionMaps`, ~327) and re-resolves each plan
   item there (~514–588). A resolution the director made against yesterday's preview cannot be trusted
   blind at commit — a peer may have changed the world again (Article V). Any re-commit must re-resolve.

4. **`commitIngest` already rebuilds the `existing` snapshot from the live DB at commit time**
   (`buildExistingSnapshot`, ~181; called ~244). So a fresh re-commit sees current live rows, including a
   candidate a peer added after the first preview.

### The two conflict shapes the director resolves

From the code, held conflicts arrive in one of two shapes:

- **`ambiguous_identity`** — `{ op:'conflict', entity, entity_id: null, reason:'ambiguous_identity',
  fields:{}, evidence:{ tier:'exact_name', candidates:[{id,name},...] }, _name }`. An incoming label
  matched more than one live row (the `"Art"`/`"art "` normalize/UNIQUE case), or a recognized identity
  vanished with a competing same-name row present.
- **`stale`** — `{ op:'conflict', entity, entity_id, reason:'stale', fields:{ [field]:{ from, to,
  source:'import', conflict:{...} } }, evidence:{ tier, matched_name }, _name }`. A re-import would
  overwrite a human-authored field (Policy A).

### Candidate approaches considered

- **A. Held-import-specific resolver that writes the proposed values directly.** A new host handler takes
  the held `conflicts[]` and the director's picks and `appendOp`s the resolved values itself. *Rejected —*
  it forks the write path. It would re-implement `commitCreate`/`commitUpdate`/the fixed-event loop and
  the hold-the-whole atomicity outside `commitPlan`, exactly the "one privileged committer" the S0 ADR
  exists to protect. It also can't cheaply re-diff against a live DB that moved again, so it either
  re-introduces the R4 crash or silently last-writer-wins.
- **B. Persist the held plan as pending ops, then resolve by `chosen_op_id`.** Write the import as ops,
  then let `resolveConflict` pick among them. *Rejected —* it destroys the hold-the-whole guarantee. The
  whole point of the `HELD` sentinel is that a held import leaves the DB byte-identical; persisting a
  proposal to make it resolvable half-populates the camp, the exact failure ADR 2026-08-01 §4 forbids.
- **C. RE-SUBMIT-RESOLVED-PLAN (chosen).** The renderer re-sends the **original import inputs** (the same
  `approved`/`links`/`cohort_id`/`fixedEvents`/`activityRules`/`mode` it sent the first time) **plus a
  `resolutions` payload** carrying the director's per-conflict decision. `commitIngest` re-runs
  `buildPlan` → `commitPlan` with the resolutions in hand; the pure diff and the commit-time re-resolution
  apply them, and the import commits in full or re-holds. **Selected** — it reuses the single committer and
  its atomicity verbatim, re-resolves against the live DB for free (Article V composes), and needs no new
  persistence and no new IPC method. It is the smallest change that finishes a held import without forking
  the write path.

---

## Decision

### 1. The re-commit mechanism: re-submit the original inputs plus a `resolutions` payload

A held import is finished by calling the **same** `shoresh:ingest-commit` handler again, with the **same
original inputs** and one added field, `resolutions`. There is no separate held-import resolver and no new
IPC method. `commitIngest` and `commitPlan` gain a `resolutions` parameter (default empty → today's
behavior exactly). The re-commit is host-only and `groups.import`-admin-gated because it *is* `ingestCommit`
— those gates (`main.js` ~244, ~254) are inherited unchanged.

The renderer holds the original inputs (it already has them in component state — `ImportScreen.commit()`
builds them) and the returned `conflicts[]`. On resolve it re-invokes with both. No server-side session or
stashed plan is needed; the plan is cheap to rebuild and *must* be rebuilt to re-resolve against the live
DB.

### 2. The `resolutions` payload

`resolutions` is a list of per-conflict decisions, each **keyed to a conflict** by the fields the conflict
already carries — `entity`, the normalized `_name`, and (for `stale`) the `field`:

```js
// ambiguous_identity — the director picked one candidate, or "create new"
{ entity, name, reason: 'ambiguous_identity', choice: 'existing', entity_id: '<candidate id>' }
{ entity, name, reason: 'ambiguous_identity', choice: 'create' }

// stale — per field: accept the import value, or keep the human value
{ entity, name, reason: 'stale', field, choice: 'accept' }
{ entity, name, reason: 'stale', field, choice: 'keep' }
```

`commitIngest`/`commitPlan` index these into a lookup keyed `entity | normalizeName(name) | field?`, using
the **same `normalizeName`** the rest of the path uses, so the key cannot disagree about "the same name".

#### `ambiguous_identity`

- **`choice: 'existing'` with `entity_id`.** The director pinned one candidate. `buildPlan` receives the
  resolutions and, for that label, treats it as recognized against the pinned `entity_id` (selected from
  the freshly-built snapshot's candidate rows) instead of emitting the ambiguity. Its **existing pure
  diff** against that specific row then produces `unchanged` (no fields differ) or `update` (fields
  differ) — so the resolved op is produced *by the same diff logic*, with no re-ambiguation. `commitPlan`'s
  re-resolution is made **resolution-aware**: for an item the director pinned, it does **not** re-run the
  generic normalize-collision check (that is what would re-ambiguate); it only verifies the pinned
  `entity_id` is still live (§4). This is how the pick is fed back without re-ambiguating.
- **`choice: 'create'`.** `buildPlan` emits `create` for that label. `commitPlan` honors it: the pinned
  "create anew" bypasses the collision-→conflict conversion for that item. The `UNIQUE(camp_id, name)`
  backstop remains — in the ambiguous case the collision is a *normalize* match (`"Art"` vs `"art "`), not
  a raw-name equality, so a genuinely-new raw name creates cleanly. **Product/design boundary (for the
  Designer, not the committer):** "create new" is offered only where a distinct raw name is possible; the
  UI must not offer "create new" for an exact raw-name duplicate, and if one is nonetheless submitted the
  commit re-holds it rather than throwing (§4).

#### `stale`

The `stale` decision is a **commit-gate** concern; `buildPlan` already emits `op:'update'` with the
FieldDelta. `commitPlan`'s Policy-A update gate (~562–570) becomes resolution-aware, per field:

- **`choice: 'accept'`.** Bypass the protection check and write the import value via the existing
  `commitUpdate`, which already stamps `source:'import'` (`IMPORT_SOURCE`, ~495). This **reuses S2b's
  `stale_accept` semantics** — the accepted value becomes import-owned, so the director's acceptance sticks
  and the next re-import updates it quietly (the S2b §3a NULL-trap escape) — but reaches them through
  `commitPlan`, the door that fits a held import, **not** through `resolveConflict`/`chosen_op_id`. The
  `parent_op_id` is the field's live `latestOp.id` read inside the transaction, exactly as an unprotected
  update already does.
- **`choice: 'keep'`.** Drop that FieldDelta from the item's delta — no op for that field. If it was the
  item's only differing field, the item contributes nothing (effectively `unchanged`).

> **Boundary note for the Maker.** `resolveConflict`'s S2b `stale_accept` variant (`main.js` ~702) is
> **not** removed and is **not** the held-import path. It remains for resolving a conflict that *was*
> persisted as an op (its `chosen_op_id` lookup requires one). A held import, which persisted nothing,
> routes its stale-accept through `commitPlan` per this ADR. The two paths write the same
> `source:'import'` provenance; they differ only in whether a persisted op exists to resolve against.

### 3. Atomicity: require ALL conflicts resolved, then commit the whole import

Consistent with the S1a hold-the-whole decision (product owner, 2026-08-08), the re-commit is
**all-or-nothing**:

- Every returned conflict must carry a resolution. A re-commit that leaves any conflict unresolved re-holds
  the whole import (it will simply re-produce that conflict at commit and trip `HELD` again). No partial
  commit.
- The commit still runs in the single `db.transaction()`. Resolutions convert gated conflicts into
  concrete ops *before* the write phase; if — after applying resolutions — `conflicts.length > 0` for any
  reason (an unresolved conflict, or a newly-appeared one, §4), the `HELD` sentinel trips and nothing is
  written, exactly as today. A director never ends with a half-finished import.

### 4. Determinism / Article V: the re-commit still re-resolves against the live DB

The resolution is a *decision*, not a *result*. `commitPlan` still re-resolves every item against the live
DB inside the transaction; the resolutions map only changes what a *resolved* item does when its world is
unchanged. Composition with the existing commit-time re-resolution:

- A **pinned `ambiguous_identity` → 'existing'(id)** is honored **iff** that `entity_id` still names a live
  row (`idExists`). If a peer deleted the pinned candidate in the meantime, the pin is stale → the item
  re-holds as a fresh `ambiguous_identity` (carrying whatever same-name rows now exist as candidates).
- A **pinned 'create'** that now collides on the raw `UNIQUE` name (a peer created that exact name) re-holds
  rather than throwing — the collision is detected in re-resolution before it reaches `commitCreate`.
- A **`stale` → 'accept'** re-reads `latestOp` in the transaction; it writes the import value with the live
  field's op as `parent_op_id`. A **'keep'** drops the field. If a peer introduced a *new* differing field
  on that entity since the preview, that new field surfaces as its own `stale`/`update` at commit and, if
  protected, re-holds the import — a newly-appeared conflict re-holds, exactly as S1a/S2b already specify.

So the re-commit is not a blind replay: it is a fresh `buildPlan`→`commitPlan` that *honors* the director's
decisions where the world still supports them and *re-holds* where it does not. This is the same
commit-time re-resolution S1a built; resolutions compose with it as an additional, decision-only input.

### 5. IPC surface

Minimal, and it reuses the existing method:

- **Request:** `shoresh:ingest-commit` (renderer `localClient.ingestCommit`) gains one optional field:
  `resolutions: [ ... ]` (§2), alongside the unchanged `approved`, `links`, `cohort_id`, `fixedEvents`,
  `activityRules`, `mode`, `token`. `preload.js` `ingestCommit` passes the args object through unchanged
  (it already forwards the whole payload), so **preload needs no signature change** — `resolutions` rides
  in the existing args object. `main.js` `ingestCommit` threads `resolutions` into `commitIngest`.
- **Response:** unchanged shape. On success, `{ held: false, conflicts: [], created, updated, total,
  fixedEvents, replaced? }`. If re-resolution re-held, `{ held: true, conflicts: [ ...fresh... ], ... }` —
  the renderer surfaces the new conflicts and lets the director resolve again. The outcome is the same
  contract `ImportScreen` already consumes.
- **Gates preserved:** host-only (`mode === 'client'` refusal) and `groups.import` admin gate are inherited
  because this is the same handler. No new authority is introduced.

### 6. No schema change

Confirmed. `resolutions` is a transient input on an existing IPC call; held `conflicts[]` are already
returned in memory and never persisted; `source:'import'` is the existing S2a column written by the
existing `commitUpdate`. No new table, column, index, projection, or sync-wire message. Rollback is a code
revert: without T73, `commitIngest`/`commitPlan` ignore `resolutions` and a held import simply stays held,
exactly as it does today. Nothing at the data layer needs undoing.

---

## Consequences

- A held import can be finished in-app: the director resolves each conflict and re-commits through the
  **same** `ingestCommit`, reusing the single privileged committer and its hold-the-whole atomicity.
- The re-commit re-resolves against the live DB, so a peer's concurrent change re-holds gracefully instead
  of silently clobbering — Article V composes with the resolution decision rather than being bypassed by it.
- `stale`-accept on a held import writes `source:'import'` through `commitPlan`, delivering the S2b NULL-trap
  escape without needing a persisted op — closing the gap the ticket named.
- Two arms of the write path change contract: `buildPlan` and `commitPlan` gain a resolution-aware branch,
  and `commitIngest`/`main.js`/`localClient` thread `resolutions`. `preload.js` is untouched (opaque args).
- **No schema, no migration, no new committer, no new IPC method.**

---

## Completion evidence (for the Verifier/Tester to make true; no code written here)

1. **Held → resolved → committed (ambiguous_identity, pick existing).** A held import with an
   `ambiguous_identity` conflict is re-submitted with `choice:'existing', entity_id`; the import commits,
   the resolved item lands as `unchanged`/`update` against that entity, no new row is minted, and no other
   conflict is produced.
2. **Held → resolved → committed (ambiguous_identity, create new).** Re-submitted with `choice:'create'`;
   a genuinely-new raw name creates cleanly; an exact raw-name duplicate re-holds (does not throw `UNIQUE`).
3. **Stale accept stamps `source:'import'` via commitPlan.** A held `stale` conflict re-submitted with
   `choice:'accept'` writes the import value with `source:'import'` and `parent_op_id` = the live field's
   latest op; a **second** re-import of the same field does not re-conflict (NULL-trap escaped) — asserted
   without any `resolveConflict`/`chosen_op_id` call.
4. **Stale keep drops the field.** `choice:'keep'` writes no op for that field; the human value is intact.
5. **All-or-nothing.** A re-commit that leaves any conflict unresolved re-holds the whole import (zero
   rows written); one with every conflict resolved commits in full.
6. **Article V composition.** A peer deletes a pinned `existing` candidate (or creates a raw-name collision
   for a pinned `create`) between preview and re-commit → the import re-holds with a fresh conflict rather
   than committing a stale decision or throwing.
7. **Gates and shape preserved.** The re-commit refuses on a Client and without `groups.import`; the outcome
   is the existing `{ held, conflicts, created, updated, total, fixedEvents }` contract.

---

## Open questions for the product owner

1. **"Create new" for an exact raw-name duplicate.** When an `ambiguous_identity` arises from a true
   raw-name duplicate (not merely a `"Art"`/`"art "` normalize collision), "create new" cannot succeed
   against `UNIQUE(camp_id, name)`. The committer's behavior is fixed here (re-hold, never throw), but
   **whether the UI offers "create new" at all in that case** is a Designer/product call for the S5
   Needs-Attention surface — recommend the UI suppress "create new" and offer only "merge into one of
   these" when the candidates share a raw name. Not blocking the backend contract.

All other decisions (re-submit-resolved-plan, all-or-nothing atomicity, stale-accept via `commitPlan`,
no schema change) are technical and settled above; none require a product ruling.
