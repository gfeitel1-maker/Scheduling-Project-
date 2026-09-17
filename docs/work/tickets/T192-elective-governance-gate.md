---
title: T192-elective-governance-gate
document_type: ticket
status: completed
created: 2026-09-17
archive_when: the superseding ADR is accepted or rejected
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T192 — Slice 0: governance gate

Supersede the prohibitions in the two accepted elective ADRs so individual elective scheduling may
be built at all, and record the owner decisions that bound it.

## Why it is its own slice

`2026-08-20-electives-authoring.md` and `2026-08-22-nested-schedules-electives-and-events.md` are
accepted and normative, and both say: no campers, no per-camper rosters, no preference data, no
solver. Writing a line of feature code before this closes violates them.

## Exit condition

The owner has accepted `docs/adr/2026-09-17-individual-elective-scheduling.md`, and with it:

- D1 — the four prohibitions are superseded; everything else in both ADRs survives.
- D3 — invalid `camper_headcount` blocks; `null` alone means unlimited. This reverses an explicit
  instruction in the 2026-08-22 ADR and must be acknowledged as a reversal, not a clarification.
- D8/D9/D10 — the minors'-data boundary, the permission matrix, and the soft-delete limitation.

Both superseded ADRs have `status: superseded` in the same change that flips this ticket.

## Open questions this gate must close

The three questions in the decision package's "open questions" section. None may be deferred into
implementation — each changes what gets built.
