---
title: "Import-agnostic elective preferences: an ETL spine, a canonical preference record, and a learned axis binding"
document_type: ticket
status: open
created: 2026-09-27
task_class: database-sync
archive_when: "all four stage tickets T279, T280, T281 and T282 are completed, and the owner has ruled on every open question in docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md section 9"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md, docs/adr/2026-09-26-general-ingest-for-campers-and-per-cell-preferences.md, docs/adr/2026-09-26-per-cell-elective-preferences.md, docs/adr/2026-09-17-individual-elective-scheduling.md]
---

# T278 — Import-agnostic elective preferences

## Why

**Owner goal, verbatim:** *"i want this to be import agnostic… every camp will have their own form of
imported material. our task is to reduce the friction between that import and getting to a schedule…
it should therefore be possible to research, produce, and test various import types for electives and
to teach the baseline of the software how to accept types it does not necessarily have
hardcoded/expected at this moment."*

**Reframed by the owner mid-design, and this is the spine:** *"we are talking about how we store
records, etl them, and then use the records to produce an elective schedule."*

**Standing owner rule, recorded in `docs/work/tickets/T265-minimum-headcount-to-run.md`:** *"it
shouldn't matter. we keep going over this. we are reading someone's data. we are not choosing how
they import it."* "Which format should we support?" is a closed question.

## The verified defect

A day × period planner grid imports **without error and silently flattens**. `parsePreferenceSheet`
(`src/ingest/preferenceSheet.js:112-119`) emits `{ camper_id, label, labelKey, rank }` and never an
`occurrence_id`; `describeElectiveRunRefusal` (`electron/ops/commitElectiveRun.js:66-75`) accepts an
absent `occurrence_id` as the legitimate whole-run fallback. Both halves are individually correct —
the owner ruled that a whole-run ranked list with no cells is real camp data — and together they mean
"Monday period 3, archery" is written as "archery, any period" with no error, no warning and no
finding. **That silent loss is the defect. A refusal is not the fix.**

Related, and in scope regardless: the header comment at `src/ingest/preferenceSheet.js:19-21` states
*"The ranking is GLOBAL — a camper ranks each elective once for the session"*. **That is false since
v78** (`docs/adr/2026-09-26-per-cell-elective-preferences.md`) and must be corrected.

Also verified and load-bearing for sizing: `RANK_HEADER = /^#\s*(\d+)$/`
(`src/ingest/preferenceSheet.js:25`) is anchored at both ends against a bare `#N`, and matches
essentially nothing in the header prose real form exports emit.

## Design

`docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md`
(status `proposed`, awaiting owner review). It **absorbs** the never-approved proposed ADR
`docs/adr/2026-09-26-general-ingest-for-campers-and-per-cell-preferences.md`, which is withdrawn on
approval — see that ADR §5 for exactly which rulings are carried forward unchanged and which are
amended.

## Round 1 — done

Design only. **No implementation, no schema change, no schema version claimed.** An ADR for owner
review, plus this ticket.

## Blocked on owner decisions before any implementation

The ADR’s §9 lists seven. The two that gate everything else:

1. **One real Camp InTouch (CampMinder) export from the owner's camp.** Every artifact examined so far
   is a blank planning form; the file that carries campers' actual answers has never been seen by
   anyone on this project, and no camp platform publishes a column-level spec. This is the single
   cheapest thing that would de-risk the design.
2. **Whether the per-camp axis binding is persisted at all, and whether it replicates** across the
   camp's devices rather than following the host-local precedent of the five decision tables
   `src/ingest/decisionJournal.js:3-5` names. This is the one schema-bearing decision and it is the
   owner's to take.

## Stages — this is a program, and each stage is its own ticket

Per `src/ingest/decisionJournal.js` — *"You cannot learn from decisions you never recorded as
decisions, which is why this ships BEFORE any learning does"* — the order is not negotiable.

| Stage | Ticket | What it delivers | State |
|---|---|---|---|
| 1 | **T279** | canonical record, one transform seam, the RESOLVE stage, the residue ledger | ready — **this is the stage that fixes the defect** |
| 2 | **T280** | the decision journal records axis-binding questions and outcomes | ready, after T279 |
| 3 | **T281** | the remembered, versioned, revocable per-camp axis binding | **BLOCKED** — owner rulings, and the matcher is not designed |
| 4 | **T282** | the synthetic corpus and the two acceptance numbers | blocked on T279; class H blocked on a real export |

Stage 3 is the only stage that needs a schema version. **No version is claimed by this program and
none may be picked before the owner rules.**

## Non-goals

- Choosing or privileging any vendor's export format.
- A trained model. The ADR §6 rules the learning layer is infer → show → confirm → remember, on the
  T118 compound-cell precedent, and states what evidence would be needed to revisit that.
- Building the corpus generator this round (designed in ADR §8, built in T282).
- Giving the instructional-swim opt-out or the free-text comments box a home in
  `elective_preferences`. The ADR §4.3 rules both out and §9 Q5 asks where the opt-out belongs. The
  comments box is **host-local, never replicated, never exported** — it is the field most likely to
  carry a medical or custody disclosure about a child.
- **Committing any file derived from a real camp's filled-in responses, in any format.** The corpus
  is synthetic-only (ADR §8.0): generated identities from a committed seeded name list, never a name
  taken from a real file, never a "redacted" copy. A real export obtained under ADR §9 Q1 is held
  **outside the repository** and only its structural shape is transcribed. **No gate enforces this** —
  `scanPrivacy` cannot match an unstructured personal name, and binary files are path-scanned only,
  contents never read — so T282 builds the name-list assertion that does.
- Reopening the "reshape your file to our template" ruling. ADR §9 Q7 asks about one narrow
  last-resort hatch and takes no decision.

## Status note (2026-09-30) — stays open

`archive_when` requires all four stage tickets (T279/T280/T281/T282) `completed`. T279 is now
`completed` (this sweep). T280 and T282 are still `status: open`; T281 is explicitly `BLOCKED — do
not start` and stays open pending owner rulings and an unspecified matcher design (see its own
2026-09-30 status note). The owner has not yet ruled on ADR §9's remaining open questions. Status
stays `open`.
