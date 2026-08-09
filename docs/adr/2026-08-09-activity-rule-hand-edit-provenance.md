---
title: "Activity-rule hand-edit provenance (_humanFields)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-09
supersedes: []
implementation_state: implemented
affects: [docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md, docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md, src/screens/ImportScreen.jsx, src/localClient.mock.js]
related_tickets: []
related_adrs: [docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
---

# Activity-rule hand-edit provenance (`_humanFields`)

**Status:** accepted

## Context

Policy A (`docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md`) protects a
director's hand-edits from a later re-import by refusing to overwrite any field whose latest op
is `source:'human'`/`NULL`, converting a differing re-import proposal into a held `stale`
conflict. The protection only fires when the field was actually *stamped* human.

The reviewable-units work (`docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md`,
Decision 2) landed the **generic** `_humanFields` provenance side-channel on `main`
(commit `293e22c`): `buildPlan` reads `source.humanEditedFields?.[entity]?.[name]`, normalizes
it to stored-column names via `dbFieldFor`, and attaches it as `item._humanFields`;
`commitCreate`/`commitUpdate` stamp those fields `source:'human'` instead of `'import'`. That
work wired the mechanism for the **unit column** (`groups.tier_id`) only.

Its scope note flagged the identical live bug for activity rules: `ImportScreen`'s import-review
UI lets a director hand-edit an activity's rule (`min_per_week`, `max_per_week`, `priority`,
eligible groups) via `updateActivityRule`, and those writes still went through the unconditional
`'import'` stamp — so a hand-tuned activity rule could be **silently overwritten** by a later
re-import. It was deferred to "its own small ticket." This ADR is that ticket.

## Decision

Reuse the already-landed generic mechanism; add only the activity-rule wiring in
`ImportScreen`. No committer or `buildPlan` changes are needed — the plumbing exists.

1. **Track which rule fields the director touched.** `updateActivityRule` accumulates the
   patched fields into a per-rule `_editedFields` set (mapped to SOURCE field names via
   `RULE_FIELD_TO_SOURCE`; `eligible_group_names → eligible_groups`). **Field-level, not
   rule-level:** editing `min_per_week` marks only `min_per_week`, leaving an untouched
   `max_per_week` file-inferred and freely re-importable.

2. **Emit them.** `buildCommitInputs` adds an `activities` key to the SAME `humanEditedFields`
   object the unit column already populates:
   `humanEditedFields: { groups: …, activities: { [name]: [sourceFields] } }`. Only touched
   fields go in; a file-inferred rule field is absent, so its op stays `source:'import'`.

From there the landed mechanism does the rest, on both the create and update paths, including
stamping `'human'` from the **first** write (load-bearing: a later re-import's Policy A gate
needs a prior human op to protect).

## Consequences

- A hand-edited activity rule now holds as `stale` on a differing re-import instead of being
  silently overwritten — verified test-first
  (`electron/ops/ingest.activityRuleProvenance.test.js`, plus the UI wiring in
  `src/screens/ImportScreen.test.jsx`).
- A purely file-inferred rule is unaffected: no `humanEditedFields.activities` entry →
  `source:'import'` → a later re-import updates it freely. No friction added to untouched rules.
- The dev mock (`src/localClient.mock.js`) is brought to parity here: the landed Decision 2 work
  wired the real committer but left the mock stamping every field `'import'`, so neither the unit
  nor the activity-rule protection worked at `:5200`. This ADR adds the `_humanFields` stamp to
  the mock's `commitCreate`/`commitUpdate`, fixing both at once (the "shared so they cannot
  drift" discipline the S2c/T74 ADRs rely on).
