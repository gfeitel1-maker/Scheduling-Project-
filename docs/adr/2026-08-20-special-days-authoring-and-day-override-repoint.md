---
title: "Special-day authoring as the single construction surface + Day-Overrides re-point"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-20
approved: 2026-08-20 (owner ratified after the Red Hat pre-ratification corrections)
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-20-special-days-data-shape-design.md
  - docs/work/specs/2026-08-20-electives-specialdays-facility-audit.md
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
related_tickets: [docs/work/tickets/T40-one-day-special-event-schedule.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
gates: ["GATED on docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md (foundational) — do not proceed to Red Hat/Maker until that ADR is ratified."]
archive_when: T40 author-UI slices ship and Day-Overrides disposition lands; then folded into PLATFORM_STATE
---

# Special-day authoring + Day-Overrides re-point

**Revision note (Red Hat, 2026-08-20, pre-ratification):** three corrections. (1) Added the durability
mapping the foundational ADR mandates (D3b) — special days/overrides are authored, so tier (c) lands in
Roots **Context**, never the census. (2) The Day-Overrides re-point is honestly re-scoped: it needs a new
group axis + two-route render + `(week,day)` binding — its own Red-Hat-gated design pass, not "a small
column." (3) `frequency_mode` removal is flagged as a conscious reversal of a documented forward-compat
decision, and the free-text record/print choice (D2) is defended with an explicit structure trigger.

**Gated on the foundational durability ADR (2026-08-20).** This ADR resolves the audit's central
special-days finding: four overlapping mechanisms, cleanly separated in storage but conflated at the
product surface. It decides **one construction surface**, keeps the lightweight annotation gesture, wires
the inventory, and dispositions the orphaned Day-Overrides module (owner decision: **re-point**, not
remove).

## Context

Four mechanisms each touch the "not-a-normal-week" problem and don't know about each other:

| Mechanism | Table | Quadrant | State today |
|---|---|---|---|
| Day Override Templates | `day_override_templates` | *override* (mostly-normal day) | built, **never rendered against a week**, no group axis, dead `frequency_mode` |
| Field-Trip stamps | `template_overlays` | *event/context* (a label) | built, label-only banner |
| Special Days (v34) | `special_days` family | *special schedule* (own day/time blocks/grid) | data layer **fully built, no UI** |
| Roots "Context" | reads overlays + overrides | read-only inventory | surfaces overrides + stamps; **not** special_days |

The quadrants map almost one-to-one onto tables — the *storage* is right. The failure is that the
capable model (Special Days) is unreachable while two weaker "decoys" own the menu names a director would
look under. Research splits the job into a **high-frequency override** (a diff on a normal day — weekly
rainy-day swaps, a group pulled for a trip) and a **rare special schedule** (color war / Maccabiah — own
time blocks, temporary teams, station staff, points), and notes much of a special day is **not
schedulable data** (rosters, points, staffing, trip times) — the tool should **record and print** those,
not solve them.

## Decision

### D1 — Special Days becomes the single "open a day and construct it" surface

Build the author-UI follow-on the T40 spec already scoped: a **list screen** + a **grid editor** that
**seeds** its time blocks from the camp's `time_blocks` as a convenience (not a storage branch — every
special day still owns its blocks, per the v34 design), then lets the director type activities per
group×block, creating one-off activities inline via the foundational ADR's in-context-create interaction.
Wire the waiting `deleteSpecialDay` cascade to IPC. Both routes' shared inline-create path is reused —
this is the "new durable knowledge" quadrant, already solved.

### D2 — Record-and-print surface for a special day's non-schedulable data

A special day carries information that is **not** an activity assignment: temporary team rosters, per-
station staffing, points, trip departure/return times, meal changes. The author UI provides a place to
**record and print** these as notes attached to the special day — Shoresh does not model or solve them.
Storage: **recommended — a free-text notes region on `special_days`.** Red Hat's challenge (free-text is
immediately insufficient for teams/points/staffing) is answered deliberately: free-text is the *right*
first cut precisely because these are things the tool **records and prints, never solves** — a director
types "Team Yeshiva: bunks 3,4,7 — Station 2: Sylvia" as prose, exactly as their spreadsheet does today.
**Explicit trigger for adding structure:** only when a concrete downstream *behavior* must read a field
(the engine or an export parsing team membership) — that is a new feature, not a formatting preference,
so structuring now would be speculative. No teams entity, no per-cell person column (owner-deferred).

### D3 — Stamps stay as the lightweight annotation gesture, unified vocabulary

`template_overlays` (Field-Trip stamps) is the right shape for "these blocks are the trip" — a label over
a block range with no activity. **Keep it; do not grow a fifth table.** Unify terminology: a "Field Trip"
is either an **annotation** (an overlay on a normal week) *or* a **Special Day** you fully construct — the
director chooses depth. Both live under Roots **Context**.

### D3b — Durability mapping (honors the foundational ADR; added after Red Hat)

Special days and overrides are **authored** entities — never reconstructed from a file — so their tier
(c) durable surfaces in the Roots **Context** inventory, **not** the ingestible census (they must not be
added to `INGESTIBLE_ENTITIES`). This is exactly the wiring D4 below specifies, which is why Context is
the right and only durable home for them.

- **Special days** are inherently **tier (c) durable** — a director builds Color War once and reuses/
  prints it for years; a special day is a named, kept object, surfaced in Context. There is no meaningful
  one-off tier for the special-day *object* itself (a throwaway day is still saved and named). The tier
  question applies instead to **activities typed inside** a special day: those route through the
  foundational ADR's in-context create and carry their own tier (a one-off "Slip-n-Slide" station is a
  tier-(a) activity, `is_reusable=false`, per the electives/foundational marker rule) — the special day
  holds a reference either way.
- **Re-pointed overrides** are tier (b)/(c) authored objects in Context (a reusable "Rainy Day" override
  is tier (c); a one-time swap bound to a single `(week, day)` is effectively tier (a)/(b) and need not
  be surfaced for reuse).

### D4 — Wire Special Days into Roots Context

Extend `buildContextChildren` ([rootMapModel.js:63-76](../../src/ingest/rootMapModel.js)) so
`special_days` appears alongside Field Trips / Special Events / Day Overrides in the one read-only Context
inventory (Roots audit Slice 3). Special days are authored, never ingested — Context stays calm at import
and populated in the persistent inspector.

### D5 — Day Overrides: re-point to a rendered week (owner decision, 2026-08-20)

The *override* job — "Tuesday is mostly normal except a few swaps" — is the **high-frequency** real case
and nothing else serves it well (Special Days is too heavy for a two-block swap; per-week exclusions only
*cancel*, they don't *swap*). **Re-point Day Overrides** so an override applies to a **specific week/day**
and actually **renders on the schedule**, instead of being a reusable template detached from any day that
nothing consumes. Concretely: an override becomes a set of block-level swaps/cancels bound to a
`(week, day)` and rendered over that day's grid on both routes.

- Remove `frequency_mode`. **Note (Red Hat):** this *reverses a deliberate prior decision* — the field
  was kept intentionally as forward-compat scaffolding (`DayOverridesScreen.jsx:9-14` documents "the
  field is forward-compatible: when the modes ship, the control reappears and existing templates already
  carry a sensible value"). Reversing it is fine (pre-production, and the re-point supersedes that
  future), but it is a conscious reversal, not the removal of oversight-dead code.
- **Scope honesty (Red Hat).** The re-point is **not** "a small additive `(week, day)` column." Overrides
  today have **no group column at all** (`schema.sql:549-563`); re-point requires (i) a `(week, day)`
  binding, (ii) a **new group axis**, and (iii) **live rendering on both routes** — composing with each
  route's per-slot flags (Manual has no `UNFILLABLE`, Generated does). That is closer to a small
  scheduling layer than a column, and its **Consequences framing below is corrected accordingly** — it is
  comparable in size to the Special Days author UI, not obviously smaller.
- **Therefore the re-point gets its own design pass**, Red-Hat-challenged before code and estimated
  separately — not bundled as a sub-clause here. This ADR ratifies the *direction* (re-point, don't
  remove); it does not pretend the shape is trivial.
- **This is a product-shape change, not a deletion.** The `day_override_templates` tables are re-pointed,
  not dropped; whether they can carry the `(week, day)` + group axis cleanly, or need a small additive
  migration, is settled in that design pass.

## Reuse / refactor / remove / missing

- **Reuse unchanged:** `special_days` family + sync registration + `deleteSpecialDay`; `template_overlays`
  as annotation; the inline activity-create path.
- **Refactor:** stamp/special-day vocabulary under one Context term; `buildContextChildren` to include
  special_days; Day Overrides from detached template → week-bound rendered override.
- **Remove:** the dead `frequency_mode` field only.
- **Missing (the real gap — build, not rework):** Special Days author UI + list + IPC + render; the
  record/print surface (D2); the Day-Overrides re-point rendering.
- **Migration:** Special Days needs none (v34 shipped). Day-Overrides re-point may need a small additive
  `(week, day)` binding column; pre-production, low risk.

## Consequences

- **Positive:** one construction surface instead of three half-overlapping ones; the capable model becomes
  reachable; the high-frequency override job finally renders; the misrouting decoys are resolved.
- **Risk:** scope creep toward modeling teams/points/staffing as first-class — held as record/print only.
  Second risk: re-pointing Day Overrides is more build than deleting it; justified by the research showing
  override is the weekly-frequent case.
- **Precedent fit:** a special day is an undated standalone object, so it *sidesteps* the plural-candidates
  ADR's "no canonical week" rule rather than competing with it (v34 design §①). Re-pointed overrides render
  on an existing route, not as a third canonical schedule — also consistent.

## Gate

Gated on the foundational ADR. When ratified: this ADR likely splits into two Maker efforts (Special Days
author UI; Day-Overrides re-point), each **Maker (test-first) → Red Hat (the override group-axis + render
correctness; special-day cascade under live use) → Security → Code Reviewer → Verifier → Grader.** The
Day-Overrides re-point design is itself Red-Hat-challenged before code, given it changes a shipped table's
meaning.
