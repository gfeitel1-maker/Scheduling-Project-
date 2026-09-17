---
title: "Individual elective scheduling — campers as a participant layer inside elective containers"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-09-17
approved: 2026-09-17 (owner, after the premise audit, red-hat and security review, and rulings on all seven open questions)
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - SECURITY.md
supersedes:
  - docs/adr/2026-08-20-electives-authoring.md
  - docs/adr/2026-08-22-nested-schedules-electives-and-events.md
affects:
  - electron/db/schema.sql
  - electron/ops/projections.js
  - electron/automerge/campDocument.js
  - electron/auth/permissions.js
  - src/engine/buildSchedule.js
  - scripts/mcp/tools.js
  - SECURITY.md
related_specs:
  - docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md
related_tickets:
  - docs/work/tickets/T192-elective-governance-gate.md
  - docs/work/tickets/T193-overlay-reconstruction-and-route-validator.md
  - docs/work/tickets/T194-participant-data-substrate.md
  - docs/work/tickets/T195-preference-import-service.md
  - docs/work/tickets/T196-assignment-engine.md
  - docs/work/tickets/T197-projection-and-export.md
  - docs/work/tickets/T198-machine-access-adapters.md
  - docs/work/tickets/T199-individual-electives-end-to-end.md
  - docs/work/tickets/T200-camper-record-purge-path.md
---

# Individual elective scheduling

**Status: accepted (owner, 2026-09-17).** This ADR was the owner gate and it is satisfied. Owner
rulings on all seven open questions are folded into the decisions below.

**Approval covers the decisions, not a licence to start building.** Feature slices T194–T200 remain
unauthorized pending their own sequencing. The only slice authorized on acceptance is **T193**,
which is severable (D7) and fixes pre-existing defects on shipped surfaces. No feature code may be written until it is
accepted. The two ADRs it supersedes explicitly prohibit campers, preference data, and a solver;
implementing without this decision would violate them.

## Context

The owner supplied an implementation brief on 2026-09-17
(`docs/work/handoffs/2026-09-17-individual-elective-scheduling-handoff.md`) reversing a settled
product decision: individually-chosen electives should produce real per-camper assignments, child
schedules, and activity rosters — not just offerings and headcounts.

The existing nested-elective model is the right container and is kept. `elective_sets` defines what
may run in an elective period; `elective_set_activities` are the offerings and carry capacity;
`template_slots.elective_set_id` places the container on the group grid; `buildSchedule.js` treats
the cell as authored and reserves each distinct offering location. What is missing is the
participant layer *inside* the container.

A premise audit of the brief against this tree (recorded in the spec, §1) confirmed most of its
claims and corrected several. The corrections that change a decision are carried below.

## Decision

### D1 — Supersede the prohibitions, preserve the abstraction

The following are superseded and no longer binding:

- `2026-08-20-electives-authoring.md` "Non-goals": *"Campers as records, per-camper rosters,
  choice/preference data, any solver."*
- `2026-08-22-nested-schedules-electives-and-events.md` §2: *"No `campers` roster"* and
  *"No solver."*

Everything else in both ADRs **survives unchanged** and is re-affirmed: the nested-schedule
abstraction (§1 of 08-22), create-in-context authoring (D1 of 08-20), the durability tiers (D2),
capacity/eligibility as first-class on the offering (D3), the atomic cell-content-kind resolution
of the elective/activity mutual-exclusion race (D4), the ingest nudge being director-confirmed and
never silent (§4), and the exclusion of `elective_sets` from `INGESTIBLE_ENTITIES`. This is a
narrow reversal of four prohibitions, not a replacement of the elective design.

Amendment rather than supersession was considered and rejected: a "non-goals" list that no longer
holds is not a detail to patch in place, and both ADRs state the prohibition in their own
`Consequences`. A reader must land on one current document.

### D2 — Owner decisions recorded

1. The preference form stays **external**. Shoresh does not build or host it.
2. Shoresh **may** store minimal camper identity and group membership for scheduling purposes.
3. Shoresh **may** store ranked preferences and generated/manual assignments.
4. The **director** chooses week, schedule route, division, offerings, mapping resolutions, manual
   changes, and finalization. Nothing is inferred.
5. The engine **may** allocate campers inside elective containers. It still does not decide which
   offerings the camp runs, and it never touches the group grid.
6. Staffing and delivery to parents remain out of scope and unbuilt.
7. Neither Manual nor Generated is ever canonical. A run names its template explicitly and that
   choice is never remembered as "the" schedule.

### D3 — Capacity gets an explicit "no limit" option; `0` means zero

The 2026-08-22 ADR §2 instructed: *"treat null / negative / non-int as 'no cap'"*. That was right
while the field was inert display data and wrong once it governs where a child goes. But the fix is
**product representation, not validation**: overloading `null` (or `0`) to mean "unlimited" is what
created the ambiguity in the first place.

**Decision (owner, 2026-09-17): add an explicit "no limit" option to the offering.** Capacity
becomes a two-part value — a limit *mode* and, when limited, a number.

- "No limit" is a thing the director **chooses and can see**, not the absence of a value.
- `0` therefore means a real **zero / closed** offering. It is no longer ambiguous and no longer
  blocks.
- Negative or non-integer remains `INVALID_CAPACITY` and blocks generation.

The UI must make the distinction unmissable — a director must never be able to look at an offering
and be unsure whether it is uncapped or closed. This removes the failure mode where a director who
typed `0` meaning "no limit" is blocked the night before camp.

**Existing data.** `electron/db/schema.sql:1020` declares `camper_headcount INTEGER` with no
DEFAULT and no CHECK. Rows exist that were written under the old semantics. T194 **surveys and
reports** what it finds; it does not rewrite. Every existing row keeps a defined meaning under the
new representation, and the migration states the mapping it applies rather than inferring intent
per row.

### D4 — Assignment uniqueness is enforced by construction, not by a uniqueness check

Red Hat's HIGH finding: the brief's invariant "exactly one `elective_assignments` row per
camper/occurrence" is **not enforceable** by the existing collision machinery.
`UNIQUE_FIELD_ENTITIES` (`electron/ops/operations.js`) expresses only single-column uniqueness
scoped to one column; a `(run_id, camper_id, occurrence_id)` composite cannot be registered. Two
devices generating the same draft run concurrently would create two rows with *different* ids,
which merge as two independent records — no field-level conflict, no `conflicts` row, a camper
silently assigned twice, and the projection picking one by iteration order.

**Decision: make the row's identity the invariant.** The `elective_assignments` primary id is a
**deterministic derived id** — a stable hash of `(run_id, camper_id, occurrence_id)` — using the
same discipline as `deriveScheduleTemplateId`. Two devices generating the same assignment produce
the *same* row id, so the write becomes an ordinary per-field last-write-wins on one record, which
the existing conflict machinery already serializes and can surface as a `conflicts` row. This
removes the duplicate class by construction rather than guarding it, exactly as D4 of the
2026-08-20 ADR chose for cell content-kind.

`elective_preferences` takes the same treatment, derived from
`(run_id, camper_id, occurrence_id, activity_id)`.

This is a hard requirement on T194, not an implementation preference.

### D5 — Generation is a single atomic operation, and a run has one generating device

Concurrent generation of the same draft run remains dangerous even with D4: two devices can produce
internally consistent but mutually incompatible *sets* (each within capacity alone, over capacity
merged), and per-field LWW cannot detect a set-level violation.

**Decision:** a generation writes a `solver_generation` marker on the run (device + monotonic
counter) in the same operation batch as the assignments it produces. On apply, assignments whose
`solver_generation` does not match the run's current marker are **inert** — not deleted, but
excluded from projection and surfaced as a `SUPERSEDED_GENERATION` finding telling the director to
regenerate. A run therefore always projects exactly one coherent generation. Losing a race costs a
regenerate, never a silently wrong roster.

### D6 — Staleness is fingerprinted narrowly, and finalization snapshots

Red Hat's analysis of the brief's fingerprint proposal: fingerprinting the whole template produces
false staleness (any unrelated edit invalidates the run, teaching the director to ignore the
warning); fingerprinting only the elective occurrences produces false cleanliness (a non-elective
cell that newly collides with an offering's location goes undetected).

**Decision — both, with different consequences.**

- The **occurrence fingerprint** (set + day + block + tier for each derived occurrence) changing
  is `STALE_OUTER_SCHEDULE` and **blocks** finalization. The run's premises moved.
- A **location-occupancy change** anywhere on the route is re-validated by the route-wide validator
  (D7) at finalization time and reported as `OUTER_RESOURCE_CONFLICT`. It does not mark the run
  stale; it blocks finalization on its own terms with a message naming the colliding cell.
- Unrelated edits produce neither.

**Generation always re-derives occurrences from live `template_slots`** and compares against the
run's recorded snapshot. Red Hat is right that the more common trigger is single-device,
same-session (edit the grid, come back, hit Generate) — so the re-derivation is what detects it,
and the UI must offer "re-derive and regenerate" at that moment rather than only blocking.

**Finalization snapshots.** Red Hat's finding that a finalized run's exported child schedule would
silently change — because non-elective cells are derived from live `template_slots` at read time —
is accepted. This is a genuine tension with the brief's "derived rather than stored" principle,
and it resolves in favour of storage **at finalization only**: finalizing writes a denormalized
snapshot of the outer schedule cells the run's campers occupy. A draft run derives; a final run
reads its snapshot. A finalized run therefore remains exportable and byte-stable even if the
template is later edited or deleted. Drafts stay fully derived, so the principle holds everywhere
it can.

### D7 — Route-wide resource validation is a precursor, landed independently

`src/engine/buildSchedule.js:874` returns `conflicts: []`; a cohort loop exists at `:862-870` but
cross-cohort conflict detection is unimplemented. Assignments may not finalize against a schedule
whose location conflicts are undetected.

A route-wide validator operating on concrete location/day/block occupancy from regular activities,
anchors, events, and elective offerings is required. It **reports**; it never moves groups or
removes offerings.

The related MCP defect is broader than the brief states. `scripts/mcp/tools.js:136` filters
preplaced slots with `.filter((s) => s.activity_id && !s.is_anchor)`, dropping elective and event
overlays — but fixing that filter alone is insufficient, because
`electron/ops/scheduleEngineInputs.js:26-53` never assembles `electiveSetActivities` or `events` at
all. Both must be fixed together or an MCP caller keeps receiving a falsely clean state.

**These are pre-existing defects on shipped surfaces.** They are scoped to T193 and land
independently of the owner gate on the rest of this ADR (see Open Question 3).

### D8 — Data footprint: a sorting problem, deliberately scoped

**This is a sorting problem, not an intake system.** The camp already knows these children. What
the feature adds is a way to sort them into offerings they chose. The design carries **no contact
details, no medical data, no date of birth, no household or parent records** — and must not, even
when the source spreadsheet contains them. The importer does not offer to map such columns.

The stored footprint is the whole footprint: display name, group membership, optional external id,
ranked preferences, assignments. That is a **design constraint**, kept because a small footprint is
better engineering, not a compliance posture. Do not build privacy ceremony around it beyond what
D9, D10, and the encryption precondition below require.

**Owner decision, 2026-09-17:** review flagged that a child's name combined with their location by
time block is personal data in the regulatory sense; the owner considered that framing and accepted
the risk knowingly.

**At-rest encryption — hard precondition.** At-rest encryption is implemented but inert
(`SECURITY.md` §T175/T179; `SHORESH_AT_REST_ENCRYPTION` defaults off, and `docStore.js` takes an
optional cipher that is `null` by default). Therefore:

> **This feature may be built, tested, and demonstrated against fixture data. It may NOT be used
> with a real camp's camper data until the owner records a dated acceptance.**

This is a visible release gate, not a footnote. T199 carries it as a blocking precondition and it
must be stated in the feature's own UI entry point, not only in documentation.

### D9 — The whole participant domain is admin-only; staff consume the export

**Owner decision, 2026-09-17:** *"the export of this is what day-to-day staff would see. Camp
admins are the people doing the behind-the-scenes work."*

The distribution mechanism for staff is the **exported artifact** — the activity roster and the
child schedule a counsellor holds — not a read grant on the entities. Import, resolve, generate,
override, finalize and export are all **admin**. No non-admin role has any in-app read path to any
of the five entities.

| Entity | admin | staff |
|---|---|---|
| `campers` | full | none |
| `elective_preferences` | full | none |
| `elective_assignment_runs` | full | none |
| `elective_occurrences` | full | none |
| `elective_assignments` | full | none |

*Superseded: an earlier draft of this ADR defaulted staff to reading finalized activity rosters
in-app. The owner replaced that with the export model above. Recorded rather than deleted, because
the reasoning changed rather than being found wrong.*

**Why this keeps the entities out of `ENTITIES`.** Not privacy — product shape.
`electron/auth/permissions.js:74` derives `staffReadWrite` by flatMapping every entity in
`ENTITIES` into `<entity>.read` **and** `<entity>.write`. Registering these five there would grant
staff read and write over a surface **no staff member is meant to touch at all**. There is no
partial registration: the flatMap is unconditional and there is no per-entity opt-in. So the five
follow the `camp_maps` precedent (`permissions.js:112-121`) and are deliberately kept out, with
hand-written admin-only entries.

The parity test guards *omission* (a camp-scoped entity missing from `ENTITIES` silently resolving
to admin-only) and cannot catch an over-grant. So a test must assert the **negative** — staff hold
no `campers.read`, no `campers.write`, no `elective_preferences.read`, no
`elective_assignments.read`.

Per-record history and Trash are staff-readable for every entity today
(`permissions.js:104-111`); for these five they are admin-only, for the same reason. Separately, no
camper field value may be passed into `recordAuditEvent` metadata — `SECRET_KEYS`
(`electron/audit/auditLog.js:1-9`) is a key-name blocklist, not a PII filter, and `audit_events` is
append-only.

**How export is gated today, stated rather than inherited.** The existing schedule export is a
**renderer-side utility** (`src/utils/exportSchedule.js`, `exportScheduleJson.js`) called from
`src/screens/ScheduleScreen.jsx`. It is not behind an `authorize()` call; it operates on data the
renderer already loaded, so it is gated implicitly by who can read the underlying entities. Staff
can export the group schedule today because staff can read schedule entities.

For this feature that implicit gating produces the right answer by construction: staff hold no read
on the participant entities, so the elective export is **not reachable by a non-admin role in the
app**. The artifact is produced by an admin and handed to staff out of band — printed, shared, or
posted. **That is the design, stated deliberately.** T197 must not add a staff-reachable export
path, and must not assume the absence of an `authorize()` call means the export is open.

### D10 — A real purge path exists; Delete is permitted, and states its cost

An earlier review claimed erasure was impossible here. **That was wrong and is corrected, not
softened.** Verified against the tree:

- The SQLite projection delete is a **real `DELETE`**, not a soft flag —
  `electron/ops/projections.js:820-834` runs `DELETE FROM <table> WHERE <key> = ?` on the
  `__deleted__` sentinel. No `deleted_at` column exists on the modeled entities.
- `electron/automerge/rebuildSupportCommand.js:126-175` deletes the SQLite file plus its `-wal` and
  `-shm` and recreates from schema — this is the only existing path that erases `operations` rows.
- Regenerating the frozen `GENESIS_B64` (`electron/automerge/campDocument.js:254`) produces a
  genuinely new document with no prior history. The project has done this five times.
- An offline peer cannot re-introduce purged data: `sharesGenesis()` (`campDocument.js:322-330`) and
  `electron/sync/automerge/syncNode.js:147-153` **refuse and drop** a document that does not share
  genesis, even from an admitted peer. It must re-pair.

**Therefore a real Delete is permitted.** The requirement is honest copy: the control must state
that a full purge requires a coordinated rebuild — every `.automerge` file is invalidated and every
device re-pairs — rather than implying a single click erases the record everywhere.

What the path cannot reach: any `.automerge` file already copied off-device, and a peer that never
rebuilds or re-pairs. Both are stated plainly rather than papered over.

**Two steps do not exist and must be built** — see T200, which owns this procedure:

1. There is **no op-log prune**. Nothing anywhere deletes from `operations`; the only existing
   erasure is the whole-file rebuild above.
2. There is **no runtime genesis regeneration**. It is a source edit plus a release, not an
   operation a director can perform.

And one trap that would silently defeat a purge: `writePreMigrationBackup()`
(`electron/db/projectManager.js:151-158`) writes a complete copy of the pre-rebuild database —
op-log included — to `<dbPath>.pre-migration-<ts>.bak`, and **nothing ever deletes it**. A purge run
through the existing rebuild tool leaves the entire pre-purge database next to the live one. T200
must handle this explicitly.

### D11 — Min-cost max-flow is retained

Red Hat asked whether greedy-by-rank would do. Assessed honestly: for a camp of ~200 campers across
~6 offerings, greedy is far simpler and would satisfy most campers most of the time. What flow buys
is a **guarantee** — a provably optimal assignment under the stated cost function — and, more
practically, the absence of a failure mode that is very hard to explain to a director: greedy can
leave a camper unassigned while a feasible assignment existed, and no amount of staring at the
screen reveals why. "The computer could have given Sara her third choice and didn't" is a trust
failure in a product whose whole value is director trust.

Retained, with the cost of ownership acknowledged: the policy constants live in one exported
object, pinned by tests, not editable through MCP, and the module is pure with no I/O. If flow
proves to be a maintenance burden, swapping the allocator behind that pure interface is a
contained change — which is itself an argument for the interface, not against the algorithm.

### D12 — Linked multi-period choices are modeled up front

The brief proposed failing closed on linked choices in v1. **Rejected (owner, 2026-09-17):**
multi-block periods already exist throughout the app and directors already create them, so a v1
that cannot express "sign up for both periods" would need retrofitting into a shipped assignment
table.

Verified against the tree, with one correction the owner's premise does not cover — **spans exist,
but electives are explicitly excluded from them**:

- A span is N sibling `template_slots` rows: a head plus tails carrying the same content field with
  `is_span_head = false` (`electron/db/localDb.js:328-330` added the column at v10;
  `collectSpanTails()` at `src/screens/schedule/useSlotMutations.js:49-65` derives membership from
  contiguity). `activities.span_blocks` (`schema.sql:464`) is the activity-level default the engine
  places from (`src/engine/buildSchedule.js:463`, `:512-524`). Spans are arbitrary-N and exist on
  **both** routes. "One session, not one block" is `buildSchedule.js:669-673` and `:720`.
- **But:** `CHAIN_CONTENT_FIELDS = ['activity_id', 'event_id']`
  (`useSlotMutations.js:29`, with the comment at `:20-29` — *"Electives are deliberately excluded:
  they never span"*); the engine refuses to span into an elective cell
  (`buildSchedule.js:475`) and always emits elective slots as `is_span_head: true` (`:372`);
  `getActivityRowSpan` gates on `activity_id` so an elective cell is always one row tall
  (`src/screens/schedule/gridGeometry.js:50`); and `elective_sets` carries a single
  `time_block_id`. The exclusion is deliberate at four layers.

So linked elective choices are a **new concept**, not an existing capability the elective layer has
merely not used. That does not change the decision — it changes what is being built.

**Decision.** Model it now, at the **choice** level, not by making elective containers span:
`elective_choices` (a parent, scoped to a run) and `elective_choice_offerings` (its member
occurrences + activities). A preference points at the **choice**; assignment expands **atomically**
to every member occurrence — all or nothing, never partially placed. A single-period choice is the
degenerate one-member case, so there is one code path, not two.

This deliberately does **not** reuse the slot-span chain. `docs/adr/2026-08-21-arbitrary-length-activity-span.md`
chose the `is_span_head` chain as the sole stored shape for *slots* and rejected explicit
`span_id`/`span_index` columns there; a choice is a different object at a different level — a
grouping of preferences, not a grouping of grid cells — so a parent/member pair is the right shape
here and does not contradict that ADR.

`UNSUPPORTED_LINKED_CHOICE` survives, demoted: it now fires only on **genuinely malformed** linkage
— a choice whose members span occurrences the camper is not eligible for, or that reference
occurrences not in the run. It is no longer a v1 escape hatch.

**Related defect found while verifying, not in scope here:** exports are not span-aware.
`src/utils/exportSchedule.js:17-27,33-40` resolves each (group, day, block) independently, so a
three-block activity exports as three identical rows. T197 must handle this for child schedules
rather than inheriting it.

### D13 — Genesis regeneration is free; pre-production confirmed

Adding new `MODELED_ENTITIES` requires regenerating the frozen `GENESIS_B64` blob
(`electron/automerge/campDocument.js:169-279`), invalidating every existing `.automerge` file. The
file's own comments note that a regeneration *"once real camp documents exist would NOT be free the
same way."*

**Owner confirmed, 2026-09-17: the project is pre-production — no real camp documents exist.**
Genesis regeneration is free. T194 does not gate on re-confirming this; it records the assumption
and this date. If that assumption ever stops holding, this decision must be revisited before any
further entity addition.

## Ratification status

Every decision here is owner-ratified as of 2026-09-17, including D7's severability (T193 lands
independently as a pre-existing defect fix, ahead of and not blocked by the governance gate on the
rest of the feature). No decision in this ADR is a reviewer default awaiting owner confirmation.

## Consequences

- **Schema:** seven new tables at v66 (`CURRENT_SCHEMA_VERSION = 65`,
  `electron/db/localDb.js:25`), additive, with a `v66_down.js` rollback. Rollback **destroys
  imported preference data** — an acceptable loss only because it is also the only way to undo the
  PII footprint; the ticket must state this in the rollback plan rather than discover it.
- **Fresh-vs-migrated parity** across five new tables is a larger surface than the single-column
  v35 `template_slots.elective_set_id` precedent (which is itself documented drift at
  `schema.sql:509-523`). Column order must match, and the parity test must compare order, not just
  the column set.
- **Registration blast radius is wider than the brief's list.** Beyond `PROJECTIONS`,
  `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES`, `DOMAIN_SNAPSHOT_ORDER`, `MODELED_ENTITIES`,
  permissions, mocks and schema tests, the audit found: `electron/ops/restore.js:54` (where
  `elective_sets` is currently `'refused: no setup UI yet'`), `electron/ops/undoReferences.js`,
  `electron/ops/slotOccupants.js:74`, `deleteRecord.js`/`deleteElectiveSet.js`/`deleteWeek.js`,
  `src/ingest/existingSnapshot.js:71`, `src/localClient.mock.js`,
  `electron/ops/campScopedEntities.js`, `src/data/setupCrudRepository.js`,
  `src/components/layout/navSections.js`, and the reconciliation rollups. T194's exit condition is
  parity across all of them.
- **A new export contract** with its own `format_version: 1`. The existing group-schedule JSON
  contract (`src/utils/exportScheduleJson.js:43`, also `format_version: 1`) is not mutated.
- **`SECURITY.md`** records the at-rest-encryption precondition (D8) and the purge path with its
  limits (D10).
- **Two more entities than the brief proposed** — `elective_choices` and
  `elective_choice_offerings` (D12) — bringing the v66 addition to seven tables.
- **Risk retained:** the pull toward parent messaging, attendance, staffing, and medical fields to
  "complete the workflow". All remain non-goals.

## Gate

**Owner rulings recorded 2026-09-17.** On acceptance: Architect (T194 data substrate
and the derived-id scheme) → Maker test-first per slice → Red Hat (sync/replay and migration) →
Security (permissions matrix and the `SECURITY.md` amendment) → Code Reviewer → Verifier → Grader.

T193 is severable and, per the ratification note above, proceeds independently — it is a fix to
shipped surfaces and is not sequenced behind the rest of the feature.
