---
task: M2 — fix place capacity in the scheduling engine
document_type: run
date: 2026-08-15
round: 2
status: pass
task_class: scheduling-engine
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: []
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
related_runs: [docs/work/runs/2026-08-15-locations-m1-create-entity.md]
selected_agents: [governor, maker, verifier, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: engine semantics settled in the accepted ADR D2; the input-signature detail is a direct implementation of it, guarded by buildSchedule.test.js and Code Reviewer. Maker escalates if it cannot be done purely
  - agent: designer
    reason: not-applicable
    note: M2 ships no UI
  - agent: security
    reason: not-applicable
    note: no auth/secret/protocol/schema change; M2 is a pure-engine change reading location capacity M1 already persists
  - agent: tester
    reason: no-predicate
    note: no new UI surface; the director-facing disclosure of the behavior change (Q2) is M3's review UI. Engine correctness is pinned by buildSchedule.test.js
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence: [src/engine/buildSchedule.test.js, src/utils/computeOverlaps.test.js]
archive_when: M2 merged to main
---

# Run: M2 — fix place capacity in the scheduling engine

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1.

## Brief

**Product outcome:** The live double-booking defect dies. A place's capacity now governs how many groups
can be there at once — read from `locations.capacity`, one number per place — instead of being read off
whichever activity the engine happened to place first. A director can no longer end up with three groups
in a pool they told Shoresh holds one.

**Success predicate:** `buildSchedule` enforces place capacity by keying occupancy on `location_id` →
`locations.capacity` (not the free-text `location` string, not `activities.max_groups_per_slot`);
`activities.max_groups_per_slot` remains enforced per-activity as an instructor/equipment cap;
`computeOverlaps` (manual route) is re-keyed by `location_id` so it is no longer place-blind; the engine
stays a pure, seeded, deterministic function (identical inputs → identical schedule); the §3.2 defect cases
are pinned by new tests in `buildSchedule.test.js`; and the full `buildSchedule.test.js` + test/lint/build
are green.

**What does not count as done:**
- Changing the flag taxonomy or the high/low placement-priority rounds. M2 changes which value the capacity
  check reads and the key it uses — nothing else about placement.
- Any UI. The director-facing disclosure of the behavior change (Q2) is M3's review UI, not M2.
- Reading the frozen `location` string for capacity. That was the buggy path; the engine stops using it.
- A `min()` of the two caps. They are different constraints at different keys (ADR D2).
- Breaking determinism.

## Pre-authorized behavior change (ADR + owner Q2)

M2 **changes generated schedules** for camps whose places had null/0 caps (was silently "unlimited",
becomes the seeded capacity, default 1) or two differently-capped activities sharing one place. This is
**already authorized** by the accepted ADR and owner Q2 ("fix and surface everything"). The user-facing
surfacing is M1's migration review journal rendered in M3. M2's obligation is: do not break determinism,
and pin the new behavior in tests. This is not a silent change — it is a decided one.

## Task class and gates

`scheduling-engine` — per `GOVERNANCE_INDEX.md`:

| | |
|---|---|
| Standards | `ARCHITECTURE_STANDARD.md` §8 · `CONSTITUTION.md` Art. V |
| Mandatory gate | **`buildSchedule.test.js`** · test · lint · build |
| Human gate | flag taxonomy / placement priority — **not touched**; the capacity behavior change is pre-authorized by the accepted ADR + owner Q2 |

## Interface directive (Governor's resolution of the two open details)

The ADR settled the semantics; two small implementation details are resolved here so Maker has a crisp target:

1. **Engine input.** Add `locations` (the camp's `locations` rows, each with `id` and `capacity`) to the
   `buildSchedule({ … })` input object. The engine builds a `locationId → capacity` map internally and
   keys occupancy by `activity.location_id`. Engine stays pure (no IPC, no `JSON.parse` — T69). The caller
   `src/data/scheduleRepository.js` `loadSetupLists()` (line 77) adds `localClient.list('locations')` and
   threads it through `useScheduleData` → `useGeneration.js:79`.
2. **Interim activities with no `location_id`.** Between M1 and M3 the activity form still writes free-text
   `location` without setting `location_id` (the picker is M3). An activity with `location_id == null` gets
   **no place-capacity constraint** — identical to today's no-location behavior, and strictly better than
   the buggy string path. Do **not** resolve the free-text string back to a location in the engine. Document
   this as a known interim limitation that M3 closes when the picker sets `location_id`. `max_groups_per_slot`
   still applies to such activities per-activity.

If either detail cannot be implemented while keeping the engine pure and deterministic, **stop and escalate**
— do not work around it.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, interface directive, synthesis |
| Architect | no | ADR D2 settles semantics; signature is direct implementation |
| Designer | no | no UI |
| Maker | yes | writes the engine change + tests |
| Code Reviewer | yes | engine interface + maintainability + determinism |
| Verifier | yes | runs the mandatory `buildSchedule.test.js` + gates |
| Tester | no | no UI; disclosure is M3 |
| Security | no | no auth/schema/protocol surface |
| Red Hat | yes | behavior change, determinism, interim location_id state, capacity edge cases |
| Grader | yes | consolidates the reports |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| buildSchedule.test.js | pending | |
| test | pending | |
| lint | pending | |
| build | pending | |

## Round 1 review (findings)

- **Code Reviewer:** ready to commit; faithful to D2; scope-disciplined; determinism + purity confirmed. Three disclosure/follow-up findings (below).
- **Red Hat: Resilience 3 — found a real correctness bug (span-tail overfill) + a false claim in this record.** Not a determinism break; both fixable.
- **Security/Tester:** omitted (no auth/schema; no UI).

## Round 2 (fixes applied before commit)

1. **Span-tail place-capacity overfill (Red Hat, MEDIUM-HIGH) — FIXED.** `canPlace` checked place capacity + `same_tier_only` only at the head block; a multi-block span could overfill a place at a tail block (e.g. a locked/anchored slot at the tail), placing 2 groups in a capacity-1 place — the exact defect the initiative kills, surviving for spans. Fix: factored a `placeBlocked()` helper and apply it at the head **and every span tail**. Tests fail-first confirmed (2-in-cap-1 → blocked), determinism green. `same_tier_only` tail case (ADR gap 5) now tested.
2. **Manual-route instructor-cap warning (Red Hat MEDIUM / Code Reviewer Q3a) — RESTORED per owner decision.** M2's re-key of `computeOverlaps` to `location_id` dropped the pre-M2 per-activity (`max_groups_per_slot`) over-book warning on the manual route; the earlier assumption that `locationFull` covered it was **false** (`locationFull` is gated `route !== 'manual'`). **Owner decided (2026-08-15): keep the warning.** Restored as a second OVERLAP bucket in `computeOverlaps` keyed by `activity_id`, with distinguishing message text — no new flag kind (OVERLAP vocabulary unchanged). Now warns even for `location_id == null` activities (before the M3 picker).
3. **Stale comment (Red Hat) — CORRECTED.** `useSlotMutations.js:~428` now truthfully states OVERLAP surfaces place-capacity over-bookings; `locationFull` untouched (M3).
4. **`locations`-omitted guard note (Red Hat, LOW) — ADDED** in `normalizeInput`.

## Findings carried forward (to M3)

- **`useSlotMutations.js:419-433` `locationFull` is still activity-keyed and place-blind, and gated `route !== 'manual'`.** After M2, a director dragging a group into an over-capacity place **on the generated route** gets neither UNFILLABLE (place-blind) nor OVERLAP (manual-only). Not a regression (place capacity wasn't enforced anywhere pre-M2), but an incompleteness M3 closes when the picker lands and `locationFull` is re-keyed by `location_id`. (Code Reviewer MEDIUM follow-up + Red Hat.)
- `max_groups_per_slot` is now a live per-activity cap even for locationless activities (ADR D2 sanctions it; disclosed). Camps with `max_groups_per_slot` set on locationless activities will also see changed generated output — noted so it isn't a surprise. (Code Reviewer LOW.)
- Transient during load: `locations: []` before the list resolves can flash spurious OVERLAP (capacity-1 default) on the manual grid until locations load. Cosmetic. (Red Hat.)

## Pre-authorized behavior change (correction)

The earlier "pre-authorized" note named only null/0 **place** caps. Correction: M2 also makes `max_groups_per_slot` a live per-activity cap for **locationless** activities (ADR D2), so their generated output can change too. Both are ADR-sanctioned; recorded here so nothing is silent.

## Round 2 re-review (fixes verified)

- **Red Hat re-check: both fixes HOLD, Resilience 4/5.** Re-ran the original span-tail failing probe → now rejected; activity-cap bucket fires correctly (incl. locationless), null/0 suppressed, combined marker stable, place-capacity intact, determinism preserved. One doc finding (below) + one pre-existing LOW carried to M3.
- **Code Reviewer re-check: ready to commit after one comment fix.** `placeBlocked` helper faithful/symmetric; two-bucket `computeOverlaps` clean; scope/purity intact; carried-forward findings tracked. Same comment finding.
- **Comment fix (both reviewers, MEDIUM) — DONE.** `useSlotMutations.js:~426-438` corrected: after fix#2 restored the activity-cap warning, the comment (from the span-tail pass) falsely said "not surfaced on the manual route." Now accurately states both place-capacity AND activity-cap OVERLAP markers surface on the manual route, and re-scopes the M3 gap to the generated-route drag path. Comment-only, lint clean (`eslint` exit 0). An ordering artifact: fix#3 corrected the comment for the round-1 state, fix#2 then changed that state back — exactly the doc-drift this repo gates on.

## Additional finding carried forward (to M3)

- **`useSlotMutations.js` `locationFull` uses `max_groups_per_slot != null`, but the engine/`computeOverlaps` use `> 0`** (Red Hat LOW, pre-existing). So `max_groups_per_slot === 0` (the "no cap" sentinel): `locationFull` treats it as a cap → spurious UNFILLABLE on generated-route manual edit, while the engine treats 0 as no-cap and places freely — a generation-vs-manual inconsistency. Lives in the deferred `locationFull` code; fix when M3 re-keys `locationFull` by `location_id` and aligns the sentinel.

## Round-2 gates (authoritative)

lint GREEN · test GREEN (2567 passed / 1 skipped, 174 files, incl. mandatory `buildSchedule.test.js`) ·
build GREEN · governance no findings. Integration not run: not mandatory for a pure `scheduling-engine`
change (no schema/sync/auth surface). Comment fix landed after this run but is comment-only + separately
lint-verified, so the figures stand.

## Verifier verdict

**PASS.** Round-2 gate log independently verified (lint/test 2567/build/governance all exit 0, incl.
mandatory `buildSchedule.test.js`; focused 73/73). Confirmed the final `useSlotMutations.js` change is
comment-only (full-file diff) and lint-clean, so the gate log stands. Both round-2 fixes present in source
and pinned. Integration confirmed legitimately not required (zero `electron/sync|auth|ops|migration` files
touched). Every success-predicate claim traced to a passing check.

## Grader score

**PASS — 4.5** (spec-fidelity 5, maintainability 5, resilience 4, test-quality 5). Lowest dimension 4 ≥ 3;
Verifier PASS; no blocking rule fired. Security/Tester frozen out
pre-dispatch (no auth-schema/no-UI) — legitimate omissions, no completeness gap.

## Decision

**PASS.** M2 fixes the live order-dependent double-booking defect: the engine now keys occupancy by
`location_id` → `locations.capacity` (a place holds what the director says, regardless of placement order),
`max_groups_per_slot` stays a separate per-activity cap, and both surface on the manual route as
distinguishable OVERLAP markers per the owner's decision. The round-1 span-tail overfill bug was caught by
Red Hat, fixed, and re-verified. Not yet committed (held for owner authorization on the M2 commit/merge —
owner said "start M2", not merge).

**Before merge (integration steps, owner-gated):** commit → rebase onto current `origin/main` → re-run gates
→ PR → merge. This branch is off `9b6d11b` (M1); main may have advanced.

**Carried forward to M3:** the generated-route `locationFull` place-blindness + its `!= null` vs `> 0`
sentinel inconsistency (re-key by `location_id` when the picker lands); the `max_groups_per_slot`-on-
locationless disclosure; transient load-time spurious OVERLAP. All pinned in Findings-carried-forward above.
