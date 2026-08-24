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
