---
title: "Stage 1 — the ETL spine, all five RESOLVERS, and schema v79 (campers.division_label)"
document_type: ticket
status: open
created: 2026-09-27
task_class: database-sync
archive_when: "a preference file of any observed kind enters through ONE pure transform module called identically from the import screen, the CLI and the MCP tools; ALL FIVE RESOLVERS are implemented under one rule (columns to roles, labels to catalog activities, division labels to existing groups, rows to camper identities, coordinates to elective cells) and every value that resolves to nothing becomes residue rather than a silent write; a correctly-read 18-cell planner for ONE camper writes 18 rows with distinct non-null occurrence_ids and is NOT refused, proven by a test entering at file bytes — which REQUIRES sameNameCampers to gain the coordinate dimension, since today one name on many rows collapsing to one derived id is refused before hasContradictoryRanks is even reached (verified by execution, ADR 13.1), while the same name twice at the SAME coordinate stays refused; campers.division_label AND elective_preferences.rank_kind exist at schema v79 with rollbackV79 and a >= 78 AND < 79 guard AND with division_label added to PROJECTIONS.campers.fields and rank_kind to PROJECTIONS.elective_preferences.fields (an unlisted field is SILENTLY discarded by applyProjection, so omitting this populates nothing with a green gate), a matching division resolves to group_id and an unmatched one is stored verbatim with a residue item and NEVER creates a group; the reported preference count EQUALS the number of rows written, with two ranks on one (camper, occurrence, choice) resolved best-rank-wins and the dropped rank residued while two choices at one rank stay refused; a forked identity (one name, several derived ids, a row lacking an external id) produces a residue item naming each row division; a row whose rank cells resolve to no known activity is skipped rather than made a camper; the false comment at src/ingest/preferenceSheet.js:19-21 claiming ranking is GLOBAL is corrected; and no test in the set asserts on a hand-built parsed fixture"
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
