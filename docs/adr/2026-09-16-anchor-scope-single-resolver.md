---
title: "Anchor scope is resolved through one shared module, in two explicit projections, and never re-read from raw columns"
document_type: adr
authority: normative
status: proposed
date: 2026-09-16
supersedes: []
implementation_state: blocked
affects: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-28-fixed-vs-recurring-events.md]
related_tickets:
  - docs/work/tickets/T183-anchor-scope-reading-consolidation.md
  - docs/work/tickets/T180-recurring-event-division-scope-is-snapshotted.md
  - docs/work/tickets/T62-engine-schedules-anchor-activities-as-regular-slots.md
---

# Anchor scope is resolved through one shared module, in two explicit projections, and never re-read from raw columns

**Status:** proposed 2026-09-16 — **blocked** on T180 and T182 landing on main.
T180 introduces the resolver this ADR generalizes; T182 isolates the engine
seam. This ADR is authored during read-only analysis and its exact line/symbol
references are pinned to the post-T180/T182 tree; they will be re-verified at
rebase before implementation.

## Context

`anchor_activities` rows carry redundant scope columns —
`unit_ids` (age divisions, the T180 write target), the legacy singular
`unit_id`, `is_all_groups`, and `group_ids`. The rule for reading them has a
fixed precedence: **`unit_ids > unit_id > is_all_groups > group_ids`**. An empty
array is *not* a scope claim and falls through to the next rule.

On 2026-09-16 the same fault surfaced as three proven bugs and one false
warning (see T183 for the enumeration): each read site **re-encoded that
precedence** against the raw columns and trusted the column name. Two encodings
of one rule drift; here they drifted into an empty exclusion set (T62), an
unsuppressable anchor (weekCatalog), a screen label asserting a division the
data didn't support (AnchorsScreen), and a spurious reconciliation drift
(ingest.js).

T180 already created the correct atom for the engine —
`resolveAnchorGroupIds(anchor, groups)` in `src/engine/anchorScope.js`, pure,
returning **group ids** — and routed `buildSchedule`, `weekCatalog`, and (via
T182) the shared `anchoredActivityIdsByGroup` helper through it. It also patched
`AnchorsScreen.anchorTierLabel` but *inline*, leaving a second encoding of the
precedence in a screen file. And `electron/ops/ingest.js liveAnchorScope` was
not touched at all.

Two facts constrain the fix:

- **Engine purity.** `src/engine/*` must not import from `src/ingest` or
  `electron/`. The dependency arrow points *into* the engine: renderer
  (`ScheduleScreen`, `ReconciliationScreen`) and `electron/ops/*` already import
  from `src/engine`, so both remaining consumers can import the resolver
  without violating purity.
- **Two projections, not one.** Coverage math needs **group ids**
  (engine, ingest drift-compare). The setup UI label needs **division names**.
  These are different return types over the *same* precedence rule.

## Decision

1. **`src/engine/anchorScope.js` is the single home of the anchor-scope
   precedence rule.** No runtime code elsewhere reads `is_all_groups` /
   `group_ids` / `unit_id(s)` to *decide coverage or scope*. (Write paths, and
   migrations/rollback that mechanically move columns, are out of scope — they
   set the columns; they do not interpret them.)

2. **Two named projections share one precedence, expressed once.** Factor the
   precedence decision into an internal step, exposed as:
   - `resolveAnchorGroupIds(anchor, groups) → groupId[]` — the literal group ids
     (engine placement, weekCatalog suppression, ingest drift-compare). Exact,
     lossless.
   - `resolveAnchorUnitIds(anchor, groups) → { unitIds, inferred }` — the age
     divisions, for display. `inferred: false` when read from stored `unit_ids`;
     `inferred: true` when a **pre-v65 legacy row** carries only `group_ids` and
     the divisions are derived backward from it.

3. **The legacy backward derivation is lossy and must never be laundered into a
   fact.** Deriving divisions from `group_ids` cannot distinguish "covers the
   whole Juniors division" from "covers one Juniors bunk" — both yield `['t1']`.
   That asymmetry *is* the T180 bug. Therefore `resolveAnchorUnitIds` marks the
   legacy answer `inferred: true`, and `AnchorsScreen.anchorTierLabel` renders an
   inferred division set distinguishably from stored scope (exact rendering is a
   Designer call; the requirement is that the label not silently claim stored
   division scope for an inferred one). The group-id projection has no such
   hazard — it returns literal ids — so it carries no `inferred` flag.

   The inline `anchorTierLabel` fix that T180 shipped was a **known-suboptimal
   expedient**, and this ADR states so plainly: it wrote a second encoding of a
   precedence rule into a screen file *while fixing a bug caused by a second
   encoding of a precedence rule*. It was accepted only because T180 already
   carried a schema migration and the expedient fixed the visible symptom. The
   record says why it was wrong so the next person under the same time pressure
   does not make the same trade. (This wording is on gracious-thompson's own
   record, as the author of that expedient.)

4. **`electron/ops/ingest.js liveAnchorScope` resolves through
   `resolveAnchorGroupIds`, staying strictly report-only (ADR §4 —
   `fixedScopeChanged`, never writes).** Two implementation constraints:
   - **Parse at the SQLite boundary.** Rows carry JSON *strings*; the resolver
     does not deserialize. Parse `unit_ids`/`group_ids` (same defensive
     try/catch + null-sentinel posture as today's `group_ids` handling) before
     calling, or `Array.isArray` is false and scope silently falls through to
     the legacy branch.
   - **Supply `tier_id`.** Add a `SELECT id, tier_id FROM groups WHERE
     camp_id = ?` read alongside the `liveAnchorScope` scan and select
     `unit_ids` from `anchor_activities`; pass the live group list at evaluation
     time. Do not disturb the `SELECT id, name` group reads at ingest.js:518/909
     (different callers).

   **This item is T183's by default and confirmed so.** Leaving T180 unchanged
   is the scope its owner already approved; only *folding* the ingest fix into
   T180 would need fresh approval. So the conservative default lands it here.
   The sole residual is an owner reversal, which would surface before T180 lands
   (and gracious will ping immediately) — no separate ownership hold beyond the
   T180+T182 implementation block that gates all of T183.

5. **The importer must not silently destroy division scope on write.** This is
   the write half, folded into T183 after verification. `electron/ops/ingest.js`
   has no `unit_ids` at all: the create path writes only `is_all_groups`/
   `group_ids`, and `replaceScope` deletes every anchor before recreating from
   the file. So a Replace re-import flattens an app-authored division-scoped
   Recurring Event back into a `group_ids` snapshot — the exact bug T180 fixes —
   silently.

   **OWNER DECISION (2026-09-16): "Preserve + report."** The importer preserves
   an existing division scope across a Replace re-import (option c below) and
   surfaces the residue on the reconciliation report (option b); it does NOT
   gain a division representation in the workbook format (option a rejected, not
   built). Preserve here means the narrow, safe form gracious identified: do not
   *destroy* an existing `unit_ids` when the re-import carries no division
   information of its own — not "always write `unit_ids`" (a grid-observed
   `group_ids` remains a legitimate observation when the file supplies groups).

   The import source (the Excel grid) is bunk/group-oriented
   and has no division column, and anchors are absent from the export, so there
   is no clean source of division scope *from the file*. The key reframe (raised
   by cranky-sammet): don't derive division scope from the grid at all — the
   director already stated it in-app; **preserve it** across the re-import.
   Three positions, in order of preference:

   - **(c) PRESERVE — recommended.** Carry the director-set `unit_ids` of a live
     anchor across the Replace delete/recreate, matched by identity. This is the
     same protection principle as `_humanFields` (ADR 2026-08-09 Decision 2): a
     value a human asserted deliberately must not be silently overwritten by a
     later import. `unit_ids` set via AnchorsScreen is exactly that.
   - **(b) REPORT — the floor for what (c) can't cover.** An incoming anchor
     with no live counterpart, or a genuine conflict, is surfaced on the
     reconciliation report the way `fixedScopeChanged` already is — told, never
     asked, never blocking. Report only the residue, after preserving.
   - **(a) INFER from the grid — rejected as a first move.** The grid cannot
     distinguish "the whole Juniors division" from "three bunks that happen to
     be all of Juniors today." Inferring a division from coverage manufactures
     an intent the file never stated — the same lossy inference flagged on
     `anchorTierLabel` (item 3 above), promoted from a display heuristic into
     *stored* scope. Build a division representation into the import model only
     if a real camp's file turns out to state divisions explicitly.

   **Two verified mechanical facts that shape (c)** (traced in the main-based
   worktree; cranky flagged both as low-confidence and asked for verification):
   - **Anchors bypass the human-field path.** `_humanFields` is consumed only in
     the generic per-field commit path (ingest.js:1546/1583); the docstring
     (ingest.js:576-577) states `anchor_activities` is rejected by the `approved`
     whitelist and written only through the dedicated `fixedEvents` branch. So
     (c) is *extend* human-field protection to anchors, not reuse it as-is —
     more work than the precedent suggests, same direction.
   - **`replaceScope` deletes every anchor BEFORE the `liveAnchorScope` scan
     runs** (teardown is the first step of `run()`; the scan follows
     `seedNameMaps`). In Replace mode the live scan therefore sees an empty
     table — so preservation requires a **pre-teardown snapshot** of live anchor
     scope, keyed by the scope-excluding `anchorSlotKey` (which already excludes
     scope precisely so a director's scope edit doesn't fragment identity,
     ingest.js:~1626), reapplied on recreate. (Note: this also means today's
     read-side drift report is effectively add-mode-only.)

   **The identity key bounds (c)'s reach — and makes (b) a common path, not a
   rare one** (raised by cranky-sammet). `anchorSlotKey` excludes scope but still
   includes name + time block + day (+ cohort). A Replace re-import is typically
   *next year's* schedule, which is exactly the artifact that moves Lunch to a
   different block or the division swim from Monday to Tuesday. Any such move
   means the slot key does not match, preservation silently doesn't apply, and
   the event lands as a fresh grid-derived `group_ids` row. So:
   - (c)'s effectiveness is bounded by the year-over-year stability of
     name+block+day — the very thing a new schedule changes. Preserving the
     stable majority still beats preserving nothing, but the residue is not an
     edge case.
   - Therefore **(b)'s reporting must be good, not a footnote** — it may be the
     common outcome, not the exception.
   - **Design question (answer in this ADR, judgment call → owner check):** when
     block/day moved but the NAME matches a live division-scoped event, preserve
     scope by name-match anyway ("this event moved and kept its Juniors scope —
     check it") or drop to (b)? **Recommended: preserve-and-report** by name —
     the alternative silently discards a deliberate director choice merely
     because the timetable shifted, which is the same silent-loss failure this
     whole item exists to end. But it is a genuine judgment call and is the
     owner check, not a code default.
   - **Measure, don't guess, at implement time:** name+block+day cross-year
     stability is testable against a real prior-year import file. (The owner's
     dev camp at `shoresh-dev/shoresh.sqlite` has only all-camp `fixed` anchors
     — 5 Lunch, 5 Rest Hour — so it is unaffected by division preservation but
     is a fixture for the stability question. Reading it is an implement-time
     step against the owner's data, not something to do while blocked.)

   Recommendation: (c) preserve as the real fix, (b) report — well, not as a
   footnote — for the common residue, (a) not built speculatively. Final call is
   an owner check at implement time, not a silent pick.

## Considered options (item 2)

- **A — leave `anchorTierLabel` inline (T180 as shipped).** Cheapest; works
  today. Rejected: it is a second encoding of the precedence rule in a screen
  file, i.e. exactly the drift this ADR exists to end. Author of that inline fix
  (gracious) concurs it should be superseded.
- **B — one projection (`resolveAnchorGroupIds`) and derive divisions from its
  output in the screen.** Rejected: the label's need is divisions, and mapping
  resolved group ids back to tiers reintroduces the lossy backward derivation as
  the *primary* path, not just the legacy fallback.
- **C (chosen) — two named projections over one shared precedence, with the
  lossy legacy answer explicitly flagged `inferred`.** One rule, two honest
  return types, no silent inference.

## Consequences

- One place to change the precedence rule; a fourth scope column (or a change to
  the order) is a one-file edit with two projection tests.
- The ingest reconciliation surface stops emitting spurious division-scope
  drift on re-import of unchanged Recurring Events.
- The setup label can no longer assert stored division scope for a value it
  only inferred — the class of "label claims more than the data supports" bug
  is closed structurally, not per-screen.
- Cost: a small `inferred` flag threaded into one screen label; a widened group
  read in ingest.js. No stored-data change, fully reversible.

## Test-first seams

- `anchorScope` projection tests: `unit_ids` populated → both projections agree
  and `inferred: false`; empty `unit_ids` falls through; `is_all_groups`;
  legacy `group_ids`-only → `resolveAnchorUnitIds` returns `inferred: true`;
  `resolveAnchorGroupIds` returns literal ids with no flag.
- ingest: re-import of an unchanged division-scoped Recurring Event → assert the
  `fixedScopeChanged` list is empty (assert the row/absence, not the call).
- A guard test (or grep-guard) that no runtime consumer outside
  `src/engine/anchorScope.js` reads the scope columns to decide coverage.
