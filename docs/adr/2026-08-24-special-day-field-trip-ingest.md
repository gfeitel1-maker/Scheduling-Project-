---
title: "Special-day/field-trip ingest as surface-then-fill candidates (D6 implementation)"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
date: 2026-08-24
supersedes: []
amends: docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md (§D3b, narrowly)
approved: "owner priority #6 (camp-setup-ingestion program). Implements D6 of docs/adr/2026-08-23-unified-schedule-overlay-model.md. Conservative detector, human-gated, minimal viable version only (Slice 5a); per-group subtler cases explicitly deferred (5b, open question)."
---

# Special-day/field-trip ingest as surface-then-fill candidates

Owner priority #6 in the camp-setup-ingestion program. Implements D6 of
`docs/adr/2026-08-23-unified-schedule-overlay-model.md`: main-schedule ingest
may now propose a `special_days` candidate when it sees a day-long deviation
from the camp's usual weekly grid, using the same D1 surface-then-fill
lifecycle the rest of the overlay family already gets. This reverses
`2026-08-20`'s §D3b prohibition (`special_days` was explicitly excluded from
ingest) — stated explicitly per the constitution's re-opening requirement —
but only as to *whether* ingest may propose a candidate, not *what* it
proposes: no new detector machinery beyond the day-deviation signal below, no
parsing of rosters/points/staffing, and D2 (record-and-print, free text,
never parsed) is untouched.

## Resolution: "special day" and "field trip" are the same ingest target

The title phrase "special-day/field-trip" names one target, not two. Verified
against the live code:

- `src/ingest/existingSnapshot.js:85-119` builds a `field_trips` census key,
  but it is **not** a distinct entity — it filters `template_overlays` rows
  whose `label` is one of `FIELD_TRIP_PRESET_LABELS` (`'Field Trip'`,
  `'Special Event'`, `'Service Project'`, line 89). A "field trip" in that
  code is a **stamp** on a specific `(week, day)` — the D8 override-and-replace
  family's lightweight annotation gesture, bound to a rendered week and never
  a standalone constructed schedule.
- `special_days` (`electron/db/schema.sql:704-711`) is the opposite shape: no
  date column, `UNIQUE(camp_id, name)`, "not calendar-dated (named/throwaway,
  not a dated entry)" per the schema comment — a reusable, named, standalone
  day construction, unrelated to any particular week.

D6's own body text resolves this for us: it says ingest "populates a
`special_days` row the director then fills in on the Special Days screen" —
naming the table explicitly. A field trip is *content* a director names into
a special day ("Field Trip — Wednesday"), not a second ingest target. **This
ADR's candidate mechanism writes only to `special_days`.** It does not touch
`template_overlays` stamps, which remain a separate, already-shipped,
director-placed gesture on the rendered week (D8's grid-first stamping, out
of scope here). If a future slice wants ingest to also propose a `(week,
day)` stamp from a source file that already shows dates, that is a new,
separate design question — not implied or required by D6, and explicitly
deferred (see Open Questions).

## The prohibition-lift mechanism

`2026-08-20` §D3b's actual constraint was: `special_days` must never be
added to `INGESTIBLE_ENTITIES` (`electron/db/schema.sql`/
`electron/ops/ingest.js:46-48`, currently `['cohorts', 'tiers', 'groups',
'days_of_operation', 'time_blocks', 'locations', 'activities']`) — the
generic create/dedup/link whitelist every plain entity commits through.

This ADR does **not** add `special_days` to that list. `INGESTIBLE_ENTITIES`
governs entities whose full shape (all fields, cross-links) is meant to be
reconstructed from a file. A `special_days` candidate is deliberately
name-only — reconstructing its `special_day_time_blocks`/`special_day_slots`
interior from a parsed grid is explicitly out of scope (that's what "no new
detector, no parsing of rosters" rules out). Forcing it through the generic
whitelist would be the wrong shape for a partial, human-completed object.

Instead this reuses the **dedicated side-channel commit pattern already
proven for `anchor_activities`** (`fixedEvents`, `electron/ops/ingest.js`
~1096-1900): a named payload array (`fixedEvents` today; this ADR adds
`specialDayCandidates`) carried alongside `approved` in `commitIngest`'s
params, written inside the same transaction, after the generic entity loop,
through the same `write()` op-log helper — never through the
`INGESTIBLE_ENTITIES` path. `anchor_activities` is "written here and nowhere
else in ingest; the generic whitelist never lets it through"
(`electron/ops/ingest.js:1717-1719`) — `special_days` gets the identical
posture. This is the mechanism D6 means by "reuse the recurring-events
surface pattern" — not the UI alone, the whole side-channel-payload +
dedicated-commit-block shape.

## The candidate → `special_days` commit shape

A candidate is `{ name, day, support }` — `day` and `support` exist for
evidence/audit purposes only (see below), never written to the row.

Minimal fields to make a candidate an openable `special_days` row (verified
against `electron/db/schema.sql:704-711` and `SpecialDaysScreen.jsx`'s
existing create flow, `nameDraft` + `POST` on create):

```
id:          minted uuid (interactive-create pattern, no deterministic derivation —
             matches the schema comment's "no deriveLocationId-style determinism")
camp_id:     from commitIngest's camp_id param
name:        candidate name (see Detector below)
sort_order:  appended after existing special_days rows (same convention
             SpecialDaysScreen's own create-flow uses)
notes:       left null — D2's free-text surface is untouched by ingest
```

No `special_day_time_blocks` or `special_day_slots` rows are created by
ingest. `SpecialDaysScreen.jsx`'s existing open-flow already asks "Seed from
Time Blocks or start empty?" (`seedPrompt`, `SpecialDaysScreen.jsx:24`) the
first time a director opens *any* special day, ingested or hand-created —
that is D1's "fill in" stage, verbatim reused, not re-specified here.

**Dedup / recognize-then-skip:** `special_days.UNIQUE(camp_id, name)` gives
dedup for free at the SQL level, but the commit code should recognize-then-
skip explicitly (mirroring `anchorSlots`/`fixedUnchanged` in
`electron/ops/ingest.js` ~1780-1800) rather than rely on the constraint to
throw: query existing `special_days` names for the camp before the write
loop, skip (report as `unchanged`) any candidate whose normalized name
collides with a live row, so a re-import doesn't error or duplicate.

**Evidence:** write an `inferred`/`low`-confidence evidence row per created
candidate (`writeEvidence`, same helper `anchor_activities` uses at
`electron/ops/ingest.js:1836-1846`), tagged `entity_type: 'special_days'`,
`field: 'name'`. This requires adding `'special_days'` to
`EVIDENCE_ENTITY_TYPES` (`electron/ops/ingest.js:270`, currently
`Set(['activities', 'anchor_activities'])`).

## The detector: conservative, minimal-viable, human-gated

**Recommendation: ship the narrowest version — an obvious whole-day,
all-camp deviation only. Confidence: high that this narrow case is reliably
detectable from one week; the general "any day that's unusually different"
case is not, and this ADR deliberately does not attempt it.**

### Signal

Reuses `fixedEvents.js`'s own per-`(group, day, block, activity)` tuple data
(`occupied`/`operatingDays` maps, `src/ingest/fixedEvents.js:120-160`) as
input — no new parsing pass over the source file. For each day `D` in the
ingested week:

1. For every group `G` that operates on `D`, compute `dayActivities(G, D)` —
   the set of `(block, activity)` pairs `G` occupies on `D` (already
   available from the same per-cell walk `fixedEvents.js` performs; this
   detector runs as a second reducer over the same intermediate tuples,
   not a second file scan).
2. `foreignToWeek(G, D)` = the subset of `dayActivities(G, D)` whose
   `activity` name **never appears for `G` on any other day of the week**
   (cross-day lookup against the same `occupied` map, keyed by group+block+
   activity, days-set). This is the day-deviation signal: an activity that's
   unique to one day, for a group, is either a genuine one-off (what we
   want) or noise (a typo, a printed note) — the next two checks separate
   these.
3. `dayDeviationRatio(G, D) = |foreignToWeek(G, D)| / |dayActivities(G, D)|`
   — how much of `G`'s day is foreign to its own week.
4. **All-camp coincidence check**: among groups with
   `dayDeviationRatio(G, D) ≥ 0.6`, take the multiset of `foreignToWeek`
   activity *names* (block-agnostic) across all of them. If a **single name**
   (post-`normalizeName`) accounts for a majority of the foreign cells across
   a majority of that day's operating groups, that name is the day's
   **dominant deviation label** and `D` qualifies as a special-day candidate.
   If no single name dominates — every group's foreign activities differ —
   **do not propose**. This is the false-positive guard: a genuinely unusual
   but still per-group-varied day (e.g., three different electives ran that
   Wednesday) is exactly the ambiguous case D6's §D3.2-adjacent reasoning
   flags as undetectable from one week, so it is deliberately left alone
   rather than guessed at.

### Threshold recommendation

- `dayDeviationRatio ≥ 0.6` per group (most of that group's day is foreign
  to its own week) — conservative; a day that's 40% normal + 60% one thing
  reads as a real deviation, a day that's mostly normal with one substituted
  period does not (that's ordinary daily variance, not a special day).
- Dominant-label coverage `≥ 0.5` of qualifying groups (majority, not
  unanimity — a Field Trip that excuses one unit is still camp-wide in
  intent even if not every group's grid shows it, e.g. a unit on a trip
  while others stay for a normal day would legitimately show `0` deviation
  for the groups that stayed — those groups simply don't enter the
  numerator or denominator for that day at all, since their own day isn't
  foreign to their week).
- Both thresholds are named constants in the new module (not buried magic
  numbers) so a future slice can tune them against real reconciliation
  precision data, same convention `classifyConfidence`'s `highThreshold`
  option already establishes (`src/ingest/confidence.js`).

### Candidate name

The dominant deviation label, verbatim (e.g. `"Color War"`, `"Field Trip"`).
If ingest already has a name for that source day (day-of-week, e.g.
`"Wednesday"`) and the label is generic/ambiguous
(`FIELD_TRIP_PRESET_LABELS`-style names, borrowing the existing
`existingSnapshot.js:89` vocabulary as a *reference list only*, not a
dependency — that module is not imported here, the set is small and stable
enough to duplicate exactly as `existingSnapshot.js:87-91`'s own comment
already accepts for the same list), suffix with the day name only on a
literal SQL collision against an existing `special_days` name, mirroring
`fixedEvents.js`'s own dedup-by-name discipline — not proactively, to avoid
manufacturing needless "Field Trip — Wednesday" noise when "Field Trip" alone
would have been fine.

### Never auto-created

Every candidate is proposal-only. Concretely: `inferSpecialDays()` is a pure
function (no DB, no I/O — mirrors `inferFixedEvents`'s contract exactly)
that returns candidates; `commitIngest` only ever creates a `special_days`
row for a candidate present in the `specialDayCandidates` payload the caller
(ImportScreen → ReconciliationScreen flow) explicitly passed after the
director's review step. There is no code path from "detector fired" to "row
exists" that skips the human gate — same posture as `2026-08-23`'s two-rows
split (decline-memory, human confirms before any write) and every other
member of this ingest family.

### UI surfacing — corrected against current code, not D6's literal wording

D6's prose says "ticked/unticked in the preview, exactly the way a Recurring
Event candidate is surfaced today." Verified against the live
`ImportScreen.jsx`: this description matches an **earlier** revision of the
Recurring Events surface. The current code
(`src/screens/ImportScreen.jsx:1068-1073`, "Sub-slice 4: no local tick —
every inferred event is shown and ships to ReconciliationScreen, which is
where a low-confidence one gets reconciled") has **already moved** per-item
accept/reject off the Import preview and onto `ReconciliationScreen`, which
is the more capable surface for a low-confidence decision (evidence,
per-item reject with a reason).

This ADR follows the **current** pattern, not D6's literal (now-stale)
phrasing of it: ImportScreen renders every `special_days` candidate as a
chip in a new "Special Days" section (visually identical treatment to the
existing "Recurring Events" chip block, `ImportScreen.jsx:1075-1150`), all
candidates ship into the plan unconditionally, and the actual accept/reject
decision happens at `ReconciliationScreen` the same way a low-confidence
fixed event's does today. This is a corrected instance of "reuse the
recurring-events surface pattern," not a deviation from D6's intent — D6's
intent (surface-then-fill, human-gated, no bespoke UI) is fully honored; only
the stale description of *which* step does the gating is corrected.

## Reused vs. new

**Reused unchanged:** `special_days` schema (no migration — table has existed
since v34/v37, `electron/db/schema.sql:704-711`); `SpecialDaysScreen.jsx`'s
fill-in flow (seed-from-blocks prompt, grid editor) entirely unchanged;
`anchor_activities`' dedicated-payload + side-channel-commit shape in
`commitIngest`, copied structurally for `special_days`; the evidence-writing
helper (`writeEvidence`) and its `inferred`/`low` confidence convention; the
Recurring Events chip visual treatment and the Reconciliation-gated decision
pattern (corrected to match current code, per above).

**New:** `src/ingest/specialDays.js` — `inferSpecialDays(parsed, proposal, { fixedEventsResult })`,
a pure function, the day-deviation detector described above. A
`specialDayCandidates` payload plumbed through `ImportScreen` →
`ReconciliationScreen` → `commitIngest`. A dedicated commit block in
`electron/ops/ingest.js` (structurally parallel to the `fixedEvents` block,
~40-60 lines: resolve day-of-week names is not needed here since
`special_days` carries no day binding, dedup-by-name, evidence write,
`write()` calls). `'special_days'` added to `EVIDENCE_ENTITY_TYPES`. A new
"Special Days" chip section in `ImportScreen.jsx`. No schema migration.

## False-positive risk decision

**Confidence: high** that the narrow "obvious whole-day, all-camp-coincident
deviation" case (Color War, a camp-wide Field Trip, Maccabiah) is reliably
detectable from a single ingested week with the thresholds above — these are
exactly the days where a source file's grid looks nothing like itself, for
every group, at once. **Confidence: low** that any per-group-varied or
partial-day case can be distinguished from ordinary weekly variance without
more signal than one week provides — this ADR does not attempt that case at
all, on purpose, rather than shipping a detector with an unbounded false-
positive rate on the far more common "normal week with one substituted
activity" shape.

**Biggest risk:** the all-camp coincidence check (dominant-label majority)
is the one heuristic doing the real work of separating "real special day"
from "coincidentally several groups had unrelated one-off substitutions the
same day." If real source data turns out to have special days where each
unit's grid uses a *different* name for the same event (e.g. "Trip" for
Seniors, "Off-Camp" for Juniors, no shared string), the dominant-label check
will under-fire and silently propose nothing — consistent with this ADR's
stated bias (miss rather than false-positive), but worth flagging as the
first thing to check against real camp data before loosening the threshold.

## Open questions for Governor

1. **Should a future slice let ingest also propose a `template_overlays`
   stamp** (the `(week, day)`-bound "Field Trip" banner, D8's family) from a
   source file that shows actual dates, separately from the `special_days`
   candidate this ADR builds? Out of scope here — D6's text only names
   `special_days` — but worth a product decision once real source files with
   dated field-trip rows are in hand, since that's a materially different
   (and easier — it only needs a name + date, not a whole constructed day)
   ingest target.
2. **Threshold tuning is a product judgment, not a technical one** — the
   0.6/0.5 values above are defensible starting points, not derived from any
   real camp data (none was available for this design pass). Recommend
   shipping Slice 5a, running it against 2-3 real prior-year files in
   reconciliation, and only then deciding whether to loosen toward the
   subtler per-group case (5b) or hold the line.
