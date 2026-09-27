---
title: "Stage 1 — canonical preference record, one transform seam, the RESOLVE stage, and the residue ledger"
document_type: ticket
status: open
created: 2026-09-27
task_class: database-sync
archive_when: "a preference file of any observed kind enters through ONE pure transform module called identically from the import screen, the CLI and the MCP tools; a RESOLVE stage binds each (day, period) coordinate to an occurrence_id against deriveOccurrences BEFORE describeElectiveRunRefusal sees it; a correctly-read 18-cell planner writes 18 rows with distinct non-null occurrence_ids and is NOT refused, proven by a test entering at file bytes; a day x period page read without per-cell scope produces a residue item the director sees instead of a silent whole-run flatten; a coordinate RESOLVE cannot bind becomes residue rather than a preference; a name appearing on rows that resolve to different camper ids produces a residue item; the false comment at src/ingest/preferenceSheet.js:19-21 claiming ranking is GLOBAL is corrected; and no test in the set asserts on a hand-built parsed fixture"
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
