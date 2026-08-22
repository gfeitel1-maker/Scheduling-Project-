---
title: T114-infer-outdoor-coschedule-alt-activity-rules
document_type: ticket
status: open
created: 2026-08-22
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-10-ingestion-evidence-persistence.md, docs/adr/2026-08-22-roots-as-hub-setup-ia.md]
archive_when: ingest infers (with import_evidence) at least one of is_outdoor / co-schedule / weather-alternative for activity rules, and ActivitiesScreen surfaces its provenance the same way Slice D does the other three
---

# T114 — Build inference for the Outdoor / Co-schedule / Alt activity rule columns

**Surfaced by the Slice D architecture investigation (2026-08-22), owner-directed split.**

## Why this exists

Roots-as-hub **Slice D** surfaces inferred-rule provenance on the Activities
screen for the three rule fields that already carry `import_evidence`:
`min_per_week`/`max_per_week`, `eligible_group_names`, and `location`. The
owner ruled: **ship those three now, ticket the rest** (do not fake provenance).

The other three Activities rule columns render "—" for a different reason than
a display gap: **nothing ever infers them.** `src/ingest/activityRules.js`'s
returned rule object never contains:

- `is_outdoor` (the **Outdoor** column),
- `max_groups_per_slot` / `same_tier_only` (the **Co-schedule** column),
- `weather_alternative_id` (the **Alt** column).

So there is no `import_evidence` row and no value to show. This is a
missing-inference problem, not a UI problem — no ActivitiesScreen work makes
these legible until ingest actually infers them.

## Scope

- Add inference for one or more of Outdoor / Co-schedule / Alt in the ingest
  path (`src/ingest/activityRules.js` + wherever the rule object is consumed),
  writing `import_evidence` with an honest `tag`/`confidence`/`support` per
  `docs/adr/2026-08-10-ingestion-evidence-persistence.md` (B4), the same way
  `min_per_week`/`location` already do.
- Once evidence exists, extend Slice D's ActivitiesScreen provenance surfacing
  to cover the newly-inferred column(s) — reuse, don't fork, the Slice D
  affordance.
- Only infer what the source data can honestly support. If a signal isn't in
  the file, leave the column blank rather than guess — the whole point of the
  owner's ruling was **no fabricated provenance**.

## Also absorbs: elective Slice 3b (catalog offering-recognition + rule-parsing)

Per the 2026-08-22 electives Slice 3 architecture pass (owner folded 3b into T114):
this ticket also owns **catalog offering-recognition + narrow rule-parsing** for
electives — activity-name matching (`recognitionKey`/`normalizeName`) plus
verbatim-quotable phrase parsing ("DOUBLE PERIOD"→multi-block span; "sign up for
both"→linked offerings), writing per-field `import_evidence` (needs a new
`entity_type` value, e.g. `'elective_set_activities'`). **Freeform eligibility prose**
("Available for ARAD CAMPERS Th 3rd/4th…") is explicitly OUT — not honestly parseable
into structured rules; stays a manual field on the Electives screen. Same
prose→confidence-banded-rule problem as the Outdoor/Co-schedule/Alt work, which is why
it lives here. Elective Slice 3a (detect + nudge + create-empty-set) ships separately.

## Related / sequencing note

Coordinate with the **fixed-activity mislabel ingest bug** (separate flagged
issue): `anchor_activities` shares the `EVIDENCE_ENTITY_TYPES` commit path, and
a mislabel would key `import_evidence` rows against the wrong
`entity_type`/`entity_id`. Whoever fixes the mislabel should verify whether
`import_evidence` needs a backfill/re-key afterward.
