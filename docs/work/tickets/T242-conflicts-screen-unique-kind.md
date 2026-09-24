---
title: "ConflictsScreen renders the unique conflict kind as an informational card"
document_type: ticket
status: completed
created: 2026-09-23
archive_when: a unique:-kind conflict renders as a buttonless informational card naming the colliding value, both records, and the screen that owns the fix, with the scalar card behaviourally unchanged
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T235-hard-set-unique-conflicts-derivation.md]
---

# T242 — ConflictsScreen `kind: 'unique'` branch

## Why

`ChoiceBox` is built around "one value per side, Keep this version writes that value." A structural
collision is two whole records and there is nothing for a Keep button to write — resolution is rename
or delete on the screen that owns the entity. The director still needs the loud signal.

## Success predicate (observable)

1. `ConflictCard` branches on `conflict.kind`. `kind: 'scalar'` is behaviourally **identical** to
   today, including every existing `ConflictsScreen.test.jsx` assertion.
2. `kind: 'unique'` renders a single informational card: no `ChoiceBox`, no buttons. It names the
   colliding value, both records, and where to fix it in plain language ("Two staff members are both
   named X — rename or delete one on the Staff screen").
3. Plain-language mapping extends the existing `FIELD_LABELS` philosophy; it does not introduce a
   second vocabulary.
4. No new screen, no new sidebar surface beyond the badge count it already contributes to, no new IPC,
   no banner.
5. The card disappears on its own when the collision stops being derived — no dismiss control.

## Non-goals

A resolution button. Deep-linking to the owning screen (the card names it in prose; a link is a
separate decision). New chrome of any kind.
