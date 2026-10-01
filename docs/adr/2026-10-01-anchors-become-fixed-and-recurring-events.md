---
title: "Anchors become fixed/recurring events at every remaining layer — the mechanical closeout"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-10-01
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_adrs:
  - docs/adr/2026-09-26-fixed-recurring-event-identity-model.md
  - docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md
  - docs/adr/2026-08-28-fixed-vs-recurring-events.md
  - docs/adr/2026-09-03-compound-cell-interpretation.md
related_tickets:
  - docs/work/tickets/T293-fixed-recurring-activity-vocabulary.md
---

# Anchors become fixed/recurring events at every remaining layer — the mechanical closeout

**Status: ACCEPTED.** Owner ruling, quoted directly: 2026-09-29, *"i agree on anchors"*; 2026-10-01,
*"anchors should no longer be the terminology at any level that is happening"* and *"it should have
already landed."* The Governor accepts this ADR on the owner's behalf per the organizer's standing
authority on owner-ruled items.

**T293 contradiction, recorded not silently resolved.** `docs/work/tickets/T293-fixed-recurring-
activity-vocabulary.md` is written as spec-only, with Non-goals stating no code lands under it. The
owner's 2026-10-01 instruction supersedes that scope — the rename lands under T293 as a follow-up
PR, not as a new ticket.

## What is already done — do not re-decide this

`docs/adr/2026-09-26-fixed-recurring-event-identity-model.md` (T267) already ruled the hard
questions: `anchor_activities` → `fixed_events` (schema v77, `electron/db/schema.sql:773`-ish,
`kind IN ('fixed','recurring')`, `activity_id TEXT` resolved by id), and **two families, not one** —
`fixed_events` (a pinned placement of a catalogue activity on the regular grid) stays structurally
separate from the pre-existing `events` table family (`events`/`event_time_blocks`/`event_groups`/
`event_slots`, a freestanding Field-Day-style construct with its own internal sub-schedule). Verified
live: `src/engine/anchorActivityLink.js:13` `resolveAnchorActivityIds(anchor)` resolves by
`anchor.activity_id` only, no name fallback. T267 left exactly one question open for Designer/owner:
what the UI calls each family. **That question is already answered in the running app**, confirmed
by reading the actual screens, not inferred: `src/components/layout/Sidebar.jsx` already renders
"Fixed Events" / "Recurring Events" (comment at line 144) for the `fixedevents`/`anchors` nav keys
(`src/App.jsx:73,78`), and the separate `events` family is already surfaced as **"Special Events"**
via `SpecialEventsScreen` (`src/App.jsx:20,83`, `Sidebar.jsx:330`). There is no director-facing
collision today. This ADR does not reopen T267.

## D1 — the events/fixed_events naming collision

**Decision: there is no collision to resolve at the schema or screen level; only consistency debt.**
`fixed_events` (table) + "Fixed Events"/"Recurring Events" (UI) vs `events` (table) + "Special
Events" (UI) are already disjoint names at every layer a director sees. The only remaining collision
is internal: the **file and symbol layer** still says "Anchors" (`AnchorsScreen.jsx`, the `anchors`
nav key, `ANCHOR_KIND_BY_SCREEN`) for a screen the sidebar already calls "Fixed Events"/"Recurring
Events" — i.e., the code vocabulary lags the UI vocabulary by one layer. Rename the file/symbols to
match the UI, not the other way around. `events`/`SpecialEventsScreen` is untouched — it is a
different, already-correctly-named concept and renaming it is out of scope, same as T267 ruled.
Confidence: high. Evidence: `Sidebar.jsx:144`, `App.jsx:20,73,78,83,122-123`.

## D2 — does any `activity_id`/identity work remain

**Decision: no, confirmed.** T267 shipped in full (`anchorActivityLink.js:13`, no name-matching
fallback present). This ADR is pure vocabulary; it creates no new identity model and touches no
resolution logic. The only load-bearing constraint it inherits from T267 is: do not let the rename
touch call order or resolution semantics in `buildSchedule.js` — see "Risk" below.

## D3 — persisted column renames and migration shape

Three columns, two different provenance shapes:

| Column | Where defined | Rename mechanism | New name |
|---|---|---|---|
| `template_slots.anchor_id` | ALTER-added v17 (`schema.sql:579` comment only — absent from the CREATE TABLE, confirmed by grep) | `ALTER TABLE template_slots RENAME COLUMN anchor_id TO fixed_event_id` | `fixed_event_id` |
| `template_slots.is_anchor` | ALTER-added v17, same as above | `ALTER TABLE template_slots RENAME COLUMN is_anchor TO is_fixed_event` | `is_fixed_event` |
| `cohorts.anchor_model` | In the CREATE TABLE (`schema.sql:682`) | `ALTER TABLE cohorts RENAME COLUMN anchor_model TO fixed_event_model` | `fixed_event_model` |

**`compound_cell_decisions.anchor_name` (schema.sql:183) is NOT part of this rename.** Confirmed by
reading `docs/adr/2026-09-03-compound-cell-interpretation.md`: it is the base term inside a compound
cell label (e.g. "Lunch" in "Lunch + Leave"), structurally unrelated to fixed/recurring scheduling.
It shares only the English word "anchor," the same false-cognate trap T267 already diagnosed once
for `events`. Decision: rename it too, since the owner said "at any level," but to a name that does
**not** borrow "fixed/recurring/event" vocabulary, because doing so would manufacture a *new*
collision to fix an old one. New name: `base_name` (pairs with the existing sibling column
`wrapper_name`). This is a cosmetic, same-table, same-shape rename — file it in the same migration
for mechanical convenience, but call it out as touching an unrelated domain in the PR body (per
"Risk" below, item 2).

**Mechanism confirmed safe:** `better-sqlite3@12.11.1` bundles SQLite 3.53.2 (checked live:
`db.prepare('select sqlite_version()').get()` → `3.53.2`), well past the 3.25 floor for `ALTER TABLE
... RENAME COLUMN`. No table-rebuild is needed for any of the four columns — plain `RENAME COLUMN`
statements, following the existing migration template at `electron/db/localDb.js:3952` (guard form
`getSchemaVersion(db) >= N-1 && < N`, never a bare `< N`) and the rollback template at
`electron/db/rollback/v83_down.js` (inverse op, explicit statement about what is and is not
recoverable, a one-line note when a replicated entity makes "rollback" mean local-only).
`schema.sql`'s own CREATE TABLE text needs editing only for `cohorts.anchor_model` and
`compound_cell_decisions.anchor_name` — the two `template_slots` columns were never in the CREATE
TABLE to begin with, so schema.sql needs a **new** comment line documenting the vN rename next to
the existing v17 comment, not an edit to the CREATE TABLE body.

**`PROJECTIONS`/registry fields referencing these columns** (`electron/ops/projections.js`,
`src/localClient.mock.js`, `electron/ops/undoReferences.js:96`, `electron/ops/deleteRecord.js:265`,
`276`) must be updated in the same PR as the schema migration — they are read/write field lists keyed
by exact column name and will silently stop reading the renamed column otherwise (this is the
project's own T62 scar, restated for this rename: a lookup keeps compiling, returns nothing).

## D4 — finding/flag vocabulary

**Correction to the brief: `ANCHOR_EXEMPT` is not a finding kind.** Confirmed by grep: it exists only
as a local test-fixture-parity guard object inside `src/engine/fixtureSchemaParity.test.js:100`
(`ANCHOR_EXEMPT = { _isSpanHead: '...' }`), unrelated to `buildSchedule`'s findings vocabulary. It
should be renamed for consistency (it is a file-local const) but is not product vocabulary and
carries no persistence concern.

**`ANCHOR_DUPLICATE` and `ANCHOR_IDENTITY_GAP` are real finding kinds, and neither is persisted.**
Both are produced fresh on every `buildSchedule()` call (`src/engine/buildSchedule.js:867,949`) and
returned in the in-memory `findings` array consumed by the schedule screen for that render. Grepped
for any `INSERT`/`UPDATE` writing a `kind` string into `template_slots.flags` or any other column —
none found; `template_slots.flags` is written by other op paths (`deleteRecord.js:276`,
`resolveImportedPlacements.js`) but never with these two kind strings. **Decision: this is a pure
rename, not a data migration.** New names: `FIXED_EVENT_DUPLICATE`, `FIXED_EVENT_IDENTITY_GAP`.
Because nothing is persisted, there is no backward-compatibility read path to maintain and no stored
value to rewrite — confirm this with a one-line grep-based assertion in the PR (see "Risk," item 3)
rather than skipping verification because the brief's premise (persisted) turned out to be wrong.

## D5 — symbol and file renames

**Correction to the brief: `placeAnchors` does not exist in the codebase** (grep returns zero
matches in `src/engine/`). Do not look for it; it may be a stale memory of an earlier refactor. The
real symbol set, confirmed live:

| Current | File | New |
|---|---|---|
| `AnchorsScreen` (component + file) | `src/screens/AnchorsScreen.jsx`, `.test.jsx` | `FixedEventsScreen` / `FixedEventsScreen.jsx` |
| `anchors` nav key | `src/App.jsx:73` | remove — collapse onto `fixedevents`/a new `recurringevents` pair (see note below) |
| `ANCHOR_KIND_BY_SCREEN` | `src/App.jsx:122` | `EVENT_KIND_BY_SCREEN` |
| `setAnchorLookup` (local fn) | `src/engine/buildSchedule.js:264` | `setFixedEventLookup` |
| `anchoredActivityIdsByGroupDay` | `src/engine/buildSchedule.js:158` | `fixedEventActivityIdsByGroupDay` |
| `anchorsOnly` (param, ~11 call sites) | `src/engine/buildSchedule.js` + screens | `fixedEventsOnly` |
| `src/engine/anchorScope.js` (file) | — | `src/engine/fixedEventScope.js` |
| `resolveAnchorGroupIds` / `resolveAnchorDayIds` / `resolveAnchorUnitIds` | `anchorScope.js` | `resolveFixedEventGroupIds` / `resolveFixedEventDayIds` / `resolveFixedEventUnitIds` |
| `src/engine/anchorActivityLink.js` (file) | — | `src/engine/fixedEventActivityLink.js` |
| `resolveAnchorActivityIds` | `anchorActivityLink.js:13` | `resolveFixedEventActivityIds` |
| `ANCHOR_MODELS` constant + `anchorModel`/`setAnchorModel` state | `src/screens/CohortsScreen.jsx:19,35` | `FIXED_EVENT_MODELS` / `fixedEventModel` |
| `ANCHOR_EXEMPT` | `src/engine/fixtureSchemaParity.test.js:100` | `FIXED_EVENT_EXEMPT` |

**Note on the nav-key collapse:** today `fixedevents` and `anchors` are two nav keys pointing at the
same component, disambiguated by `ANCHOR_KIND_BY_SCREEN = { fixedevents: 'fixed', anchors:
'recurring' }` (`App.jsx:122-123`). Renaming the component is independent of renaming the second key;
Maker should rename `anchors` → `recurringevents` in the same pass so no nav key says "anchor"
anywhere, keeping the existing two-key/one-component shape (this ADR does not propose merging them
— that is a screen-IA question, out of scope here, same as T267 left the Anchors screen's shape out
of scope).

`weekCatalog.js` (`src/engine/weekCatalog.js`) uses `anchors`/`anchor` only as a local parameter/
variable name importing the two renamed functions above — rename the parameter for consistency, no
independent decision needed.

## Risk and how we catch it

Two mechanical defenses, both required in the implementation PR(s), not optional follow-up:

1. **Byte-identical schedule snapshot.** Before touching `buildSchedule.js`, `anchorScope.js`, or
   `anchorActivityLink.js`, snapshot `buildSchedule()`'s full output against the existing seeded-PRNG
   fixtures (same fixtures `buildSchedule.test.js` already uses). The rename must be a pure
   identifier substitution — same call order, same object shapes — and the snapshot must be
   byte-identical after. This is the project's own standing defense (T62's lesson, restated in
   T267); a renamed-but-reordered call changes the Mulberry32 draw sequence silently.
2. **Non-vacuity on the acceptance fixtures.** `electron/fixtures/electiveAcceptanceCamp.js` and the
   `scripts/fixtures/*` family must still produce non-empty `fixed_events`/finding results after the
   rename — assert counts, not just "no error," so a stale string-keyed lookup (compiles, returns
   `[]`) cannot pass silently.

Named blind spots carried into the brief for Maker, confirmed still applicable by this read:
string-keyed lookups (the `anchoredByGroupDay.get(...)` Map-key pattern in `buildSchedule.js` is
exactly this shape — a renamed field whose key string is typo'd produces an empty Map hit, not an
error); fixtures read via `readFileSync` as strings (invisible to ESLint and to a stale graphify
graph alike); `scripts/` CLI and the `mcp__shoresh__*` tool surface (none currently named "anchor" —
confirmed: `grep -ri anchor electron/preload.js` returns nothing, and the `mcp__shoresh__*` tool list
in this session carries no "anchor" name — but re-grep at implementation time since `scripts/` was
not exhaustively read here); export/import header round-trips (see below).

**Verify retirement, not just launch** (org-migration discipline): the closeout step of the final PR
in "Ordering" is a repo-wide case-insensitive `anchor` census (the same method used to produce
`docs/work/evidence/T293/anchor-sweep-raw.txt`) with an explicit, reviewed allowlist for anything
deliberately kept (ADR prose quoting the old term historically, `docs/archive/**`, and the
`_Prior:`-marked lines required by the descriptive-doc convention below) — a shrinking but nonzero
count that was never re-checked against its own allowlist is exactly how a rename is declared done
without being done. This project's "no compatibility shims" instruction means there is no parallel
old/new path to keep in sync during the transition (the org-migration skill's usual step 2 does not
apply here — the owner's no-live-users ruling is the explicit exception case that skill itself
contemplates), so retirement verification is the only safety net; it is not optional.

**graphify is stale for this work** (built 2026-09-18, predates T266/T267) and abstained on
`buildSchedule()`/`setAnchorLookup()` ("No unique node match" — unindexed, not "nothing depends on
it"). Grep plus the two mechanical defenses above are the primary instruments here, not the graph;
Maker should not treat a graphify silence as clearance.

## Export/import headers

**Correction to the brief: the "Fixed Events" sheet name is not in `src/utils/exportWorkbook.js`.**
Grepped `exportWorkbook.js` directly — no "Fixed," "anchor," or `fixed_event` text anywhere in that
file; its `SHEET_LAYOUT` (setup-entity round-trip export, PR #692/#691) covers Programs/Age
Divisions/Groups/Days/Time Blocks/Activities only, no fixed-events sheet. The actual "Fixed Events"
sheet name lives in **`src/utils/buildCampDataWorkbook.js:242`** (a different export, the full camp
data workbook), already shipped and already correctly named — do not rename it again. That same file
also title-cases `cohorts.anchor_model` values at line 116 for display (`r.anchor_model` →
`titleCase(...)`); once the column is renamed to `fixed_event_model` (D3), this read site updates
with it — same PR, mechanical. `src/ingest/fixedEvents.js` (the import-side binder) is already
correctly named; grep it for internal "anchor" identifiers in the same pass but it is not a rename
target by file name.

## Ordering

Land as separably-green PRs, schema-then-outward, each PR independently shippable (no live users, no
cross-PR compatibility requirement, so nothing blocks sequencing except review bandwidth):

1. **Schema + registries.** The three `ALTER TABLE ... RENAME COLUMN` statements (D3), the
   `compound_cell_decisions.anchor_name → base_name` rename, the migration/rollback pair at the next
   free schema version, and every registry/field-list that names these columns (`PROJECTIONS`,
   `localClient.mock.js`, `undoReferences.js`, `deleteRecord.js`). Confirm the schema version number
   against `main` at PR time — do not hardcode v84 here (T267 made the same deliberate choice and was
   right to).
2. **`electron/ops` + IPC.** Any remaining "anchor" occurrences in electron-side op files that read/
   write the renamed columns (`deleteRecord.js`, `undoReferences.js`, `resolveImportedPlacements.js`)
   — confirmed there is no IPC method name itself to rename (`electron/preload.js` has no "anchor"
   string).
3. **Engine.** `anchorScope.js` → `fixedEventScope.js`, `anchorActivityLink.js` →
   `fixedEventActivityLink.js`, `buildSchedule.js` internal symbols, finding kinds (D4), the
   byte-identical snapshot defense (Risk item 1) gates this PR's merge.
4. **Ingest.** Any "anchor" identifiers in `electron/ops/ingest.js` and `src/ingest/*` not already
   correctly named.
5. **Screens/copy.** `AnchorsScreen.jsx` → `FixedEventsScreen.jsx`, the `anchors` nav key, `
   ANCHOR_KIND_BY_SCREEN`, `CohortsScreen.jsx`'s `ANCHOR_MODELS`/local state.
6. **Export/import headers.** `buildCampDataWorkbook.js`'s `anchor_model` read site (mechanical,
   follows from step 1); confirm no sheet/column header text itself needs changing (D3/"Export"
   section above already confirms "Fixed Events" is correctly named).
7. **Docs.** `CLAUDE.md`, `docs/current/PLATFORM_STATE.md`, `docs/current/WHERE_DATA_LIVES.md`, and
   any DESIGN doc that names these columns/symbols — see governance note below.

## Reused vs. new

**Reused:** T267's table/identity model (untouched); the migration/rollback template established at
`localDb.js:3952`/`v83_down.js`; the `PROJECTIONS` single-gate pattern (no new sync mechanism, same
rule — a rename is a field-name edit to an existing allowlist entry, not a new one).

**New:** nothing structural. This ADR introduces no new table, no new column shape, no new
contract — every change is a rename of an existing persisted column, finding-kind string, or code
symbol to its already-decided target vocabulary (T267).

**Interface-contract checklist, applied:** No IPC/WS message shape or op-log mutation path is added,
changed, or renamed — confirmed, no "anchor" string anywhere in `electron/preload.js`, so
idempotency, concurrent-retry safety, unknown-outcome handling, and error shape are all untouched;
nothing here goes through `client_write_id` or a new write path. The one checklist item that
genuinely applies is **scope/authority boundary via `PROJECTIONS`**: `PROJECTIONS`' field lists
(`electron/ops/projections.js`) and its mirrored allowlist (`src/localClient.mock.js`) name the
renamed columns by exact string and must be edited in the same PR as the schema migration (D3,
Ordering step 1) — not because this crosses a new authority boundary, but because an unrenamed entry
in either list is a silent read/write path that stops seeing the column, the same T62-shaped failure
named throughout this ADR. **Trust-boundary validation**: the renamed columns' values arrive from
this app's own writes and from a migration of this app's own prior schema, not from import or another
device's differing schema — no new validation is needed at a trust boundary, because none is crossed.

## ADR required: yes

Filed as this document, `docs/adr/2026-10-01-anchors-become-fixed-and-recurring-events.md`. It
changes a stored schema shape other code depends on (three column renames across two tables) and
settles a scope dispute between this ticket's own written Non-goals and a later owner ruling — both
independently clear the constitution's bar, even though the decision content itself is almost
entirely "rename to what T267 already named."

## Open questions for Governor

1. **Schema version number.** Confirm the next free version at implementation time (worktree scan
   for an unpushed higher number, per the organizer's standing practice) — do not let Maker hardcode
   v84 from this document.
2. **`compound_cell_decisions.anchor_name → base_name`.** This is a product-adjacent naming call
   (D3) made here because "at any level" is explicit in the owner's words, but the new name itself
   (`base_name`) was not run past the owner. Flag for a one-line confirm or let Governor/Designer
   override the name without reopening the rest of this ADR.
3. **Descriptive-doc updates** (`CLAUDE.md`, `PLATFORM_STATE.md`, `WHERE_DATA_LIVES.md`) must land in
   the same PR as whichever rename step touches the path they describe, per `npm run
   check:governance`'s descriptive-doc-path check — Governor should confirm which step in "Ordering"
   each doc edit rides with rather than batching all doc edits into step 7 if that creates a window
   where a doc names a path mid-rename that doesn't exist yet.

## Out of scope, explicitly

- Any change to the `events` table, `SpecialEventsScreen`, or their sub-schedule tables — a
  different, already-correctly-named concept (T267, reaffirmed here).
- Merging the `anchors`/`fixedevents` nav keys into one screen-IA shape — a Designer/IA question, not
  implied by this ADR.
- `src/engine/fixtureSchemaParity.test.js`'s own guard logic beyond renaming its two local constants
  — the guard mechanism itself is untouched.
- Any work on `ANCHOR_IDENTITY_GAP`'s underlying identity model — settled by T267, not reopened here.
