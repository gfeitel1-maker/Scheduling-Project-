---
task: M3a — Locations setup screen + readiness promotion
document_type: run
date: 2026-08-15
round: 2
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-m3-locations-design.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
related_runs: [docs/work/runs/2026-08-15-locations-m3-design.md]
selected_agents: [governor, maker, code-reviewer, verifier, tester, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no new structure; locations entity shipped in M1, CRUD is entity-generic via setupCrudRepository
  - agent: designer
    reason: not-applicable
    note: design already specified and owner-approved (docs/work/specs/2026-08-15-m3-locations-design.md); Maker implements to it
  - agent: security
    reason: not-applicable
    note: no auth/protocol/IPC surface change; CRUD routes through existing write/list handlers

# Red Hat ADDED (rule 8, post-Maker): the delete flow deviated from the spec's previewDelete
# path (locations isn't in CLEARABLE_ENTITIES) to a bespoke modal that UNBINDS bound activities'
# location_id before delete — a stored-data mutation on activities. That is a stored-data op
# and must be adversarially reviewed. My original "not-applicable" omission was wrong for this diff.
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence: [src/screens/LocationsScreen.jsx, src/screens/LocationsScreen.test.jsx, src/engine/readiness.js, src/engine/buildSchedule.test.js]
archive_when: M3a merged to main
---

# Run: M3a — Locations setup screen + readiness promotion

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1.

## Brief

**Product outcome:** A director can add, name, and manage *places* — the first visible locations
surface. Capacity phrased in their words ("Groups at once", "3 groups"), a floor of 1 (no 0/unlimited),
optional throughout. A camp that skips it loses nothing.

**Success predicate:** a `LocationsScreen` exists on the `setupCrudRepository` seam (name, capacity,
notes), registered in the SCREENS map + Sidebar (after Activities, marked optional per D-1); the
Readiness "Locations" row moves from `FORWARD_AREAS` to `OPTIONAL_AREAS` with a `COLLECTION_FOR` binding
and its Review button navigates to the new screen (gap 14 closed); locations never reach `REQUIRED`
(weekly scheduling still builds with zero locations); test/lint/build green; Tester confirms it reads as
native Shoresh on the running app.

**What does not count as done:** the activities picker (M3b) or the migration review region (M3c); a
capacity control that can express 0/unlimited; locations becoming required; a second stylesheet (use
inline `S` like the other setup screens).

## Scope (from the approved design spec §Locations screen + §readiness)

- New `src/screens/LocationsScreen.jsx` mirroring `DaysScreen`/`GroupsScreen` (intro line, table card,
  inline-row edit, add card, calm empty state). Uses `setupCrudRepository('locations', …)`.
- `CapacityStepper` (min 1) per the spec — reusable; capacity renders as "N groups", column "Groups at
  once".
- Register in `src/App.jsx` SCREENS map + `src/components/layout/Sidebar` (D-1: after Activities,
  optional, own `Next:` chain; do not alter Activities' required chain).
- `src/engine/readiness.js`: move `location` `FORWARD_AREAS → OPTIONAL_AREAS` + `COLLECTION_FOR`
  binding; `REQUIRED_AREAS` must not grow. Fix `readinessHubModel`/Review-button target `camp → locations`.
- Delete routes through the existing Trash/previewDelete flow.
- **Mock parity:** `locations` must be listable/writable through `src/localClient.mock.js` for the
  `:5200` dev server (it should already be, from M1 — verify).

## Agents

| Agent | Selected | Why |
|---|---|---|
| Governor | yes | routing |
| Maker | yes | builds the screen to the approved spec |
| Code Reviewer | yes | plan/spec fidelity + maintainability |
| Verifier | yes | test/lint/build |
| Tester | yes | director's-eye UX on the running screen (first visible slice) |
| Grader | yes | consolidates |
| Architect/Designer/Security/Red Hat | no | see omissions |

## Round 1 review

- **Code Reviewer:** spec fidelity HIGH; readiness promotion correct and well-fenced (locations structurally cannot reach `missing`). One HIGH: the in-screen unbind of `activities.location_id` duplicates a primitive the host delete path owns (`weather_alternative_id` in `deleteRecord.js`), loses atomicity, and M3c's merge needs the same primitive. Recommended relocating to the host contract OR deferring location delete to M3c.
- **Red Hat: Resilience 4/5, no blocker.** Traced the delete end-to-end: the unbind **is** op-logged/sync-safe (not raw), orders **delete-last so partial failure fails safe** (no dangling ref), **surfaces the consequence** to the director, and **restores correctly** with an accurate caveat. **Recommends accepting the bespoke flow — do NOT force `CLEARABLE_ENTITIES`** (its only real gain, host-atomicity, is minor and does not fix the actual risk). The real risk is engine-side (below).

## Governor decisions (synthesis of the two reviewers)

1. **Delete flow: ACCEPT the bespoke op-logged flow as-is.** Red Hat confirmed it is data-safe; Code Reviewer's concern was shipping duplicated logic. Resolved by **committing to extract the shared "re-point activities' `location_id` + delete the location row" primitive at M3c** (the merge's real second consumer), per `ARCHITECTURE_STANDARD.md` §9 (don't abstract for a consumer that doesn't exist yet). M3a ships ONE copy — no duplication — so Code Reviewer's merge-gate condition ("don't merge duplicated as the durable version") is met. **M3c must re-home this primitive (host delete path preferred) and re-decide `CLEARABLE_ENTITIES` with both consumers concrete; Red Hat mandatory there.**
2. **Engine capacity-lookup hardening: FIX NOW (round 2).** Both reviewers flagged, Red Hat insists. (a) An unmapped `location_id` (dangling ref) must be **unconstrained**, not silently capacity-1 (`buildSchedule.js:~227`) — plus emit a dangling-reference finding (surface, don't hide). (b) A stored capacity `≤ 0` must floor to 1, not block all placement (`buildSchedule.js:~541`). M3a's delete made these newly reachable.
3. **Cosmetic LOWs: fold in** — rename `countBoundActivities`; allow transient-empty typing in `CapacityStepper` (keep the floor-of-1 on the committed value).

## Findings carried forward

- **To M3c:** re-home the "unbind/re-point activities + delete location" primitive into the host delete path (the `weather_alternative_id` clear template), shared by delete + merge; re-decide `CLEARABLE_ENTITIES`. Red Hat mandatory.
- **Inherent / follow-up:** the concurrent cross-device bind window (Device A deletes L while Device B binds an activity to L) produces a dangling `location_id` that no conflict catches — inherent to the op-log's FK-by-convention (no DB FK on `location_id`); `CLEARABLE_ENTITIES` would not close it either. Round-2 Fix 1 removes the **silent over-constraint** consequence (dangling → unconstrained + a visible finding), which is the Shoresh-correct mitigation. The race itself is an accepted property of the local-first model.
- **Defense-in-depth follow-up:** no DB CHECK / op-layer clamp on `capacity ≥ 1` (UI floors it, the op-log/import path does not). Round-2 Fix 2 hardens the engine; a schema CHECK or op-layer clamp is a further follow-up (natural home: M4 import).
- The unbind clears `location_id` but leaves the frozen free-text `location` string; recreating the same-named place does not auto-rebind (M3b/c territory).

## Round 2 review (fixes verified)

- **Red Hat re-check: engine fix HOLDS, Resilience 4/5.** Dangling→unconstrained bulletproof, mapped case unchanged, capacity floor holds, determinism holds, `groupId:null` safe through every findings-rail consumer. Three LOW copy/UX blemishes the new finding introduced (past-tense wording, empty-string case, group-less locate dead-end) — all fixed in the polish pass.
- **Tester: UX 4/5, Visual Fidelity 4/5** (static eval — live app unavailable, browser MCP unresponsive + port held). Welcoming, obviously-optional, hard-to-misuse; matches the approved mockup and the sibling screens; readiness reads correctly as optional. One MEDIUM (delete-copy jargon) — fixed. Two LOWs (Delete-All `window.confirm`, static modal motion) are **family-wide conventions** (Days/Tiers too) → spun off as a separate ticket, NOT fixed in Locations alone.

## Round 3 polish (applied)

1. **Delete-confirmation copy de-jargoned** (Tester MEDIUM): "clears that binding"/"pointed to it"/"not re-bound" → plain camp language ("takes <Place> off those activities — they stay on the schedule, just without a place"; "you can put it back — but the activities won't automatically start using it again"). Live-count sentence preserved.
2. **`DANGLING_LOCATION` finding copy** (Red Hat LOW): present/conditional tense, covers deleted-and-blank ("is set to a place that isn't in your locations list, so it has no place limit") — no longer claims a placement fact or "no longer exists". Firing condition unchanged.
3. **Group-less locate guarded** (Red Hat LOW): `FindingsRail.jsx` rows with `groupId == null` render as plain text (no dead-end locate); dismiss button untouched.

Tests green (75 engine+screen, 50 ScheduleScreen), eslint clean.

## Findings carried forward

- **To M3c (Governor commitment):** re-home the "unbind/re-point activities + delete location" primitive into the host delete path (the `weather_alternative_id` clear template), shared by delete + merge; re-decide `CLEARABLE_ENTITIES`. Red Hat mandatory.
- **Spun off (task_ab83ab86, family-wide, Designer→Maker):** Delete-All `window.confirm` → styled modal + delete-modal entrance motion, across Days/Tiers/Locations (shared convention; not a Locations regression).
- **Inherent/accepted:** the concurrent cross-device delete-vs-bind dangling-ref window (op-log FK-by-convention); round-2 Fix 1 makes its only consequence visible (a finding) rather than a silent over-constraint.
- **Defense-in-depth follow-up:** no DB CHECK / op-layer clamp on `capacity ≥ 1` (engine now floors it; natural home M4 import).
- The unbind leaves the frozen free-text `location` string; recreating a same-named place doesn't auto-rebind (M3b/c).

## Verifier verdict

**PASS.** Authoritative final log independently confirmed: lint 0, test 0 (175 files, 2586 passed /
1 skipped, 0 failed), build 0, governance no findings. Every success-predicate claim traced to a passing
test (readiness optional-never-required, dead Review button fixed, engine dangling→unconstrained +
capacity floor + `DANGLING_LOCATION` finding + CapacityStepper floor-1 all pinned; stale label assertion
reconciled). Integration legitimately not required (ui-ux-design; no schema/sync/auth surface).

## Grader score

**PASS — 4.0** (spec-fidelity 4, maintainability 4, resilience 4, UX/visual-fidelity 4). Lowest 4 ≥ 3;
Verifier PASS; no blocking rule fired. Code Reviewer HIGH resolved (accept + M3c re-home commitment, no
duplication shipped); all MEDIUM/LOW items fixed or deliberately spun off. **Live-UI caveat:** visual
fidelity rests on a static eval against the owner-approved mockup — the browser MCP was unresponsive in
this environment. A live pass is warranted before final promotion sign-off.

## Decision

Round-3 polish applied; delete flow accepted with the M3c re-home commitment; family-wide delete-UX spun
off. On Verifier PASS + Grader ≥4.0, PASS. Live-UI verification for owner/Tester deferred: the in-app
browser MCP is unresponsive in this environment — the approved mockup stands as the visual proxy and the
owner can run `npm run electron:dev` to click through before merge.
