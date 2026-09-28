---
title: "T293 — the fixed / recurring / activity / event vocabulary, defined and audited"
document_type: spec
status: draft
created: 2026-09-28
task_class: copy-terminology
archive_when: "The owner has ruled on the two open decisions in §5 (the two-'event' UI naming and whether to consolidate the three activity classifiers), and the resulting follow-up tickets are filed; at that point the definitions in §2 become the reference and this spec is superseded by them"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-26-fixed-recurring-event-identity-model.md, docs/adr/2026-08-28-fixed-vs-recurring-events.md, docs/adr/2026-08-23-override-family-model.md, docs/adr/2026-08-29-unify-special-events-screen.md, docs/adr/2026-08-22-events-overlay-placement.md]
related_tickets: [docs/work/tickets/T293-fixed-recurring-activity-vocabulary.md, docs/work/tickets/T267-fixed-recurring-event-identity-model.md]
---

# T293 — the fixed / recurring / activity / event vocabulary

This spec does two things and no third thing. It **defines**, in one place, what "fixed",
"recurring", and "activity" each mean — how each behaves in the engine, on the grid, and in
eligibility — and it **audits** every place the terms drift, overlap, or read ambiguously, as
concrete `file:line` findings. It changes **no code**. Every fix implied by a finding is a
follow-up, owner-gated where §5 says so.

The definitions in §2 are verified against code at schema **v78** (worktree `cool-curie-5514ca`,
2026-09-28), not against the docs, which lag the code in the places §4 records.

## 0. Reconciliation with the in-flight T267 (read this first)

T293 and T267 share territory; the boundary is clean and stated here so neither contradicts the
other.

- **T267 owns the data-model identity.** T267 PR1 is **merged** (PR #560, 2026-09-26, schema v77;
  main is now v78): the table `anchor_activities` was renamed **`fixed_events`**, gained a real
  `activity_id TEXT` soft-reference to `activities.id`, and the fixed/recurring distinction is kept
  as the existing `kind` column, not a table split (per
  `docs/adr/2026-09-26-fixed-recurring-event-identity-model.md`, which supersedes the entity-split
  proposed in `docs/adr/2026-08-28-fixed-vs-recurring-events.md`). `activities` gained
  `catalog_role`. T267 ticket status is **in-progress**: **PR2** (cut resolution over to
  `activity_id`, delete the by-name fallback) and **PR3** (cosmetic rename of residual
  `anchor_activities`/"anchor" identifiers) are **not yet merged**.
- **T293 owns the vocabulary and the drift audit.** This is the deliverable the T267 ADR explicitly
  handed off: its **Open Question #1** — "what the UI calls each of the two 'event' concepts so a
  director never confuses them" — is §5 Decision 1 below.
- **No duplication, no contradiction.** Findings in §3 that are already scoped to T267 PR2/PR3 are
  labelled `[T267]` and are **not** re-ticketed by T293; T293 only records them so the vocabulary
  picture is complete. Findings labelled `[T293]` are new and belong to this ticket's follow-ups.

## 1. The shape of the problem, in one paragraph

There are **four** distinct scheduling objects and the English word "event" is stretched across
three of them. `fixed_events` (one table) holds two of them — **fixed** and **recurring** — which
are one *engine* concept (a hard pre-placement / "anchor") differing only in **scope**. The
separate `events` table holds a third, structurally unrelated thing (a Field-Day-style construct
with its own internal sub-schedule). **Activity** is the fourth and the only *contended* one. The
confusion is not in the data — the data model is now coherent post-T267 — it is that (a) the UI
calls three different objects "…Event", (b) three different columns partially classify an activity,
and (c) several code comments still deny that the T267 `activity_id` column exists.

## 2. The authoritative definitions

For each concept: what backs it, how the **engine** treats it, how it behaves on the **grid**, and
how it participates in **eligibility**. Every claim carries its `file:line`.

### 2.1 `fixed` — an all-camp hard pre-placement

- **Backed by:** a `fixed_events` row with `kind='fixed'`. The DB CHECK
  (`electron/db/schema.sql:806-811`) forces `kind='fixed'` ⇒ `is_all_groups=1`, `unit_id IS NULL`,
  `group_ids` empty, `unit_ids` empty. So **fixed ≡ all-camp scope**, enforced at the database, not
  by convention.
- **Engine:** placed in Pass 1 before any activity, as a locked `type:'anchor'` slot
  (`src/engine/buildSchedule.js:252-290`, `363-369`). Scope resolves through
  `resolveAnchorGroupIds` (`src/engine/anchorScope.js:18-30`); `is_all_groups=1` yields every group.
  **Never contends, never counted toward `min_per_week`.**
- **Grid:** rendered by `src/components/schedule/SlotCell.jsx:148-171` as `cell-inner--anchor`
  showing the event name; **not draggable** (`canDrag` requires `type==='activity'`,
  `SlotCell.jsx:126`).
- **Eligibility:** skips eligibility entirely; its underlying activity row is marked non-free-choice
  and given an empty eligibility set (`src/engine/buildSchedule.js:216-219`), and its name is
  excluded from the free-choice pool per group/day
  (`src/engine/buildSchedule.js:157-193, 413-421`).

### 2.2 `recurring` — a group/division-scoped hard pre-placement

- **Backed by:** a `fixed_events` row with `kind='recurring'`. The CHECK's first OR-branch lets it
  carry `unit_ids` (JSON tier-id array, v65/T180, `schema.sql:800-804`), the legacy `unit_id`, or
  `group_ids`. Same table, same projection entry as fixed
  (`electron/ops/projections.js:331-362`).
- **Engine:** **identical code path to `fixed`.** The engine never branches on `kind` — the ADR
  constraint "no engine code path forks on kind" is **honored** (verified: `grep '\.kind'` in
  `src/engine/` returns only comments and unrelated `readiness.js` category kinds). The only
  difference is the scope data resolved by `resolveAnchorGroupIds` /
  `resolveAnchorDayIds` (`src/engine/anchorScope.js:18-54`). Same lock, same no-contention, same
  no-min-counting.
- **Grid:** same `type:'anchor'` rendering as fixed — **the grid does not visually distinguish fixed
  from recurring** (`SlotCell.jsx:148-171`).
- **Eligibility:** same as fixed (hard pre-placement, name-excluded from the free-choice pool).

> **Consequence for the definition:** *fixed* and *recurring* are **one engine/grid/eligibility
> concept** — a scope-parameterized hard pre-placement ("anchor") — distinguished **only** by
> `fixed_events.kind`, which drives scope and authoring, never engine behavior. Any future `if
> (kind === 'recurring')` in `buildSchedule.js` is a misread of the brief, not a needed change
> (per `docs/adr/2026-08-28-fixed-vs-recurring-events.md` §4, still the governing statement of
> intent).

### 2.3 `activity` — the free-choice, contended catalog row

- **Backed by:** an `activities` row where `catalog_role` is NULL
  (`src/engine/freeChoiceActivities.js:45-47`). Placed slots persist in `template_slots.activity_id`
  (`electron/db/schema.sql:586-593`), one of the three mutually-exclusive slot fields
  `[activity_id, elective_set_id, event_id]` (`electron/ops/projections.js:1070-1071`).
- **Engine:** the **only contended** concept. Pass 0 resolves per-group eligibility
  (`buildSchedule.js:203-229`); Pass 2 places high- then low-priority via `runRound` with capacity
  checks and a seeded PRNG (`buildSchedule.js:479-517`); `min_per_week` / `max_per_week` /
  `prefer_before_day` are all counted (`buildSchedule.js:656-704`). A multi-block span counts as
  **one** session.
- **Grid:** `type:'activity'` slots, **draggable** (`SlotCell.jsx:126`), carrying the activity's
  colour and identity.
- **Eligibility:** the concept eligibility is *about* — it goes through the full resolution the
  other two skip.

### 2.4 `event` (adjacent, defined to keep it out of the other three)

- **Backed by:** the separate `events` table plus `event_time_blocks` / `event_groups` /
  `event_slots` (`schema.sql:1226-1292`) — a construct with its **own internal sub-schedule**.
  Surfaces on the weekly grid only as an opaque `type:'event'` cell via `template_slots.event_id`
  (`buildSchedule.js:374-382`, `SlotCell.jsx:204-206`).
- **Engine/grid/eligibility:** pre-placed overlay, never contends, never counted — a **different
  family** from `fixed_events`, per `docs/adr/2026-09-26-fixed-recurring-event-identity-model.md`.
  It is defined here only so §3.A's naming collision is unambiguous.

### 2.5 One-line reference table

| Concept | Table / column | Engine | Grid | Eligibility | Scope |
|---|---|---|---|---|---|
| fixed | `fixed_events`, `kind='fixed'` | Pass 1, locked, no contention, no count | `type:'anchor'`, not draggable | skipped (hard pre-place) | all-camp (CHECK-enforced) |
| recurring | `fixed_events`, `kind='recurring'` | **identical to fixed** | `type:'anchor'`, not draggable | skipped (hard pre-place) | group / division |
| activity | `activities`, `catalog_role IS NULL` | Pass 2, contends, counted | `type:'activity'`, draggable | full resolution | per eligibility |
| event | `events` + `event_*` | pre-placed overlay, skipped | `type:'event'`, opaque | skipped | own sub-schedule |

## 3. Findings — drift, overlap, ambiguity (concrete, cited)

Severity: HIGH = actively misleads a maintainer or a director now; MEDIUM = real inconsistency a
reader can hit; LOW = naming debt / cosmetic. `[T267]` = already owned by in-flight T267;
`[T293]` = new follow-up this ticket should file.

### A. The two-/three-"event" naming collision — HIGH `[T293]` (this is ADR OQ#1)

The bare word **"Event(s)"** denotes the `events` table, while **"Fixed Event" / "Recurring
Event"** denote `fixed_events` rows, and **"Special Events"** is an umbrella over "Event" +
"Special Day". A director sees four sibling-looking labels for three different objects.

- `src/screens/SpecialEventsScreen.jsx:29` — type option `{value:'event', label:'Event'}` (= `events` table).
- `src/screens/SpecialEventsScreen.jsx:471` — row tag `'Event'`; `:489` — button `Delete Event`.
- `src/screens/SpecialSchedulesScreen.jsx:16` — `eventsHeading:'Events'` (= `events` table).
- `src/screens/AnchorsScreen.jsx:262-263` — `eventLabelCap = 'Fixed Event' / 'Recurring Event'`; `:735` — `+ Add Fixed/Recurring Event` (= `fixed_events`).
- `src/components/layout/navSections.js:72-73` — nav rows `'Fixed Events'` and `'Recurring Events'` sit two rows above `'Special Events'` (`:87` → `events` + `special_days`).
- Sharpest instance: nav row **"Special Events"** (`navSections.js:87`) opens a screen whose two type choices are **"Event"** and **"Special Day"** (`SpecialEventsScreen.jsx:29-30`) — so "Special Events" contains a plain "Event", while an unrelated "Events"/"Fixed Events"/"Recurring Events" vocabulary lives elsewhere.

This is the core confusion the ticket exists to resolve and is exactly
`docs/adr/2026-09-26-fixed-recurring-event-identity-model.md` Open Question #1. **Owner decision
required — §5 Decision 1.**

### B. Stale comments deny the T267 `activity_id` column exists — HIGH `[T267]`

Three separate comments assert a column-absence that is **false** as of v77. These will mislead the
PR2 author into thinking there is nothing to cut over — the precise T62-class trap the T267 ADR
warns about.

- `electron/ops/ingest.js:2472-2473` — "An anchor has no activity_id column (there is no such column, and never has been)". The column exists (`schema.sql:805`).
- `src/engine/freeChoiceActivities.js:11-13` — "an anchor references its activity BY NAME … there is no activity_id column".
- `electron/db/schema.sql:552-556` — the `activities.catalog_role` comment repeats "no activity_id column".

Belongs to T267 PR2/PR3 (the cutover that makes them true). Recorded here, not re-ticketed.

### C. Three overlapping classifiers for "what kind of thing is this activity" — MEDIUM `[T293]`

An activity's identity is derived from **different columns in different places**, with no single
authority and one dormant column:

- `fixed_events.kind` (`schema.sql:799`) — scope discriminator (fixed vs recurring).
- `activities.catalog_role` (`schema.sql:563`) — free-choice vs pinned.
- `activities.recurrence_truth_status` (`schema.sql:539-545`) — **dormant: projected but no writer and no engine reader** (`electron/ops/projections.js:261-264`).

The link between a `fixed_events` row and its `activities` row is still **by name**
(`src/engine/anchorActivityLink.js:51-54`) — `activity_id` is honored-first but written by nothing
at runtime (see D). So "is this activity actually a fixed/recurring event?" is answered by
name-join + `catalog_role`, not by the intended `activity_id`. The dormant
`recurrence_truth_status` is a live-schema third classifier that a reader will mistake for
authoritative. **Owner decision on consolidation — §5 Decision 2.**

### D. By-name resolution is still the only live link; `activity_id` written by nothing — MEDIUM `[T267]`

- `src/screens/AnchorsScreen.jsx:146-156` writes name/kind/scope — **no `activity_id`**.
- `electron/ops/ingest.js:2466-2508` (fixed-event write) — no `activity_id`.
- `src/engine/anchorActivityLink.js:51-53` — honors `activity_id` first, falls back to name for
  every real row.

This is the documented PR2-pending state, not a regression, and carries the T62 double-placement
risk until PR2 lands. Owned by T267; recorded for completeness.

### E. `fixed` is absent from the readiness spine while `recurring` is present — MEDIUM `[T293]`

The nav marks **both** `fixedevents` and `anchors` (recurring) `expected:true`
(`src/components/layout/navSections.js:72-73`), promising symmetry. But `src/engine/readiness.js`
has an entry for `anchors` (Recurring Events, `readiness.js:92-93, 174`) and **none** for
`fixedevents`. Consequently the six-state readiness/census layer (Roots) can surface "Recurring
Events needs a look" when empty but is **structurally incapable** of surfacing the same for an
empty Fixed Events collection. Deterministic asymmetry, not opinion.

### F. Events vs Special Days: separate in data, thin and inconsistent in copy — MEDIUM `[T293]`

Per `docs/adr/2026-08-23-override-family-model.md` (and the screen merge in
`docs/adr/2026-08-29-unify-special-events-screen.md`) these are **separate entities unified only at
the authoring surface** — confirmed still separate (`SpecialEventsScreen.jsx:468-471` distinct tags
and delete paths). But the display under-delivers the distinction:

- `SpecialEventsScreen.jsx:34-35` — `emptyMessage:'No special events yet.'`,
  `namePlaceholder:'Name a special day or event…'` collapse both into one umbrella; only a coloured
  tag + a one-word type label distinguish a Field-Day "Event" (own sub-schedule) from a "Special
  Day" (whole-day grid replacement). No copy explains the difference.
- Three label sets across the authoring→build path for the same two entities: "Special Events"
  (`navSections.js:87`), "Special Schedules" (`navSections.js:115`), and the sub-headings "Special
  Days" / "Events" (`SpecialSchedulesScreen.jsx:15-16`).

**Suspicion "events vs special-days may be one concept" is REFUTED** at the data layer — they are
two families (interior-sub-schedule × on-grid-vs-detached, per the override-family ADR). The defect
is display legibility, not a wrong data model.

### G. `anchors` nav key means *recurring*; `fixedevents` means *fixed* — LOW `[T293]`

`navSections.js:72-73`: the key `anchors` drives the **Recurring Events** row and `fixedevents`
drives the **Fixed Events** row — counterintuitive, since "anchor" is the umbrella term for both.
A maintenance trap, not user-facing. Residual "anchor" identifiers across `AnchorsScreen.jsx`,
`anchorScope.js`, `anchorActivityLink.js`, and the persisted `type:'anchor'` / `is_anchor` /
`anchorId` (the last three are **load-bearing persisted values**, so renaming them is a data-shape
change, not a cosmetic sweep — mostly T267 PR3 territory).

### H. Schema version tags stale in comments — LOW `[T267]`

`schema.sql:775` tags `activity_id` "(v75 … renumber at rebase)" and `:546` tags `catalog_role`
"v75"; the actual `activity_id` migration is **v77** (`electron/db/localDb.js:35`). Cosmetic;
T267 PR3.

## 4. Suspicions from the ticket, adjudicated

| Ticket suspicion | Verdict | Evidence |
|---|---|---|
| "Recurring Events reads as optional" | **REFUTED** (current state correct) | `readiness.js:92-93` `expected:true` → empty resting state is `needs-attention`, not `optional`; `navSections.js:73` no `optional:true`. PR #170 lineage is in effect. |
| "events vs special-days is one concept" | **REFUTED** at data layer; real issue is display legibility (Finding F) | separate tags/paths `SpecialEventsScreen.jsx:468-471`; override-family ADR |
| "fixed-event eligibility copy doesn't match behavior" | **REFUTED** — no user-facing copy describes scheduling order; the behavior note lives only in code | `readiness.js:76-79` (code comment only); no contradicting on-screen string found |

## 5. Decisions the owner must make (nothing below is decided here)

**Decision 1 — the two-/three-"event" UI naming (ADR OQ#1, Finding A). HIGH.**
The product needs names that keep three objects distinct to a director: the pinned daily/weekly
items (`fixed_events`), the Field-Day constructs (`events` table), and the whole-day overrides
(`special_days`). Governor's recommendation, offered for the owner to accept or replace, **confidence
medium** (this is a naming/IA call, not a technical one): reserve the bare word **"Event"** for the
`events`-table Field-Day construct only; rename the `fixed_events` surfaces to drop "Event" — e.g.
**"Fixed"/"Recurring"** as *"Daily/Weekly staples"* or *"Pinned items"* (exact wording is
Designer's), and keep **"Special Days"** and **"Special Events"** clearly under one "Special
Schedules" umbrella with the umbrella term used consistently across authoring and build. **If the
owner rules here, the ruling changes labels (behavior-adjacent) and should be captured in a short
follow-up ADR** before the label-change ticket is built.

**Decision 2 — consolidate the three activity classifiers (Finding C). MEDIUM.**
`kind` (scope), `catalog_role` (free-choice vs pinned), and the **dormant**
`recurrence_truth_status` overlap. Governor's recommendation, **confidence medium**: (a) let T267
PR2 make `catalog_role` the single authority for "is this pinned", resolved by `activity_id` not by
name — already T267's plan; (b) **decide the fate of `recurrence_truth_status`** — either wire a
reader or drop the column — because a projected, writer-less, reader-less classifier is a standing
trap (a future author will treat it as authoritative). This is an owner call because dropping a
synced column is a migration and wiring it is a product feature; neither is in T293's scope.

## 6. Follow-ups this spec implies (proposed sequence, not filed here)

1. `[T267]` PR2/PR3 close Findings B, D, H and most of G (already ticketed; T293 files nothing).
2. `[T293-a]` after Decision 1: a short ADR capturing the naming ruling, then a label-change ticket
   for Finding A.
3. `[T293-b]` Finding E — add `fixedevents` to `readiness.js` so the census treats Fixed and
   Recurring symmetrically (small, mechanical, but touches the readiness spine → its own ticket).
4. `[T293-c]` Finding F — display-legibility pass on the Special Events/Special Days/Special
   Schedules copy (Designer-led).
5. `[T293-d]` after Decision 2: wire-or-drop `recurrence_truth_status`.

## 7. What this spec deliberately did not do

- No code changed; no ADR filed. An ADR becomes appropriate **only** once the owner rules on
  Decision 1 (a naming/behavior ruling worth recording) — flagged, not pre-empted.
- No redesign of the scheduling model (ticket non-goal). The definitions in §2 describe what the
  code does today; they do not propose changing it.
- No re-litigation of T267's data-model decisions, which are accepted and partly shipped.
