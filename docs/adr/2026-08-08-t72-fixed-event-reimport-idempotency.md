---
title: "Fixed-event (anchor) re-import is idempotent (T72)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: implemented
affects:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
  - docs/work/tickets/T72-fixed-event-reimport-idempotency.md
  - electron/ops/ingest.js
---

# Fixed-event (anchor) re-import is idempotent (T72)

## Status

Proposed.

## Context

S1a delivered "identical re-import → zero ops" (its F4 guarantee) but scoped it to the
six ingestible entities only. The fixed-event loop in `commitPlan`
(`electron/ops/ingest.js` ~651–713) was deliberately left out: it runs **unconditionally**,
minting a fresh `randomUUID()` anchor per resolved day and `appendOp`-ing every field with
**no recognition** of an anchor already in the DB. So each re-import of an unchanged schedule
creates a fresh set of duplicate `anchor_activities` rows. T72 owns closing that gap.

Anchors are written **only** in this one loop; the generic op whitelist never lets
`anchor_activities` through. Anchors are **inferred** from the parsed grid by
`inferFixedEvents` (there is no hand-edit-then-reconcile path feeding this loop today), and
they fan out **per resolved day** — one row per `(fixed event, day)`.

The columns this loop writes per row are exactly:
`camp_id, cohort_id, day_id, time_block_id, name, is_all_groups, group_ids`
(`unit_id`, `span_blocks`, `notes` are never written by ingest).

## Decision

### 1. Anchor identity key (the core question)

Two anchor rows are **the same fixed-event occurrence** when they agree on:

```
(camp_id, cohort_id, day_id, time_block_id, normalizeName(name))
```

This is the **slot identity** of a fixed event: "this activity, in this block, on this day,
for this cohort." `is_all_groups` and `group_ids` are deliberately **excluded** — they are
*attributes* of the occurrence, not part of its identity.

Why exclude the group scope (rejecting the ticket's fuller candidate tuple): including
`group_ids`/`is_all_groups` in the key is what *reintroduces* the duplication T72 exists to
kill. If a director's file later widens or narrows a fixed event's group set, a group-inclusive
key would compute a *different* key and **create a second row beside the old one** — the exact
silent duplicate the ticket forbids ("at minimum it must not silently duplicate"). The
slot-identity key instead recognizes it as the same occurrence and takes no action on the
attribute change (see §4). `inferFixedEvents` collapses by `(name, block, day-set)` and derives
one scope per entry, so within a single import the slot key names at most one row per plan
fan-out — the key is well-formed against how anchors are actually produced.

`group_ids` is a JSON string and would in any case be a fragile identity component: on a
clean re-import the resolved group UUIDs and their order are byte-identical (S1a recognizes the
same group rows; `inferFixedEvents` sorts group names deterministically), but nothing about
that stability is worth buying into the identity when excluding it is both simpler and safer.

### 2. The idempotent skip (recognize-not-create)

Mirror S1a's recognition-map pattern, confined to the fixed-event loop:

- Once, after any teardown and inside the same transaction (alongside `seedRecognitionMaps`),
  build an **anchor recognition set** from the live DB: for every `anchor_activities` row in the
  camp, add the slot key `(cohort_id, day_id, time_block_id, normalizeName(name))` (camp is
  already fixed by the query) to a `Set`. Camp-scoped read, entity/column names from constants,
  same discipline as `seedRecognitionMaps`.
- In the per-day fan-out, **before** minting `anchorId`, compute the slot key for the row about
  to be written. If the set already contains it, **skip**: emit no ops, mint no id, and record
  the row in a new `fixedUnchanged` tally. Otherwise create exactly as today, and add the new
  key to the set so a same-key second day-row inside the same import can't self-duplicate.

Single-committer / `appendOp` discipline is preserved: this only *gates* the existing writes;
it adds no new write path. The whole loop stays inside the one `db.transaction()`, so a held
import (S1a conflict on the entity pass) still rolls anchors back with everything else.

### 3. Schema

**No schema change.** Skip-if-exists is pure orchestration over reads the DB already supports.
No new column, no table, no UNIQUE constraint. (A UNIQUE on the slot tuple was considered and
rejected: it would convert the rare legitimate same-name/same-slot/different-group pair into a
hard insert failure and is unnecessary once the loop recognizes-then-skips. Enforcement stays in
the committer, consistent with how the six entities are handled.)

### 4. Interaction with recognition / hold-the-whole, and the update boundary

A fixed event is **create-or-skip only**. It never needs to become a `conflict` and never
participates in the S1a hold-the-whole sentinel:

- Anchors are inferred, not human-authored through a competing path, so there is no protected
  (human-owned) anchor field to defend — the Policy-A stale gate that guards entity fields has
  no analogue here.
- A changed group scope on a slot that already exists is **recognized and left untouched** (the
  skip in §2 fires on slot identity, so no duplicate is created), **not updated**. Anchor field
  **updates are explicitly out of scope for T72** and deferred to a later reconciliation slice.
  This is the one behavioral boundary worth stating plainly: after this change, re-importing a
  file whose *group membership* for an existing fixed-event slot changed will neither duplicate
  the anchor nor apply the new scope — it is a no-op on that row until anchor reconciliation
  lands.

## Consequences

- Re-importing an unchanged schedule produces **zero new `anchor_activities` rows and zero
  anchor ops** — F4 idempotency now extends to fixed events.
- A genuinely new fixed event (new name, new day, new block, or new cohort → new slot key) still
  creates, exactly as today.
- The `commitPlan` fixed-event outcome gains a `fixedUnchanged` count for evidence; `created`
  now counts only rows actually written.
- The deferred group-scope-update boundary (§4) is a known, documented limitation, not a
  regression — the pre-T72 behavior duplicated on every re-import regardless.

## Completion evidence

- New ingest fixture: import a fixed-event set, then import the **same** set again → assert the
  second pass writes **zero** new `anchor_activities` rows / zero anchor ops (`fixedUnchanged`
  equals the fan-out count, `created === 0`).
- A new-slot fixed event on a second import still creates.
- Existing ingest, golden-ops, and S2b suites stay green (the change only *adds* a skip branch;
  first-import op sequences are byte-identical).

## Open question for Governor (one product decision)

The slot-identity key means a re-import where a fixed event's **group scope changed** is a
no-op on that anchor (no duplicate, but the new scope is not applied) until anchor reconciliation
is built. Confirm this deferral is acceptable for T72, versus pulling a minimal anchor-scope
*update* into this ticket. Recommendation: **defer** — recognize-not-create is the smallest
responsible fix that satisfies the ticket's success predicate and its "must not duplicate" floor;
scope-update carries its own merge/staleness semantics that belong with the reconciliation program.
