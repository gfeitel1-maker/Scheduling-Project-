---
title: W1 — Camp-Setup Vocabulary Unification (design)
document_type: spec
status: approved
authority: subordinate-to-constitution
owner: Governor (session camp-setup-ingestion-0ce0e1)
approved_by: product owner (2026-08-21)
created: 2026-08-21
parent: docs/work/specs/camp-setup-ingestion-program.md
review_trigger: any change to a canonical display word, or introduction of the per-camp relabel layer (follow-up W1b)
---

# W1 — Camp-Setup Vocabulary Unification

Workstream W1 of the camp-setup + ingestion program. Establishes **one canonical
display word per concept** across setup, roots/reconciliation, and ingest, and
deletes every competing word. Ratified by the product owner 2026-08-21.

## Problem

Three DB entities each wear 2–3 director-facing words, and one word ("Unit")
denotes two different entities depending on the screen. Evidence from a code
sweep (2026-08-21):

- `tiers` (age-division level) is shown as **"Unit"** on setup screens but
  **"Age Division"** in roots/intro.
- `cohorts` (session/program grouping) is shown as **"Program"** in setup but
  **"Units"** in the reconciliation root-map — so clicking "Units" in the
  root-map opens the Programs screen, the inverse of the rest of the app.
- `locations` wears **"Place"**, **"Location"**, and **"Resources"**.
- `groups` is mostly "Group" but one nav label reads "Groups & Units".
- "division" is overloaded: a cohort intro calls a cohort "a session or division
  of camp" while tiers are "Age divisions".

There is no `units`, `programs`, or `resources` table — all three are
display-layer aliases over `cohorts`/`tiers`/`locations`. The "Units" setup
screen is physically `TiersScreen.jsx`.

## Decision

Internal DB/code names never change and are never shown (`tiers`, `cohorts`,
`locations`, `groups`). Each concept gets exactly one canonical display word:

| Concept (DB entity) | Canonical display word | Words retired |
|---|---|---|
| `tiers` | **Age Division** | "Unit" (all setup screens) |
| `cohorts` | **Program** | "Units" (root-map inversion) |
| `locations` | **Location** | "Place", "Resources" |
| `groups` | **Group** | "Groups & Units" nav label |

Pre-production posture (no live camps): this is a **clean hard rename**, no
back-compat aliases for the retired display words. Per-camp relabeling (each camp
renames its displayed words over the canonical concept, extending the existing
`source_aliases`/`confirmAlias` infra) is a **separate follow-up workstream
(W1b)**, explicitly out of scope here.

## Non-goals

- No schema change, no new table, no migration. (tiers/cohorts/locations/groups
  tables and columns are untouched.)
- No per-camp relabel layer (that is W1b).
- No change to ingest's acceptance of "unit" as an **input** synonym — source
  spreadsheets say "unit"; ingest still reads it and resolves to the Age Division
  concept. Only user-facing labels/failure reasons change.
- No change to the DB word "tier"/"cohort" anywhere in code.

## Change map (fix sites)

**`tiers` "Unit" → "Age Division":**
- `src/screens/TiersScreen.jsx` — header "{n} units", "No units yet", "Add your
  first unit", the delete-gate copy at :246, and empty-state at :367-368,389,405-406.
- `src/.../recordLabels.js:9,36` (`tiers:'Unit'`, `tier_id:'Unit'`).
- `src/.../readiness.js:40` step label 'Units' / "Add your ...".
- `src/screens/GroupsScreen.jsx:52` "— No unit —".
- Already-canonical "Age Division" sites remain the anchor (no change):
  `screenIntroText.js:15`, `domainRollup.js:61,70`, `rootMapNav.js:22,48`,
  `rootMapModel.js:113,127`, `readiness.js:44`.

**Kill the inversion — `cohorts` root-map "Units" → "Program":**
- `domainRollup.js:60` (`CHILD_OF.cohorts:'Units'`).
- `rootMapNav.js:20` (`CHILD_SCREEN.Units:'cohorts'`).
- `rootMapNav.js:47` (`SCREEN_LABEL.cohorts:'Units'`).
- CohortsScreen already says "Program" — no change.

**`locations` → "Location":** (retirement of "Place" is repo-wide, not just the
label map — the M3 locations spec, `docs/work/specs/2026-08-15-m3-locations-design.md`,
chose "Place" informally and is superseded by this spec on that point; "Place" is
not in any standard or ADR, so completing the retirement is not an Article-I gate.)
- `domainRollup.js:31` Facility domain caption "Resources" → **"Facility"** (its
  own domain name, matching Structure/Time/…). NOTE: an intermediate "Location(s)"
  caption was rejected in review — it duplicated the "Locations" entity node
  directly beneath it (Tester MEDIUM). The location word lives on the entity, not
  the domain.
- `reconstructionMomentCopy.js:14` "Facility & Resources".
- `screenIntroText.js:20` "Places at your camp…".
- `recordLabels.js:19` "Place" → "Location"; and `:139` restore copy "set their place again".
- `src/screens/LocationsScreen.jsx` — ~15 director-facing sites: "Add Place",
  "Add your first place", "{n} place/places" counts, "Merge into one place",
  delete-dialog "Delete all places?"/"Delete All Places"/entityLabel, admin/error
  copy, map-empty "Places still work everywhere else", merge/rollback copy.
- `src/screens/ActivitiesScreen.jsx` — location-picker copy: 'Create "{q}" as a new
  place', "Type a place, or add a new one…", "New place — … on the Places screen.",
  dangling "The place set here no longer exists", import badge "+ new place".
- `src/utils/computeOverlaps.js:88` fallback 'this place'; `computeWeekClosures.js:89`
  "'This place' is marked closed this week".
- `rootMapNav.js:44` already "Locations" — no change.
- Tests asserting these strings (LocationsScreen.map.test.jsx "No places yet",
  ActivitiesScreen.test.jsx "+ new place", etc.) updated to canonical.
- FALSE POSITIVES to leave: `DaysScreen` "places" = day-slots not locations;
  code identifiers (`placeActivity`, `placement`, `placeholder`, "in place").

**`groups` nav label:**
- `rootMapNav.js:42` "Groups & Units" → "Groups".

**De-overload "division":**
- `screenIntroText.js:14` reword the cohort intro so "division" is not used for a
  cohort (Age Division now owns that word).

**"Program with no field" copy (relationship, not a new entity):**
- `TiersScreen.jsx:246,367-368` reword the borrowed gate messages to canonical:
  e.g. "Add a Program before adding Age Divisions."

**Additional in-scope sites found during implementation** (same word, same
concept — enumerated here so the doc matches the shipped diff):
- `CohortsScreen.jsx` — "A program groups units…" → "…age divisions".
- `ImportScreen.jsx` — several "unit" → "age division" sites incl. the replace-warning copy and its LABEL map.
- `TiersScreen.jsx` `downloadTemplate()` — sheet name "Units" → "Age Divisions",
  filename `units_template.xlsx` → `age_divisions_template.xlsx`.
- `exportWorkbook.js` — tiers sheet name "Units" → "Age Divisions".
- `navSections.js` / `TopBar.jsx` — sidebar labels.
- `rootMapLayout.js` — hand-placed layout key `Units` → `Program` (else the
  root-map node falls back to an auto-arc position — caught in review).
- `DeleteRecordDialog.jsx` — `LABEL.locations` entity word (the schedule-cell
  `places(n)` helper is a false positive and was left).

**Ingest (labels/reasons only, not parsing):**
- `src/ingest/fieldUpdate.js:20` keep `unit → tier_id` as accepted input synonym.
- `fieldLabels.js:18` ("which unit it belongs to") → Age Division wording.
- `buildPlan.js:96` snapshot `unit_name` exposure — surface as Age Division in
  any user-facing copy; internal key names may stay.
- Failure reason `'unit_unresolved'` — internal code string may stay; any
  user-facing rendering of it reads "Age Division".

Note: the fix sites above are the ones the sweep found. The Maker verifies
completeness with a repo-wide search for each retired display word (case-insensitive,
whole-word) — `\bUnit(s)?\b`, `\bResource(s)?\b`, `\bPlace\b` (as a location label),
and the `cohorts:'Units'` mappings — and reports any site not listed here rather
than silently leaving or changing it.

## Success predicate (observable)

- Every director-facing surface uses exactly the canonical word for each concept;
  none of the retired words appears as a display label anywhere in setup, roots,
  or ingest output. Verified by a repo-wide search returning zero display-label
  hits for retired words, plus tests asserting the canonical labels.
- Clicking the roots root-map node that lists age-divisions opens the
  age-division (tiers) screen, and the node that lists programs opens the program
  (cohorts) screen — the inversion is gone.
- No schema/migration diff. `npm run verify` is green.

## Test plan (test-first at the label seam)

1. A test asserting `recordLabels` maps `tiers`→"Age Division", `cohorts`→
   "Program", `locations`→"Location" (extend any existing recordLabels test).
2. A test asserting the root-map nav (`rootMapNav`/`domainRollup`) maps the
   cohorts node to "Program" and the tiers node to "Age Division" — pinning the
   de-inversion.
3. Update existing tests/snapshots that assert the retired words.
4. `npm run verify` (lint + test + integration + governance) as the gate.
