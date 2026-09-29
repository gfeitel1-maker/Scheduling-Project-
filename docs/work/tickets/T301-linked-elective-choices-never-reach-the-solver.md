---
title: "The linked-choice tier is unreachable in the product"
document_type: ticket
status: open
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T300-findings-name-activities-as-the-director-does.md]
archive_when: "a director can author an elective choice that spans more than one period, that choice reaches `buildElectiveAssignments` as `choices` + `choiceOfferings` from the real screen, a camper who ranks it is placed in ALL of its periods or none, and a run driven from the UI produces an `UNSUPPORTED_LINKED_CHOICE` finding when the data warrants one — OR the tier is deliberately retired and the dead code, schema and tests go with it"
---

# T301 — The linked-choice tier is unreachable in the product

Found while scoping [T300](T300-findings-name-activities-as-the-director-does.md). T300 fixed the
rendering of `UNSUPPORTED_LINKED_CHOICE`; this ticket is about the fact that a director can never
cause that finding, because the whole feature it belongs to is not wired.

## What exists

T247 built a **two-tier solver**. Tier 1 places *linked choices* — an elective a camper takes as a
SET across more than one period, placed all-or-nothing — before the ordinary per-occurrence pass.
`runLinkedChoiceTier` in `src/engine/buildElectiveAssignments.js` is complete, deterministic and
well tested, and it emits `UNSUPPORTED_LINKED_CHOICE` in three cases.

The storage exists too: `elective_choices` and `elective_choice_offerings` (both v66, schema
`electron/db/schema.sql`), and `elective_run_outer_snapshots` carries `is_linked_choice` /
`choice_label` (v76, T197).

## What does not, verified 2026-09-29

**1. The only production caller passes neither input.** `src/screens/elective/assignment/AssignmentPanel.jsx`
calls `buildElectiveAssignments` with `campers`, `occurrences`, `offerings`, `preferences`,
`attendance` and `lockedAssignments` — and no `choices`, no `choiceOfferings`. Both default to `[]`,
so `membersByChoice` is empty and `runLinkedChoiceTier` returns on its first guard. Nothing else in
`src/` passes them either; every other call site is a test.

**2. Nothing ever authors a linked choice.** `electron/ops/commitElectiveRun.js` writes
`elective_choices` rows with `is_linked: 0` HARDCODED. The engine already documents this and routes
around it — its own comment says "Deliberately NOT the `is_linked` column: nothing in this repo
writes it as 1 (commitElectiveRun hardcodes 0), so reading it would leave this tier permanently
dead" — and derives "linked" from *more than one member occurrence* instead.

**3. So the fallback definition is dead too.** The only writer of `elective_choice_offerings` is the
projection's parent stub in `electron/ops/projections.js`, an `INSERT OR IGNORE ... (id, choice_id)`
that carries no occurrence and no activity. A choice can therefore never reach two member
occurrences, so the derived definition of "linked" is never satisfied either.

Both the column-based and the count-based definitions of "linked" are unreachable, by different
routes. The engine's workaround for (2) is defeated by (3).

## Why it matters

- **A real product capability is built and paid for and cannot be used.** A camp that runs a
  two-period woodworking elective cannot express it; those campers get placed one period at a time,
  which is the exact outcome the `UNSUPPORTED_LINKED_CHOICE` message apologises for.
- **It is invisible.** Tier 1 returning early is indistinguishable from "no linked choices exist",
  so nothing reports the gap. Tests pass because they construct the inputs by hand.
- **Dead code that looks live is a standing hazard.** T300 spent real effort fixing a finding a
  director cannot see, and the next reader will too.

## The decision this ticket needed first — SETTLED

**Owner ruling 2026-09-29: yes, linked choices are wanted.** The retirement branch below is closed;
the work is an authoring surface, a writer, and the wiring from `AssignmentPanel` into the solver.
Designer before Architect before Maker, as this ticket already said.

_Prior: this section asked whether the feature was wanted at all, and said not to start
implementation before it was settled. It is settled._

Four further decisions were taken during design the same day and are recorded, with what each one
forces, in [the design spec](../specs/2026-09-29-t301-linked-elective-bundles-design.md): the unit of
a bundle is the **offering** (director picks the periods); division scoping is **fully general**; an
activity **may** carry more than one bundle, which a camper picks between; and a bundle's name is
**proposed and editable**, because that name is what a camper's sheet must match.

Two consequences worth carrying at the ticket level:

- **T219 (multi-day catalog linkage) is the same feature, not a separate one.** `deriveOccurrences`
  builds an occurrence per distinct `(day, time_block, tier)` cell, so Mon P3 + Mon P4 and Tue P2 +
  Thu P2 are structurally identical. T219 should be closed by this work or explicitly re-scoped.
- **There is one unsettled architectural decision, and it is the ADR's job, not this ticket's.** A
  bundle serving several divisions must expand to one choice PER division, because tier 1 excludes a
  camper who does not attend every member occurrence — and `deriveElectiveChoiceId(runId, labelKey)`
  keys on label alone, so those choices collide on one id. Three options and a preference are in the
  spec.

Do not start slice 1 before the ADR settles that.

## Non-goals

- Not a change to tier 2, the per-occurrence pass every real run uses today.
- Not a re-litigation of T247's placement algorithm, which is tested and sound.
- Not a migration: whichever way the decision goes, the schema already supports it.

## Evidence to gather before implementing

- Drive a run from the real UI with a choice spanning two periods and confirm today's behaviour
  (each period placed independently) — the ticket's premise should be re-confirmed at the screen,
  not only by reading call sites.
- Confirm whether any camp fixture in `test/fixtures/preference-corpus/` expresses a multi-period
  set, which would say whether this is a real camp need or a speculative one.
