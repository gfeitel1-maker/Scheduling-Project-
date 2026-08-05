---
title: "Ingesting recurring fixed events from a prior-year schedule"
document_type: adr
authority: normative
status: accepted
date: 2026-08-03
supersedes: []
implementation_state: in-progress
affects: [docs/work/tickets/T34-ingest-infer-fixed-event-blocks.md, docs/work/specs/2026-08-03-ingest-fixed-events-design.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
---

# Ingesting recurring fixed events from a prior-year schedule

**Status: ACCEPTED by the product owner, 2026-08-05**, who approved reopening §2 and instructed
implementation to begin, taking the recommended defaults on both open questions (Replace leaves
existing anchors untouched; no re-import anchor dedup this iteration). This ADR is the human-approval
gate that CONSTITUTION Article IV requires for an architecture change and for reopening a decision
recorded as accepted. It **amends** [ADR 2026-08-01 §2](2026-08-01-ingesting-a-prior-year-schedule.md);
it does not supersede it. The technical design under it is
[the fixed-events design spec](../work/specs/2026-08-03-ingest-fixed-events-design.md). Nothing is
implemented until this is accepted.

Resolves the design question behind [T34](../work/tickets/T34-ingest-infer-fixed-event-blocks.md).
`GOVERNANCE_INDEX.md` puts ingestion in the Database/sync row, whose gate is "ADR +
migration/rollback plan" — both are here.

---

## Context

ADR 2026-08-01 §2 fixed the ingest scope at **entities only, not placements**, and enforced it with
a whitelist (`INGESTIBLE_ENTITIES`) that deliberately excludes `template_slots`,
`template_overlays`, and `anchor_activities`. That ADR foresaw exactly this pressure: *"'Entities
only' is a scope decision that will be under pressure the moment someone notices the placements are
sitting right there in the parsed grid, and a whitelist is the difference between that being a
deliberate reopening of the decision and an afternoon's work."*

This is that deliberate reopening. T34 is a product-owner request, 2026-08-02: *"it is not
calculating or picking up fixed event blocks for a unit or for a group — i.e. lunch for two groups
is always X period every day."* A schedule grid encodes not just *which* activities a camp runs but
that some of them are **pinned to the same period every day for specific groups** — Mifkad, Lunch,
Swim, a staggered `Lunch 1/2/3`. Reading those back as bare activity names throws away the pinning,
and the director rebuilds it by hand — which for a large camp is a meaningful share of the retyping
this whole feature exists to remove.

The app already has a name for a pinned placement that is not a full template slot: an
**`anchor_activities`** row, labelled "Fixed Event" in the UI, with Mifkad / Lunch / Swim as its own
examples. It carries `name`, `day_id`, `time_block_id`, `is_all_groups`, `group_ids`, `notes`; it is
cohort-scoped; its projection already exists; and the engine already pins anchors first and fills
around them. So the concept, the storage, and the engine behaviour all exist. What is missing is
permission for *ingest* to propose one.

Product-owner decisions approved for this ADR (2026-08-02 → 2026-08-03):

1. **Reopen §2 for `anchor_activities` only.** Ingest may **propose** recurring fixed events, which
   land as `anchor_activities`. It still may **not** write `template_slots`, `template_overlays`, or
   anything else.
2. **Detection is majority + confidence.** For each `(group, activity, time_block)`, if the activity
   occupies a **majority** of that group's operating days it is a candidate; **every** operating day
   → high confidence (ticked by default), a majority but not all → low confidence (unticked). This
   mirrors the existing rare-activity `lowConfidence` handling.
3. **Group-scoping by shared shape.** Candidates sharing `(activity, block, day-set)` collapse across
   groups: if every group shares it → `is_all_groups`; otherwise scope to exactly the sharing groups
   (a whole unit falls out as its groups). Over-include; the director refines later.
4. **Staggered variants** (`Lunch 1/2/3`) fall out naturally as separate fixed events — one per
   distinct `(name, block, group-set)`. No special-casing.

## Decision

### 1. Ingest may propose recurring fixed events, behind the same non-skippable preview

The load-bearing decision of ADR 2026-08-01 — **read → propose → director edits → commit, and the
proposal stage is never skippable** — governs fixed events unchanged, and *more* strongly. Inferring
a placement is higher-stakes inference than inferring an entity name: it asserts not just that
"Lunch" exists but that it is fixed to a period for particular groups on particular days. So a
proposed fixed event is always a preview tick the director confirms; high-confidence events
default-ticked, low-confidence default-unticked, **all** of them shown. No "import fixed events
directly" path exists, and its absence is the feature.

### 2. The boundary moves by exactly one entity, and stays enforced by the whitelist

`anchor_activities` becomes writable by ingest — and **only** through a dedicated, validated commit
path (a `fixedEvents` payload on `commitIngest`), never through the generic `INGESTIBLE_ENTITIES`
path. `INGESTIBLE_ENTITIES` is **unchanged**: it still lists the six setup entities and still throws
for `anchor_activities` in the generic `approved` map. The guarantee that made §2 enforceable — the
boundary is what the writer can *address* — is preserved: there is now exactly one more thing the
writer can address, reachable only through code written specifically to validate it.

**What still holds, permanently under this ADR:** ingest never writes `template_slots`,
`template_overlays`, spans, overlays, or any placement other than `anchor_activities`. A test
asserts that a commit which *creates a fixed event* still writes **zero** `template_slots` rows —
the same shape of guarantee ADR 2026-08-01 completion-evidence #2 already established, now extended
to the case where an anchor genuinely is written.

### 3. No schema change, and therefore no migration

`anchor_activities` and its projection (`electron/ops/projections.js`) exist today; the table has
carried `name`, `day_id`, `time_block_id`, `is_all_groups`, `group_ids`, `notes` since the
version-16 migration. Ingest writes those existing fields through the existing op-log, per-day
fanned-out, exactly as the Fixed Events screen already does. It needs no new table, no new column, no
new projection.

**Rollback plan:** there is nothing to roll back at the schema level. If the feature is withdrawn,
the code is removed; every anchor it created is an ordinary record that stays valid, remains editable
on the Fixed Events screen, and is deletable and Trash-restorable through the paths that already
exist.

### 4. An import remains one transaction; an unresolvable fixed event is skipped, not fatal

The fixed-events writes run **inside the same SQLite transaction** as the entity writes, appended
after them (ADR 2026-08-01 §4 — the whole import commits together or rolls back together; no camp is
ever half-populated).

A single proposed fixed event whose block, day, or groups cannot be resolved to a real row — because
the director unticked the underlying entity, or chose *Replace* — is **skipped and reported in the
result**, not written and not fatal to the import. This is a reachable, legitimate consequence of the
director's own editing, not an error; surfacing it (never hiding it) satisfies §1, and confining the
blast radius to that one derived row rather than the whole import is the proportionate choice. A
genuine failure (a constraint or disk error) still rolls the entire import back, unchanged.

## Consequences

- A returning camp recovers not just its activity list but its fixed structure — Mifkad, Lunch,
  Swim, staggered lunches — as reviewable proposals rather than a second afternoon of retyping.
- Ingest becomes a path that creates `anchor_activities`. It is the *second* creator of anchors (the
  Fixed Events screen is the first); both must produce identically-shaped rows (per-day fan-out,
  cohort-scoped, `group_ids` as JSON, `is_all_groups` as `1|0`), or the same fixed event authored two
  ways diverges. The commit path mirrors `AnchorsScreen`'s create shape deliberately for this reason.
- The preview screen gains a Fixed Events section. It is tick/untick only — an imported fixed event
  is an ordinary anchor, so its full editor already exists on the Fixed Events screen, and building a
  second one in the preview would duplicate that surface.
- The §2 boundary is now "six entities plus `anchor_activities`, the latter only via one validated
  path." The next request to ingest a *template slot* is again a deliberate reopening, not an
  afternoon's work — the whitelist still makes that line visible.

## Completion evidence (to be satisfied by the implementation under this ADR)

1. No ingest path writes an `anchor_activities` row the director has not confirmed in the preview.
2. `INGESTIBLE_ENTITIES` is unchanged and a test still asserts the generic path rejects
   `anchor_activities`; anchors are writable only through the dedicated `fixedEvents` commit branch.
3. A commit that creates a fixed event writes **zero** `template_slots` rows — asserted by test.
4. Written anchors are cohort-scoped to the active Program and reference real `time_block_id`,
   `day_id`, and `group_ids` — asserted by test; per-day fan-out produces one row per day.
5. A fixed event that cannot resolve its block/day/groups is reported in the commit result and does
   not prevent the rest of the import from committing — asserted by test.
6. A forced failure inside the fixed-events branch rolls back both entities and anchors (atomicity).
7. No schema change and no migration: `anchor_activities` and its projection are untouched; the
   engine (`buildSchedule.js`) is untouched.
8. Detection produces high/low confidence per the majority split, collapses group-scope by shared
   shape, and separates staggered variants — asserted by unit tests over a fabricated fixture in both
   grid orientations.
