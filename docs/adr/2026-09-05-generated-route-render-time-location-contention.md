---
title: "Generated route gains render-time location-contention detection (extends OVERLAP, does not touch UNFILLABLE)"
document_type: adr
status: proposed
authority: normative
implementation_state: proposed
task_class: scheduling-engine
date: 2026-09-05
supersedes: []
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md
  - docs/adr/2026-08-15-camp-locations-entity.md
amends: []
affects:
  - src/utils/computeOverlaps.js
  - src/screens/ScheduleScreen.jsx
  - src/screens/schedule/useSlotMutations.js
---

# Generated route gains render-time location-contention detection (extends OVERLAP, does not touch UNFILLABLE)

## Status

**Proposed — design only, not yet built.** This document is deliberately filed with `implementation_state: proposed`; it is a technical design for Governor to turn into a Maker brief, not a record of something already shipped.

## Context

### The motivating scenario

A director generates a schedule. The engine places every group's activities respecting each location's capacity (`placeBlocked`, `src/engine/buildSchedule.js:339-350`) — at the moment of generation, the schedule is provably contention-free. The director then, working entirely within the app's intended workflow, builds an afternoon elective set that needs the gym. Nothing on the Generated route today tells the director that the gym is already booked for another group at that time. The contention is real, but invisible, until the director regenerates the whole schedule — which they have no reason to do, because nothing signaled that anything was wrong.

### Why the engine's generation-time guarantee does not hold indefinitely

Two independent things break it, both already true of the shipped app:

1. **The Generated route is explicitly editable.** Its entire purpose (per `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`) is that the director drags-and-drops to adjust what the engine proposed. A drag-and-drop edit is a write that never re-runs the engine.
2. **Underlying data changes after generation, independent of any edit to the schedule itself.** Adding an elective set, changing `locations.capacity`, or reassigning an activity's `location_id` all happen on other screens, on their own timeline, with no connection back to a schedule that already exists.

**Verified: partial mitigation already exists, but only for case 1, and only for the moment of the drag itself.** `src/screens/schedule/useSlotMutations.js` (~line 878-895, the "M3b re-key, round 2" block) runs a write-time check on every Generated-route slot mutation: it counts other groups already booked into the same `location_id` at that `(day, block)` (`coScheduledAtPlace`) against `locations.capacity`, and separately checks the activity's own `max_groups_per_slot`. If either is tripped, the write is still accepted (per Constitution Art. V — the director is never blocked) but the slot's persisted `flags.UNFILLABLE` is set. This closes the sub-case where the *conflicting drag itself* is the thing that creates the overbooking. It does **nothing** for case 2 — a capacity change or a new elective set made from a different screen, days later, that never touches this slot's own write path. That is the actual gap this ADR closes.

### Verified: the "engine doesn't see elective/anchor/event locations" premise is now false

An earlier note (`project_unified_schedule_overlay_model` memory, Slice 4) recorded that anchor/event/elective cells in the engine never registered their location in the capacity map. **That gap has since been closed.** `src/engine/buildSchedule.js:212-218` defines `registerOverlayOccupancy(locId, ...)`, which writes into the same `placeUsage` map that `placeBlocked` reads, and it is called for anchors (`:238`), events (`:251`), and elective offerings (`:280`). Anchor/event location columns exist (`anchor_activities.location_id`, `events.location_id`, schema v45) with a UI to set them (`LocationPicker`, merged). The engine's generation-time capacity check is therefore already correct across all four occupant kinds (regular activities, anchors, events, electives) — the problem is exclusively that this correctness is a single point-in-time fact that nothing re-checks afterward.

### Correction (post-review, same date): the elective-occupancy premise below is now stale

**This section originally claimed `computeOverlaps` had no knowledge of `elective_set_id` occupancy at all. That is no longer true and was already fixed before this ADR was filed as `proposed`** — commit `d376fe3` ("count elective occupancy in location-contention checks", merged as `0cea17b`) added exactly this: `computeOverlaps` now resolves an elective slot's offerings to their real locations (via `resolveElectiveOfferingLocations`, mirroring the engine's own `registerOverlayOccupancy` derivation) and buckets them into the same per-`(day, block, location_id)` place-capacity count as regular activities. See `src/utils/computeOverlaps.js` (the `elective_set_id != null` branch) and its test coverage in `src/utils/computeOverlaps.test.js` (the elective-occupancy tests). The paragraph below is left in place, struck through in spirit, purely as a historical record of what motivated the design — do not treat it as current fact.

~~This is the load-bearing finding of this design, and it changes what "just turn OVERLAP on for Generated" would actually do. `src/utils/computeOverlaps.js:44` — the function that computes Manual's `OVERLAP` — begins:~~

```js
for (const s of slots) {
  if (s.is_anchor || !s.activity_id) continue
  ...
```

~~It only considers slots with `activity_id` set. It has no knowledge of `elective_set_id` or `event_id` occupancy at all. So today, on Manual, an elective set and a regular activity contending for the same gym already go undetected by `computeOverlaps` — the elective side of that pair is invisible to it. Applying `withOverlapFlags` unchanged to the Generated route would not solve the motivating scenario (an elective set vs. a placed activity in the gym); it would only catch two `activity_id`-based bookings clashing.~~ **Elective occupancy is now handled (see correction above). `event_id` occupancy remains deliberately out of scope — see the new Non-goal below, not a gap to close.**

### Anchor semantics (shipped, same date, in the branch that also fixed elective occupancy)

A companion fix, landed in the same branch as this ADR's filing, settled how `computeOverlaps` treats anchors — a question this ADR's original text left implicit by grouping anchors with "overlay occupants" generally (see the now-corrected `event_id`/anchor phrasing in the Decision section below). The shipped rule, **not** "count the anchor as an ordinary occupant":

- An anchor is immovable declared truth about where a group is, and is **never itself flagged**.
- A place-capacity or activity-cap bucket made **entirely of anchors** (the canonical case: every group's Flagpole anchor, all at the same capacity-1 Flagpole location, every day) is **never flagged**, at any count — this is correct by construction, not an overbooking, and naive occupant-counting would wallpaper every Flagpole cell in every imported camp.
- A **mixed** bucket (an anchor plus a non-anchor placement) counts the anchor toward the capacity total (an anchor already filling a capacity-1 place makes any additional non-anchor booking over capacity) but flags **only the non-anchor rows** — the anchor can't move, the placement can.
- Anchor-vs-anchor is never a conflict.

This does not change any recommendation below, but any future extension of `computeOverlaps` (including whatever comes out of this ADR) must preserve this rule rather than reverting to the simpler "anchors are just another occupant" model the Decision section's `event_id`/anchor phrasing could be read to imply.

### Reconciling with the deferred flag-lifecycle work

A separate deferred item (`project_schedule_flag_lifecycle` memory, "4 flag kinds, 3 lifecycles, reads arbitrary — needs its own ADR") flagged that `UNFILLABLE` (persisted, dismissible, generated-only), `OVERLAP` (derived, non-dismissible, manual-only), and `UNDERSERVED`/`DISTRIBUTION` (in-memory-only aggregate findings) already read as arbitrary to a director, even though each is principled on the schema side. **This ADR is a concrete instance of that deferred question, not a separate track.** It does not attempt to resolve the full lifecycle question (that remains its own product decision — see Open Questions), but it must not make the inconsistency worse, and where it can reduce it (see Decision, below) it should.

## Decision

### Recommendation: extend `computeOverlaps` to cover overlay occupancy, then apply it on both routes

**Confidence: medium-high.** The direction (contention detection should be a route-agnostic fact about current data, not a route-specific verdict) is well-supported by every one of five independently-generated design frames (see Divergence, below) converging on some form of "recompute continuously / on both routes," and the code-level extension follows an existing, already-shipped pattern (`registerOverlayOccupancy`) almost exactly. The medium (not high) qualifier is because the actual sizing of "does this read as noisy or as helpful to a director" needs real-data / Tester validation, not just architectural reasoning — flagged as an open question below.

**What changes:**

1. **`computeOverlaps` (`src/utils/computeOverlaps.js`) gains occupant-kind awareness.** ~~Today it buckets rows by `(day, block, location_id)` derived from `activity_id → actMap → location_id`, skipping anything without an `activity_id`. It must instead resolve a location for any occupied slot kind — `activity_id`, `elective_set_id`~~ **Corrected: `activity_id` and `elective_set_id` occupancy are both already handled — see the correction note in Context above.** Anchor occupancy (via `is_anchor`) is also now handled, with the anchor-specific semantics described in that same section (never flag an all-anchor bucket; flag only the non-anchor rows of a mixed bucket) — **not** by treating an anchor as an ordinary occupant. ~~and `event_id`/anchor occupancy the same way `registerOverlayOccupancy` does~~ — **`event_id` occupancy is a deliberate non-goal, not a remaining gap; see the Non-goal below.** The activity-cap bucket (`max_groups_per_slot`) mirrors the same anchor treatment (all-anchor bucket never flagged, mixed bucket flags only non-anchor rows) and stays activity-only otherwise, since instructor/equipment caps are a property of the activity, not of overlay occupants.

**Non-goal: `event_id` occupancy is explicitly excluded from contention, by product decision, not by oversight or future work.** The product owner has ruled that events are deliberately outside the normal course of the schedule ("they are not supposed to be tied to the schedule because they are outside the normal course of events") and must not register as location occupants for `OVERLAP` purposes. This ADR's Decision, Files/modules affected, and Open Questions sections below were originally written recommending `event_id` be folded into the same occupant-kind-aware bucketing as `elective_set_id` and anchors; that recommendation is withdrawn. Any future work must not add event occupancy to `computeOverlaps` without a new product decision superseding this one.

2. **`withOverlapFlags` runs on the Generated route too**, not gated by `route === 'manual'` (`src/screens/ScheduleScreen.jsx:194-195`). It stays a pure, render-time, non-persisted derivation exactly as it is on Manual today — no new column, no new IPC call, no new write path. It is recomputed from whatever `slots`/`activities`/`locations` are already in memory for that screen, so it naturally picks up both failure modes: a stale drag-and-drop edit and an out-of-band data change (a new elective set, a lowered capacity, a relocated activity), because all of those are already reflected in the `locations`/`activities` arrays the screen already loads.

3. **`UNFILLABLE` is untouched.** It keeps its current meaning and lifecycle exactly as-is: a persisted, dismissible record of what the engine (or a write-time capacity check) determined at the moment a placement was made. `OVERLAP` keeps its current meaning too: a live, non-dismissible statement about whether the schedule as currently rendered is contended, independent of when or how it got that way. Extending `OVERLAP`'s reach to the Generated route does not blur this distinction — if anything it sharpens it, because it makes explicit that `UNFILLABLE` answers "was this placement flagged when it was written" and `OVERLAP` answers "is this cell contended right now."

### Do `OVERLAP` and `UNFILLABLE` co-occur, and does that read as contradictory?

They can legitimately co-occur, and that is not a bug to design away — it is two true, distinct facts about the same cell:

- A slot dropped into an already-full room on the Generated route gets `UNFILLABLE` at write time (existing mechanism) **and** would also show `OVERLAP` at render time (new) for as long as the room stays over capacity. These are not contradictory; they are the same fact reported by two different mechanisms with two different lifecycles — `UNFILLABLE` is "this was a bad placement when it happened" (persists until dismissed, even if the room frees up later), `OVERLAP` is "this room is over capacity right now" (clears itself the instant it's true, no dismiss state).
- **The genuinely new case this ADR exists to catch — an elective set added after generation — produces `OVERLAP` only, never `UNFILLABLE`**, because nothing wrote to that slot; the room simply became contended out from under it. This is the case with no existing signal at all today, and it is the one that matters most for the motivating scenario.

**What this means to a non-technical director, in the app's own terms, is the real test, and it holds up:** `UNFILLABLE` reads as "the schedule couldn't legitimately put someone here" — a placement problem. `OVERLAP` reads as "too many groups need this room at once" — a room problem. A director who sees both on one cell learns two true things: the activity assignment itself was flagged, *and* the room is also double-booked. That is more informative than confusing, provided the Findings Rail (see Files/modules affected) labels them distinctly rather than merging them into one undifferentiated red mark.

## Divergence: candidates considered

Five isolated cognitive-frame ideation passes (regulator, inversion, 3am-on-call, remove-load-bearing-assumption, biology — full transcripts available on request) were run independently before converging. Despite having no visibility into each other, they converged strongly on one theme: **a one-time, generation-time guarantee is structurally the wrong shape for a value that keeps changing; some form of continuous or event-triggered re-derivation is required, whether or not the flag vocabulary itself changes.** The concrete candidates that emerged, clustered by angle:

**Recompute-continuously plays** (regulator, 3am, biology, remove-assumption all converged here independently):
- (a) **Apply render-time contention on both routes** — reuse/extend the existing `OVERLAP` mechanism. ★ *chosen*
- Homeostatic/"always-on thermostat" framing (biology) — same conclusion from a different vocabulary: correction must be continuous, not a single injected dose.
- Event-triggered recompute on every relevant write (elective creation, capacity edit, location reassignment) pushing a notification rather than waiting for a render (3am, remove-assumption) — a genuinely different delivery mechanism for the same underlying fact.

**Staleness/certificate plays** (regulator, inversion):
- (b) **Keep the split, add a staleness signal** ("data changed since generation, review before use") computed from a hash/version of the generation-time inputs, shown as a banner rather than a per-cell flag.
- "Confidence expiry" gating export until re-verified (regulator) — ties into the fact that export is already the app's one mandatory decision point (`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`).

**Scope-to-what-changed plays** (3am, remove-assumption):
- (c) **Derive contention on Generated only for overlay-caused clashes** (electives/events/anchors), since those are exactly the things that change independently of the schedule itself, while activity-vs-activity contention stays engine-guaranteed. A genuine option, rejected below.
- Diff current slots against the last-generation snapshot and only flag *new* drift, so regeneration silently absorbs old contention (3am) — an optimization on top of (a), not a different destination.

**Unify-the-vocabulary plays** (remove-assumption, inversion):
- (d) **Retire the route-specific flag vocabulary entirely**, replacing `UNFILLABLE`/`OVERLAP` with one shared concept. Rejected below — see Karpathy reasoning.

**Traps identified and rejected:**
- *Lock location fields post-generation so drag-and-drop can't create contention* (inversion) — directly defeats the Generated route's stated purpose (editability by drag-and-drop); a non-starter product-wise, not just an engineering one.
- *Trust regeneration to eventually fix drift* (inversion) — unbounded; the director has no signal telling them regeneration is overdue, so "eventually" never actually arrives.
- *Full engine re-validation synchronously on every keystroke-level edit* (inversion) — too expensive for a drag-and-drop UX; the existing write-time `locationFull` check in `useSlotMutations.js` already does the cheap, targeted version of this for the one case where it's affordable (the write itself), and this ADR does not propose replacing it.
- *Make regeneration near-free so staleness never accumulates* (remove-assumption) — attacks a true architectural pain point (regeneration is a discrete, director-invoked, non-incremental operation) but is a much larger undertaking than the stated problem calls for; out of scope here.

### Why (a) over (b) and (c), and why not (d)

- **Against (c), scoping only to overlay occupants:** tempting, because overlay occupants are indeed the volatile part. But activity-vs-activity contention on Generated is *not* actually permanently safe either — a director can drag one regular activity on top of another regardless of what the engine originally placed, and `locationFull` at write time only catches that at the moment of the specific drag, not if the *other* slot moves later or a capacity is lowered afterward. Scoping to overlay-only would leave a real, reachable gap for no complexity savings, since the extended `computeOverlaps` handles both occupant classes with the same bucketing logic once it's occupant-kind-aware at all.
- **Against (b), a staleness banner instead of a per-cell flag:** weaker as a signal — it tells the director "something changed, go look," not "here, this room, these two groups." Manual already gives directors the sharper per-cell signal; giving Generated a vaguer one for the same underlying fact reintroduces exactly the "why does this route work differently" friction the deferred flag-lifecycle note is about. A staleness banner is not rejected outright — it is a reasonable **complement** (see Open Questions) for signaling drift a director hasn't scrolled to yet, but it should not substitute for the per-cell fix.
- **Against (d), retiring the route-specific vocabulary:** this is the smallest-responsible-solution violation. The plural-candidate-schedules ADR deliberately kept `UNFILLABLE` and `OVERLAP` distinct because they answer genuinely different questions (an engine verdict recorded at write time vs. a live derived fact) — that distinction is doing real work and this ADR's own reasoning above (on co-occurrence) depends on it still existing. Unifying the vocabulary is a bigger, riskier redesign than the stated problem requires, and it is exactly the kind of decision the deferred flag-lifecycle ADR should own deliberately, not something to fold in as a side effect of closing a data-freshness gap.

## Files/modules affected

- **`src/utils/computeOverlaps.js`** — ~~extend the place-capacity bucketing loop to resolve a location for `elective_set_id` and `event_id`/anchor occupants (not just `activity_id`)~~ **corrected: `elective_set_id` occupancy and anchor occupancy (with anchor-specific never-flag/mixed-bucket semantics, not naive counting) are both already shipped — see corrections in Context above. `event_id` occupancy is an explicit non-goal, not remaining work.** Function stays pure, stays render-time, stays unpersisted.
- **`src/screens/ScheduleScreen.jsx`** — remove the `route === 'manual'` gate around `withOverlapFlags` (`:194-195`) so it runs on both routes; the `overlapSlots`/Findings Rail logic at `:584-592` currently hard-codes `isManual` for whether `OVERLAP` findings are shown at all — that gate must also be lifted, and the Findings Rail row rendering (`:635-637`) should keep `UNFILLABLE` and `OVERLAP` visually and textually distinct (they already use different `kind`s and reasons; no new work needed there beyond not suppressing `OVERLAP` on Generated).
- **No change to** `electron/main.js`, any IPC surface, `electron/db/schema.sql`, or the op-log. This is a pure-function/render-path change only.
- **No change to** `src/screens/schedule/useSlotMutations.js`'s existing write-time `locationFull` check — it keeps doing what it does (flagging `UNFILLABLE` on the specific drag that creates overbooking); this ADR adds a second, independent mechanism for the cases that check can't see.

## Reused vs. new

**Reused:** `computeOverlaps`/`withOverlapFlags` (existing, extended not replaced), the `OVERLAP` flag kind and its Findings Rail plumbing (existing), the overlay-occupant-to-location derivation pattern (`registerOverlayOccupancy`, existing in the engine, applied to a second consumer), `locations.capacity` and `activities.location_id`/`elective_set_activities`/`anchor_activities.location_id`/`events.location_id` (all existing schema, no migration).

**New:** the occupant-kind-aware bucketing inside `computeOverlaps` (genuinely new logic, but same shape as existing code elsewhere in the repo — not a new concept for this codebase, a second application of one). No new persisted state, no new flag kind, no new table, no new IPC method, no new file.

## ADR required: yes

This is filed as an ADR (this document) because it changes behavior an existing, accepted ADR (`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`) deliberately specified — that ADR's explicit design intent was "`OVERLAP` on manual only." Even though this change touches no schema and no persisted contract, it revises a documented architectural decision about where a derived value is allowed to appear, which meets this project's ADR bar as a decision "other code will depend on" and a change to "an existing contract other modules already call" in spirit (screens already branch on `route === 'manual'` in multiple places keyed to this exact distinction). The decision is also not obviously reversible in practice once directors start relying on the signal, per the constitution's third ADR trigger.

## Open questions for Governor

1. **Dismissibility/lifecycle policy.** This design keeps `OVERLAP` non-dismissible on Generated, matching Manual today. Is that the right call for Generated specifically, where a director may be mid-edit and already aware of a contention they're about to resolve? This is a product decision, not a technical one, and it is exactly the deferred flag-lifecycle question (`project_schedule_flag_lifecycle`) — recommend Governor decide whether to fold this ADR's shipping into that lifecycle decision, or ship this narrower fix first and let lifecycle work land later on top of both routes uniformly.
2. **Is a staleness banner also wanted, as a complement?** Several divergent frames independently proposed surfacing "this schedule's inputs changed since it was generated" as a screen-level signal in addition to the per-cell fix. This ADR does not require it, but it is cheap to add later and would help a director who hasn't scrolled to the affected cell. Worth a product decision on whether it is wanted in the same release or deferred.
3. **Real-data validation of noise.** Does turning `OVERLAP` on for Generated produce a reasonable number of flags on the ADR's own test camps, or does closing the "engine/electives register occupancy" gap (already shipped, per Slice 4) plus this render-time check together surface a wave of pre-existing contention that reads as overwhelming on first render? Recommend a Tester pass on real camp data before shipping to non-technical directors, not just unit-test coverage of `computeOverlaps`.
4. **Should the write-time `locationFull` check in `useSlotMutations.js` also become overlay-aware** (currently it only checks `activity_id`-keyed co-occupants — `computeOverlaps` has since closed this gap for elective and anchor occupancy, per the corrections above, but `useSlotMutations.js`'s write-time check has not been revisited), so that a drag onto an elective-occupied room is caught at write time too, not just at next render? **Events remain out of scope here too, per the Non-goal above.** This is a smaller, closely related fix, worth deciding whether it ships alongside this ADR or as a fast-follow — flagging rather than deciding, since it is a scope call, not an architecture call.
