---
title: "An elective finding names an activity the way the director spells it"
document_type: ticket
status: completed
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T265-minimum-headcount-to-run.md]
archive_when: "every finding rendered on the elective assignment preview names an activity by the name the camp gave it, not by the internal normalized label key; a name containing a space and an ampersand renders intact; and a test drives the real finding producers and asserts the RENDERED output"
---

# T300 — An elective finding names an activity the way the director spells it

## The defect, confirmed on main (883bd107)

A real UI capture of the assignment preview
(`/private/tmp/claude-501/visual/t265/03-declined-offering-and-shortfall.png`, produced by T265's own
evidence run) renders:

> “archery” had 4 of the 6 campers it needs to run, so it did not run. Those campers were moved to
> their next choice.

The camp's activity is **Archery**. `archery` is an internal key.

`electiveChoiceLabelKey` (`electron/ops/electiveDerivedIds.js`) is `whitespaceInsensitiveName`: it
lowercases and DELETES whitespace. It exists so two devices agree that `Archery` and `archery` are
one elective — it is an identity key, and it is not display text. Every producer of an elective
finding holds only that key, so every one of them interpolated it into a sentence a director reads.

**A name with a space is worse than the lowercase**, and that is the case this ticket is measured on:
`Arts & Crafts` reaches the screen as `arts&crafts`.

## Findings that were affected

All four render through one list, `src/screens/elective/assignment/AssignmentPreview.jsx`:

| Finding | Producer | Carried |
|---|---|---|
| `BELOW_MINIMUM` | `src/engine/buildElectiveAssignments.js` (T265) | `activity_id`, `labelKey` |
| `KEPT_BELOW_MINIMUM` | `src/engine/buildElectiveAssignments.js` (T265) | `activity_id`, `labelKey` |
| `UNSUPPORTED_LINKED_CHOICE` | `src/engine/buildElectiveAssignments.js` (T247) | `choice_ids` |
| `UNRANKED_OFFERING` | `findMismatches`, `src/screens/elective/assignment/buildOfferings.js` | `labelKey` |

The bug report named the first three. The fourth is the same defect in the same rendered sentence
list and was found while scoping this one; fixing three of four would have left the class alive
(`feedback_guard_the_choke_point_not_the_instance`).

`findMismatches`' *other* finding, `UNMATCHED_PREFERENCE_LABEL`, was already correct — it prefers a
real `label` and falls back to the key only when it has nothing else. That was the precedent this
fix generalises.

## Why the fix is at the render, not in the producers

`buildElectiveAssignments` is a pure function with no access to display names, and `findMismatches`
is the same shape one layer out. Teaching each of them about display names would spread a display
concern across two pure modules and still leave the next producer to rediscover the bug.

Every one of these findings already carries the identifiers a name can be looked up FROM, and they
all converge on one rendered list. That list is the choke point. `src/screens/elective/assignment/findingDisplayMessage.js`
resolves the name there; the producers are byte-unchanged.

### The coupling this creates, stated plainly

A producer hands the renderer a finished sentence with the key already inside it, so the renderer has
to find the key in that sentence in order to replace it. It anchors on the QUOTES the producers wrap
labels in (curly in the engine, straight in `findMismatches`). A bare replace would rewrite prose: an
elective called `Run` would turn "campers it needs to run" into "campers it needs to Run".

**If a producer ever stops quoting its labels, the substitution silently stops happening.** That is
why the tests call the real producers rather than hand-writing findings — a wording or quoting change
in the engine turns the render tests red instead of quietly restoring the bug.

## Also in this slice, by owner ruling 2026-09-29

The same summary line read **"1 campers placed · 1 occurrences · 1 findings"**. Flagged in the bug
report as a separate pre-existing plural bug with the scope call left to the owner; the owner chose
all three counts. The per-occurrence header one component down already did this correctly.

## Known gap, not closed here

`UNSUPPORTED_LINKED_CHOICE` is **unreachable from this screen today**. `AssignmentPanel.jsx` does not
pass `choices` or `choiceOfferings` to `buildElectiveAssignments`, so the engine's `choiceById` is
empty, the linked-choice tier never runs, and the finding cannot fire. The renderer accepts an
optional `choices` prop and resolves the label from it, so whoever wires the solver's linked-choice
inputs does not have to rediscover this bug; nothing in `src/` passes that prop yet, and inventing a
source for it would have been a fake wiring, not a fix.

## Non-goals

- Not a change to `electiveChoiceLabelKey` or to any derived id. The key is correct at its job;
  it was only being used for the wrong one.
- Not a change to any producer's message text, wording, or finding shape.
- Not a sweep of label rendering outside the elective assignment preview.

## Evidence

- `src/screens/elective/assignment/AssignmentPreview.test.jsx` — nine render tests driving the real
  producers. Five cover the four affected findings and the quote anchoring; four are guards against
  over-correction (an unresolvable finding passes through verbatim, `UNMATCHED_PREFERENCE_LABEL`
  keeps the SHEET's spelling, counts that are not one keep their plural).
- **Non-vacuity, and the first attempt was wrong.** Planting the defect — making the quotes optional
  in `findingDisplayMessage.js` — left the `UNMATCHED_PREFERENCE_LABEL` guard GREEN, because in that
  message the key never appears at all, so it could never have been the test that earns the
  anchoring. The test that does was written after the plant said so: an elective named `Run` has the
  key `run`, and `run` is also an ordinary word in the engine's own sentence, so a substitution that
  did not require the quotes renders "campers it needs to Run, so it did not Run". That test goes red
  under the plant and green on revert.
- `/private/tmp/claude-501/visual/t300/02-finding-names-the-activity.png` — the real UI, same demo
  camp and same solve as the T265 capture above, with the declined offering named `Arts & Crafts`.
  The capture script asserts the rendered text rather than only photographing it.
