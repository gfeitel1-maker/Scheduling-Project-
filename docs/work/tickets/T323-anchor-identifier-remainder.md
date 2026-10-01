---
ticket: T323
document_type: ticket
title: Anchor identifier/comment remainder sweep (T293/#696 residual)
status: completed
created: 2026-10-01
archive_when: zero retired-fixed-event-sense "anchor" identifiers/comments remain in src/** and electron/** (excluding deferred paths), no KEEP occurrence renamed, director-facing count stays zero, and the full gate is green on CI
task_class: copy-terminology
parent: T293
related_prs: ["#696", "#702"]
---

# T323 — Rename the retired "anchor" fixed-event vocabulary remainder (identifier/comment level)

## Context

#696 (T293) renamed the retired **fixed-event / recurring-event "anchor"** vocabulary at the
DB-column, engine-input-key, export-sheet, screen, template-filename, and engine-HELPER-function
level (e.g. `resolveFixedEventActivityIds`, `fixedEventCoveredGroupIds`). #702 followed up. What
#696/#702 left behind is the **identifier and comment remainder**: local variable names
(`anchor`, `anchoredIds`, `anchoredActivityIdsByGroup`, `anchorSlotKey`, `anchorGroupKey`, …) and
prose comments that still call a fixed event an "anchor".

This is a **semantic classification pass, not a find-replace.** The word "anchor" carries TWO live
senses and several must-keep historical/CSS uses — see KEEP below. A blind sed corrupts live
vocabulary.

## Success predicate (observable)

1. Zero references to the **retired fixed-event sense** of "anchor" at the identifier/comment level
   in the in-scope paths (`src/**`, `electron/**` excluding the deferred paths below).
2. Director-facing (user-visible rendered string) "anchor" count for the retired fixed-event sense
   stays **zero** — no rendered copy changed.
3. The full 8-gate (`npm run verify`) is green on CI.

## What does NOT count as done

- Renaming any KEEP-category occurrence (that is a defect, not progress).
- Touching the deferred paths.
- A green gate achieved by narrowing or deleting a test's assertion rather than updating the
  symbol it references.

## RENAME — the retired fixed-event sense

Local vars / comments where `anchor` means a **fixed-event record**:
- `src/engine/buildSchedule.js` (~75 hits): `anchor` (a fixed-event record), `anchoredIds`,
  `anchoredActivityIdsByGroup`, the `"groupId|dayId|blockId" → anchor` lookup comment, prose like
  "an anchor links its activity", "which group ids does this anchor cover". → `fixedEvent`,
  `fixedEventIds`, fixed-event language.
- `src/screens/FixedEventsScreen.jsx` (~52), `src/engine/fixedEventScope.js` (~18),
  `src/utils/computeOverlaps.js` (~24), `src/engine/weekCatalog.js` (~10),
  `electron/ops/ingest.js` (~68, incl. `anchorSlotKey`/`anchorGroupKey`/`saveAnchor`), and the
  long tail — classify each; most are the fixed-event sense.

## KEEP — do NOT rename (live or historical; renaming is a defect)

1. **Compound-cell base-term sense** — `anchor`/`wrapper` = the base term in a compound cell label
   ("Lunch" is the anchor in "Lunch & Swim"). `src/screens/ImportScreen.jsx` (wrapper/anchor UI
   copy; the `{ key: 'anchors', … }` reconciliation key — rendered text already correct), and
   `src/ingest/` compound-cell code (`multiBlockCandidates.js`, `extractEntities.js`,
   `fixedEvents.js`, `coScheduleRules.js`, `sheetGrid.js`, `textGrid.js`). LIVE domain vocabulary.
2. **Historical citations** — ADR/ticket filenames containing "anchor" in comments
   (`buildSchedule.js` ~103/153/825; `electron/fixtures/electiveAcceptanceCamp.js:7`;
   `electron/ops/ingest.js:2223`). Keep verbatim; do not rename ADR/ticket files.
3. **Plain-English "anchor/anchored"** in a non-domain sense (CSS positioning, "anchored to the
   cell's bottom"). Keep.
4. **The `--anchor` CSS design token and ALL its users** — `src/index.css:14` (`--anchor` + its
   `--purple` deprecated alias), `scheduleGrid.css` `.cell-inner--anchor`, `ANCHOR_COLOR`
   (`src/components/schedule/slotCellConstants.js`), `src/styles/shared.js`,
   `RootMap.jsx`, `SlotCell.jsx`, `FixedEventsScreen.jsx:898`. DEFER — a design-token rename
   spanning the scheduleGrid.css exception + deprecated-alias entanglement is a separate
   design-system decision.

## DEFER — do not touch (list in PR body)

- `electron/sync/**` and `electron/db/**` — primary worker's T233 S3a is in flight there; v84
  already renamed the DB columns; remaining `electron/db/localDb.js` hits are the compound-cell
  comment sense.
- The `--anchor` CSS design token family (KEEP #4).

## Discipline

- For any EXPORTED symbol renamed: `graphify affected "<symbol>()" --graph ~/dev/shoresh/graphify-out/graph.json`
  first (read header line back), then `grep -a` across `test/`, `test/integration/`, `scripts/*.mjs`.
- The three `check:governance` detectors (staleSettingsKey / vacuousFilterAssertion / retiredSqlColumn)
  must pass on the diff.
- Update any `.test.js`/`.automerge.js` referencing renamed symbols; re-grep tests for OLD names after.

## Agents

Maker (Opus), Code Reviewer, Red Hat (mandatory — engine/ops seam + rename blast radius), Verifier,
Grader. Security omitted (no auth/secret/PIN/wire/IPC/packaging surface). Reviewers read-only.
