---
title: "Architecture & product audit — electives, special days, facility mapping"
document_type: spec
status: draft
created: 2026-08-20
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
related_specs:
  - docs/work/specs/2026-08-20-group-electives-design.md
  - docs/work/specs/2026-08-20-special-days-data-shape-design.md
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
  - docs/work/specs/2026-08-15-camp-spatial-model-assessment.md
related_tickets:
  - docs/work/tickets/T40-one-day-special-event-schedule.md
  - docs/work/tickets/T41-elective-scheduling.md
  - docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md
archive_when: the recommendations here are ratified into per-area ADRs (or rejected), superseding this audit as the record of the 2026-08-20 review
---

# Architecture & product audit — electives, special days, facility mapping

**This is an audit. No code was changed. Nothing here is approved for implementation.** It ends with
recommendations to review, not a plan to run.

The question the owner asked is not "do these features exist?" — all three exist in some form. The
question is: **does each feel like a natural extension of the scheduling workspace Shoresh has
become?** The product principle being audited against:

> Shoresh should not require a director to perfectly model camp in setup screens before they can do
> their real work. Increasingly, the director works directly at the point of intent — typing a thing
> that does not exist yet, and having Shoresh decide how durable that knowledge should be.

Shoresh already has one proven instance of exactly this: on the schedule grid a director can type an
activity that does not exist, and `createActivityFromCell`
([useSlotMutations.js:943](../../../src/screens/schedule/useSlotMutations.js)) mints it with
usage-derived defaults (`min_per_week: 1`, all-groups-eligible, human provenance) and places it in one
gesture. **That function is the yardstick this whole audit measures against.** All three areas fall
short of it in the same way.

Evidence is cited by `file:line`. Where a claim is judgment rather than what the code deterministically
does, it is marked **(opinion)**. Real-world grounding comes from a parallel research pass on how camps
actually run these things (sources at the end of each area).

---

## Area 1 — Electives

### Current state (deterministic)

The elective feature is **one-third built**, on purpose. T41 was decomposed into three slices; only
**slice 1 shipped** (data shape + engine-skip + full sync/permissions/migration registration). Slices 2
(setup CRUD) and 3 (authoring + render) do not exist, so **there is no way for a director to create,
place, or see an elective anywhere in the running app.**

- **Data model, schema v35** ([schema.sql:705-740](../../../electron/db/schema.sql)): `elective_sets`
  (camp-scoped parent — a *named set of activities*, `UNIQUE(camp_id, name)`) and
  `elective_set_activities` (the member join), plus a nullable `template_slots.elective_set_id`. A slot
  is an "elective cell" when `elective_set_id` is set; `activity_id` is then ignored. The two are meant
  to be mutually exclusive but **write-path enforcement of that is deferred to the unbuilt slice 3** —
  today it is only a render-time convention.
- **Engine-skip (correctness-critical)** ([buildSchedule.js:150-190](../../../src/engine/buildSchedule.js)):
  an elective cell is treated as pre-placed/do-not-fill, like an anchor — excluded from both
  head-selection and span-tail collision. Wired through `useGeneration.js`, which annotates itself as
  "a no-op today" because nothing ever writes `elective_set_id`.
- **A delete-cascade primitive** (`deleteElectiveSet.js`) exists and is **not called from any IPC
  handler yet.** No import path, no export path touches electives; real camps' "Chugim"/"Indoor
  Elective" still ingest as flat single activities.

**Net: a clean, correct, inert data substrate with zero user-reachable surface.**

### Intended user job

*"Next Wednesday's afternoon period we're offering pottery, soccer clinic, jewelry, D&D and cooking;
the bunk splits across them."* The director wants to record that **where they build the schedule**,
supply only what scheduling needs, and have the useful parts (the named set, its members) survive for
reuse — while a genuine one-off does not calcify into permanent camp vocabulary.

### Real-world check

Research confirms the owner's group-level model is **legitimate and common, not a strawman**:
group-rotation camps place whole groups, and even choice-based camps that "rank then assign" have a
*human* produce the final placement. What the group-level model deliberately does **not** cover is
per-camper free-choice with a capacity solver — that is a real but **distinct product** (individual
roster management), and conflating the two is the trap. Two things exist in *both* worlds and should be
preserved: **per-offering capacity** and **age/eligibility**. Also: electives are usually a **multi-day
recurring** commitment, not a single cell. (Sources: Canadensis, Summer Fenn, Pali, CampMinder/Bunk1
elective modules.)

### Friction / mismatch

1. **The whole job is currently impossible in the app** — no CRUD, no cell authoring, no render.
2. **The proven point-of-intent pattern is not extended to electives.** The planned slice 2 routes the
   director to a *separate setup-CRUD screen first* — the exact "model the camp in setup before you can
   work" tollbooth the principle warns against — even though `createActivityFromCell` already
   demonstrates the better shape for this codebase. **(opinion)**
3. **No lifecycle distinction between durable and one-off.** `elective_sets` is flatly camp-scoped and
   permanent; there is no season/week scoping and no ephemeral marker. Every set a director makes is
   durable camp vocabulary forever.

### Underlying architectural cause

The registration/data work (correctly) outran the experience work, and **the slice-2/3 plan predates
the point-of-intent principle** — it assumes the classic setup→schedule flow while the codebase already
contains the better pattern, unused. One genuine strength to keep: the **set-vs-placement seam** is the
right durable/ephemeral boundary — `elective_sets` rows are the durable "what we offer,"
`template_slots.elective_set_id` is the per-route, per-week "where it runs." Placing/clearing a set does
not mutate the set.

### Recommended target state

- **Reuse unchanged:** the v35 data model, projections, sync registration, permissions, engine-skip,
  `deleteElectiveSet` cascade, and the set-vs-placement seam. No schema churn is needed to build the UI.
- **Refactor / re-plan (opinion):** invert slices 2 and 3 — make **create-in-context the primary
  path**. Let a director, in a cell, name an elective and list its members inline (members themselves
  create-on-type via `createActivityFromCell`), minting the set + members + placement in one gesture. A
  management screen becomes the *secondary* review/rename/retire surface, not the mandatory entry point.
- **Move the `elective_set_id`/`activity_id` mutual-exclusion into the write path now**, before any
  writer sets `elective_set_id` — it is a latent integrity gap while it stays a render-time convention.
- **Add (missing):** IPC surface; elective-cell render in `SlotCell`; per-offering **capacity** and
  **age/eligibility** carried on the set members (both exist in every real elective model); export that
  renders an elective cell as its set. Import recognition of flattened "Chugim" is a *later, separable*
  concern — do not block authoring on it.
- **Owner decision — the one place new data-model work may be needed:** a durable-vs-one-off signal.
  Minimal option: an inline elective that is placed but never promoted to a named reusable set (so it
  never enters the reuse palette), vs. an explicit "reuse next time?" affordance. See the cross-cutting
  section — this should be solved **once**, not invented here.
- **Remove:** nothing. The substrate is clean.
- **Migration:** building the UI needs none (v35 is in place). A durability marker, if chosen, is a
  trivial additive nullable column with an "existing rows = reusable" backfill. No live camp uses
  electives, so there is no production data to migrate.

---

## Area 2 — Single-day / special-event scheduling

### Current state (deterministic)

There are **four separate mechanisms** in the tree that each touch part of the "not-a-normal-week"
problem. They were built at different times and **do not know about each other.**

| Mechanism | Table | The quadrant it serves | State |
|---|---|---|---|
| **Day Override Templates** (`DayOverridesScreen.jsx`, since removed by T108) | `day_override_templates` | *override* (mostly-normal day) | Built, **never rendered against a week**, no group axis; `frequency_mode` is a dead field |
| **Field-Trip stamps** ([FieldTripDrawer.jsx](../../../src/components/schedule/FieldTripDrawer.jsx)) | `template_overlays` | *event/context* (a label, not an assignment) | Built, label-only banner over the normal grid |
| **Special Days** ([schema.sql:661-703](../../../electron/db/schema.sql), v34) | `special_days` family | *special schedule* (own day, own time blocks, full grid) | Data layer **fully built, no UI at all** |
| **Roots "Context"** ([rootMapModel.js:63-76](../../../src/ingest/rootMapModel.js)) | reads overlays + overrides | read-only inventory | Surfaces #1 and #2; not yet #3 |

The critical part: **the four quadrants the owner named map almost one-to-one onto existing tables.**
The distinction is modeled cleanly *in storage*. Special Days is the only mechanism that matches "open a
day and construct it freely," and it is the one a director cannot reach.

### Intended user job

A director opens a day and just starts constructing it — typing one-off activities that may never recur
— without a setup tollbooth. For a trip day they also want to *note* "these blocks are the trip"
without rebuilding the grid.

### Real-world check

Research splits this cleanly into **two features, not one**:

- **Override** — "mostly normal, a few changes" (rainy-day swap, a visiting performer in one period, a
  group pulled for a trip). **High-frequency — happens weekly.** It is a *diff on the normal day.*
- **Special schedule** — color war, Maccabiah, carnival. **Rare but high-stakes.** Structurally
  incompatible with the normal grid: campers re-divided into **temporary teams**, its **own time
  blocks**, whole-camp events, **staff named per station**, points. Crucially, **much of a special day
  is not schedulable data at all** (team rosters, spirit points, station staffing, trip times, meal
  changes) — the tool should let the director **record and print** those, not try to *solve* them.

(Sources: Camp Stone Color War sheet, Peacock Powder planning guide, CampMinder rainy-day, Community Rec
scheduling templates.)

### Friction / mismatch

1. **The one capable model is unreachable** (Special Days has no screen).
2. **Two reachable mechanisms are decoys wearing the right names.** DayOverridesScreen's own
   placeholder text says "Color War, Field Trip"; FieldTripDrawer's presets say "Field Trip / Special
   Event." A director hunting for special-event scheduling will find *these*, then hit their ceilings —
   Day Overrides has no per-group axis and is never rendered; stamps are label-only. **The naming
   actively misroutes the user away from the model that would serve them.** **(opinion)**
3. **The tollbooth is in the wrong place.** Day Overrides forces cohort + template-name + time-block
   reuse before any construction — the opposite of "just start typing." Special Days was designed to
   avoid exactly this, but the avoidance only exists on paper.

### Underlying architectural cause

**Clean separation in storage, bad conflation at the product surface.** The special-days design
deliberately rejected overloading day-overrides (②) or `schedule_templates.kind='special'` (③) with
sound reasoning — the schema is *right*. The failure is that **three of the four mechanisms shipped as
isolated slices and never converged into one director-facing surface**, and the two oldest predate and
duplicate the intent of the newest without being retired or connected. Secondary: **Day Overrides is a
shallow orphaned module** — 458 lines of CRUD for a table nothing renders (deleting it removes
complexity without moving it anywhere).

### Recommended target state

**One surface, built on the `special_days` family, is the smallest coherent model. Do not build a fifth
system.** The four-quadrant distinction is real, but it collapses into *one authoring screen with two
gestures* plus a lightweight annotation:

- **Reuse unchanged:** the `special_days` family + its sync registration + `deleteSpecialDay`;
  `template_overlays` (stamps) as the annotation gesture; the drag-first inline activity-create path
  (this is the "new durable knowledge" quadrant, already solved).
- **Missing (the actual gap, and it is *build*, not *rework*):** Special Days **author UI** — a list
  screen + grid editor that *seeds* its time blocks from the camp's `time_blocks` as a convenience,
  then lets the director type activities per group×block, creating one-off activities inline. Wire the
  waiting `deleteSpecialDay` to IPC. Add a place to record the **non-schedulable** parts of a special
  day (team rosters, station staffing, points, trip times) as printable notes — the tool records them,
  it does not solve them.
- **Refactor:** unify "stamp"/"special day" terminology under one **Context** vocabulary; wire
  `special_days` into Roots Context so all three appear in one inventory.
- **Remove or re-point — ADR gate (opinion, medium confidence):** Day Overrides is unrendered and
  strictly weaker than Special Days for every special use, and weaker than per-week exclusions for
  "cancel some blocks this week." Either **remove** `DayOverridesScreen` + its nav + the dead
  `frequency_mode`, **or** — if the pure *override* job (Tuesday is mostly normal with a few swaps) is
  real and distinct, which the research says is the *high-frequency* case — **re-point** it to apply to
  a specific week/day and actually render. This is a product decision: does "mostly-normal-with-swaps"
  deserve its own gesture, or is it just a lightly-edited normal week? Settle it in an ADR before either
  path.
- **Migration:** Special Days needs none (v34 shipped). Removing Day Overrides is a v-next drop with a
  rollback precedent; pre-production with no live data (memory: *Bias Bold*) makes a hard cutover
  low-risk if the ADR chooses removal.

---

## Area 3 — Facility / location mapping

### Current state (deterministic)

The **identity + capacity + contention** model is genuinely deep and correct. The **spatial/topological**
model is a deliberate stub.

- **`locations` is a real op-log-native entity** ([schema.sql:589-598](../../../electron/db/schema.sql)):
  `name, capacity, notes, sort_order, map_geometry`, `UNIQUE(camp_id, name)`. The old free-text
  `activities.location` is frozen. `deriveLocationId` gives byte-identical ids across devices for
  migration/restore.
- **Capacity is authoritative and the order-dependent capacity bug is fixed**
  ([buildSchedule.js:559-602](../../../src/engine/buildSchedule.js)): the engine builds
  `locationCapById` from `locations`, keys occupancy on `location|day|block`, caps at stored capacity,
  raises `DANGLING_LOCATION` for a missing place. Per-week availability exists
  (`week_location_exclusions`) honored on both routes.
- **The map (M6) is UI-only positioning, not authoritative spatial data.** `camp_maps` holds a capped
  background image; `locations.map_geometry` stores `{x,y,w,h}` fractions. **The only consumer of
  `map_geometry` anywhere is LocationsScreen's own render** — grep finds zero engine or schedule reads.

### Intended user job

Name the physical places once; don't retype "Pool" across 40 activities; have the scheduler respect that
two groups can't share a place at once; and *eventually* understand that moving a group from the upper
field to Room 7 between periods is expensive.

### Real-world check

- The **upload-image + drop-pins approach is the right ceiling** for what camps actually possess. The
  overwhelming majority of maps a director can produce are **raster and not to scale** (illustrated,
  brochure, hand-drawn, or a Google Maps screenshot). A real fraction of camps have **no map at all**.
  Accurate GIS is a *project camps undertake*, not something they have.
- **You cannot reliably derive travel cost from an uploaded image** — most maps aren't to scale, pixel
  distance ignores the actual foot-path (a lake or fence between two pins), and no image carries scale
  metadata.
- **Director-authored adjacency is more realistic than image-derived distance.** Directors know the
  walk ("waterfront connects to the field," "bunk-to-gym is 5 minutes"); they do not know coordinates.
  This also degrades gracefully for the no-map camp. **Invert the tempting design: the image is the
  friendly UI, the authored graph is the truth the engine uses.** (Sources: ACA computerized-mapping
  article, SummerCampMaps, Pelland.)

### Friction / mismatch

- **The map is genuinely "UI without authoritative data."** `map_geometry` is real persisted, synced
  data, but it is decorative — nothing outside LocationsScreen reads it. A director who places 30
  markers produces data that influences nothing.
- **No physical vocabulary exists.** A location is `name + capacity + notes + a rectangle on a photo`.
  No indoor/outdoor on the location, no entrance, no adjacency, no path, no travel cost.
- **The rename-then-recollide hazard is open** (T101): renaming a place then re-creating the old name
  can silently overwrite via id-derivation-from-name. Owner/Architect decision pending.

### Underlying architectural cause

The initiative built the *contention/capacity* half deeply (engine-consumed, sync-safe, deterministic
id) and left the *geometry* half as an inert presentation layer. `map_geometry` was added as a nullable
field with no consumer and M6 wired it only to a drag-to-place canvas. So the foundation for travel cost
**does not exist as data** — it exists only as pixel coordinates, which the research says are the wrong
source of truth.

### Recommended target state (assessment only — do NOT build now)

- **Reuse unchanged:** the whole `locations` entity, `deriveLocationId`, the engine `locationCapById`
  seam, `week_location_exclusions`, the `camp_maps` singleton, and the resolution-independent
  `{x,y,w,h}` convention. This spine is correct.
- **Refactor / add (small, additive, reversible) — only if the owner wants the travel-cost foundation:**
  - A location-level `kind` (indoor/outdoor), kept *separate* from `activities.is_outdoor` (which is a
    weather concern).
  - **One genuinely new table — `location_connections`** `(id, camp_id, from_location_id,
    to_location_id, cost_minutes)` — director-authored adjacency. This is the single structure that
    turns "a list of places" into "a graph of places," and it is where travel burden eventually lives.
    It is an ordinary camp-scoped op-log entity — **no GIS, no computer vision.** The uploaded map
    becomes the *intuitive UI* for authoring it (click two pins → "how long is this walk?"), never the
    metric source.
- **Resist adding map polish until something downstream reads geometry** — more map UI now is
  compounding UI-without-data. **(opinion)**
- **Remove:** nothing (the frozen `activities.location` column is a harmless restore fallback).
- **Sequencing:** **close T101 before** any new name-derived create path, since a topology built on
  location ids inherits that identity hazard.
- **Migration:** all additions are nullable-additive with the established both-places DDL pattern; edges
  are director-authored so there is nothing to backfill.

---

## Cross-cutting — the one problem to solve once

The owner's hypothesis was that these are not three unrelated feature problems but **one architectural
problem: Shoresh needs a consistent way for a director to create new camp knowledge in context, decide
how durable it should be, and use it immediately — without leaving their workflow.**

**The evidence confirms the hypothesis, with one important refinement.** Shoresh already has *half* of
this seam, and it is the half everyone keeps not-reusing:

1. **In-context creation exists — for exactly one entity.** `createActivityFromCell` is the reference
   implementation. Electives (slice-2 setup CRUD), special days (author UI TBD), and locations (typed
   only in a setup screen, never in a cell) each **re-solve, or defer, the same problem instead of
   generalizing the one working answer.**
2. **The durability decision is the actual missing piece — and it is missing everywhere, identically.**
   `createActivityFromCell` always writes *durable* camp knowledge; there is no "use once and forget"
   and no "this-summer-only." Electives have no ephemeral tier. Special days *are* the throwaway tier but
   are unreachable. The owner's "Slip-n-Slide" example — use once / this summer / durable / associate
   with Upper Field / infer constraints — has **no place in the model to land** on any of the three.
3. **The durability boundary is already named in the architecture — reuse it, don't reinvent it.** The
   Roots reconciliation work already split the world into **durable, reconstructible camp knowledge**
   (the 7 `INGESTIBLE_ENTITIES` surfaced in the Roots census) versus the **authored "Context" layer**
   (field trips, special events, day overrides — *never* reconstructed). Electives and special days are
   new members of the authored class; locations are durable/ingestible. **"How durable is this?" already
   has a home: does it belong in the reconstructible census, or the authored Context layer, or is it a
   one-off slot value that belongs to neither?** That three-way answer is the model to make explicit.

### What to solve once (not three times)

- **A single "create camp knowledge in context" interaction**, generalized from `createActivityFromCell`
  — type a name into a cell, get progressive enrichment (Shoresh asks only for what scheduling needs,
  when it needs it), with sensible defaults. Electives, special-day activities, and typed locations all
  route through it. Do **not** send any of the three to a mandatory setup screen first.
- **A single, explicit durability spectrum** attached to that interaction, with the smallest set of
  tiers the use cases actually need: **(a) one-off slot value** (a string used once, never promoted),
  **(b) this-summer / this-schedule** (real but scoped, not permanent camp vocabulary), **(c) durable
  camp knowledge** (enters the reconstructible census / setup). Default conservatively and let promotion
  be a later, low-friction gesture — never an upfront interrogation.
- **A single place a typed location flows into the facility model**, so a location invented in a cell is
  the same `locations` row a director later gives capacity/adjacency — no duplicate setup.

### Reuse / refactor / remove / missing — consolidated

| | |
|---|---|
| **Reuse unchanged** | `createActivityFromCell` pattern; the elective v35 substrate + engine-skip; the `special_days` v34 substrate + `deleteSpecialDay`; the `locations` entity + engine capacity seam + `deriveLocationId`; `template_overlays` as annotation; the Roots census as the durable-knowledge surface. |
| **Refactor** | Generalize the in-context-create interaction across all three; unify special-day/stamp vocabulary under Context; invert the elective slice plan (context-create before setup CRUD); move the elective mutual-exclusion into the write path. |
| **Remove (ADR-gated)** | Day Overrides screen/nav/`frequency_mode` — or re-point it to a real rendered week. Nothing else. |
| **Missing** | The durability-tier model (once/this-summer/durable); elective + special-day authoring UI + IPC + render; per-offering capacity + eligibility on electives; `location_connections` (adjacency/travel cost) + location `kind`; a consumer of `map_geometry`; special-days → Roots Context wiring; record/print surface for a special day's non-schedulable data. |

### Data-migration implications

Small and additive throughout. Electives (v35) and special days (v34) already shipped — building their
UI needs no migration. New work is nullable-additive: a durability marker on `elective_sets`, a location
`kind`, and one new `location_connections` table. No live camp data exists yet (memory: *Bias Bold* —
clean cutovers preferred), so a Day-Overrides hard removal is low-risk if chosen.

### Conflict with the reconstructibility / `.shoresh` project work

**Low, and mostly synergistic — with one thing to get right.** The `.shoresh` file is the portable camp
db; the reconstructibility work is the Roots census that decides what durable knowledge a camp *has*.
The durability spectrum recommended here must **reuse that census as tier (c)** rather than introduce a
parallel notion of "durable." The specific risk: an in-context-created durable entity must show up in
the Roots census (so the camp's knowledge stays honest and reconstructible), while a one-off or
this-summer value must **not** pollute it (the Roots audit's H2/Context work is precisely about keeping
the census calm and truthful). Get the tier→census mapping right and the two initiatives reinforce each
other; get it wrong and every one-off Slip-n-Slide becomes permanent camp vocabulary — the exact failure
the Context layer was built to prevent.

### Risk of over-building

Real, and worth naming per the owner's warning:

- **Electives:** the gravitational pull is a per-camper choice solver. The research says group-level
  allocation is a legitimate, common model; **keep per-camper choice an explicit non-goal**, not a
  half-built solver.
- **Special days:** the pull is a fifth subsystem. There is already one too many. The move is to
  *finish one and retire/absorb the overlaps*, not add.
- **Facility maps:** the pull is GIS/CAD/computer-vision on uploaded images. The research is unambiguous
  that this is fragile and mismatched to what camps have. **One authored-adjacency table** is the whole
  V1 foundation; the image stays a friendly backdrop.
- **The durability model itself:** the pull is an elaborate scope/season/versioning system. The use
  cases need **three tiers**, one sensible default, and low-friction promotion — no more.

---

## Director workflows the recommendations are tested against

1. **First-time electives, mid-schedule.** Director building next Wednesday's grid types "Electives:
   pottery / soccer / jewelry" into the afternoon cell → set + members are minted inline (new activities
   created on type) and placed; Shoresh asks capacity/eligibility only if/when it matters; the set is
   offered for reuse next week. *Passes only if the elective plan is inverted to context-create-first.*
2. **Rainy Tuesday (override).** Director swaps two periods and cancels swim for one group, on the real
   week, and it renders. *Passes only if Day Overrides is re-pointed to a rendered week — or if this is
   judged "just a lightly-edited normal week" and needs no separate gesture.*
3. **Color war (special schedule).** Director opens a new special day, seeds time blocks from the normal
   grid, builds a groups×block station grid, records team rosters and station staff as printable notes.
   *Passes only if the Special Days author UI is built and the non-schedulable record/print surface
   exists.*
4. **"Slip-n-Slide" durability.** Director types "Slip-n-Slide at Upper Field" into one special-day
   cell; it is used once by default; a single gesture promotes it to this-summer or to durable camp
   knowledge (and, if durable, it appears in the Roots census). *Passes only if the one durability
   spectrum exists and maps tier (c) onto the census.*
5. **Travel cost.** Director uploads their brochure map, drops pins, then clicks two pins and enters "5
   min"; the engine can later flag a group scheduled across a 15-minute hop between back-to-back periods.
   *Passes only if `location_connections` exists and the image stays UI, not metric.*

---

## Bottom line

The data layer is in unusually good shape — three clean substrates, correct engine behavior, honest
separation of concepts in storage. **The gap is not schema; it is that the point-of-intent interaction
and the durability decision — the two things that would make all three feel native — exist for exactly
one entity and were never generalized.** The smallest coherent change is to **generalize the one working
in-context-create pattern and give it an explicit three-tier durability decision that reuses the Roots
census as its "durable" tier**, then finish the two authoring UIs on top of substrates that are already
built, and put Day Overrides through an ADR. That is far less new construction than it sounds, because
the hard, correctness-critical parts already shipped.

**No implementation is authorized by this document. Recommended next step: one ADR per area
(electives-authoring, special-days-authoring + Day-Overrides disposition, facility-topology), each
gated on the single cross-cutting decision — the durability spectrum — being settled first.**
