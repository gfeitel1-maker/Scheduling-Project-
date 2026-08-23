---
title: "Slice 3b design — Lunch as one recurring event with a per-unit stagger map"
document_type: spec
status: active
authority: informative
date: 2026-08-23
created: 2026-08-23
archive_when: Slice 3b ships (merged) or is re-scoped by Governor
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md]
related_adrs:
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
---

# Slice 3b design — Lunch as one recurring event with a per-unit stagger map

Implements ADR `2026-08-23-unified-schedule-overlay-model.md` D5(b): the *implementation* of the
owner-approved reversal of `2026-08-03` Decision 4. D5(b)'s direction — model a staggered activity
as ONE recurring entity carrying a stagger map, not N separate anchors — is already approved.

**Revision note (2026-08-23, second pass, reframed as an ingestion problem):** the first version
of this document led with a storage shape derived from one real schedule, whose stagger buckets
happened to be flat (constant block per group all week) — and got the shape wrong as a result: a
flat `{bucket → time_block_id}` map cannot represent what a second real schedule
("Schedule by Group.xlsx") actually contains, where **Alufim eats "Lunch 3" @ 12:55–1:35 on
Mon/Tue/Thu/Fri but "Lunch 5" @ 12:10–12:50 on Wednesday** — one group, two blocks, in a normal
week. This pass restructures the document to lead with **what ingestion should detect and
propose**, grounded in both real files, and derives the storage shape as whatever faithfully
persists that proposal — not the other way around. The automatic-merge recommendation is
unchanged in substance; the merge predicate, fallback scoping, and engine contract are rewritten
to be day-aware. The schema mechanics (how a JSON column gets added, the parity/gate checklist
shape, the reversibility argument) are preserved from the first pass and moved later in the
document, after the detection contract that motivates them.

**Not in scope**: Slice 0's already-shipped collapse fix (`fixedEvents.js` `cellPeriod`/`keyOf`,
commit 57847ca). Slice 4's engine capacity work (location contention). Slice 2b's weekly-recurrence
detect-or-confirm work (Defect 4 below). Defect 5's artifact-suppression rule (flagged, not
resolved, as an open question). Any UI editor for the stagger map beyond what commit produces.
**Revised scope note**: `fixedEvents.js` is *not* entirely untouched by this slice — Defect 3 below
requires one small, targeted change to it (stop discarding a minority-day tuple, surface it
low-confidence instead), correcting the "not touched" claim in earlier passes of this document.

## State of the world, verified against the live tree (2026-08-23)

Contrary to the slice plan's framing as "not yet started," **Slices 1 and 3a are both already
shipped** — `electron/db/schema.sql:460-469` (v42, `anchor_activities.schedule_week_id` +
`recurrence_level`) and `electron/db/schema.sql:765-778` (v43, `elective_sets` gains the identical
binding row). `CURRENT_SCHEMA_VERSION` is 43 (`electron/db/electiveCapacity.migration.test.js:70`).
Slice 3b is next in the dependency chain and targets schema **v44**.

`src/ingest/fixedEvents.js` walks the normalized `{orientation, timeAxis, groupAxis, cells}` shape
that `src/ingest/parseGridSchedule.js` produces (via `workbookToPages` → `extractEntities` →
`inferFixedEvents`), builds `(group, day, block, activity, period)` tuples (`addTuple`/
`cellPeriod`), and groups them into `ProposedFixedEvent` entries keyed by `(normalizeName(activity),
block, days-set)` — see `pushEntries`/`byPeriod` (`fixedEvents.js:209, 258-283`). `normalizeName`
(`src/ingest/preview.js:14-16`) is trim + lowercase + whitespace-collapse **only**.

**This pass was re-grounded by running the actual detector against both real files** (not just
reading the source), and the real output changes the scope of this slice: `fixedEvents.js` already
carries `scope.groups` and `scope.days`/`days` per proposed event — the division-partition data the
merge needs is **already present in the detector's output**; Slice 3b's clustering step consumes
existing fields, it does not need new extraction for the group/day membership. But the detector run
also surfaced a real defect (#3 below) that a pure downstream-clustering step cannot fix by itself,
because the data it would need to merge is not in the output at all — it's silently dropped before
the clustering step ever sees it. **`fixedEvents.js` is not fully out of scope for Slice 3b** — one
small, targeted change to it is required (see Defect 3); everything else about it is unchanged.

## Detection contract — 5 concrete defects, current → required behavior

Grounded in the actual detector run against both real files (`entities.groups`(14), `days`(5),
`time_blocks`(12), `activities`(~37) all extract correctly; daily all-group anchors — Carpool,
Busses, Group Time, Mifkad — already detect correctly at `conf: high`, `is_all_groups: true`, all 5
days; this part of the pipeline is not touched).

### Defect 1 — Fragmentation by block

**Current**: one logical "Lunch" emits as multiple separate `ProposedFixedEvent` rows, split by
block. File A: Lunch@11:25 / Lunch@12:10 / Lunch@12:10 / Lunch@12:55 (4 rows). File B: "Lunch 1" /
"Lunch 2" / "Lunch 2" / "Lunch 3" (4 rows, shift number printed in the name — a distinct identity
under `normalizeName`, unchanged, load-bearing per the task).
**Required**: the merge (this slice, downstream of detection) collapses these into **one**
staggered event, using `scope.groups` **already present** on each row — no new extraction. This is
D5(b) itself.

### Defect 2 — Fragmentation by coincidental day-support

**Current**: the same logical block+event further shatters when day-sets differ even though the
groups clearly belong to the same bucket-partition. File A: Lunch@12:10 splits into
`{Chalutzim,Giborim}` (Tue–Fri) and `{CITs}` (Mon,Tue,Thu,Fri) as **two separate rows** — same name,
same block, disjoint groups, merely different day-sets (a CIT absence on one day, most likely).
Menucha splits the same way: `{Tzofim3}` vs. `{Tzofim1,2, Yeladim}`.
**Required**: the clustering rule (Q2) must **not** treat a differing day-set as evidence of a
different event when name + block + group-partition already indicate one thing. This directly
corrects the first pass of this document, which required exact days-set equality across a whole
cluster — that requirement is now known to be wrong even for the *non*-staggered case (it would
have kept Chalutzim/Giborim and CITs artificially split at the same block).

### Defect 3 — Day-varying block silently dropped (the Alufim-Wednesday case)

**Current**: File B's Alufim Lunch detects **only** as "Lunch 3" @ 12:55 on `{Mon, Tue, Thu, Fri}`.
The Wednesday "Lunch 5" @ 12:10 occurrence for Alufim is **missing from the detector's output
entirely** — not present as a low-confidence row, not present at all. Root cause: `fixedEvents.js`'s
day-support is evaluated as a majority-of-operating-days threshold per `(group, block, activity)`
tuple; Wednesday is one day out of five/six, below whatever threshold keeps a candidate alive, and
gets silently discarded rather than surfaced.
**Required**: this is a genuine, narrowly-scoped **detection** gap, not a clustering gap — no
clustering step, however smart, can merge a fact that was never emitted. `fixedEvents.js` needs a
small, targeted change: a group's minority-day occurrence of a *different* block, for an activity
that otherwise recurs, must still be emitted as its own low-confidence `ProposedFixedEvent` (using
the confidence machinery already in the file — `CONFIDENCE`/`classifyConfidence`/`tierFromHighFlag`
— rather than a new mechanism) instead of being dropped below threshold. This is the one place this
slice's scope genuinely includes a `fixedEvents.js` change — corrects the "not touched" claim in
the first two passes of this document. It is a narrow addition (stop discarding a minority-day
tuple that already has all the data needed; classify it low-confidence) — not a rewrite of the
majority-threshold logic for the daily-vs-weekly axis, which stays out of scope (Defect 4, below).

### Defect 4 — Weekly, single-day-per-week events missed entirely

**Current**: "All Camp Activity" is correctly extracted into `entities.activities` but **never**
becomes a fixed-event candidate — its single-weekday presence falls below the daily-recurrence
majority threshold the same way Defect 3's minority day did, but for a *different* underlying
reason (a `weekly`-level event, not a `daily` one with one exceptional day).
**Not in scope for Slice 3b** — this is exactly the gap ADR D3.1/D3.2 names and defers to Slice 2b
(weekly-recurrence detection needs its own confirm-or-multi-week-evidence resolution, a genuinely
unresolvable single-week ambiguity, unlike Defect 3's fully-decidable case). Noted here only so it
isn't conflated with Defect 3 — both are "detector drops a minority-day occurrence," but Defect 3's
occurrence belongs to an activity that's *already* a confirmed recurring event with a majority
pattern (Lunch), while Defect 4's occurrence has no majority pattern at all to attach to.

### Defect 5 — False positives from structural artifacts

**Current**: File B emits "CIT Block 1", "CIT Block 2", "CIT Block 3" at `conf: high` — these are
header/row-label artifacts from the CIT sheet's own layout, not real activities.
**Not in scope for Slice 3b's core deliverable** — flagged as a real defect found by the same
grounding run, but orthogonal to staggering (it's an artifact-suppression rule, not a merge or
day-representation problem). Raised as an open question below for whether it should ride along in
this slice's `fixedEvents.js` touch (Defect 3 already requires opening that file) or be its own
follow-up.

### Confidence as the merge/confirm hook

The detector already tags confidence per candidate — `high` on the clean daily anchors, `low`
already on exactly the fragmented Lunch/Menucha rows (Defects 1–2) and (once Defect 3 is fixed) on
the newly-surfaced minority-day rows. This is a natural, already-existing signal for Q4: merge
clusters built entirely from `high`-confidence members can commit automatically; a cluster whose
merge depends on a `low`-confidence member (Defect 3's minority-day row) is a materially different
claim — "we're fairly sure this day is different" vs. "we're certain this is Lunch" — and gets
surfaced for confirmation rather than silently folded in. See Q4 below for the tiered
recommendation this produces.

## Empirical grounding, consolidated

- **File A**: Lunch fragments across 4 detector rows by block and incidental day-support (Defects
  1–2); the underlying partition is 3 divisions, division-aligned, no day-varying block anywhere.
  Two of the three divisions' cells print "Lunch + Leave," Alufim/CIT print plain "Lunch" — a real
  name difference, not a spelling variant (see Q2/Q3).
- **File B**: Lunch fragments across 4+ detector rows by block/shift-number naming ("Lunch 1".."Lunch
  3" observed directly in the run; "Lunch 5" for Alufim's Wednesday currently absent per Defect 3).
  Alufim alone has genuine day variation once Defect 3 is fixed; every other bucket is flat.
- Both files: division-aligned buckets — every bucket resolves to exactly one `tiers` row's member
  groups (modulo the day-support fragmentation Defect 2 describes, which is noise on top of a real
  division partition, not a different partition). Storage keys by unit/`tier_id` when this holds
  (both real files) and falls back to a synthesized group-set key only when it doesn't.

## Storage shape (derived from the proposal, not designed independently)

New column, schema v44, `anchor_activities.stagger_map TEXT`, nullable JSON. NULL means "uniform"
(today's only behavior, D3 axis 4). Non-null is a direct serialization of the clustering step's
per-bucket proposal object:

```jsonc
{
  "<bucket_key>": {
    "default_time_block_id": "<time_block_id>",
    "day_overrides": { "<day_id>": "<time_block_id>", ... }   // present only for days that differ
  },
  ...
}
```

- `bucket_key` is the resolved `tier_id` when the bucket's groups exactly equal one `tiers` row's
  members (both real files, the expected common case); otherwise a synthesized deterministic key
  (sorted-group-id join), exactly as the first pass of this doc described for the flat case —
  unchanged reasoning, just now one level richer per bucket.
- `day_overrides` is **sparse by construction**: a bucket with no day variation (every group in
  both real files except Alufim) has an empty or absent `day_overrides`, so the common case adds
  zero day-axis bytes over the flat shape the first pass proposed. This was ranked over a dense
  `(bucket, day) → block` map (also considered — see Candidates below) precisely because it
  matches the real shape: staggering exists, day-variation-within-a-stagger is the rare exception
  (one bucket out of three/four, one day out of six), and the JSON stays small and legible in a
  sqlite browser — a bucket with no exceptions reads as `{"default_time_block_id": "..."}`, no
  ceremony.
- `anchor_activities.time_block_id` stays populated as the representative/fallback block (the
  cluster's most-common `default_time_block_id`, deterministic tie-break by block string sort) —
  unchanged rationale from the first pass: every reader that hasn't been taught `stagger_map` yet
  sees a coherent, non-crashing anchor at *some* block.
- `group_ids` stays the union of all groups across all buckets — unchanged from the first pass.

### Candidate approaches considered (storage shape)

Five genuinely different shapes were generated under parallel divergent frames (regulator,
logistics, 3am-on-call, remove-the-load-bearing-assumption, naive/10-year-old) before converging
on the above. Clustered by underlying angle:

- **Default + sparse day-exceptions per bucket (chosen)** `[N7 V9 F9]` — matches the real data
  exactly (mostly uniform, one bucket has one exceptional day); one opaque JSON field, one op-log
  write, no new entity type; auditable (an exception literally names its day and — optionally —
  could carry a `reason` string per the regulator frame, not built this slice, noted as a cheap
  future addition); degrades safely (`day_overrides` absent ⇒ byte-identical to the flat shape).
- **Dense `(bucket, day) → block` map, no default/exception split** `[N4 V8 F8]` — a real
  alternative, structurally simpler (one tier, not two), but verbose against the actual data: up
  to 6 keys per bucket even when 5 of them repeat the same value, harder to eyeball-diff in a
  sqlite browser at 3am (the 3am-on-call frame's own criterion), no smaller-blast-radius property
  for a corrupted single key. Rejected in favor of the sparser shape; not a trap, a real runner-up.
- **Normalized child table** (`anchor_stagger(anchor_id, bucket_key, day_id, time_block_id)`)
  `[N5 V5 F6]` — **trap, amplified from the first pass**: the day dimension multiplies row count
  (up to ~6× more rows than the flat version already rejected for the same reason — new
  `entity_type`, new op-log/sync/undo-registration surface, per-row conflict resolution nothing
  actually needs since a director edits a stagger map as one act).
- **Per-day shadow anchor rows** (`Lunch-Mon`, `Lunch-Wed`, ... as separate `anchor_activities`
  rows) `[N6 V3 F2]` — **trap**: this is the entity-boundary-removal frame's most interesting idea,
  but it directly reverses D5(b) itself — the whole point of Slice 3b is that "Lunch" is one
  entity a director edits as one thing, not N entities kept in sync by hand. Splitting by day
  instead of by group is the same mistake in a different axis.
- **Reuse `day_overrides`/`special_days` for the Wednesday exception** `[N6 V4 F3]` —
  **trap**: overloads the ADR's own override-and-replace family (D2) for a contend-and-coexist
  case. A day override *replaces* a period; Alufim's Wednesday Lunch doesn't replace anything, it's
  normal recurring-event scheduling that happens to vary by day. Using the override mechanism here
  would blur the exact seam the ADR just drew.
- **Named rotation/service-pattern table** (a shared lookup of reusable day→block sequences, keyed
  by a pattern id, referenced by many anchors) `[N8 V3 F4]` — the most novel idea (logistics
  frame), and a real future win *if* many anchors across a camp start sharing identical weekly
  patterns — but nothing in either real file shows that yet (each camp's Lunch pattern is used by
  exactly one anchor). Building shared-pattern infrastructure for a one-anchor problem is
  premature per karpathy-guidelines; noted as the natural next step if a third real file shows
  cross-anchor pattern reuse, not built now.

Confidence: **high** on the default+day-exceptions shape, for the reasons above and because it is
a direct, lossless serialization of what the detection contract already computes — there is no
independent "storage design" step left to get wrong once the proposal shape is right.

## Q2 — Clustering rule (the detector's merge predicate)

Applied over the set of `ProposedFixedEvent` entries (each already carrying `scope.groups` and
`days` — no new extraction), before the commit write loop, in two stages:

**Stage 1 — base-name grouping.** Group entries by normalized name; for any name matching
`/^(.+?)\s*\d+$/` (a trailing shift-index numeral), also compute its stripped base. If two or more
entries — after this stripping — share a base **and** at least one of them had a numeral stripped
(never fires on a single already-identical name, never fires on an unrelated lone entry that
happens to end in a digit with no sibling), they form a **candidate cluster**. File A's
"Lunch + Leave"/"Lunch" do not share a base (no numeral involved) — no candidate cluster, two
anchors, unchanged from today. File B's "Lunch 1".."Lunch 3" (and, once Defect 3 is fixed, "Lunch
5") all strip to base "lunch" — one candidate cluster.

**Stage 2 — per-(group, day) partition check**, over the candidate cluster's entries. Corrects the
first pass's requirement (exact days-set equality across the whole cluster), which Defect 2's real
data shows is wrong even in the non-staggered case:

1. **Sub-partition by (block, groups) first, then union days.** Two entries with the same block and
   disjoint-but-clearly-partition-aligned groups but *different* day-sets (File A's Chalutzim/Giborim
   Tue–Fri vs. CITs Mon/Tue/Thu/Fri, both @ 12:10) are **not** treated as evidence of two different
   events — they union into one bucket at that block, with the day-sets merged (the bucket's
   effective days become the union; a group absent on a particular day simply isn't scheduled that
   day, which is orthogonal to which block it uses when it is). This is the direct fix for Defect 2.
2. **Per-(group, day) disjointness across different blocks, not whole-cluster disjointness.** For
   every `(group, day)` pair implied by the cluster's entries, that pair must appear at **exactly
   one** block. (Replaces the first pass's "groups arrays pairwise disjoint" test, which would have
   wrongly rejected the real Alufim case as "the same group appears in two entries.") Alufim appears
   at the Lunch-3 block for Mon/Tue/Thu/Fri and at the Lunch-5 block for Wednesday (once Defect 3
   surfaces that row) — each `(Alufim, day)` pair maps to exactly one block. Clean; this is the
   direct fix for Defect 1/3 together.
3. **Completeness.** Every group known to be in scope for this name-family, across every day it
   operates, maps to some block. No group's Lunch silently disappears.
4. **Division-alignment preference, per bucket** (unchanged posture from the first pass): when a
   bucket's groups exactly equal one `tiers` row, key it by `tier_id`; otherwise a synthesized key.
5. **More than one distinct block somewhere in the cluster** (unchanged: a cluster that reduces to
   one block everywhere is not a stagger, falls through to today's single-anchor path).

When all hold, the cluster commits as **one** `anchor_activities` row, `stagger_map` built as: for
each bucket (the groups sharing an identical block-per-day pattern across the whole week, after
rule 1's day-set union), `default_time_block_id` = the block covering the bucket's majority of
days, `day_overrides` = any day(s) where the bucket's block differs (Defect 1/3's fix) — never
built from a differing day-set alone (Defect 2's fix, rule 1 above absorbs that into one bucket
before `day_overrides` is even considered).

## Q3 — Fallback, rescoped to same-day conflicts only

Cross-day variation is **expected**, not a fallback trigger — this is the core correction from the
first pass. The non-clean shapes that still fall back to today's N-separate-anchors behavior:

- **Same-day conflict**: a group appears in two cluster entries covering the *same* day (violates
  Stage-2 rule 1) — e.g. a hypothetical bad source where Alufim shows both "Lunch 3" and "Lunch 5"
  on the same Wednesday cell/row. Contradictory, not staggered; falls back so the director sees and
  reconciles it by hand, same reasoning as the first pass's "overlapping groups" case.
- **Incomplete coverage**: a group in scope for the name-family has no covering entry on some day
  it operates (violates Stage-2 rule 2). Same fallback, same reasoning as the first pass.
- **No shared base after Stage 1, or a base shared by only one entry**: e.g. a genuinely different
  activity that happens to end in a digit with no sibling — never enters a candidate cluster at
  all, not a fallback case, just never clusters.
- **Name mismatch that Stage 1 correctly does not bridge** (File A's own real wrinkle, unchanged
  from the first pass): "Lunch + Leave" vs. "Lunch" do not share a stripped base — no fuzzy
  matching, no merge. Commits as two separate anchors, exactly as today.
- **`is_all_groups: true` co-occurring with a scoped bucket of the same base-name** — unchanged
  fallback reasoning from the first pass (a detection-layer inconsistency, not a legitimate
  stagger).

**Deterministic detection**: implemented as a pure function (e.g. `resolveStaggerCluster(entries)`
returning `{ merged: <ProposedFixedEvent-shaped object with stagger_map> }` or `{ merged: null,
entries }`), unit-testable against fixtures built directly from both real files: File A's
two-anchor outcome, File B's one-anchor-with-Wednesday-exception outcome, plus the same-day-
conflict and incomplete-coverage fallback shapes.

## Q4 — Automatic vs. director-confirmed, now tiered by confidence

**Revised recommendation (this pass): tiered, using the confidence field the detector already
produces, not a flat automatic/confirm choice.** Confidence: medium-high on the tiering itself,
same as the first pass's confidence in "automatic" alone.

- **All-high-confidence merges (Defect 1/2's fix) — automatic, no confirmation gate.** A cluster
  built entirely from `high`-confidence members (File A's division-partition-by-block-and-
  coincidental-day-support fragments; File B's flat, majority-supported shift entries) is fully
  decidable from the ingested data — merging four fragmented "Lunch@block" rows into the partition
  their own `scope.groups`/`days` already encode adds no new claim the director hasn't implicitly
  already reviewed by ticking the individual fragments.
- **A merge that depends on a `low`-confidence member (Defect 3's fix) — surfaced, default-ticked,
  with the day-exception named in the tile's label.** This is the one real change from the first
  pass's flat "automatic" recommendation: once Defect 3 stops discarding Alufim's Wednesday
  minority-day tuple, it's still tagged `low` by the same confidence machinery that already flags
  the fragmented-by-coincidence rows — "we're fairly sure Wednesday is different" is a materially
  weaker claim than "we're certain this is Lunch," and the existing preview convention already
  distinguishes high/low confidence elsewhere in this pipeline. Default-ticked (unlike Slice 2b's
  default-unticked stance, since there's no missing-information gap here, just a lower-support
  signal) but visibly flagged, so a director skimming the preview sees "Lunch — Alufim differs on
  Wednesday (low confidence)" rather than a silently-asserted claim.

This tiering is a small addition to the existing preview machinery (confidence tiers already
render differently), not a new confirmation mechanism.

## Q5 — Engine/render expansion contract, per-(group, day)

`src/engine/buildSchedule.js:120-158`: for each anchor, `groupList` is resolved from
`unit_id`/`is_all_groups`/`group_ids`, then every group is keyed against the anchor's single
`anchor.time_block_id`. This must resolve **per (group, day)**, not per-division-flat (the first
pass's version resolved per-group only, which was correct for the flat case but insufficient for
Alufim):

```js
const group = groupsById.get(gid)
const bucket = stagger_map && (bucketKeyFor(group) /* tier_id match, or synthesized-key membership */)
const effectiveBlockId = bucket
  ? (bucket.day_overrides?.[did] ?? bucket.default_time_block_id)
  : anchor.time_block_id
```

then key `anchorLookup` on `${gid}|${did}|${effectiveBlockId}` instead of the anchor's shared
`time_block_id`. Everything downstream of `anchorLookup` (placement-exclusion check ~line 310,
pre-placed rendering ~line 190) is already keyed on `(group, day, block)` triples and needs no
other change.

**Behavior-preservation check** (unchanged from the first pass): for `stagger_map == null`,
`effectiveBlockId` reduces to `anchor.time_block_id` for every group on every day — byte-identical
to today's loop. Maker's test suite should assert this with a `stagger_map: null` fixture producing
identical `anchorLookup` contents before/after.

**Slice 4 (engine location-contention) needs no extra work here**: after this slice,
`anchorLookup` already contains correct per-group, per-day, per-block entries for a staggered
anchor (including Alufim's Wednesday exception); Slice 4 consumes `anchorLookup` as it already
does, unaware staggering exists.

Render (Recurring Events screen, schedule grid's "what's here" query) needs the symmetric read-side
change: a cell at `(group, day, block)` resolves against a staggered anchor by checking
`stagger_map[bucket].day_overrides[day] === block` (falling back to `default_time_block_id`, or to
flat `time_block_id` when `stagger_map` is null) rather than a flat `time_block_id === block`
comparison. Maker should grep for existing `time_block_id ===` comparisons against
`anchor_activities` rows at implementation time and extend each found site, since this design
cannot enumerate every render call site without risking staleness.

## Migration/gate checklist

- **Schema version**: v44. Single additive column, `anchor_activities.stagger_map TEXT`, nullable,
  appended last per the drifted-table convention already on this table (v42/v43 precedent).
- **Files to touch**, named from the live tree:
  - `electron/db/schema.sql` — new column + comment block (mirror v42/v43 comment style).
  - `electron/db/localDb.js` — new v44 migration (`ALTER TABLE anchor_activities ADD COLUMN
    stagger_map TEXT`).
  - `electron/db/*.migration.test.js` siblings — **at minimum**
    `electron/db/electiveCapacity.migration.test.js` (`CURRENT_SCHEMA_VERSION` assertion, `43` →
    `44`), and any test hardcoding `anchor_activities`' full column list for fresh-vs-migrated
    byte-identical comparison must gain the new column. Run `grep -rln "anchor_activities"
    electron/db/*.migration.test.js` at implementation time and check each one's column-list
    assertions by hand — **this exact class of miss just failed the Slice 3a gate; do not repeat
    it.**
  - `electron/ops/projections.js` — the `anchor_activities` projection entry (`~line 270`) must
    pick up `stagger_map` in its field list, same as `schedule_week_id`/`recurrence_level` did.
  - `electron/ops/undoReferences.js` — register `stagger_map` in `ACCEPTED_NON_REFERENCES`
    (checked by `electron/ops/undoReferences.schemaParity.test.js`), same convention-only,
    `enforced: false` posture as `group_ids`, with the same documented scanner-gap note: the
    scanner's `jsonArrayContains` (`undoReferences.js:148-151`) only handles flat arrays, so a
    `stagger_map` value's embedded `time_block_id`s/bucket keys are real references the scanner
    cannot verify — accepted, not built as a `json_map`-kind extension this slice, since the ingest
    commit path is the only writer and resolves every id from live rows before writing.
  - `electron/sync/syncClient.js` `DOMAIN_TABLE_COLUMNS` and `electron/localClient.mock.js`
    `MOCK_WRITE_ALLOWLIST` — both must list `stagger_map`, per the v42/v43 precedent; grep each for
    `anchor_activities` at implementation time.
  - `projectionsCoverage`-style scanner — verify it picks up the new column; if schema-derived (as
    v42/v43 presumably proved out), no manual entry needed, but confirm rather than assume.
  - `src/ingest/fixedEvents.js` — **one targeted change** (Defect 3): stop discarding a
    minority-day `(group, block, activity)` tuple that differs from an otherwise-majority-supported
    pattern; emit it as its own low-confidence `ProposedFixedEvent` using the existing
    `CONFIDENCE`/`classifyConfidence`/`tierFromHighFlag` machinery instead of a new one. `normalizeName`
    itself is unchanged; Defects 4 and 5 (weekly-single-day detection, CIT-Block artifact
    suppression) are explicitly not addressed here — see Open questions.
  - `electron/ops/ingest.js` — commit-time write loop (`~1624-1765`): insert
    `resolveStaggerCluster` (Stage 1 + Stage 2 above, including the Defect 2 day-set-union
    sub-partition) before the existing per-tuple write; write `stagger_map` on the merged row;
    thread the merge's confidence tier through to the preview payload (Q4); leave the fallback path
    (non-clean clusters) using the existing per-tuple write unchanged.
  - `electron/ops/ingest.test.js` — new fixtures built from both real files: File A's
    fragmented-by-block-and-day-support rows collapsing into one clean 3-division anchor (Defects
    1–2), File B's one-anchor-with-Wednesday-exception outcome (Defects 1–3), plus the
    same-day-conflict and incomplete-coverage fallback cases.
  - `src/ingest/fixedEvents.test.js` — new fixture for Defect 3's minority-day emission (Alufim's
    Wednesday tuple now appears, tagged low-confidence, instead of silently vanishing).
  - `src/engine/buildSchedule.js` (`~120-158`) — the per-(group,day) `effectiveBlockId` change.
  - `src/engine/buildSchedule.test.js` — behavior-preservation fixture (`stagger_map: null`
    identical output) plus a new fixture reproducing File B's Alufim case: three buckets, one with
    a Wednesday `day_overrides` entry, asserting `anchorLookup` places Alufim at the Lunch-5 block
    on Wednesday and the Lunch-3 block on every other operating day.
  - Whichever render component resolves `time_block_id === block` against `anchor_activities`
    (grep-and-verify at implementation time).
- **Red Hat: required.** Named in the slice plan's own gate line and the ARCHITECTURE_STANDARD's
  schema-change gate. Direct Red Hat at: (a) the Stage-1 base-name stripping regex — can it ever
  false-positive-merge two genuinely unrelated activities that happen to share a stripped base with
  no real sibling relationship (e.g. "Period 5" and some other name ending in a coincidental "5")?
  the "only fires when unifying an existing sibling cluster" guard is the mitigation, worth
  adversarial testing; (b) Defect 3's relaxed minority-day threshold in `fixedEvents.js` — does
  lowering the bar to "emit as low-confidence" instead of "discard" risk resurrecting noise the
  majority-threshold was originally added to suppress (a truly one-off, non-recurring day getting
  proposed as a stagger exception)? This is the same single-week-ambiguity risk D3.2 names for the
  weekly-recurrence case, at smaller scale — worth Red Hat explicitly probing whether Defect 3's fix
  needs its own confidence floor separate from Defect 1/2's; (c) whether a *second* ingest of the
  same camp (re-import) correctly re-resolves an existing staggered anchor rather than duplicating
  it — the reimport-tombstone matching at `ingest.js:1035-1057` keys on `(cohort, day, time_block,
  name)` and will need to account for a staggered anchor's per-bucket `stagger_map` shape when
  matching, or risks treating a re-detected N-tuple form as unrelated to the existing merged row and
  duplicating it.
- **Rollback**: schema-level, none needed if withdrawn pre-merge (additive column). If withdrawn
  post-merge with live data, the column is simply never written by a reverted commit path;
  existing `stagger_map` values remain valid, harmless if unread — consistent with this repo's
  pre-production, no-live-camp-data posture.

## Reversibility

Unchanged from the first pass: a committed staggered entity is losslessly separable back into N
entities — `stagger_map` (now with its `day_overrides`) plus `group_ids` contains every fact N
separate anchors would have carried (name, per-bucket per-day block, scope). Not built as part of
Slice 3b.

## Scope boundary — explicitly not built by Slice 3b

- **No engine capacity accounting.** Slice 4 owns feeding `anchorLookup` occupants into
  `placeUsage`. This slice only fixes `anchorLookup`'s keys to be per-(group,day) correct.
- **No stagger-map editor UI.** Per the standing "no coming-soon controls" rule: the merged entity
  must be fully usable without one — it renders correctly (per-bucket-per-day resolution above),
  places correctly in the engine (per-(group,day) lookup above), and is editable today's way if the
  existing per-cell anchor editor is taught to read/write `stagger_map`/`day_overrides` instead of
  assuming a flat `time_block_id`. If, at implementation time, the existing editor genuinely cannot
  express "change just this group's Wednesday block," Maker should build the minimal read/write
  path (even unstyled) or explicitly flag a follow-up slice to Governor — not ship a merged entity
  with no edit path at all.

## Open questions for Governor

1. **Editability of a merged stagger entity** (unchanged from first pass) — does Slice 3b need a
   minimal per-group, per-day block editor, or is editing via re-import / direct JSON acceptable
   for one slice?
2. **Auto-merge vs. confirm-gate** — unchanged recommendation (automatic), but now explicitly
   requires the preview tile to surface day-exceptions in its label text (Q4) — is that sufficient
   surfacing, or does the owner want an explicit "this varies on Wednesday, confirm?" sub-line?
3. **Name-alias merging** ("Lunch + Leave" vs. "Lunch," File A's own wrinkle) — unchanged: this
   design recommends against bridging that gap, meaning File A commits as two anchors, not one
   3-division stagger, unless the director renames one to match the other by hand first.
4. **Reimport/re-detection collision handling** (Red Hat gate note above) — whether the
   reimport-tombstone matching logic needs its own design pass before Slice 3b starts, or can be
   handled inside Slice 3b's test-first work, is a scoping call once Red Hat's finding is in hand.
5. **Base-name stripping regex scope** (new, this pass) — Stage 1's `/^(.+?)\s*\d+$/` sibling-gated
   stripping is narrower than general fuzzy matching but is still new clustering logic beyond what
   the first pass proposed (which assumed exact-name equality was sufficient). Worth an explicit
   go/no-go from Governor/owner before Maker builds it, since it's the one piece of this design that
   makes a matching decision `normalizeName` itself doesn't make.
6. **Defect 5 (CIT Block 1/2/3 false positives)** — a real, confirmed defect found by the same
   detector run grounding this document, but orthogonal to staggering. Since Defect 3 already
   requires Maker to open `fixedEvents.js` in this slice, should artifact suppression ride along
   (cheap marginal cost, same file open) or ship as its own follow-up ticket (cleaner scope, but a
   known false-positive ships un-fixed for at least one more slice)? Product/scheduling call, not
   technical.

## Recommended path

Lead with the detection contract, grounded in an actual run of the detector against both real
files: `fixedEvents.js` already carries `scope.groups`/`days` per candidate and already gets the
daily all-group anchors right; the real gaps are two clustering defects (fragmentation by block,
Defect 1; fragmentation by coincidental day-support, Defect 2 — both fixable entirely downstream, in
a new clustering step) and one true detection gap (Defect 3: a minority-day tuple, like Alufim's
Wednesday, is silently discarded rather than emitted low-confidence — the one place this slice
requires a small, targeted `fixedEvents.js` change). Two further defects were found by the same run
and are explicitly out of scope: weekly single-day events (Defect 4, deferred to Slice 2b) and
CIT-Block artifact false positives (Defect 5, flagged as an open question, not resolved here).

Slice 3b's clustering step (Q2) groups `ProposedFixedEvent` entries by base-name (a sibling-gated
trailing-numeral strip), unions day-sets across entries that share a block and partition-aligned
groups (Defect 2's fix), and builds a per-bucket `default_time_block_id` + sparse `day_overrides`
map from entries that share a group but differ by block (Defect 1/3's fix). The resulting
`stagger_map TEXT` column (v44) on `anchor_activities` is a direct, lossless serialization of that
step's output — `{bucket_key: {default_time_block_id, day_overrides: {day_id: time_block_id}}}`.
Both real files are handled correctly: File A's block/day-support-fragmented rows collapse into one
clean 3-division anchor with no day variation; File B's shift-numbered rows merge into one anchor
whose one exceptional bucket (Alufim) carries a single Wednesday override, once Defect 3 stops
dropping that row. Merge ships tiered by the detector's existing confidence field (Q4): fully
automatic when every contributing entry is high-confidence, surfaced-but-default-ticked with the
exception named in the tile's label when a low-confidence minority-day row (Defect 3's fix) is
load-bearing to the merge. The engine's `anchorLookup` resolution becomes per-(group,day), which is
exactly the shape Slice 4's capacity work will need with no further change.

The real product/scope questions this design surfaces and does not resolve alone: whether a
minimal stagger-map editor must ship alongside the merged entity (open question 1); whether the
day-exception label plus default-ticked low-confidence surfacing is sufficient (open question 2);
the sibling-gated base-name stripping rule's acceptability (open question 5); and whether Defect
5's artifact-suppression fix should ride along with Defect 3's mandatory `fixedEvents.js` touch or
ship separately (open question 6).
