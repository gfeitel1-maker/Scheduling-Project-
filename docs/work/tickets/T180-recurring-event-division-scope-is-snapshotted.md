---
title: "A Recurring Event's division scope is snapshotted at save, so a group added later is silently excluded"
document_type: ticket
status: completed
created: 2026-09-16
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T62-engine-schedules-anchor-activities-as-regular-slots.md]
related_adrs: [docs/adr/2026-08-28-fixed-vs-recurring-events.md]
archive_when: adding a group to a division either extends that division's recurring events to it, or the UI stops claiming division scope for a fixed group list — covered by a test
---

# T180 — A Recurring Event's division scope is snapshotted at save

**Risk:** Medium — user-visible scheduling correctness, and the screen currently
asserts something the data does not hold.
**Task class:** scheduling / setup UI.

Found while auditing the T62 defect class (code trusting a link that isn't
really there). Different mechanism, same shape: a label that claims more than
the stored data supports.

## Problem

Creating a Recurring Event, the director picks **age divisions** (tiers). On
save, `src/screens/AnchorsScreen.jsx:107` expands that selection to the groups
in those divisions and stores the result as a fixed `group_ids` list:

```js
const group_ids = isFixed
  ? []
  : groups.filter(g => selectedTiers.includes(g.tier_id)).map(g => g.id)
```

The division itself is never stored. So:

1. Add a group to that division later — a new bunk mid-season — and the
   recurring event **does not apply to it**. Nothing surfaces this.
2. The Anchors list still shows the division's NAME in the "Age Divisions"
   column, because `anchorTierLabel` (`AnchorsScreen.jsx:651`) derives it
   *backwards* from the stored `group_ids`. One group of a division is enough
   for the row to read as the whole division.
3. Re-opening the editor pre-ticks the division the same backwards way
   (`AnchorsScreen.jsx:85-91`), so the form shows "this division" while the
   data covers a subset. Saving without changing anything silently repairs it —
   which also means the bug is invisible to anyone who happens to re-save.

The engine is faithful to the data: `buildSchedule.js` resolves a non-all-groups
anchor straight from `anchor.group_ids`. Nothing is wrong downstream; the loss
happens at save.

## Note on `unit_id`

`anchor_activities.unit_id` is exactly the mechanism that would make division
scope live rather than snapshotted, and `buildSchedule.js:135` already resolves
it as the FIRST branch of scope resolution (`groups.filter(g => g.tier_id ===
anchor.unit_id)`). It is deliberately unwritten today — see the recorded
exemption in `electron/ops/projectionsCoverage.test.js:296` (legacy rows may
carry it; no current writer). Reviving it is therefore a real option, not a new
column — but it is a **decision**, not a cleanup, since it changes what a
recurring event means and `unit_id` is not in the writable-field registries
(`electron/ops/projections.js`, `src/localClient.mock.js`) and would have to be
added to both.

## Options (owner decision — do not pick unilaterally)

1. **Store the division.** Write `unit_id`, let the engine's existing branch
   resolve groups at build time. Division scope becomes live. Costs: registry
   additions, a migration decision for existing rows, and the v51 CHECK
   constraint interaction needs checking.
2. **Keep the snapshot, stop the UI lying.** Display the literal group list
   rather than a division name reverse-derived from it, so what is shown is
   what will happen. Cheapest, honest, loses the convenience of the label.
3. **Snapshot but re-offer.** Keep `group_ids`, and when a group is added to a
   division that has recurring events, surface it — per the standing rule, as a
   flag, never a banner (see `feedback_no_banners_flags_instead`).

Recommendation: **(1)**, medium confidence — it matches what the director meant
when they picked a division, and the engine branch already exists and is tested.
(2) is the safe fallback if the registry/migration cost is judged too high for
the value.

## Testing

Test-first. Whichever option is chosen, the pinning test is the same shape:
a recurring event scoped to a division, a group added to that division
afterwards, then assert the intended behavior — either the new group is
covered (option 1), or the UI no longer claims division scope (option 2).

## Out

- Fixed (all-camp) events. `is_all_groups=1` resolves live already; unaffected.
- The T62 name-matching fix (`docs/work/tickets/T62-*`), already merged.

## Decision (owner, 2026-09-16)

**Option 1, in its plural form.** Option 1 as written could not be implemented
as written: the division picker (`toggleTier`, `AnchorsScreen.jsx`) is
**multi-select**, and `unit_id` is a single TEXT column the engine matches
against one tier. Writing `unit_id` would therefore have fixed only
single-division events and left the schema meaning two different things
depending on how many divisions a director ticked. The owner chose the honest
form: store the divisions as a **list**.

## Resolution

- **v65 migration** (`electron/db/localDb.js`, `schema.sql`) adds
  `anchor_activities.unit_ids TEXT` — a JSON array of tier ids. A table
  RECREATE, not an `ADD COLUMN`, because v51's `kind='fixed'` CHECK had to grow
  to cover it (SQLite cannot attach a cross-column CHECK to an existing table).
  Backfill converts a legacy `unit_id` into a one-element `unit_ids`; a
  `group_ids` snapshot row is **not** converted — the division it meant is not
  recoverable from the groups, and guessing it backwards is the derivation this
  ticket exists to remove. `unit_id` is kept, not cleared, so rolling back
  cannot lose scope.
- **Engine**: scope resolution moved into one shared function,
  `src/engine/anchorScope.js` (`resolveAnchorGroupIds`), used by both
  `buildSchedule.js` and `weekCatalog.js`. The extraction was not cosmetic —
  `weekCatalog` read `anchor.group_ids` raw, so a division-scoped event (empty
  `group_ids`) could never be suppressed by a week exclusion. That was a second
  live defect, found and fixed here, with its own tests.
- **AnchorsScreen**: writes `unit_ids` and an empty `group_ids` (two scope
  columns that can disagree is the state this ticket ends); pre-ticks the
  picker from `unit_ids`; `anchorTierLabel` reads `unit_ids`. The backwards
  derivation survives in both places as the **legacy-only** fallback, so
  pre-v65 rows do not suddenly read as unscoped — and a legacy row re-saved
  through the form gains real `unit_ids`, a one-way repair.
- **Excel import** on the same screen had the identical defect (it expanded
  Age Division names to a group list); it now stores `unit_ids` too.
- **Registries**: `unit_ids` added to `electron/ops/projections.js` and
  `src/localClient.mock.js`. The `unit_id` exemption in
  `projectionsCoverage.test.js` is updated, not removed — it is still
  read-only.

### Deliberately NOT changed

`electron/ops/ingest.js` still writes a `group_ids` snapshot for imported
fixed events. That path derives scope from the groups it **observed** doing
the activity in a spreadsheet — an observation, not a division the director
chose. Converting it would be inventing a claim the source never made.

### Known adjacent oddity (not this ticket)

`src/engine/weekCatalog.js` reads `anchor.activity_id ?? anchor.unit_id`,
treating the legacy division column as an activity id fallback. That predates
this work and is the same family as T62. Left alone; worth its own ticket.

## Known follow-ups (open at landing)

Two holes are known and deliberately NOT fixed here. Both are in the importer,
whose write side belongs to T183 (anchor-scope consolidation). Recording them
so nobody discovers them as surprises.

### 1. Replace-mode re-import destroys division scope — the serious one

`electron/ops/ingest.js` **cannot write `unit_ids` at all** — verified, zero
occurrences in the file; it writes only `is_all_groups`/`group_ids`
(~line 2240). And `replaceScope` (ingest.js:96) deletes every anchor for the
camp before the rebuild:

```js
const anchors = db.prepare('SELECT id FROM anchor_activities WHERE camp_id = ?').all(camp_id)
for (const row of anchors) remove('anchor_activities', row.id)
```

So a director who runs **"Re-import last year" in Replace mode** deletes every
recurring event and recreates it from the grid snapshot as a `group_ids` list —
**silently flattening division scope back to exactly the state this ticket
fixes.** Add mode is unaffected; Replace is the damage path.

This does not corrupt data and does not break a schedule: it reverts an event
to the pre-T180 snapshot behavior. What it costs is the liveness — the
re-imported event stops covering a group added to its division later, and
nothing tells the director that happened. Which is, precisely, the defect.

Worth stating plainly: **T180's feature is destroyable by a normal admin
workflow until T183's write side ships.** That is a reason to sequence T183
promptly, not a reason to hold T180 — the alternative is leaving the original
bug in place, which is strictly worse. Found by cranky-sammet, relayed via the
coordinator, verified here against the source before recording.

### 2. Re-import drift check reports a false "scope changed"

`liveAnchorScope` (ingest.js:1631) builds its scope map from `is_all_groups`
and `group_ids` only. A division-scoped event carries an empty `group_ids` by
design, so a re-import that observes it covering three bunks compares incoming
`['g1','g2','g3']` against a live `[]` and reports *"scope changed from
(nothing) to Aleph, Bet, Gimel"* for a row nobody edited.

Report-only — that path is read-only per ADR §4 and pushes to
`fixedScopeChanged` without writing — so it is a false warning, not corruption.
Assigned to T183.

### Also superseded by T183

`AnchorsScreen.anchorTierLabel`'s inline `unit_ids > group_ids` fallback
re-encodes the precedence that `resolveAnchorGroupIds` owns, projected to
division labels instead of group ids. Two encodings of one rule is the drift
that caused this ticket; it was accepted here only because T180 already carried
a migration and it fixed the visible symptom. T183 replaces it with a shared
`resolveAnchorUnitIds` atom carrying an explicit `inferred` flag — needed
because deriving divisions backwards from `group_ids` cannot distinguish "the
whole Juniors division" from "one Juniors bunk".
