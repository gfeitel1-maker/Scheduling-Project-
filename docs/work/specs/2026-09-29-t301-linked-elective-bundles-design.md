---
title: "Linked multi-period elective bundles — design"
document_type: spec
authority: proposed
status: draft
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
depends_on:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
related_tickets: [docs/work/tickets/T301-linked-elective-choices-never-reach-the-solver.md, docs/work/tickets/T219-multi-day-catalog-linkage.md]
archive_when: "a director can author a named multi-period bundle on an elective set's offerings table, a camper who ranks it is placed in every one of its periods or none, and the run is driven from the real screen"
---

# T301 — Linked multi-period elective bundles

**Owner decision 2026-09-29: yes, linked choices are wanted.** This supersedes the open question
T301 was written around. The ticket's own instruction — Designer before Architect before Maker —
stands, and this document is the design input to the ADR, not a substitute for it.

## Success predicate (observable)

A director, on an elective set's offerings table, can mark that an activity is taken **as a bundle**
across a chosen subset of that set's periods, name the bundle, and create more than one bundle for
the same activity. After a solve driven from the real screen, a camper who ranked a bundle appears
in **every** one of its periods or in **none**, and any finding about it names the bundle by its
name.

Verified by: a test entering at the screen and asserting `elective_assignments` rows, plus a UI
capture of the authoring control and of a solved run containing a bundle.

## Non-goals

- **Not** a change to tier 1's placement algorithm (T247 — tested, sound, and left alone).
- **Not** spanning elective containers. D12 verified electives are excluded from the slot-span chain
  at four layers and chose the choice/member model deliberately; that decision is not reopened.
- **Not** a camper-side expression of linkage. D14 established from real catalog artifacts that the
  **camp** declares linkage on the offering.
- **Not** a change to capacity or minimum semantics. A bundle's capacity is already the tightest
  seat count across its members (tier 1 takes `Math.min` over member `seatsLeft`).

## Owner decisions taken during design, 2026-09-29

| # | Question | Decision |
|---|---|---|
| 1 | What is the real-world unit of a bundle? | **Per offering, director picks the periods.** Not whole-set, not adjacency-derived. |
| 2 | How do divisions scope it? | **Fully general** — "for afternoons only, for all divisions, for a few divisions, for one day but not another." |
| 3 | Two separate bundles of one activity in a set? | **Yes** — a camper picks between them. |
| 4 | Who names a bundle? | **Proposed, director edits.** The name is what a camper's sheet must match, so it is visible and editable. |
| 5 | Must a bundle's periods be contiguous? | **No — arbitrary.** Any subset of the set's periods, adjacent or not. |

Decision 1 makes **T219 (multi-day catalog linkage) the same feature, not a separate one.**
`deriveOccurrences` builds an occurrence per distinct `(day, time_block, tier)` cell, so Mon P3 +
Mon P4 and Tue P2 + Thu P2 are structurally identical — "these N occurrences, taken together."
T219 should be closed by this work or explicitly re-scoped.

Decision 5 settles what decision 1 only implied, and it forecloses three things:

- **No adjacency rule, anywhere.** A bundle may be Mon P1 + Thu P4. Nothing validates contiguity,
  nothing derives membership from it, and no error says "these periods are not adjacent."
- **The control is a selection, not a length.** A director picks cells; they never type "spans 2
  blocks." This is the second, independent reason not to reuse the slot-span chain — D12 rejected it
  on the grounds that a choice groups *preferences* rather than *grid cells*, and arbitrary
  membership means the chain could not express a bundle even if that objection were dropped.
  `activities.span_blocks` is not involved in this feature at any layer.
- **A one-member bundle is legal and is simply not linked.** It is a named alias for a single
  offering, which is D12's own "a single-period choice is the degenerate one-member case, so there is
  ONE code path". The engine already agrees: it defines linked as *more than one member occurrence*,
  so a one-member bundle falls through to tier 2 with no special casing and no finding.

## What already exists, verified against the tree 2026-09-29

- `elective_choices` (label, `is_linked`) and `elective_choice_offerings` (member occurrences +
  activities) are v66 and are exactly this shape.
- Tier 1 of `src/engine/buildElectiveAssignments.js` is complete, deterministic, and tested. It
  places a choice atomically across its members and emits `UNSUPPORTED_LINKED_CHOICE` on malformed
  linkage.
- `elective_choices.label` is already the **camper-facing** name and is independent of
  `activities.name` — `commitElectiveRun` writes whatever the sheet said.

## What does not exist

- No authoring surface anywhere.
- `commitElectiveRun` writes every choice with `is_linked: 0` **hardcoded**. The engine documents
  this and routes around it, deriving "linked" from *more than one member occurrence* instead.
- The only writer of `elective_choice_offerings` is the projection's parent stub, carrying no
  occurrence and no activity — so the derived definition is unreachable too.
- `AssignmentPanel` passes neither `choices` nor `choiceOfferings` to the solver.

## Design

### A bundle is authored in setup and re-derived per run

This mirrors what the elective layer already does: `elective_occurrences` and `elective_choices` are
run-scoped and rebuilt from live `template_slots` on every generation (D6), while
`elective_set_activities` persists across runs. An authored bundle must outlive a run, so it needs
setup-level storage; the run-scoped choices are derived at solve time, beside `deriveOccurrences`.

**Why not reuse `elective_set_activities`:** it carries `UNIQUE(elective_set_id, activity_id)`, so
two bundles of one activity cannot be two rows there. Decision 3 makes that fatal. Relaxing an
inline `UNIQUE` in this codebase is a migration plus a two-direction sweep and is the wrong price
for this.

**Members are `(day_id, time_block_id)`, not `occurrence_id`** — an occurrence is run-scoped and
re-derived every generation, so storing one would tie an authored bundle to a run that no longer
exists. Division falls out at expansion time.

### Decision 3 needs no key change, because of decision 4

Two bundles of woodworking are two differently-**named** choices, "Woodworking — Mondays" and
"Woodworking — Thursdays". Owner ruling R2 (choice keyed on `(run, normalized label)`, so editing a
bundle's periods keeps campers' preferences attached) stays intact, and the importer keeps matching
a camper's ranked label exactly as it does today. The bundle's name **is** the discriminator, which
is also how a real camp catalog reads.

### THE OPEN ARCHITECTURAL DECISION — for the ADR

**Per-division expansion collides with the label-keyed choice id, and this is the one thing this
design does not settle.**

Tier 1 excludes a camper who does not attend **every** member occurrence:

```
const absent = wanted.filter((c) => !occs.every((o) => attends(c, o)))
```

That rule is correct and must not be weakened. Within one division's bundle it is exactly the
guarantee that makes all-or-nothing mean anything — relaxing it to "place into every member they
attend" would silently half-place a camper whose group simply is not scheduled on Monday P4, which
is indistinguishable from the wrong-division case at the `attends()` seam.

So a bundle serving several divisions **must expand into one choice per division**, never one choice
with cross-division members — otherwise every camper is excluded and the bundle never places.

But `deriveElectiveChoiceId(runId, labelKey)` keys on label alone, so two divisions' choices for one
bundle **collide on one id**.

Options for Architect, with the tradeoff each carries:

- **(A) A tier arm on the choice id.** `deriveElectiveChoiceId(runId, labelKey, tierId)` at a new
  per-kind version (`echo2:`), following the precedent T279 set with `epref2:` — a per-kind bump
  without touching the module-wide `V`, which is shared by eight id kinds. Reaches
  `commitElectiveRun`'s `choiceIdByKey`, which maps label → choice id and would need the camper's
  tier. **Preferred on current evidence**, because it leaves the engine and R2 untouched and the
  precedent for the id change is documented.
- **(B) Keep one choice, partition members inside the engine by the camper's tier.** No id change
  and no importer change, but it changes tested tier-1 semantics and loses the b1 guarantee above.
  Rejected unless (A) proves worse in the ADR.
- **(C) Scope a bundle to one division at authoring time.** The director creates a bundle per
  division. No id change, no engine change — but it contradicts decision 2 ("for all divisions")
  by making the director do the expansion by hand.

The ADR must also state what happens when a run carries **both** sheet-derived choices (from the
import path, `is_linked: 0`) and bundle-derived choices for the same label.

## Slices

1. **Schema + derivation.** New setup-level bundle storage, a `deriveChoices` module beside
   `deriveOccurrences`, and the id decision above. Needs an ADR and a rollback plan
   (`GOVERNANCE_INDEX` database/sync row: ADR + migration/rollback plan, human gate).
2. **Authoring control.** The bundle control on the offerings table, beside capacity and minimum,
   with the proposed-and-editable name. Designer first.
3. **Wiring.** `AssignmentPanel` passes `choices` + `choiceOfferings` to the solver, and the
   `choices` prop T300 added to `AssignmentPreview` gets its real source.

Slice 1 is the only one with a migration in it and should land alone.

## Open questions carried to the ADR

- The id/importer decision above (A/B/C).
- What a director sees when a bundle cannot be honoured. `UNSUPPORTED_LINKED_CHOICE` exists and T300
  fixed its rendering, but it has never been seen by a human on a real screen.
