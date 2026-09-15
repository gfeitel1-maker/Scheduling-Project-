---
title: "Watch: five mechanisms now remember what the director taught the app"
document_type: ticket
status: completed
created: 2026-09-13
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a fifth or sixth learned-convention mechanism has been built and the owner has decided whether the repetition is a real abstraction or a coincidence worth keeping apart
---

# T157 — Watch: five mechanisms now remember what the director taught the app

**Open as a tripwire, not as work.** From the external architecture review of
2026-09-13 (item 11), whose advice — *do not generalize preemptively* — is
correct and is being followed. This exists so the decision happens on evidence
rather than on whoever notices first.

The mechanisms that each remember a camp-specific convention a director
confirmed:

| Mechanism | Table |
|---|---|
| Import label aliases | `source_aliases` |
| Compound-cell readings (`Lunch + Leave`) | `compound_cell_decisions` |
| Location-word readings | `location_word_decisions` |
| Declined two-row splits | `declined_two_row_splits` |
| Open reconciliation decisions | `open_reconciliation_decisions` |

All five are host-local, never replicated, and each repeats the same shape:
a table, a lookup at parse time, provenance, a reconciliation surface, an IPC
call, and persistence. Five instances of a shape is a pattern worth watching and
not yet evidence of an abstraction — the differences (what is keyed, what a
decision means, whether it can be revoked) are currently doing real work.

**The tripwire:** when a sixth arrives, or when a change has to be made to all
five at once, that is the moment to ask whether a camp-acquired-knowledge
abstraction has actually emerged. Until then, keeping them separate is the
cheaper mistake.

## Closed 2026-09-15 — by the second trigger, not the first

The tripwire was: *a sixth mechanism arrives, OR a change has to be made to all
five at once.* Neither happened on the count — there are still exactly five, and
checking that took one query.

What fired was the second condition in its more useful form: **the owner asked
for a capability that requires the shared abstraction.** "The software should
learn from decisions and imports and inputs" is not satisfiable by five
independent caches of confirmed answers, because none of them records the
question, and four tables of yes-answers is not a signal.

So the abstraction arrived — as `import_decisions`, the decision journal
(T173 slice 1) — and it did NOT fold the five in. They keep working unchanged;
the journal records that they fired and whether the director overrode. Whether
they should eventually be folded in is now a decision to make **on journal
evidence**, which is the discipline this ticket was asking for in the first
place.

Design: `docs/superpowers/specs/2026-09-15-seedlings-importer-learning-design.md`.

## Recommendation (2026-09-14, superseded by the above)

**Do nothing.** Five similar things is a pattern to watch, not proof of a shared
idea, and the differences (what is keyed, what a decision means, whether it can
be revoked) are currently doing real work. The tripwire is the whole deliverable:
it makes the decision happen on evidence rather than on whoever notices first.
Confidence high. See `docs/work/architecture-reports/2026-09-14-open-decisions-brief.md`.
