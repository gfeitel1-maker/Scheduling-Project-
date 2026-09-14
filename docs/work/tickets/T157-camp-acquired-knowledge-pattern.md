---
title: "Watch: five mechanisms now remember what the director taught the app"
document_type: ticket
status: open
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
