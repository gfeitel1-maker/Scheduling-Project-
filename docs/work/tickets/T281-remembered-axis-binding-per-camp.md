---
title: "Stage 3 — a remembered, versioned, revocable per-camp axis binding"
document_type: ticket
status: open
created: 2026-09-27
task_class: database-sync
archive_when: "a director-confirmed axis binding is remembered per camp and re-proposed on a matching re-import while NOT auto-applying to a drifted file; a RECALLED binding is re-run through the domain and coverage checks on EVERY import, so a binding that no longer matches the file re-asks instead of silently narrowing (this is what closes P38, where renaming one rank header dropped rank 3 for 13 campers under ok=true); the match/drift key is derived from header text, axis labels and geometry only and provably never from cell contents; a remembered binding is revocable by an explicit act that is not byte-drift, expires on a change to the camp's elective COORDINATE SET into re-confirmation (NOT 'across a season boundary' — there is no season concept in this schema, grep returns zero, and a schedule changing shape is the right trigger rather than a date passing; ADR 13.6a), and is listed on a review surface showing when it was confirmed and what it has been applied to; the seedlings reservation at electron/db/schema.sql:245/:251 is either filled by this work or its comments corrected; and the owner has ruled on persistence, on replication, and on what the record id is derived from"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T278-import-agnostic-elective-preferences.md]
---

# T281 — Stage 3: the remembered axis binding

Umbrella: **T278**. Design: ADR §6, §6.0, §6.1, §6.2, §6.3.

## BLOCKED — do not start

Two blockers, both stated in the ADR:

1. **Owner decisions** — ADR §9 Q3: persist at all? replicate? what is the id derived from? This is
   the only schema-bearing stage; **no version is claimed and none may be picked before that ruling.**
2. **The design does not exist yet.** ADR §6.0 rules that the **profile record's field list, its key,
   and what constitutes a MATCH** are NOT YET SPECIFIED and need their own design round. Matching and
   drift *are* the mechanism; approving the ADR did not approve a matcher.

## The failure this stage introduces and must answer

ADR §6.1 — a **confirmed-wrong** binding carries no residue and no low confidence, re-applies
pre-confirmed, and today has no unlearn path. All four of §6.1's rulings are in `archive_when`.

**ROUND 5 (ADR §12.9).** Substance unchanged; this slice now owns **P38's remembered half** — §11.2's
domain and coverage checks applied to a *recalled* binding, not only a freshly proposed one. Round 3
measured P38 as a silent miss; ADR §12.4 row 7 splits it between T279 (the loud half: an unrecognised
column is reported) and this slice (the remembered half: a stale binding re-asks).

**ROUND 6 (ADR §13.6a).** The ship-gate said "expires across a season boundary"; `grep -c season
electron/db/schema.sql` returns **0**. Replaced with expiry on a change to the camp's elective
coordinate set — the same input §11.2 checks 1 and 3 already consume, implementable today, and more
correct: what should force re-confirmation is the schedule changing shape, not a calendar date.
