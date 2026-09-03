---
title: T118-compound-cell-interpretation
document_type: ticket
status: in-progress
created: 2026-09-03
governing_docs: [docs/adr/2026-09-03-compound-cell-interpretation.md]
related_adrs: [docs/adr/2026-09-03-compound-cell-interpretation.md]
archive_when: all four slices shipped and merged
---

# T118 — Compound cell interpretation (director-confirmed, per-camp learned)

See `docs/adr/2026-09-03-compound-cell-interpretation.md` for the decision and the full evidence
trail (real files, root cause, precedent). This ticket is the build plan, in four slices, each
independently test-first, reviewed, and merged before the next starts — same rhythm as the
canonical-saved-version feature (T117, slices 1-2).

## Slice 1 — Pure classifier (`src/ingest/compoundCellPatterns.js`, new)

No I/O, no db, no camp context. Detects candidate compound patterns from raw cell strings.

```js
/**
 * @param {string[]} cellValues  every raw cell string seen in a parsed file (pages[].rows[].cells)
 * @returns {Array<{
 *   pattern: string,        // the literal cell text as it appeared, e.g. "Lunch + Leave"
 *   occurrences: number,
 *   parts: [string, string],
 *   anchorGuess: string|null,   // the part that also appears as its own standalone cell, or null
 *   wrapperGuess: string|null,  // the other part, or null if ambiguous
 * }>}
 */
export function detectCompoundCellPatterns(cellValues) { ... }
```

Algorithm (per the ADR's "Detection" section):
1. Split cell values on connector chars `&`, `+`, `/`, `w/` (regex, candidate-generation only —
   this module never mutates or splits real data, it only reports).
2. Build a partner map: for every compound cell's parts, record which OTHER parts each part has
   been seen paired with (same shape as the `partnerCounts`/`partners` map validated during the
   investigation — see the probe scripts referenced in the ADR for the exact tested logic).
3. A part with ≥2 distinct partners → include its pattern(s) as candidates. A part with exactly 1
   partner across the WHOLE file → its pattern is a single fixed name; do NOT emit a candidate for
   it (this is what correctly excludes `Arts & Crafts`, `A/C`, `Ruach & Shabbat` — validated against
   the real corpus during investigation, zero false positives on the fixed-name case across 4
   camps' files).
4. For each emitted candidate, `anchorGuess` = whichever part ALSO appears as a fully standalone
   cell value elsewhere in `cellValues` (unsplit, exact match); `wrapperGuess` = the other part, or
   both null if neither/both qualify (ambiguous — the UI's "not sure" option exists for this case
   too, not just director uncertainty).
5. Group by exact `pattern` string (not by parts) so `Lunch + Leave` and `Swim & Return` are two
   separate candidates even though both involve a "wrapper" concept — the UI asks about the
   PATTERN, not the abstract word, matching the ADR's card design (one card per pattern).

**Unit tests** — `src/ingest/compoundCellPatterns.test.js`, fixtures drawn directly from real
patterns found in this investigation (do not invent synthetic ones where a real one exists):
- `Lunch + Leave` / `Swim & Return` / `Lunch & Swim` mixed into a cell list with plain `Lunch`,
  `Swim`, `Return`-never-standalone → both patterns detected, `anchorGuess` correctly picks
  `Lunch`/`Swim` (they appear standalone elsewhere), `wrapperGuess` picks `Leave`/`Return`.
- `Arts & Crafts` appearing many times, always as that exact pair, nothing else pairing with
  `Arts` or `Crafts` → NOT detected as a candidate (single-partner exclusion).
  `Change/Snack`, `Change/Ga Ga`, `Change/SPLAT` in one cell list → `Change` has 3 distinct
  partners → all three patterns detected as candidates.
- A pattern where NEITHER part appears standalone anywhere (e.g. `Sports (w/G1)` type cells,
  parenthetical qualifier) → still detected as a candidate (multi-partner test doesn't require a
  standalone anchor to fire), but `anchorGuess`/`wrapperGuess` both null.
- Empty `cellValues` → `[]`.
- One candidate per distinct pattern, not per occurrence (dedupe by `pattern` string, `occurrences`
  counts how many times it was seen).

## Slice 2 — Per-camp learned-decision persistence

New host-local table, sibling to `source_aliases` (`electron/db/schema.sql:108`, see
`docs/adr/2026-08-09-s1b-host-local-aliases.md` for the shape this mirrors). Design the exact
columns before writing the migration — at minimum: `camp_id`, the literal `pattern` string (the
lookup key on next import), the confirmed `interpretation` (`as_written` | `wrapper` |
`alternatives`), `anchor_name`/`wrapper_name` when interpretation is `wrapper`, `confirmed_by`,
`confirmed_at`. Same guarantees as `source_aliases`: **never included in any full-sync
SELECT/payload, never replicated, never sent to a peer** (mirror the exact schema.sql comment
convention at line 128). A migration bump is required — read `electron/db/localDb.js`'s existing
migration-block pattern first (see `reference_migration_guard_form` — gate on `>= N-1 && < N`, not
bare `< N`).

Writer: `electron/ops/confirmCompoundCellPattern.js` (new), same shape as
`electron/ops/confirmAlias.js` — `db.transaction()`, host-only, admin-gated at the IPC boundary, NO
`appendOp` call (never replicated, matching `source_aliases`'s writer).

Reader: a `listCompoundCellDecisions(db, camp_id)` function, sibling to `listAliasMap`
(`electron/ops/ingest.js:247`), returning a `Map` keyed by the literal `pattern` string.

**Tests** — `electron/ops/confirmCompoundCellPattern.test.js`: write then read round-trips
correctly; a second write for the same `(camp_id, pattern)` updates rather than duplicates; the
table is absent from whatever function assembles a full-sync payload (assert this explicitly, same
as `source_aliases` presumably already has a test proving its own exclusion — find and mirror it).

## Slice 3 — Extraction integration (read-before-extract, still pure `extractEntities`)

Thread `compoundCellDecisions` (the Map from slice 2's reader) into `extractEntities` as a new
optional argument, parallel to how `proposal.canonicalMap` already flows — `extractEntities`
remains pure; the caller (renderer, at parse time) is responsible for fetching the Map via
`localClient` and passing it in. When a cell's raw text exactly matches a confirmed pattern's key:
- `as_written` → unchanged from today's behavior (kept as one activity name, as it already is).
- `wrapper` → resolves to `anchor_name` only; the wrapper string does not enter
  `proposal.entities.activities` at all, and does not appear in `proposal.seenCounts` under its own
  name (folds into the anchor's count, same mechanics as `canonicalizeActivityName` folding a typo
  variant onto its canonical spelling — reuse that function's shape, don't reinvent).
- `alternatives` → out of scope for slice 3/commit-time activity creation (see Slice 4 note on
  `alternatives` — this interpretation is recorded but slice 4 decides how commit actually treats
  a shared-slot activity; do not guess the eligibility mechanics here without checking how
  elective-set or multi-eligibility activities already work in this codebase first).

**Tests** — extend `extractEntities.test.js` (or a sibling file): a compound-cell decision Map with
a `wrapper` entry folds correctly (activity count, seenCounts, canonicalMap-style resolution);
`as_written` entries are a no-op; an unrecognized pattern (not in the Map) behaves exactly as today
(regression guard — this must never change behavior for a camp's first-ever import of a new
pattern).

## Slice 4 — ImportScreen UI + commit wiring

New section "Cells We Weren't Sure About" at `src/screens/ImportScreen.jsx:1341` (immediately after
Longer Blocks, before Keep-vs-Replace), following the ADR's card design exactly: one card per
undecided pattern (from slice 1's classifier, filtered against slice 2's already-confirmed decisions
so a resolved pattern never shows a card again), showing the literal cell text, occurrence count,
and four choices — `One thing, as written` / `"[wrapperGuess]" is a wrapper around
"[anchorGuess]"` / `These are alternatives — either one` / `Not sure — ask me later`. Nothing
pre-selected. A card left on "not sure" or untouched ships nothing different from today's behavior
(same "unticked = not written" contract as Longer Blocks) — never a forced guess.

State: `compoundCellCandidates` (from slice 1, computed at parse time alongside `multiBlockCandidates`)
and `compoundCellDecisions` (a `{ [pattern]: 'as_written'|'wrapper'|'alternatives' }` map), same
shapes/naming convention as `multiBlockCandidates`/`multiBlockDecisions`
(`src/screens/ImportScreen.jsx:171-172`).

`buildCommitInputs` (`src/screens/ImportScreen.jsx:691`) must apply resolved decisions **before**
`approved.activities`/`outgoingRules` are built from `proposal.entities` — this is the one place
this slice differs structurally from the Longer Blocks precedent (which only appends; this one must
rewrite upstream). Concretely: run the same fold slice 3 taught `extractEntities` to do, but against
the LIVE in-memory `compoundCellDecisions` from this import's UI state (not yet persisted), so a
decision made THIS import affects what THIS import commits, even before it's written to the learned
table. Also pass the newly-confirmed decisions to `ingestCommit` so `commitIngest` (or a step
alongside it, matching how `materializeImportedVersion` runs after `commitIngest` per T117 — check
whether this belongs inside or alongside that same seam before assuming) writes them via slice 2's
`confirmCompoundCellPattern`, once, at successful commit.

**Tests**: component-level test (mirror `ImportScreen.test.jsx`'s existing coverage style) — a file
with a known compound pattern shows one card; picking "wrapper" then committing (a) does not create
the wrapper as an activity, (b) writes a compound-cell-decision row; re-running the import flow
against the same (mocked) camp state with the decision already present shows NO card for that
pattern. Mock parity: `src/localClient.mock.js` needs the new list/write functions, mirroring how
alias confirmation is already mocked.

## Explicitly out of scope (per the ADR)

- The PDF multi-line-merged-cell fragmentation bug (a text-grid parsing issue, not a compound-cell
  interpretation issue) — separate ticket if pursued.
- PDF import support at all — separate initiative.
- Any change to `createConfidenceTier` itself.
- Any cross-camp signal of any kind.

## Verification gates (each slice)

`npm run verify` must pass. Slices 2+ touch `electron/db/**`/`electron/ops/**` — native module ABI:
`npm rebuild better-sqlite3` before Vitest per CLAUDE.md. Full-suite result, not `| tail` (capture
real exit code). Slice 2's schema/migration change plus slice 4's sync-exclusion property are exactly
the kind of change that should get a Red Hat pass before merge (data shape + a new "never syncs"
invariant) — do not skip that review to move faster.
