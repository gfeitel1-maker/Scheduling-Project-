---
title: "Merged-cell reading — multi-block special/recurring blocks from ingest"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
date: 2026-08-24
supersedes: []
approved: "owner priority #6, redirected 2026-08-24 after real-data diagnosis. XLSX-first confirmed by owner. The prior whole-day special-day detector design (an unmerged ADR draft, never landed) is superseded before it shipped — real camp schedules don't mark special things by blanking a whole day; they use MERGED multi-block cells, which the parser silently drops."
---

# Merged-cell reading — multi-block special/recurring blocks from ingest

Owner priority #6, redirected. The original framing (a "whole-day special-day
detector", `2026-08-24-special-day-field-trip-ingest.md`) was **wrong against real
data** and is superseded before implementation. This ADR replaces it.

## The finding (validated against the owner's real files, 2026-08-24)

The owner supplied 7 real schedule files (3 camps). Running the live ingest
parsers over them revealed:

- Real camps mark special/longer blocks with **merged multi-block cells**, not
  whole-day deviations. Concretely (via `XLSX['!merges']` inspection):
  - **Group Schedules 1.xlsx** (owner's own camp): 14 multi-row merges, all
    **`Ruach & Shabbat` spanning 3 blocks** — a recurring multi-block special
    block.
  - **Camp Mindy** (4 files): 31–36 multi-row merges each, including
    **`Weekly Special`** and **`Special Activity`** (2-block spans).
  - **ALL 2025 Bunk Schedules.pdf**: **`Special Event … Mitzvah Project`**
    spanning blocks 6–7 every Friday.
- **The parser ignores merge metadata entirely** — no `!merges` read anywhere
  (`src/screens/ImportScreen.jsx` builds `sheets` from `sheet_to_json({header:1})`,
  which drops merges; `src/ingest/sheetGrid.js:workbookToPages` never sees them).
  Consequences, both confirmed by running the parsers:
  - **XLSX**: the merged cell's value survives only in its top-left; the span is
    lost. `Ruach & Shabbat` is read as an ordinary **single-block activity**
    (verified: it appears in `extractEntities`' activity list, not as a
    multi-block or special block). Its 3-block extent and its special/recurring
    nature are both gone.
  - **PDF-text**: the merge is fragmented across rows during extraction
    (`Special Event` / `and Mitzvah` / `Project` land on separate block-rows) and
    every fragment is dropped — the block is **fully invisible** to ingest.
- The whole-day detector correctly fires **0 candidates** across all 9 fixtures
  (6 xlsx + 3 committed `.txt` samples) — because there are no whole-day
  deviations to find. Real "special" content lives in merged blocks.

So #6's real problem is a **parser reading bug**, not a missing detector: Shoresh
cannot see merged multi-block cells, so it mis-files or drops exactly the special/
recurring blocks the director expects it to pick up.

## Owner decisions (2026-08-24)

- **XLSX-first.** Read XLSX merge ranges (`!merges`, explicit and reliable) now;
  covers the owner's own camp + Camp Mindy. PDF-text merge reconstruction
  (fragile, whitespace-based) is **best-effort/deferred**, not in the first cut.
- **Recurring OR one-off — the director decides, ingest does not force a bucket.**
  A merged multi-block block can be recurring (Shabbat, every week; a weekly
  Special Event) or one-off (a specific field trip). Surface it as a candidate;
  the director confirms which. (Owner: "shabbat could be multiple blocks and
  reoccur whereas a field trip might be once or recurring.")

## What this needs (design owned by the Architect addendum below)

1. **Reading fix (foundational):** capture `wb.Sheets[name]['!merges']` in the
   xlsx parse path and thread it into `workbookToPages`/`sheetToPage` so a merged
   cell is reconstructed as ONE block spanning its time-blocks. This is a parser
   change with broad blast radius (`extractEntities`, `fixedEvents`, `buildPlan`
   all consume `pages`) — the modeling fork (fill spanned cells vs. record a span
   attribute on one logical cell) is the key architectural decision and must not
   regress existing single-cell parsing. Reuse the arbitrary-length span
   capability (`is_span_head`, PR #145) to represent the multi-block extent
   rather than inventing new span machinery.
2. **Surfacing:** a reconstructed multi-block block becomes a candidate the
   director confirms as a recurring or one-off special/event block, reusing the
   recurring-events surface / the events overlay layer — not a bespoke UI.

## Non-goals
- No PDF-text merge reconstruction in the first cut (deferred).
- No roster/points/staffing parsing.
- No whole-day special-day detector (superseded).

## Slice plan
- **Slice A (foundational, ship first):** the merge-reading fix — read `!merges`,
  reconstruct multi-block spans in the parse path, represented via the existing
  span mechanism. Independently valuable: it corrects multi-block spans for ALL
  content (a 2-block "Science" becomes one correct session), not just special
  blocks. Must be validated against the owner's real files: no regression in
  activity/fixed-event counts, and `Ruach & Shabbat` reads as a 3-block span.
- **Slice B:** surface a reconstructed multi-block block as a director-confirmed
  candidate (recurring or one-off), reusing the recurring-events/events surface.
- **Slice C (deferred):** best-effort PDF-text merge reconstruction, if real need
  proves it out.

## Confidence & biggest risk
Confidence **high** on the diagnosis (validated against real data). Biggest risk:
**Slice A's blast radius** — changing how cells are read feeds every downstream
ingest consumer; the reconstruction must be behind a clear model and regression-
tested against the real fixtures, not just synthetic ones. The Architect addendum
resolves the fill-vs-span-attribute fork before any Maker touches the parser.

---

## Slice A design (Architect addendum, 2026-08-24)

### Resolved decision: SPAN-ATTRIBUTE (option b), not fill

**Ground truth about today's behavior, confirmed by reading the actual consumers:**

`XLSX.utils.sheet_to_json` (used at `src/screens/ImportScreen.jsx:263`) already
puts a merged range's value ONLY in its top-left cell; every other cell in the
range comes back as `''` via `defval: ''`. So today's bug is not double-reading
— it's **truncated extent**. `Ruach & Shabbat` shows up exactly once, under
block-row 6, and is silently absent from block-rows 7–8 where it also belongs.

Both real consumers key off **one row = one time-block, one tuple**:

- `src/ingest/extractEntities.js:454` (`row.cells.forEach`) pushes one
  `activities` entry, one `activityPeriods` entry, per (row, column) cell that
  has content — **per time-block row**, not per logical session.
- `src/ingest/fixedEvents.js:161-184` builds tuples keyed by
  `(group, day, block, activity)` where `block = row.label` — again **one row
  = one block**, and `footprintByActivity` (fixedEvents.js:345-352) unions
  `group|block` pairs per activity to detect dual-use. Nothing here has any
  notion of "this activity's block IS also the next row's block."

**Why FILL (option a) is wrong:** if Slice A propagated `"Ruach & Shabbat"`
into the block-7 and block-8 cells too, both consumers above would read it as
**three separate occurrences** in three separate blocks — `extractEntities`
would triple-count it in `activities`/`activityPeriods` (skewing rarity/
elective-header inference), and `fixedEvents` would materialize **three
independent per-block tuples** instead of one 3-block session, which is
exactly the wrong shape to hand to a "one fixed event, 3 blocks long" director
decision later. Fill actively destroys the information Slice A exists to
capture (see "one row = one time-block" above) — it doesn't preserve it.

**Why SPAN-ATTRIBUTE (option b) is right:** leave cell occupancy exactly as it
is today (value only in the top-left/anchor cell, blanks elsewhere) — this is
already correct, zero-regression, by construction, since it's unchanged
behavior. Slice A's only job is to attach a **parallel fact**: "this cell,
which already produced one activity occurrence, is the head of a vertical
merge N blocks tall." Nothing that reads `row.cells` today has to change to
avoid regressing — the fact is additive and inert until a consumer chooses to
read it.

**Confirms the ADR's own instruction to reuse `is_span_head`:** grepped
`is_span_head` across `src/` — every hit is in `src/utils/normalizeSlots.js`,
`src/utils/applyDayOverrides.js`, and `src/screens/schedule/useSlotMutations.js`,
i.e. the **`template_slots`/schedule layer only**. There is no existing notion
of a span at the ingest/`pages` layer — `page.rows[].cells[]` is flat, one
value per cell, no cross-row relationship at all. So Slice A cannot "reuse"
`is_span_head` directly (it doesn't exist yet at this layer); its job is
narrower and matches the ADR's fallback reading: **carry the span extent
through `pages` so a later consumer (Slice B's candidate-surfacing, or
`buildPlan`'s slot-writing) can set `is_span_head`/write an N-block chain when
it eventually writes `template_slots` rows.** Slice A does not write any
`template_slots` row itself — that stays out of scope, per the ADR's own
Slice A/B split.

### Precedent for the parallel-array shape

`row.locations[]` already exists as a parallel array to `row.cells[]` (Q8,
`docs/adr/2026-08-15-locations-import-export-roundtrip.md` §D5, read at
`src/ingest/extractEntities.js:517`, populated only by `textGrid.js` on
unlabeled pages — a no-op elsewhere). Slice A follows the same convention
rather than inventing a new cell-object shape: add `row.blockSpans[]`, a
parallel array to `row.cells[]`, present only on cells that anchor a vertical
merge. `row.blockSpans[cellIndex]` is `undefined`/absent for an ordinary cell,
and an integer `N ≥ 2` (blocks covered, including the anchor's own row) for a
cell that is the top-left of a vertical merge spanning N block-rows. This
keeps `row.cells` byte-for-byte unchanged — every existing reader is
unaffected.

### Where `!merges` is captured and threaded

1. **Capture** — `src/screens/ImportScreen.jsx:255-264`, the `sheets` array
   built for the xlsx branch. Add `merges: wb.Sheets[name]['!merges'] ?? []`
   to each `{ name, rows }` entry. `wb.Sheets[name]['!merges']` is SheetJS's
   native range array: `[{ s: { r, c }, e: { r, c } }, ...]`, 0-indexed,
   inclusive, in the **raw worksheet's** row/column coordinates (before any
   header detection or row filtering).
   - The `.txt`/`.csv` branch (`ImportScreen.jsx:268-273`, `parseTextGrid`)
     never produces a `sheets` entry at all — it calls `parseTextGrid`
     directly, bypassing `workbookToPages` entirely. So it is a structural
     no-op with no guard needed: there is nothing to thread merges through.

2. **Thread** — `workbookToPages(sheets, fileTitle)` signature is unchanged
   (`sheets` already carries whatever fields each entry has); it now reads
   `merges` off each sheet entry and passes it to `sheetToPage(rows, name,
   merges)`. **`sheetToPage`'s signature changes**: add a third, optional
   `merges = []` parameter — optional so every existing call site and test
   that calls `sheetToPage(rows, title)` with two arguments keeps working
   unchanged (defaults to no merges, i.e. today's behavior exactly).

3. **Reconstruct inside `sheetToPage`** — this is the fiddly part and the
   thing Maker must get exactly right, because `!merges` coordinates are in
   the RAW table's row/column space, but `sheetToPage` filters rows (skips
   footnote-only and fully-blank rows, `sheetGrid.js:70-71`) and re-bases
   columns (`header.slice(1, width)`, so worksheet column `c` is
   `page.columns[c-1]`, i.e. `row.cells[c-1]`). Required approach:
   - While building `body` (the existing loop at `sheetGrid.js:61-75`), also
     record, per pushed row, its **original `table` row index** (`i` in that
     loop) in a parallel array (e.g. `bodyOrigRowIndex[bodyIndex] = i`) —
     this already exists implicitly as the loop variable; it just needs to
     be retained rather than discarded.
   - For each merge range `{s, e}` with `e.r > s.r` (a **vertical** merge —
     spans more than one raw row) and `s.c === e.c` (single column; see
     horizontal scoping below): find the body row whose `bodyOrigRowIndex`
     equals `s.r` (the anchor). Its column in `page.columns`/`row.cells` is
     `s.c - 1` (raw column 0 is the label column, dropped by
     `header.slice(1, width)`). If no body row's original index equals `s.r`
     exactly (the anchor row itself was filtered out — shouldn't happen since
     a merge anchor by definition has content, but guard it), drop the merge
     silently rather than guessing.
     - **Block count, not raw-row count:** `blockSpans` must count how many
       **body rows** (i.e. time-block rows that survive filtering) the merge
       covers, not `e.r - s.r + 1` raw rows — a footnote or blank row inside
       the raw range must not be counted as a block. Compute this by counting
       how many entries in `bodyOrigRowIndex` fall within `[s.r, e.r]`
       inclusive.
     - Set `row.blockSpans[s.c - 1] = blockCount` on the anchor's own pushed
       row object (mutate after `body.push(...)`, or build spans as a
       separate per-row map and merge in before returning).
   - **Horizontal merges** (`e.c > s.c`, i.e. a value spans multiple
     day/group columns): the ADR's own validation data describes every real
     merge as "multi-**row**" (`Group Schedules 1.xlsx`: "14 multi-row
     merges"; Camp Mindy: "multi-row merges" per file) — no horizontal merge
     is reported in the validated files. **Slice A scopes to vertical merges
     only.** A horizontal merge (`s.r === e.r && e.c > s.c`) is not
     reconstructed — it is left exactly as today (value in the leftmost
     cell, blanks to its right), which is a safe no-op, not silent data
     loss, since nothing currently reads or expects horizontal spans either.
     If real data later shows horizontal merges matter, that's Slice A.2,
     scoped separately.
   - A merge that is neither purely vertical nor purely horizontal
     (`e.r > s.r && e.c > s.c`, a block merge) is similarly left
     un-reconstructed in Slice A — same reasoning, no validated real-file
     evidence it occurs.

### What downstream must do (Slice A) — nothing

Per the fill-vs-span-attribute resolution above, `extractEntities.js` and
`fixedEvents.js` require **zero changes** in Slice A. `row.blockSpans` is
inert to both today — neither reads it. This is the concrete mechanism by
which Slice A avoids regressing existing single-cell parsing: the change is
purely additive at the `pages` layer, and the acceptance gate (`activity`/
`fixed event` counts unchanged on the real fixtures) should hold by
construction, not by luck. The count regression test is still required
(construction can be wrong) but the design does not depend on downstream
consumers being taught to ignore something new — there is nothing for them to
newly encounter.

Slice B (separate, not in this design) is the first and only consumer of
`row.blockSpans` — it reads the span to build the director-facing multi-block
candidate, and it (or `buildPlan`, at commit time) is where an `is_span_head`
chain finally gets written to `template_slots`, reusing the existing
mechanism per the ADR's instruction — just one layer later than "reading a
cell" happens.

### Schema/migration

**None.** `pages`/`row` is a transient in-memory JS shape produced and
consumed entirely within the ingest pipeline (`ImportScreen.jsx` →
`extractEntities`/`fixedEvents` → the reconciliation screens → `buildPlan` →
`template_slots` writes). Adding `row.blockSpans[]` touches no persisted
schema and needs no SQLite migration. `is_span_head` (the eventual consumer of
this data, in Slice B/buildPlan) is already a nullable `template_slots` column
(`src/utils/normalizeSlots.js:13`) — no new column either.

### Slice A sub-plan (ordered, gate-able)

1. **A1 — capture + thread merges, no reconstruction yet.** Add `merges` to
   the `sheets` entries in `ImportScreen.jsx`; add the optional third param to
   `sheetToPage`/`workbookToPages`; wire it through but don't populate
   `blockSpans` yet (or populate an always-empty `blockSpans` to prove the
   plumbing). Gate: existing `sheetGrid.test.js` and full `npm run verify`
   pass unchanged — proves the threading is a true no-op absent reconstruction
   logic.
2. **A2 — vertical-merge reconstruction.** Implement the anchor-row lookup +
   block-counting logic above; populate `row.blockSpans`. Add unit tests in
   `src/ingest/sheetGrid.test.js` (or a new `sheetGrid.merges.test.js`)
   covering: a 3-row vertical merge landing correctly on the anchor with
   `blockSpans[i] === 3`; a merge whose range includes a filtered
   footnote/blank row (block count excludes it); a horizontal merge (left
   un-reconstructed, no `blockSpans` entry, no crash); a merge with no
   corresponding surviving body row (dropped silently, no crash). Gate: new
   tests pass, `npm run verify` still green.
3. **A3 — real-file regression gate (the ADR's stated acceptance test).** Run
   the parser against `Group Schedules 1.xlsx` (or the committed
   `docs/work/specs/samples/*.txt`/equivalent xlsx fixture the ADR's
   validation used) and confirm: activity count and fixed-event count are
   **unchanged** from today's baseline (38 activities / 11 fixed events per
   the ADR), AND the `Ruach & Shabbat` cell now carries `blockSpans === 3` at
   its anchor row. This is a manual/scripted verification step (not
   necessarily a committed automated test, since it depends on a real,
   possibly-not-committed file) — if the owner's real xlsx isn't committed to
   the repo, Maker should ask Governor whether to commit a redacted/structural
   copy as a fixture so A3 becomes a durable regression test rather than a
   one-time manual check.

Each of A1–A3 is independently committable and independently gate-able; A1
alone is a safe no-op landing, A2 adds the capability, A3 is the proof it
matches the validated real-world case the whole ADR is grounded in.

### Files/modules affected
- `src/screens/ImportScreen.jsx` (~line 255-264): add `merges` to the `sheets`
  entries built in the xlsx branch. No change to the `.txt`/`.csv` branch.
- `src/ingest/sheetGrid.js`: `sheetToPage` gains an optional third parameter
  `merges`; `workbookToPages` threads `sheet.merges` through. New internal
  logic to map raw merge ranges to body-row anchors and populate
  `row.blockSpans`.
- `src/ingest/sheetGrid.test.js` (or new `sheetGrid.merges.test.js`): new
  coverage per A2 above.
- `src/ingest/extractEntities.js`, `src/ingest/fixedEvents.js`: **unchanged**
  in Slice A (explicitly verified above, not just asserted).

### Reused vs. new
- **Reused:** the `row.locations[]` parallel-array convention (Q8) as the
  shape precedent for `row.blockSpans[]`; SheetJS's native `!merges` range
  format (no new parsing needed for the ranges themselves); the existing
  `body`-building loop in `sheetToPage` (extended, not replaced) to capture
  original row indices.
- **New:** `row.blockSpans[]` itself — genuinely new, because no existing
  ingest structure records a cross-row relationship between cells; the
  anchor-row-lookup/block-counting logic inside `sheetToPage`.

### ADR required: no
This is an addendum to an already-accepted ADR (`2026-08-24-merged-cell-
multiblock-ingest.md`), not a new architectural decision — it resolves the
fork the ADR explicitly deferred to the Architect and specifies the
implementation the ADR already committed to. No new persistent data shape
(confirmed above: no schema/migration), no changed contract other modules
already call (both real consumers are verified untouched), and the reversible/
irreversible tradeoff (fill vs. span-attribute) is decided within this
addendum, which is itself the durable record of that decision — a second ADR
document would just restate it.

### Open questions for Governor
1. **Real-file fixture for A3.** The ADR's acceptance test is "no regression
   against the owner's real files," but I don't know whether
   `Group Schedules 1.xlsx` (or an equivalent) is committed anywhere in the
   repo as a test fixture, or only exists on the owner's machine from the
   ADR's validation run. If it's not committed, A3 can only be a manual
   verification step this session, not a durable CI regression test — worth
   asking the owner whether a redacted/structural copy should be added under
   `docs/work/specs/samples/` (matching the existing `.txt` fixture
   convention) so this becomes automated.
2. **Slice B timing.** This design deliberately stops at "the span extent
   exists in `pages` and nothing reads it yet" — confirm that's the intended
   Slice A boundary (matches the ADR's own slice split) and Slice B (director-
   facing candidate + eventual `is_span_head` write) is a separate Governor-
   scoped piece of work, not expected in the same PR.

---

## Slice B design (Architect addendum, 2026-08-24)

Closed case for divergence — the owner has already fixed the two candidate
shapes (recurring → anchor, one-off → event) and the reuse constraints
(recurring-events surface, no bespoke UI, no internal vocabulary in copy).
What's undecided is mechanical: how a span gets written, and this addendum
resolves it against the real schema rather than by generating alternatives.

### The load-bearing mechanical question — resolved

**`anchor_activities` already has a `span_blocks INTEGER` column
(`electron/db/schema.sql:508`), and it is already a live, consumed field —
not a stub.** `src/engine/buildSchedule.js:143` reads `anchor.span_blocks ||
1` directly when placing an anchor into the schedule (tail-block handling at
line 148 immediately below). This is the *same* span primitive
`docs/adr/2026-08-21-arbitrary-length-activity-span.md` (PR #145) shipped for
manually-authored spanning activities — `anchor_activities.span_blocks` is
its anchor-table counterpart, already wired into the one and only engine that
consumes anchors.

This means the ADR's instruction to "reuse `is_span_head`" resolves
differently at this layer than Slice A's addendum guessed: **`is_span_head`
lives on `template_slots` (the placed-schedule layer) and is not what a
*recurring* candidate needs.** A recurring multi-block block is not a placed
slot — it is an `anchor_activities` row, and that table's own span
representation is `span_blocks`, already load-bearing, already read by the
engine. **No new column, no `is_span_head` chain, at the anchor level.**
`is_span_head` only re-enters the picture for the one-off path, below, where
the target really is `template_slots`.

Concretely, confirming "recurring" for a 3-block `Ruach & Shabbat` candidate
means one `anchor_activities` INSERT:

```
time_block_id = <id of the block the merge anchors on>   -- the FIRST of the 3
span_blocks   = 3
day_id        = <resolved day>
name          = "Ruach & Shabbat"
group_ids / is_all_groups = <resolved scope>
```

— exactly the shape `electron/ops/ingest.js`'s existing fixed-events commit
block already produces (see below), plus one new field.

### 1. Detection → candidate

New pure function, `src/ingest/multiBlockCandidates.js`, sibling to
`fixedEvents.js` and `extractEntities.js`, same "propose, never write" shape:
takes `{ pages }` (the same `pages` Slice A already threads `blockSpans`
through) and returns `{ multiBlockCandidates }`.

- **Qualifying cells:** any `row.blockSpans[cellIndex] >= 2` on any page.
  (Slice A only ever sets `blockSpans` for `N >= 2`, per its own design — no
  extra threshold needed here.)
- **Shape per candidate**, derived the same way `fixedEvents.js` already
  derives its tuples from a row/cell (reuse, don't reinvent):
  - `name` — the cell's value, via the same `activityNamesFromCell`/
    `cleanTitle` helpers `extractEntities.js` and `fixedEvents.js` both
    import from `extractEntities.js` — keeps name spelling identical to
    whatever `extractEntities` would produce for the same cell, which matters
    because (per `fixedEvents.js`'s own header comment) "the commit path
    resolves a fixed event's block/days/groups BY NAME."
  - `start_block` — the row label at the anchor row (the same block-label
    resolution `fixedEvents.js:isBlockLabel`/its block-row walk already does).
  - `span_blocks` — `row.blockSpans[cellIndex]`, straight through.
  - `day` / `group` — resolved from the page's orientation exactly as
    `extractEntities.js`/`fixedEvents.js` resolve them today for an ordinary
    cell in that same (row, column) position — a multi-block cell is still
    one cell; only its extent is new information, not a new resolution
    problem. Unlike `fixedEvents.js`, do **not** attempt cross-day
    collapsing/majority-vote here: a multi-block merge is evidence of ONE
    literal occurrence at ONE cell (Shabbat happens to repeat weekly because
    every Friday's page independently shows the same 3-block merge — each
    page produces its own candidate; Slice B does not need to invent
    fixed-events' occupied/operating majority machinery to see that "Friday,
    Ruach & Shabbat, 3 blocks" recurs — the director's own recurring/one-off
    choice is what does that collapsing, by hand, at confirm time). If the
    same `(name, start_block, span_blocks)` triple appears on every
    operating day for a group, that repetition is visible to the director as
    multiple identical-looking candidate chips, which is acceptable
    over-inclusion (the ADR's own stated bias) rather than a defect — do not
    build a second collapsing pass to hide it.
- **Noise guard (Red Hat MED from Slice A, block-count bleed):** no
  algorithmic fix in Slice B — the ADR already assigns this to the human
  gate. Slice B's obligation is to make a false candidate *cheap to reject*:
  every candidate renders with a plain "not this" affordance (see UI below)
  and nothing commits until the director positively picks recurring-or-
  one-off. There is no third, silent "ignore" outcome that auto-commits
  anything — an un-acted-on candidate simply does not ship (same rule
  `fixedEvents.js` already follows: nothing here is written unless
  confirmed).

### 2. The recurring-vs-one-off UI choice

Add to `src/screens/ImportScreen.jsx` a new section, same structural place
and visual idiom as the existing "Recurring Events" chip block
(`ImportScreen.jsx:1095-1173`) — a labelled group of chips, one per
candidate, sitting alongside (not replacing) the Recurring Events section.
Copy: plain language, no "overlay"/"anchor_activities"/"span" — draft:

- Section label: **"Multi-Block Blocks"** → reject this, too internal; use
  **"Longer Blocks"** or reuse the ADR's own owner-quoted framing: **"These
  spanned more than one time block"**.
- Body copy, modeled on the existing Recurring Events body copy
  (`ImportScreen.jsx:1102-1105`): *"These filled more than one time block in
  a row. Tell us if this happens every week, or if it was a one-time
  thing."*
- Each candidate chip shows `name · start_block–end_block · scope · day(s)`
  (mirrors the existing fixed-event chip's `name · time_block · scope ·
  days` format at `ImportScreen.jsx:1148-1153`) plus **two buttons**, not a
  pre-ticked default: **"Every week"** and **"Just this once"** — reusing the
  `TwoRowSplitSuggestion` disclosure *component* (expand/decide/confirm
  interaction shape, `ImportScreen.jsx`'s existing import) is the right
  reuse target here, not its copy or its specific two-row-split semantics:
  swap its decision payload from `{ suffix }` to `{ kind: 'recurring' |
  'one_off' }`. A candidate with neither button pressed stays in an
  undecided state and is simply **not included** in `commitIngest`'s payload
  — same "unticked = not written" rule the rest of the review screen already
  uses, so there is no new no-op/decline state to invent (that already IS
  "don't press a button").
- State: `const [multiBlockDecisions, setMultiBlockDecisions] = useState({})`
  keyed by the same `key = \`${name} ${start_block} ${days.join(',')}\``
  convention `fixedEvents` chips already use for their own `key`
  (`ImportScreen.jsx:1120`).

### 3. The two commit paths

Both live in `electron/ops/ingest.js`, as **dedicated payload + dedicated
commit block** — the pattern the file already uses for `fixedEvents` (a
second top-level param on `commitIngest`, handled after the generic
`INGESTIBLE_ENTITIES` loop, inside the same transaction —
`ingest.js:619`/`~1662-1718`), not the generic whitelist path. Add one new
`commitIngest` param, `multiBlockDecisions = []`, array of
`{ name, start_block_id, span_blocks, day_id, scope, kind }` (already
resolved to real ids by the same name/day/group resolution the fixed-events
block performs at `ingest.js:821` — `groupIdByName`, block-name → id lookup
— reuse those resolvers, don't re-derive).

**`kind === 'recurring'`:** extend the existing fixed-events commit block
(`ingest.js:~1718`, the `for (const fe of plan.fixedEvents)` loop that
already inserts `anchor_activities` rows) rather than writing a parallel one
— a recurring multi-block candidate is structurally a fixed event with
`span_blocks > 1` instead of the implicit `1`. Concretely: give
`fixedEvents.js`'s candidate shape (and this new candidate shape, once
`kind === 'recurring'` is chosen) an optional `span_blocks` field, defaulted
to `1` for every existing fixed-event candidate (byte-identical to today's
behavior — confirmed no existing caller sets it, so the default is a true
no-op), and have the commit block write `span_blocks: fe.span_blocks ?? 1`
into the `anchor_activities` INSERT instead of the implicit `1` it presumably
writes today. **Maker must confirm the exact current INSERT/column list at
`ingest.js:~1718-1859` before adding the field** — this design specifies the
column exists and is consumed downstream, not the exact current SQL text,
which Maker should read fresh rather than trust paraphrased here.

**`kind === 'one_off'`: surface-then-fill, not full placement.** This is the
one place this design diverges from "just write the entity" and the reason
is load-bearing, not stylistic:

- `events` (`electron/db/schema.sql:847`) is a **catalog** row only — `id,
  camp_id, name, sort_order, notes, location_id`. It carries no day/
  time-block/span placement fields at all. Placement onto an actual schedule
  grid lives at `template_slots.event_id` (set on a `template_slots` row,
  with `is_span_head` chaining a multi-block placement — confirmed:
  `schema.sql:339-343`, the Events overlay placement ADR).
- `template_slots` rows are scoped to one **route** (`manual`/`generated`)
  and one **week** (`schedule_week_id` via `schedule_templates`) — concepts
  ingest has never had context for. `INGESTIBLE_ENTITIES` and the
  `fixedEvents` commit path both write only camp/cohort-scoped catalog data;
  neither ingest path today resolves "which of the camp's (possibly several)
  weeks and which of its two routes" a placement belongs to. Forcing that
  resolution inside ingest — guessing a route, guessing a week — is the kind
  of decision this ADR's own precedent (the superseded whole-day detector)
  warns against: inventing structure the source data doesn't actually
  specify. A merged cell in one week's printed schedule does not, by itself,
  say which of the camp's `schedule_weeks` rows or which route the director
  wants it placed on.
- **Recommended scope for Slice B: commit the `events` catalog row only** —
  `name`, `camp_id` (via the existing `events` projection's `ensureExists` +
  ordinary field ops, `electron/ops/projections.js:436-446`, the same
  op-log write path `ScheduleScreen`'s own event-creation UI already uses —
  no new write mechanism needed), plus the source day/block-span folded into
  `notes` as a plain-language provenance note (e.g. "Imported from Group
  Schedules 1.xlsx — Friday, 3 blocks starting 4:00pm") so the director isn't
  starting from a blank event. **Ingest does not write any `template_slots`
  row.** The director places the new event onto whichever week/route grid
  they choose using the existing Events placement UI (drag-to-place, per the
  Events overlay ADR) — the same UI a manually-created event already uses.
  This matches the "surface globally / build locally" precedent this same
  program already used for event import (`docs/adr/2026-08-22-events-
  overlay-placement.md`'s per-event grid import, cited in project memory as
  "surface globally/build locally") and for the parked "special-day/field-
  trip ingest as surface-then-fill candidates" framing (D6) that directly
  named this exact shape before this ADR existed.
- This is a **product-level narrowing**, not a technical wall — full
  placement is not impossible, it requires ingest to gain
  week/route-resolution it has never needed before. Flagged below as an open
  question rather than silently decided, because "create the event but don't
  place it" vs. "ask the director which week to place it into, then place
  it" is a real UX tradeoff, not a pure architecture call.

### 4. Block-count-bleed guard

Addressed inline in §1/§2 above: no algorithmic filtering added in Slice B
(the ADR assigns this to the human gate); the design obligation is that a
false candidate costs one un-pressed button, not an accidental commit —
there is no default-ticked state and no "select all" affordance for this
section.

### 5. Parity / registry / migration

- **`anchor_activities` (recurring path):** no new registration needed.
  `anchor_activities` is already in `EVIDENCE_ENTITY_TYPES`
  (`ingest.js:270`) and already written through its own dedicated
  `fixedEvents` commit block, not the generic whitelist — Slice B's
  `span_blocks` addition is one new field on an already-registered write
  path, not a new entity type.
- **`events` (one-off path):** `events` already has a full projection
  definition (`projections.js:436-446`, `ensureExists` + field list
  `['camp_id', 'name', 'sort_order', 'notes', 'location_id']`) used today by
  the manual Events UI. Writing an ingest-created event through ordinary
  field-write ops against that same projection needs **no new registry
  entry**. `events` is, however, genuinely new to `commitIngest` — it has
  never been written by ingest before (confirmed: absent from both
  `INGESTIBLE_ENTITIES` and every `ingest.js` reference to `'events'` prior
  to this design). Whether an ingest-created `events` row needs
  `EVIDENCE_ENTITY_TYPES` treatment (re-import provenance protection, same
  as `activities`/`anchor_activities` get) is an open question below —
  Slice B is the first ingest writer of this table, so there is no existing
  precedent to match; Governor should decide whether re-import protection is
  in scope for this slice or deferred.
- **No schema migration** for either path: `span_blocks` and `events`'
  columns all already exist. Slice B is additive at the ingest-payload/
  commit-logic layer only.

### Files/modules affected

- New: `src/ingest/multiBlockCandidates.js` (+ test file) — candidate
  detection, pure function, no I/O.
- Modify: `src/screens/ImportScreen.jsx` — new "Longer Blocks" review
  section, decision state, wiring into the `commitIngest` payload.
- Modify: `electron/ops/ingest.js` — `span_blocks` field threaded through the
  existing `fixedEvents` commit block; new `multiBlockDecisions` param and
  commit block for the `one_off` path (events catalog write only, via the
  existing `events` projection).
- Modify: `src/ingest/fixedEvents.js` — candidate shape gains an optional
  `span_blocks` (default `1`, no behavior change for existing callers) so a
  `kind: 'recurring'` multi-block candidate can be handed to the same commit
  block without a parallel code path.
- Unchanged: `electron/db/schema.sql`, `electron/ops/projections.js` (no new
  fields/tables — both already have what Slice B needs).

### Reused vs. new

- **Reused:** `anchor_activities.span_blocks` (already a live schema column
  and already consumed by `buildSchedule.js`); the `fixedEvents` dedicated-
  payload/commit-block pattern; the `events` table and its existing
  `projections.js` write path; the Recurring Events chip UI idiom and the
  `TwoRowSplitSuggestion` disclosure component's interaction shape;
  `extractEntities.js`'s name/day/group resolution helpers.
- **New:** `multiBlockCandidates.js` (candidate detection over
  `blockSpans`); the "Longer Blocks" review section and its recurring/
  one-off decision state; `events` as an ingest-writable entity for the
  first time; the `notes` provenance string for a surfaced one-off event.

### ADR required: no

This addendum resolves the fork the base ADR explicitly deferred to the
Architect (recurring vs. one-off commit mechanics) and specifies the
implementation already committed to by the accepted ADR. No new persistent
data shape (`span_blocks` and `events`' columns both pre-exist), no changed
contract other modules already call (the fixed-events commit block gains an
optional field with a no-op default; `events`' projection is used exactly as
designed for its existing caller), and the one real tradeoff — one-off
events are surfaced-then-placed rather than auto-placed — is a product
narrowing recorded here and in the open question below, not an irreversible
technical commitment: Slice B.2 (full auto-placement) remains available
later without any rework of Slice B's `events` row shape.

### Open questions for Governor

1. **One-off event placement scope.** Confirm "create the event, let the
   director place it via the existing Events UI" (surface-then-fill) is the
   intended Slice B scope, versus asking the director to also pick a
   week/route at confirm time so ingest can write `template_slots` directly.
   The former is smaller and matches this program's own "surface globally /
   build locally" precedent; the latter is a real UX improvement (one fewer
   trip to the schedule screen) but requires ingest to gain week/route-
   resolution UI it has never had. Recommend the smaller scope for Slice B,
   with full placement as an explicit, separately-scoped Slice B.2 if the
   owner wants it.
2. **Re-import provenance for ingest-created events.** Should an
   ingest-created `events` row get the same re-import protection
   (`EVIDENCE_ENTITY_TYPES`) `activities`/`anchor_activities` already have,
   so a director's hand-edit to an imported event's name/notes survives a
   later re-import the way an activity's does? This is Slice B's first
   precedent for the question, not a pre-existing pattern to copy — needs an
   owner call, not just an architecture call.
3. **Exact `anchor_activities` INSERT column list.** This design specifies
   *that* `span_blocks` should be threaded into the existing fixed-events
   `anchor_activities` INSERT at `ingest.js:~1718-1859`, not the literal
   current SQL — Maker should read that block fresh before editing it, since
   this design was written from targeted greps, not a full read of that
   ~140-line block.

### Confidence & biggest risk

**Confidence: high** on the mechanical resolution (`span_blocks` is
grounded in a live, engine-consumed schema column — not inferred, verified
by reading `buildSchedule.js:143` directly) and on the recurring path being
a small, additive extension of an existing, well-tested commit block.
**Medium** on the one-off path's scope, specifically — not because it's
technically risky, but because "surface-then-fill vs. full auto-placement"
is a real product decision this design deliberately did not make unilaterally
(open question 1). **Biggest risk:** if Governor/owner picks full
auto-placement instead of the recommended surface-then-fill scope, Slice B
grows a genuinely new capability (ingest resolving week/route context) that
has no precedent anywhere in the ingest pipeline today, and should be
re-scoped as its own slice rather than folded into this one.
