---
task: "Intake of the owner-supplied individual elective scheduling brief"
title: "Handoff — individual elective scheduling (owner-supplied brief)"
document_type: handoff
authority: descriptive
status: active
date: 2026-09-17
created: 2026-09-17
archive_when: individual elective scheduling ships or the superseding ADR is rejected
---

# Handoff — individual elective scheduling

Owner-supplied implementation brief, received 2026-09-17. Verbatim text extraction of
`docs/work/handoffs/assets/2026-09-17-individual-elective-scheduling-handoff.docx` (the original
Word file is kept alongside this note).

**Status of authority.** This is an *implementation brief*, not governance. It is subordinate to the
constitution and to accepted ADRs. Several of its file-path and behaviour claims are assertions about
the repository that have not yet been verified against the tree; treat every one as a lead to check,
not a fact. It explicitly requires a superseding ADR and an owner gate before any feature code.

---

Shoresh IndividualElective Scheduling
Architecture decision, implementation plan, and Opus 5 execution brief

Prepared from the current Scheduling-Project repository
Repository snapshot reviewed: September 17, 2026
Purpose: turn externally collected camper preferences into conflict-aware, capacity-respecting schedules by child and rosters by activity—without replacing the campwide group scheduler.
THE DECISION
Keep the existing group schedule and its nested elective cells. Add a second, deterministic scheduling pass that fills those cells for individual campers. The external form remains external. The import service normalizes its responses; the assignment engine allocates campers; exports project the same assignments by child and by activity. MCP and CLI expose this capability, but do not contain the scheduling logic.

Give this whole document to Opus 5. The boxed execution prompt on the next page tells it how to use the brief and how to respect Shoresh governance.

Execution prompt for Opus 5
Paste this prompt with the repository available and attach this document. It is intentionally direct, scoped, and verification-oriented without asking Opus 5 to perform redundant self-review.
You are implementing individual elective scheduling in the Shoresh Scheduling Project.

Read, in order:
1. CLAUDE.md
2. docs/governance/GOVERNANCE_INDEX.md and every governing document it routes you to
3. this implementation handoff in full
4. the repository files named in the handoff

Treat the handoff as an implementation brief, not as higher authority than the repository constitution or accepted ADRs. Inspect the current code before relying on any file path or assumption in the brief.

Deliver the feature at the scope defined here. Do not redesign the camp scheduler, build a form builder, add staff assignment, add parent messaging, or model campers as ordinary groups. Make routine implementation decisions yourself. Ask only when the repository's governance requires owner approval or when two interpretations would materially change product behavior.

The accepted elective ADRs currently prohibit campers, preferences, and a solver. Therefore your first deliverable is a superseding ADR plus the corresponding spec/work record. Stop for the required owner approval. After approval, resume from the approved documents and implement the slices in order through the end-to-end acceptance fixture.

Use the repository's Governor workflow and required agents; do not invent a parallel process. Keep subagent use within that workflow and low in count. Before the first tool call, state your immediate action in one sentence. During work, update only when you find something important, complete a slice, or must change direction. Keep messages concise. Match written deliverables to the substance; do not add filler or duplicate summaries.

When implementation is permitted, complete each slice rather than leaving stubs. Use the existing op-log/Automerge/SQLite architecture, pure deterministic engine conventions, authorization boundary, migration/rollback rules, and fresh-versus-migrated parity requirements. Show completion with the repository's normal tests and the acceptance fixture specified in this handoff. Do not add extra verification ceremonies beyond the project's required gates.

Start now by reconciling this brief with the current repository and drafting the superseding ADR. Do not write feature code before the owner gate.

Expected first stop
A concise architecture/work-record package for owner approval. This is a real gate: implementation before that approval would violate accepted ADRs dated 2026-08-20 and 2026-08-22.

1. Outcome and boundaries
The feature has one job: convert ranked elective choices from an external file into a durable assignment set that can be rendered as each child’s daily schedule and as each activity’s roster. It operates inside elective periods already placed on a selected candidate camp schedule.
In scope
Not in scope
Import CSV/XLSX responses; map columns to campers, elective occurrences, and existing activities.
Building or hosting the preference form.
Create minimal camper records from the response data when identity can be resolved.
Parent accounts, email/SMS delivery, medical data, DOB, or household records.
Assign one camper per elective occurrence using rank, capacity, eligibility, locks, and explicit unassigned results.
Staff assignment or staff availability.
Preserve director control: preview, resolve ambiguity, generate, manually override/lock, finalize.
Silently choosing between Manual and Generated camp schedules.
Export by child, by offering roster, and as versioned JSON.
Replacing the existing group scheduler.
Expose the same application service through UI, CLI, and MCP.
Putting business rules or a solver inside MCP prompts.

Definition of done
A director selects a week, route, and age division; imports a real preference sheet; resolves every ambiguous identity/activity mapping; generates deterministic assignments; sees capacity and eligibility exceptions; makes and locks manual changes; finalizes the run; and exports matching child schedules and activity rosters. Outside elective periods, each child inherits the selected group schedule.

2. What the repository has today
The existing system is much closer to the target than it first appears. It already has the outer container and the physical-resource accounting. What it lacks is the participant layer inside the container.
Current component
Actual behavior
Consequence
elective_sets
A named, optionally reusable nested schedule container bound to day, time block, group scope, and week.
Keep it. It remains the definition of what may run in an elective period.
elective_set_activities
Membership rows connect a set to activities. Each row has camper_headcount; activity supplies location and eligibility.
Keep it as the offering catalog and capacity source.
template_slots.elective_set_id
Places an opaque elective container into the group schedule.
This is the bridge between the outer group schedule and the inner camper schedule.
buildSchedule.js
Treats elective cells as authored/locked, skips normal placement, and registers each distinct offering location as occupied.
Reuse for outer schedule validation; do not turn it into the preference allocator.
Electives screens
Create, rename, delete, populate, and inspect flat offerings.
Extend around assignment runs; do not replace the offering editor.
Excel/JSON export
Exports the group grid; an elective cell contains the set label/member list.
Add a separate individual-elective export contract.
CLI/MCP ingest
Imports camp setup. ENTITY_MAP and schedule_state do not expose the participant domain.
Add adapters only after the shared domain service exists.

Code-backed observations
electron/db/schema.sql defines elective_sets and elective_set_activities; camper_headcount is a nullable offering cap.
src/engine/buildSchedule.js recognizes electiveSetId in preplacedSlots, excludes the cell from ordinary filling, and consumes distinct offering locations in the shared place ledger.
src/ingest/electiveSetPopulate.js only creates flat set membership. It does not import people or preferences.
src/utils/scheduleCells.js, exportSchedule.js, and exportScheduleJson.js render the set as one opaque group cell; JSON format_version is 1.
scripts/mcp/tools.js does not include elective or camper entities in ENTITY_MAP. Its schedule_state reconstruction currently filters preplaced slots to activity_id rows, so it omits elective/event overlays when re-running validation. Fix this precursor before relying on MCP schedule state for the new feature.
buildSchedule.js returns conflicts: [] across cohorts. Location accounting is real within a cohort, but cross-cohort conflict detection is explicitly unfinished. If age divisions use separate cohorts, a combined post-build resource validation pass is required before assignments may finalize.
3. Governance change required
Do not code around this
docs/adr/2026-08-20-electives-authoring.md and docs/adr/2026-08-22-nested-schedules-electives-and-events.md are accepted and explicitly say: no campers, no per-camper rosters, no preference data, and no solver. The new owner direction reverses those decisions. A superseding ADR or a clearly scoped amendment must be approved before feature code.

The new ADR should preserve the nested-schedule abstraction and supersede only the prohibitions that now conflict with the desired product. It should record these owner decisions as one coherent change:
The preference form remains external.
Shoresh may store minimal camper identity and group membership for scheduling.
Shoresh may store ranked preferences and generated/manual assignments.
The director chooses the week, schedule route, division, offerings, and whether a run is finalized.
The engine may allocate campers inside elective containers; it still does not decide which offerings the camp runs.
Staffing and delivery to parents remain separate work.
The ADR must also amend the older statement that invalid camper_headcount values may be treated as unlimited. Once a field controls actual assignments, negative, non-integer, or zero-capacity ambiguity must block generation with an actionable finding; null alone means unlimited.
4. Target architecture
Implement this as one product pipeline with two pure scheduling passes. The first pass builds or validates the campwide group schedule. The second fills only the nested elective occurrences for individual campers. Keeping the passes separate preserves the existing engine’s invariants while making the child a schedulable unit where that unit is relevant.
Stage
Input
Output / responsibility
1. Outer schedule
Selected week + explicit Manual or Generated template
Group/day/time-block cells, including elective_set_id containers; location/resource findings.
2. Occurrence derivation
Selected route plus division/group membership
Stable elective occurrences for that run, collapsed across groups in the same division/time/set.
3. Preference normalization
External CSV/XLSX + user-approved mapping
Resolved campers and ranked choices; unresolved rows remain blocked, not guessed.
4. Assignment
Occurrences, offerings, ranks, capacities, eligibility, locks
Deterministic assignments and explicit unassigned/conflict findings.
5. Projection
One finalized assignment run + outer schedule
Child schedules, offering rosters, summary/exceptions, versioned JSON.

Why children are not groups
Conceptually, a camper is a schedulable unit of one. Persisting each child as a normal groups row would nevertheless be the wrong implementation: it would pollute the campwide group grid, inherit group recurrence and availability semantics that do not apply, multiply the ordinary engine’s search space, and make every existing export and setup screen treat children as bunks. The participant entity belongs to the elective sub-schedule. Outside an elective occurrence, the child’s schedule is a projection of the child’s group schedule—not a duplicate set of slots.
Run scope and route
Every assignment run is bound to one schedule_week_id, one schedule_template_id (therefore one explicit route), and one tier_id. Shoresh must never remember a global “real schedule” or infer a route. If the chosen outer schedule changes after generation, the run becomes stale and must be regenerated or explicitly retained as a historical finalized run.
5. Persistence model
Add five synced entities. The names below are the recommended contract; the superseding ADR may adjust names only if the repository has a documented naming constraint.
Entity
Required fields
Invariant / purpose
campers
id, camp_id, external_id?, display_name, group_id, is_active
Minimal scheduling identity. Match external_id first; otherwise exact name + group only when unique. No contact or sensitive profile fields.
elective_assignment_runs
id, camp_id, schedule_week_id, schedule_template_id, tier_id, name, status, source_filename, source_sha256, solver_version
Immutable scope and import provenance. status is draft or final. A rerun creates a new version or replaces only an unfinalized run by explicit action.
elective_occurrences
id, run_id, elective_set_id, day_id, time_block_id, tier_id
Snapshot of the selected route’s nested elective periods. Unique on run + set + day + block + tier.
elective_preferences
id, run_id, occurrence_id, camper_id, activity_id, rank
Normalized ranked choice. Unique rank and unique activity per camper/occurrence.
elective_assignments
id, run_id, occurrence_id, camper_id, activity_id, preference_rank?, source, is_locked
Exactly one row per camper/occurrence. source is generated or manual. Locked rows survive regeneration.

Derived rather than stored
Child schedule cells outside electives are derived from campers.group_id + the chosen template_slots.
Offering location and eligibility remain on activities; capacity remains elective_set_activities.camper_headcount.
Activity rosters are the inverse projection of elective_assignments. Do not maintain a second roster table.
Counts and satisfaction summaries are computed from preferences + assignments. Do not persist denormalized totals.
Occurrence derivation rule
Scan the selected template’s slots where elective_set_id is non-null. Join each slot’s group to tier_id. For the selected tier, collapse rows with the same elective_set_id, day_id, and time_block_id into one occurrence. Record the result in the run so later edits to the outer template are detectable. A camper participates when the camper’s group is among the source slots represented by that occurrence; do not infer participation solely from the set’s legacy group_ids text field.
Multi-block choices
The first end-to-end release handles one assignment per occurrence. It must fail closed—not flatten or partially assign—when an imported choice requires linked periods or multiple days. If the real form requires those choices, extend the same model before launch with an elective_choices parent and elective_choice_offerings members; preferences point to the choice and assignment expands atomically to every member occurrence. Do not encode linkage in free-text names or special-case it in MCP.
Repository registration blast radius
For every new entity, implementation is incomplete until all of these stay in parity: schema.sql; additive migration and rollback; PROJECTIONS; DIRECT_CAMP_ENTITIES or PARENT_SCOPED_ENTITIES; DOMAIN_SNAPSHOT_ORDER in foreign-key-safe order; Automerge MODELED_ENTITIES and frozen genesis procedure; authorization matrix; list/read scoping; mock local client field registry and behavior; fresh-vs-migrated schema tests; first-pairing sync; projection rebuild; trash/history/delete semantics. Follow the current governance checks rather than copying this list blindly if the registries have moved.
6. Import and identity flow
Build a dedicated preference-import service. Do not reuse the generic camp-setup ingestion planner: that pipeline proposes structural entities from schedules, while this pipeline resolves rows against a director-selected run and commits participant data only after a preview.
Director selects week, route, age division, and creates a draft run.
Shoresh derives occurrences and shows the existing offerings for each one.
Director uploads CSV/XLSX. The parser reads bounded files using the project’s existing spreadsheet safety limits.
Mapping screen identifies camper name, optional stable external ID, group/bunk, and ranked-choice columns for each occurrence.
Preview resolves values to existing groups and activities by explicit mapping. Unknown/duplicate people, groups, activities, ranks, or occurrences are blocking rows.
Director confirms resolutions. Commit writes through the op-log as one auditable application operation; it never writes SQLite directly.
Generation becomes available only when every included row is resolved or explicitly excluded with a recorded reason.
Resolution case
Required behavior
external_id matches one camper
Update allowed scheduling fields; retain the same camper id.
No external_id; name + group uniquely matches
Offer the match in preview and require confirmation on first import.
Duplicate names or missing group
Block the row and ask the director to choose/create the camper.
Choice text matches one offering in that occurrence
Resolve and display the canonical activity before commit.
Choice matches activity globally but not in the occurrence
Block; do not add the offering silently.
Blank or duplicate rank
Show a row-level error. Allow explicit “no preference” only as a mapped value.
Repeated source file hash
Warn and let the director open the existing draft; never duplicate silently.

7. Assignment engine
Create src/engine/buildElectiveAssignments.js as a pure deterministic module. It receives plain objects and returns assignments plus findings. It performs no database access, no file parsing, no UI work, and no writes. This is the same architectural discipline as buildSchedule.js, but it solves a different level of the nested schedule.
Hard constraints
Each active camper in scope receives at most one activity in each occurrence.
The activity is a member of the occurrence’s elective set.
Activity eligibility admits the camper’s tier/group.
Assigned count does not exceed a finite, valid camper_headcount.
A locked manual assignment is retained and consumes capacity before generated placement.
A camper cannot be assigned to overlapping occurrences. Invalid or overlapping occurrence input is a blocking finding.
Generation cannot finalize while the selected outer schedule has unresolved location/resource conflicts, including the new combined cross-cohort check.
Optimization rule
For each independent occurrence, use deterministic min-cost max-flow. Source-to-camper edges have capacity 1; camper-to-offering edges exist only for eligible ranked choices; offering-to-sink capacity is the remaining offering capacity after locked assignments. Add an explicit unassigned edge. Costs must make unassigned more expensive than every possible rank combination, then penalize lower ranks monotonically. Sort campers and offerings by stable IDs before building the graph so input order cannot change the result. Return the achieved rank for every generated assignment and a reason for every unassigned camper.
Recommended cost contract
rank 1: 0
rank 2: 10
rank 3: 30
rank 4: 70
rank n: previous + increasing penalty
unranked fallback: disabled by default
unassigned: greater than (camper_count × maximum ranked cost)

The exact constants belong in one exported policy object and are pinned by tests. They are not editable through MCP. If the director opts into assigning unranked choices, that is an explicit run option and the export labels those assignments accordingly.
Findings, not silent repairs
Finding
Meaning
INVALID_CAPACITY
Capacity is negative, zero where ambiguous, non-integer, or otherwise unusable.
NO_ELIGIBLE_CHOICES
Camper ranked choices, but none are eligible/offered for the occurrence.
CAPACITY_SHORTFALL
Eligible demand exceeds available seats; camper remains unassigned.
LOCK_CONFLICT
Locked assignments exceed capacity or violate eligibility.
STALE_OUTER_SCHEDULE
Template/occurrence fingerprint changed since the run was derived.
OUTER_RESOURCE_CONFLICT
An offered location conflicts with another group/division in the selected schedule.
UNSUPPORTED_LINKED_CHOICE
The source requires atomic multi-period/multi-day placement not yet modeled.

8. Outer-schedule deconfliction
The existing engine already reserves each distinct offering location during an elective cell. Preserve that behavior. Before finalization, add a route-wide validator that evaluates all cohort outputs together because buildSchedule currently documents cross-cohort conflicts as unimplemented. The validator must operate on concrete location/day/block occupancy facts from regular activities, anchors, events, and elective offerings. It reports conflicts; it does not move groups or remove offerings.
Also repair the MCP schedule_state reconstruction so preplacedSlots includes activityId, electiveSetId, and eventId, and pass electiveSetActivities/events into the engine inputs. Until that is fixed, an MCP caller can receive a falsely clean state for a schedule containing overlays.
9. Director workflow
Screen state
Primary action
What must be visible
No run
Choose week, route, division; start import
Route is explicit and never remembered as canonical.
Import preview
Map and resolve
Row count, matched/unmatched campers, groups, occurrences, activities, duplicate ranks.
Ready to generate
Generate assignments
Offering capacities, demand, locked seats, blocking outer conflicts.
Draft assignments
Move/lock camper; regenerate
Rank received, capacity remaining, unassigned reasons, satisfaction summary.
Final
Export or create a new revision
Read-only run identity, source file, route/week/division, finalized timestamp/author.

Manual override is not an escape hatch around constraints. Moving a camper recomputes capacity and eligibility immediately. A deliberate exception, if product-approved later, must be recorded as an explicit override reason; do not silently permit over-capacity placement in the first release.
10. Exports and machine access
Generate all views from the same run so they cannot disagree.
Artifact
Shape
Child schedules
One row per camper/day/time block, combining inherited group cells with elective assignments. Include activity, location, group, and assignment status. Provide a printable packet with one child per page only after the tabular output is correct.
Activity rosters
One row per assignment grouped/sorted by day, time block, activity, and camper; include camper group and count/capacity.
Exceptions
Unresolved, unassigned, unranked, stale, capacity, eligibility, and resource findings.
Summary
Counts by rank received, unassigned count, fill by offering, run identity, source hash, route/week/division.
JSON
A new elective-assignment export contract with its own format_version: 1. Do not mutate the existing group schedule format_version 1 in place.

The first delivery target should be an XLSX workbook containing Summary, Child Schedules, Activity Rosters, and Exceptions plus the versioned JSON export. A printable/PDF child packet is the next presentation layer over the same projection; do not block the data model on email or messaging integration.
11. CLI and MCP
The CLI and MCP are valuable because the input file varies by camp, but they are adapters around application services. The service owns validation, preview, committing, solving, and export. A model may help a director describe column mappings; it must not invent identities, choices, or capacities.
Surface
Command/tool
Authority
CLI
electives preview --file … --week … --route … --tier …
Read-only; returns mapping needs and normalized preview.
CLI
electives commit --run … --mapping …
Mutating; writes through op-log with author identity.
CLI
electives generate --run …
Mutating; persists draft assignments through op-log.
CLI
electives export --run … --format json|xlsx
Read-only file projection.
MCP
preview_elective_preferences
Read-only wrapper over the same preview service.
MCP
commit_elective_preferences / generate_elective_assignments
Require --allow-write and author_user_id; structured errors.
MCP
get_elective_assignment_run / export_elective_assignments
Read-only, stable versioned results.

Do not add the new entities to the generic list_entities surface unless the security review approves exposing minor data that way. Prefer purpose-built, camp-scoped tools returning only the fields needed for the workflow.
12. Authorization and minors’ data
This feature introduces personally identifiable data about minors into the replicated camp document. Keep the footprint intentionally small. The initial schema stores display name, group, optional external identifier, preferences, and assignments—nothing else. Do not ingest parent contact information merely because it is present in the source sheet.
Admin: import, resolve identities, generate, manually override, finalize, delete/restore runs, export all views.
Staff: read finalized activity rosters for their operational use. Do not inherit automatic read/write simply by appending these entities to ENTITIES; make the permission decision explicit in the superseding ADR and tests.
Draft camper preferences and child-wide schedules should be admin-only unless the owner explicitly approves broader access.
All reads remain camp-scoped; all writes authorize before appending operations; exports formula-sanitize user-controlled strings.
13. Implementation sequence
Slice
Deliverable
Exit condition
0. Governance
Superseding ADR, work record, implementation spec, owner approval.
The no-campers/no-solver decisions are explicitly superseded and permission/terminology decisions are approved.
1. Correct current seams
Fix headless/MCP overlay reconstruction; add combined route resource validator.
A stored elective/event overlay is represented in schedule_state and cross-cohort location conflict fixture fails/passes correctly.
2. Data substrate
Five entities, migrations/rollback, projections, sync, authorization, repositories/mocks.
Fresh/migrated schemas match; two-device sync and projection rebuild retain rows; governance checks pass.
3. Import
Bounded CSV/XLSX parser, mapping preview, identity resolution, commit service, UI and CLI preview.
Realistic fixture imports with zero guesses; ambiguous rows block.
4. Assignment
Pure min-cost-flow engine, findings, persistence, manual moves/locks, rerun behavior.
Determinism, capacity, eligibility, locks, infeasible cases, and staleness tests pass.
5. Projection/export
Child schedule, activity roster, summary, exceptions, JSON v1, XLSX.
Both views reconcile exactly to the assignment rows and inherited group schedule.
6. MCP
Purpose-built preview/commit/generate/get/export tools over shared services.
MCP and UI/CLI return equivalent results; mutations are gated and attributed.
7. End-to-end release
Integrated screen flow, fixture, accessibility/visual QA, current docs.
The acceptance scenario below passes without manual database edits.

14. End-to-end acceptance fixture
Create one realistic repository fixture and make it the proof of completion:
Two age divisions in different cohorts, at least two groups per division, three elective occurrences, six offerings, and one location shared with a non-elective group activity.
At least 24 campers, including duplicate display names in different groups, one missing external ID, and one inactive camper.
Ranked choices that produce first-, second-, and third-choice assignments, one capacity shortfall, one eligibility rejection, and one locked manual assignment.
A Manual and Generated template that differ, proving route selection is explicit and run-scoped.
One outer location conflict that blocks finalization until the director edits the outer schedule or offering.
The fixture passes when:
Import preview identifies every ambiguous row and commits only after explicit resolution.
Two runs over identical inputs produce byte-equivalent normalized assignment output.
No offering exceeds capacity; no camper violates eligibility; every lock is retained.
A child’s non-elective cells equal the selected group template; elective cells equal the assignment rows.
Every child assignment appears exactly once in the matching activity roster, and roster counts equal summary counts.
Changing the selected template after generation marks the run stale and prevents finalization.
The same finalized run survives sync to a second device and a projection rebuild.
JSON, XLSX, UI, CLI, and MCP agree on run identity, assignments, and findings.
15. Required tests and gates
Layer
Required coverage
Pure engine
Determinism under shuffled input; rank cost; finite/unlimited/invalid capacity; eligibility; locks; all-full; no-ranked-choice; overlapping occurrence; stable findings.
Import
CSV/XLSX bounds; formula strings; duplicate headers/ranks; unknown activity/group; duplicate names; external-ID reuse; repeated file hash; no-write preview.
Persistence
DDL parity, additive migration, rollback, fresh-vs-migrated equivalence, PROJECTIONS/MODELED_ENTITIES parity, FK-safe snapshot order, delete/history semantics.
Sync/security
Two-device concurrent edits; field conflicts; camp isolation; admin/staff matrix; denied write before op append; no minor data in generic surfaces unless approved.
UI
Route/week/division selection, blocked preview, move/lock, stale run, final read-only state, keyboard/focus behavior, readable exception copy.
Exports/MCP
Inverse roster equality, inherited schedule equality, formula sanitization, JSON version pin, write gate, structured validation errors, overlay-aware schedule_state.

Run targeted tests while building, then the repository’s normal full governance/test/build commands before handoff. Report the exact commands and outcomes. Do not claim completion with skipped migrations, mocked-away sync, or a solver unit test alone.
16. Files Opus should inspect first
Area
Primary files
Governance
CLAUDE.md; docs/governance/GOVERNANCE_INDEX.md; constitution; architecture, design, work-record standards
Prior decisions
docs/adr/2026-08-20-electives-authoring.md; docs/adr/2026-08-22-nested-schedules-electives-and-events.md; related elective specs
Schema/sync
electron/db/schema.sql; electron/db/localDb.js; electron/db/rollback/; electron/ops/projections.js; campScopedEntities.js; electron/automerge/campDocument.js
Authorization
electron/auth/permissions.js; authorize.js; permissions parity tests
Elective UI/data
src/screens/ElectivesScreen.jsx; src/screens/elective/ElectiveSetDetail.jsx; ScheduleElectivesScreen.jsx; src/data/scheduleRepository.js
Engine
src/engine/buildSchedule.js; electiveOccupancy.js; eligibility.js; computeOverlaps.js; engine tests
Import
src/ingest/electiveSetPopulate.js; workbook safety/parser modules; scripts/ingestCli.js
Exports/machine access
src/utils/scheduleCells.js; exportSchedule.js; exportScheduleJson.js; scripts/mcp/tools.js; server.js; scheduleEngineInputs.js

17. Explicit non-solutions
Do not represent every camper as a groups row.
Do not parse arbitrary forms inside a model prompt and write the model’s answer directly to the database.
Do not add a second location-capacity mechanism for electives.
Do not mutate or silently replace the existing group schedule export contract.
Do not choose Manual versus Generated automatically.
Do not let invalid capacity become unlimited during assignment.
Do not add parent messaging, accounts, staffing, attendance, or medical fields to “complete the workflow.”
Do not bypass the superseding ADR because the desired behavior seems obvious.
18. Decision summary for the ADR
Decision
Chosen answer
Where preferences originate
External forms/files.
Where normalization happens
A dedicated Shoresh import service with preview and explicit mapping.
What is scheduled
Campers only inside derived elective occurrences; group schedule elsewhere.
How assignment is computed
Pure deterministic min-cost max-flow with capacities, eligibility, locks, and explicit unassigned findings.
What remains director-owned
Week, route, division, offerings, mapping resolutions, manual changes, finalization.
How outputs stay consistent
Child schedules and activity rosters are projections of one assignment run.
Role of CLI/MCP
Thin adapters over shared application services.
First release privacy posture
Minimal camper identity only; no parent contacts or sensitive profile data.

Appendix A — Suggested JSON contract
{
  "format_version": 1,
  "run": {
    "id": "…", "status": "final", "week_id": "…",
    "template_id": "…", "route": "manual|generated", "tier_id": "…",
    "source_sha256": "…", "solver_version": 1
  },
  "campers": [{ "id": "…", "display_name": "…", "group_id": "…" }],
  "occurrences": [{
    "id": "…", "elective_set_id": "…", "day_id": "…",
    "time_block_id": "…", "tier_id": "…"
  }],
  "assignments": [{
    "camper_id": "…", "occurrence_id": "…", "activity_id": "…",
    "preference_rank": 2, "source": "generated", "is_locked": false
  }],
  "findings": [{ "kind": "CAPACITY_SHORTFALL", "camper_id": "…", "occurrence_id": "…" }]
}

Keep names/locations in reference collections or resolved export views rather than duplicating them into assignment records. A format-version change is required if the public shape changes incompatibly.
Appendix B — Prompting basis
This handoff follows the current official guidance available on September 17, 2026: provide the complete specification up front for long-horizon coding; constrain scope explicitly; specify concise progress behavior and deliverable length; limit subagent spawning; avoid redundant “double-check” instructions; explore, plan, then implement; point to concrete repository files and give the agent pass/fail verification criteria.
Anthropic, “Prompting Claude Opus 5”: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
Anthropic, “Best practices for Claude Code”: https://code.claude.com/docs/en/best-practices
End of handoff
The smallest correct product is not “an MCP that reads a form.” It is a governed participant-assignment domain inside the existing nested elective model, with one shared import/solver/export service and UI, CLI, and MCP adapters around it.
