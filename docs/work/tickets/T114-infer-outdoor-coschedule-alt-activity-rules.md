---
title: T114-infer-outdoor-coschedule-alt-activity-rules
document_type: ticket
status: open
created: 2026-08-22
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-10-ingestion-evidence-persistence.md, docs/adr/2026-08-22-roots-as-hub-setup-ia.md]
archive_when: ingest infers co-schedule rules WITH import_evidence rows, and ActivitiesScreen surfaces their provenance the same way Slice D does the other three (is_outdoor and weather_alternative_id are downscoped as not inferable from a schedule - see Scope below)
---

# T114 — Infer age divisions and per-activity co-scheduling from an import

## SHIPPED 2026-09-13 — and the shape changed substantially under owner review

What this ticket asked for was inference for three activity rule columns. What
it became, through six owner corrections, is a bigger and more useful thing:
**the import now proposes a camp's age divisions.**

### What ships

| inferred | from |
|---|---|
| **Age divisions + membership** | group NAMES. `Tzofim 1/2/3` -> one "Tzofim". `Kittah Aleph/Bet` -> one "Kittah" (the varying token may be a number, a letter, or a WORD acting as an ordinal). `CIT` alone -> its own division. EVERY group lands in one. |
| **Division corrections** | the grid. A name-derived division whose groups never share a slot SPLITS. Splits but never merges — an all-camp lunch would otherwise fold the whole camp into one division. |
| **Per-activity co-scheduling** | observed co-occurrence. `can_co_schedule`, `max_groups_per_slot`, and WHICH groups. |
| **`same_tier_only`** | the above two together. |
| **Probable all-camp overrides** | near-universal attendance + low frequency, raised as a question in reconciliation. |

Divisions ingest as `tiers`, so they flow through the ordinary
propose-then-confirm path — the Age Divisions screen fills in from the import
instead of reading "needed", and nothing is ever written without the director
seeing it.

### Six owner corrections, each of which changed the design

1. **`is_outdoor` is not inferable at all.** A property of the PLACE, not the
   placement. Dropped from scope; spun off as T147.
2. **"`same_tier_only` is not inferable" was WRONG** — that was a statement
   about a current gap in ingestion, not about the domain.
3. **Requiring repetition before admitting a division was wrong.** *"What camp
   is not separating out their kids into divisions?"* Every group is in one.
4. **`Kittah Aleph`/`Bet` are one division**, not two unrelated names — and the
   grid, not the names, is the tiebreaker when they disagree.
5. **The co-schedule rule belongs to the ACTIVITY, not a group.** An all-camp
   lunch gets its own (large) rule. Anchors are excluded only from the DIVISION
   inference, where their co-occurrence would wrongly imply shared membership.
6. **A near-all, once-a-week activity is a director OVERRIDE**, not a
   restriction. *"The original schedule probably said all camp."* Recognised
   and asked, never silently written — because writing the naive reading turns
   a one-week accommodation into a permanent rule the engine honours forever.

### Closed since (2026-09-13, same day)

- **Co-schedule now reaches the database, with its evidence.** A defect found
  while wiring this: `coScheduleRef.current` in `ImportScreen.jsx` was assigned
  at parse time and read by NOTHING, so every activity's observed capacity was
  computed and then discarded. It now travels as `rule.co_schedule` and lands on
  `activities.max_groups_per_slot` / `same_tier_only`.

  Two paths were needed, not one. A CREATE item carries `fields: {}` — buildPlan
  builds every create field from the `_rule` side-channel — while an UPDATE item
  carries real `fields` and is diffed upstream. So the create half lives in
  `commitCreate` (`electron/ops/ingest.js`) and the update half in
  `foldApprovedToRecords` (`src/ingest/fieldUpdate.js`). Wiring either alone is
  silently half-broken: fold-only writes nothing on a first import, side-channel
  only never refreshes on a re-import. Also note `buildPlan`'s `_rule`
  reconstruction is a FIXED field list — anything not named there is dropped in
  transit, which is what swallowed the first attempt.

- **`import_evidence` rows are written for both fields.**
  `max_groups_per_slot` is tagged `observed`/`high` (a count of groups in one
  slot is seen, not deduced); `same_tier_only` is tagged `inferred`/`low`,
  because it rests on a group -> division map that is itself inferred from group
  NAMES. Support carries the busiest slot, the groups in it by name, and how
  many slots were examined. `co_schedule_groups` lives in the evidence rather
  than a column — it is the observation behind the constraint, not a constraint
  the engine reads — which also keeps this free of a schema migration.

- **The Activities screen surfaces it.** `RULE_FIELDS`
  (`src/utils/ruleProvenance.js`) gains a fourth row, so the Co-schedule column
  gets the same clickable provenance dot and confirm gesture as the other three.

### Still open

- **Divisions carry no evidence.** Co-schedule rules now record why they
  concluded what they did; divisions still do not, so a director cannot audit a
  split. The asymmetry is known and deliberate-for-now, not overlooked.
- `weather_alternative_id` (the Alt column) remains uninferred, and is now
  formally downscoped — see the Scope section below. Not a gap to close; a
  thing a schedule cannot carry.

## Original ticket follows

# T114 — Build inference for the Co-schedule / Alt activity rule columns

## DOWNSCOPED 2026-09-13 (owner): outdoor inference is REMOVED from this ticket

The owner's reasoning, and it is correct: **outdoor-vs-indoor cannot be inferred
from a schedule at all.** A schedule cell says `Archery / Barn`. Nothing in that
tells you whether the Barn is outdoors — outdoor-ness is a property of the
PLACE, not of the placement, so the only source that could carry it is a
locations list. Attempting to infer it from a schedule would be manufacturing a
fact, which is exactly what this repo's provenance rules exist to prevent.

Co-schedule (`max_groups_per_slot` / `same_tier_only`) IS inferable from a
schedule, because it is a statement about how placements co-occur, which is
precisely what a grid records. That one remains in scope.

Weather-alternative (`weather_alternative_id`) is NOT, and an earlier revision
of this ticket was wrong to group it with co-schedule (owner, 2026-09-13: "we
know that weather cannot be inferred"). An alternative is the activity you
substitute WHEN IT RAINS, and a schedule records no weather. Seeing Swim
replaced by Arts one Tuesday is equally consistent with rain, a broken filter,
or a staff absence — the grid cannot distinguish them, so any correlation drawn
from it would be manufactured, the same error as inferring outdoor-ness above.
Downscoped alongside `is_outdoor`; it needs a source that actually carries the
fact (a director saying so).

Spun off: inferring LOCATIONS from a schedule — see
`docs/work/tickets/T147-infer-locations-from-a-schedule.md`. That one needs a
conversation before any design.


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
