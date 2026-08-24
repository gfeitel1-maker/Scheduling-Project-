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
