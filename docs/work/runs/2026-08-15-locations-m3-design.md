---
task: M3 — locations setup screen + picker + migration review (design phase)
document_type: run
date: 2026-08-15
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/current/PLATFORM_STATE.md]
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
related_runs: [docs/work/runs/2026-08-15-locations-m1-create-entity.md, docs/work/runs/2026-08-15-locations-m2-engine-capacity.md]
selected_agents: [governor, designer]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no new structural/schema decision; entity + engine already shipped (M1/M2). M3 is UI over existing state
  - agent: maker
    reason: no-predicate
    note: implementation follows the design spec; dispatched per sub-slice (M3a/b/c) after the design is reviewed
  - agent: verifier
    reason: no-predicate
    note: no code this phase
  - agent: tester
    reason: no-predicate
    note: binds at implementation (director's-eye UX on the running screen)
  - agent: security
    reason: not-applicable
    note: no auth/protocol change this phase
  - agent: red-hat
    reason: no-predicate
    note: binds at the merge sub-slice (M3c) — merging two location rows is a stored-data operation affecting activities that point at them
  - agent: grader
    reason: no-predicate
    note: no gate/opinion panel this phase
  - agent: code-reviewer
    reason: no-predicate
    note: binds at implementation — reviews the M3a/b/c code against this design spec, not the spec itself
deterministic_checks: []
human_gates: [design review by product owner before implementation]
verdict: null
completion_evidence: []
archive_when: superseded by the M3 implementation run records (M3a/b/c)
---

# Run: M3 — locations setup screen + picker + migration review (design phase)

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. This routes the DESIGN phase; each
> implementation sub-slice (M3a/b/c) gets its own run record.

## Brief

**Product outcome:** A director sees and manages *places* in the app for the first time — a Locations
screen where they name places and say how many groups fit; a contextual way to pick (or create) a
place while setting up an activity, so they never leave the work to go administer a facilities list;
and, the first time they open Locations after upgrading, an honest, un-missable reconciliation of what
the migration inferred from their old data.

**Success predicate (design phase):** an accepted design spec + visual prototype exists covering (1)
the Locations setup screen, (2) the activities location picker (typeahead + create-new inline), and
(3) the first-run migration review — grounded in `DESIGN_STANDARD.md`, the Shoresh root metaphor, and
the REAL migration-journal data shape, and reviewed by the product owner before any implementation.

**What does not count as done:** production code (that's M3a/b/c); a prose-only description with no
visual the owner can react to (`feedback_show_me_the_running_ui`); a design that makes locations or the
map mandatory (they stay optional); a design that invents a season concept.

## What M3 must cover (from the ADR M3 row + carried-forward items)

1. **Locations setup screen** — 8th setup entity on `setupCrudRepository` (name, capacity = "how many
   groups fit here at once", notes). Delete via the existing Trash/previewDelete flow. Follows the
   existing setup-screen pattern (`DaysScreen`/`GroupsScreen`) and `DESIGN_STANDARD`.
2. **Activities location picker** — replace `ActivitiesScreen`'s free-text `location` `<input>` with a
   picker: typeahead over existing locations + **create-new inline** (contextual creation — the
   director never becomes a facilities-data administrator). Selecting sets `activities.location_id`.
   This completes the D5 freeze (the app stops writing free-text `location`).
3. **First-run migration review** — surface `location_migration_reviews` (kinds:
   `capacity_disagreement` `{declaredCaps, seededCapacity}`, `was_unlimited`, `near_duplicate`). The
   **near-duplicate merge must be impossible to miss — a first-run gate, not dismissible chrome**
   (ADR migration §c + Red Hat): "Pool and pool look like the same place — merge?" with an explicit,
   reversible merge. Capacity disagreements and was-unlimited are shown before the director regenerates.
4. **Readiness promotion** — move `location` from `FORWARD_AREAS` to `OPTIONAL_AREAS` with a
   `COLLECTION_FOR` binding; **never `REQUIRED_AREAS`** (locations stay optional). Fixes the dead
   Readiness "Review" button (gap 14).

## Engineering notes carried in (for the Maker sub-slices, not the Designer)

- The journal is a **local, non-replicated** table populated only on the device that ran the migration
  (typically the Host) — M3 must **not assume it exists on every device** (Code Reviewer, M1). It also
  has **no read path yet** — M3a adds an IPC/repository read.
- Re-key `useSlotMutations.js` `locationFull` by `location_id` and align its `max_groups_per_slot`
  `!= null` vs `> 0` sentinel with the engine (M2 carried-forward). Closes the generated-route
  drag-into-over-capacity-place blind spot.
- Add the D5 app-wide test asserting no code path writes `activities.location` once the picker replaces
  the free-text input.
- Decide whether a NULL-vs-declared capacity reads as a "disagreement" (kind a) or belongs with
  "was_unlimited" (kind b) — the M1 journal records `[null,3]` as disagreement `[1,3]` (Code Reviewer).

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, decomposition, owner design review |
| Designer | yes | the M3 experience spec + prototype |
| Architect | no | no new structure; entity+engine shipped |
| Maker / Verifier / Tester / Red Hat / Security / Grader | at implementation | dispatched per sub-slice (M3a/b/c) |

## Design review — owner decisions (2026-08-15)

Owner reviewed the interactive mockup (`docs/work/specs/m3-mockup.html`) and **approved the design.**
Spec: `docs/work/specs/2026-08-15-m3-locations-design.md`.

- **D-1 (sidebar placement): as recommended** — Locations after Activities, marked optional, own
  `Next:` chain; Activities' required Next chain untouched.
- **D-2 (capacity-disagreement copy): name the activities if cheap.** Ship "Swim Lessons said 1, Free
  Swim said 3" when the activity-join is free (the review screen already loads activities for the
  gate); fall back to numbers-only if it turns out costly. Resolved at M3c.
- **D-3 (merge gate treatment): as recommended** — a blocking modal the director cannot scroll past.

## Decision

**Design accepted. Proceed to implementation in three slices**, each through the full loop (Tester now
included on the running screen):

- **M3a** — LocationsScreen CRUD (`setupCrudRepository`, CapacityStepper min 1), register in
  SCREENS/Sidebar (D-1), readiness promotion `FORWARD_AREAS → OPTIONAL_AREAS` + fix the dead Review
  button (gap 14). No picker, no review region. Delivers a working *optional* Locations screen.
- **M3b** — activities location picker (typeahead + create-new inline) replacing the free-text input;
  completes the D5 freeze (stop writing `activities.location`, add the app-wide no-write test);
  re-key `useSlotMutations.js` `locationFull` by `location_id` + align the `0`-vs-`>0` sentinel.
- **M3c** — migration review region on the Locations screen + the journal read path (IPC/preload/
  localClient/mock, host-local-safe) + the non-dismissible near-duplicate merge gate (D-3), with the
  D-2 copy. **Red Hat mandatory** (merging two location rows is a stored-data op affecting activities
  that point at them).
