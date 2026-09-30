---
title: "Stage 1 — the ETL spine, all five RESOLVERS, and schema v79 (campers.division_label)"
document_type: ticket
status: completed
created: 2026-09-27
task_class: database-sync
archive_when: "a preference file of any observed kind enters through ONE pure transform module called identically from the import screen, the CLI and the MCP tools; ALL FIVE RESOLVERS are implemented under one rule (columns to roles, labels to catalog activities, division labels to existing groups, rows to camper identities, coordinates to elective cells) and every value that resolves to nothing becomes residue rather than a silent write; a correctly-read per-cell planner for ONE camper writes ONE ROW PER CELL, each carrying the coordinate as written on the sheet, with NO two cells merged and NO dropped-duplicate residue, and is NOT refused, proven by a test entering at file bytes (occurrence_id may legitimately be NULL at import time: no template exists then, and the caller resolves the coordinate at solve time - the earlier wording demanded distinct NON-NULL occurrence_ids, which was proven unachievable on this path and is corrected here rather than left standing) — which REQUIRES sameNameCampers to gain the coordinate dimension, since today one name on many rows collapsing to one derived id is refused before hasContradictoryRanks is even reached (verified by execution, ADR 13.1), while the same name twice at the SAME coordinate stays refused; campers.division_label, elective_preferences.rank_kind AND elective_preferences.coordinate_day_label/coordinate_period_label exist at schema v79 with rollbackV79 and a >= 78 AND < 79 guard AND with division_label added to PROJECTIONS.campers.fields and rank_kind plus both coordinate columns to PROJECTIONS.elective_preferences.fields (an unlisted field is SILENTLY discarded by applyProjection, so omitting this populates nothing with a green gate), a matching division resolves to group_id and an unmatched one is stored verbatim with a residue item and NEVER creates a group; the reported preference count EQUALS the number of rows written, with two ranks on one (camper, occurrence, choice) resolved best-rank-wins and the dropped rank residued while two choices at one rank stay refused; a forked identity (one name, several derived ids, a row lacking an external id) produces a residue item naming each row division; a row whose rank cells resolve to no known activity is skipped rather than made a camper; the false comment at src/ingest/preferenceSheet.js:19-21 claiming ranking is GLOBAL is corrected; and no test in the set asserts on a hand-built parsed fixture"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T278-import-agnostic-elective-preferences.md]
---

# T279 — Stage 1: canonical record, transform seam, RESOLVE, residue

Umbrella: **T278**. Design: ADR §3, §3.1, §3.1a, §3.4, §4.4.

**This is the stage that fixes the stated defect.** The silent flatten becomes visible; nothing else
in the program does that.

## The trap this stage exists to avoid

ADR §3.1a: a binding keyed to a coordinate with `rank: 1` per cell **refuses every grid**, because
`hasContradictoryRanks` keys on `(camper_id, occurrence_id, rank)` and an absent `occurrence_id`
collapses 18 cell choices onto one key. Verified by executing the function. **RESOLVE must run before
the refusal gate.** `commitElectiveRun` and `describeElectiveRunRefusal` are unchanged.

## Not in this stage

Persisting or remembering anything (T281). The corpus (T282).

**ROUND 5 RE-CUT (ADR §12.9).** This slice grew: it now carries **six of the seven measured in-scope
silent misses** (P02, P06, P09, P13, P18's loud half, P35), the cross-cutting division loss, and P38's
loud half. Deliberately one slice, not five — the resolvers are **one rule with five applications**
(ADR §12.0), and splitting them ships a state where some values are resolved and others silently
accepted, which is today's state half-fixed and harder to reason about than either end.

**Needs schema v79** — TWO columns: `campers.division_label TEXT` and `elective_preferences.rank_kind TEXT`, both nullable, ALTER ADD COLUMN appended last, with
`rollbackV79(db)` and a `>= 78 && < 79` guard. Clean addition, nothing to migrate (pre-production).
Re-check `CURRENT_SCHEMA_VERSION` immediately before merge: the check-to-merge window stays open.

**Traceability:** ADR §12.4 maps each silent miss to its design element and its file-bytes test.

**ROUND 6 (ADR §13).** Three corrections landed here. (1) **F1 blocker:** `sameNameCampers`
(`src/ingest/preferenceSheet.js:126-137`), tested first by `commitElectiveRun.js:36-44`, refuses a
correctly-read per-cell grid for a single camper — reproduced by executing the functions, not by
reading them. The predicate above was unachievable until the identity resolver owns multiplicity.
(2) v79 grows to a second column, `elective_preferences.rank_kind`, without which §4.2's ruling is
unimplementable. (3) **Both projection allowlists are part of this change, not a follow-up** — a field
absent from `PROJECTIONS.<entity>.fields` is discarded silently by `applyProjection`, so the failure
mode is a green gate over an empty column.


## ROUND 2 — owner ruling: the machine seam never refuses, and the coordinate is STORED

Two rulings, and the second is a real fix rather than a policy tweak.

**1. The CLI and the MCP tools must never refuse a readable file.** Owner: *"imagine that
someone is using the cli or the mcp — the point would be to have your AI talk to the software. that
bridge makes everything about our life easier. how could we write software that says no to someone?"*
A refusal at the machine seam is not a safety property, it is the bridge failing. This generalises
the standing ruling *"we are reading someone's data. we are not choosing how they import it"*: at the
machine seam, **ACCEPT AND REPORT** is the only acceptable shape. Recorded in the ADR as a standing
design rule (§14.1) because it governs every future adapter and every future gate on that path, not
just this ticket.

**2. Storage must carry the COORDINATE, not only the resolved occurrence.** The round-1
implementation keyed `elective_preferences` on `(camper, occurrence_id, choice)`, and `occurrence_id`
is NULL until a template exists — so a per-cell sheet imported before any schedule was built had two
cells naming one activity **merge into one row**, with the loss reported as a dropped duplicate. Read
as a product statement: the importer was discarding a camper's answer because it could not yet
express it. That is T278's own defect happening inside the fix for it.

The coordinate (day label, period label, as written) is a fact about **what the child asked for** and
is true the moment the sheet is read. The occurrence is a fact about **one candidate schedule**. ADR
§3.1 always said the record *"names a coordinate (day, period), never an occurrence_id"*; storage
never followed the record, and now does. `deriveElectivePreferenceId` gains a third, coordinate-scoped
arm (`epref2:`), so two cells are two rows **with no template in sight**. Coordinate resolution stays
exactly where §13.2 put it — solve-time, template-scoped — so a file imported in spring round-trips
its coordinates intact and becomes resolvable later **without being re-imported**.

**MEASURED:** P33 (per-cell long form) went from 15 preference rows and 75 `DROPPED_DUPLICATE_RANK`
residue items to **90 rows and 0** — 75 of a camper's answers were being discarded, and are now
stored. No other probe changed bucket, residue count or row count, and no probe reports a count
disagreeing with the rows it wrote.

## Closed (2026-09-30)

Merged in #579. This ticket's `archive_when` is one long sentence; itemised below, each sub-clause
checked first-hand against origin/main (re-run, not taken on the PR body's word) and cited to the
specific file that discharges it.

- **One pure transform seam, called identically from the import screen, the CLI and the MCP tools.**
  `src/ingest/preferenceSheet.js` is imported by `scripts/preferenceSheetCli.js` (CLI),
  `scripts/mcp/tools.js` (MCP), and the import screen path. Structure confirmed by import graph.
- **All five resolvers under one rule; unmatched → residue, never a silent write.**
  `src/ingest/preferenceSheet.js`'s header states the rule and names all five (columns→roles,
  labels→activities, division labels→groups, rows→identities, coordinates→cells); each resolver's
  residue behavior is exercised in `test/preferenceEtlResolve.test.js` (P01/P35 division, P09/P13
  label, P02 rank, P06/F1 identity, coordinate tests) — 57/57 passing on this branch.
- **A correctly-read per-cell planner for ONE camper writes ONE ROW PER CELL, no merge, no dropped
  residue, not refused.** `test/preferenceEtlResolve.test.js`'s `'F1: a per-cell planner for ONE
  camper writes a row per cell and is NOT refused'` (line ~569): 6 distinct coordinates, 1 camper row,
  6 `elective_preferences` rows, real `SELECT COUNT(*)` assertions.
- **`sameNameCampers` gains the coordinate dimension.** `src/ingest/preferenceSheet.js`'s slot-based
  collision logic (keyed on coordinate+rank intersection, not identity alone) is exercised by the same
  F1 test plus `'two cells naming the SAME activity are TWO rows, with their coordinates intact'`.
- **Schema v79** (`campers.division_label`, `elective_preferences.rank_kind`/
  `coordinate_day_label`/`coordinate_period_label`) with `rollbackV79`/`v79_down.js` and the
  `>= 78 && < 79` guard, both allowlists updated. `electron/db/schema.sql` carries all four columns;
  `CURRENT_SCHEMA_VERSION` is now 82, so v79 has landed and later migrations build on it; both fields
  are present in `PROJECTIONS.campers.fields` and `PROJECTIONS.elective_preferences.fields`.
  `preferenceEtlV79.migration.test.js` (6/6) pins the columns, declaration order, and rollback.
- **A matching division resolves to `group_id`; an unmatched one is stored verbatim with residue and
  never creates a group.** `test/preferenceEtlResolve.test.js`'s `'P01: stores every division verbatim
  AND resolves it to an existing group'` and `'NEVER creates a group or a tier from a file (T224 as a
  rule)'`.
- **The reported preference count equals the number of rows written.** `test/preferenceEtlResolve.test.js`'s
  `'P02: the reported preference count EQUALS the number of rows written'` (line ~263): asserts
  `result.counts.preferences === (real SELECT COUNT(*) FROM elective_preferences)`.
- **Two ranks on one (camper, occurrence, choice) resolve best-rank-wins, with the dropped rank
  residued; two choices at one rank stay refused.** `test/preferenceEtlResolve.test.js`'s `'P02: the
  surviving row keeps the BETTER (lowest) rank, and the drop is residue'` (line ~274): a real `SELECT`
  shows exactly one surviving row at the lower rank, and the residue names the dropped rank
  (`droppedRank: 21`). The "two choices at one rank stay refused" half is pinned by
  `'same rank on two DIFFERENT choices is still REFUSED (unchanged)'` in the same file.
- **A forked identity produces a residue item naming each row's division.**
  `test/preferenceEtlResolve.test.js`'s `'P06: a partial-id fork is RESIDUE, not a refusal, and names
  each row'` (line ~535): a real two-row query confirms the fork, and the residue's
  `rows[].divisionLabel` names each row's division (`['Lower Division', 'Upper Division']`).
- **A row whose rank cells resolve to no known activity is skipped rather than made a camper.**
  `test/preferenceEtlResolve.test.js`'s `'P13: a row whose rank cells resolve to no known activity is
  not a camper'`.
- **The false `GLOBAL`-ranking comment is corrected.** Confirmed by reading
  `src/ingest/preferenceSheet.js`'s header — the claim is gone.
- **No test in the set asserts on a hand-built parsed fixture.** `test/preferenceEtlResolve.test.js`'s
  own header states this as the file's organizing rule verbatim: "EVERY TEST HERE ENTERS AT FILE BYTES
  AND ASSERTS AT THE DATABASE... A test that constructs a `parsed` object and asserts on its contents
  proves that the test author can build an object." Every test in that file reads a real file via
  `commitBytes`/`commitProbe` (wrapping `runPreferenceSheetCli`) and asserts via `SELECT`. This is
  established for `preferenceEtlResolve.test.js`, the file this program's own resolve-stage test
  design targets; the broader claim over every other test file touched by this PR was not separately
  re-audited and is recorded here as a named residual rather than presented as checked.

Also re-verified live: `node scripts/preferenceCorpusProbe.mjs` reproduces P33 exactly as the ticket
claims (5 campers, 90 preferences, `ok: true`, no `DROPPED_DUPLICATE_RANK`/no merge).
`preferenceSheet.test.js` (28/28) and `electiveDerivedIds.test.js` (95/95) also pass on this branch.
