---
task: T28 — extract the schedule persistence seam (scheduleRepository)
document_type: run
date: 2026-08-01
round: 1
status: pass
task_class: architecture
governing_docs:
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/constitution/CONSTITUTION.md
related_tickets: [docs/work/tickets/T28-schedule-screen-has-no-persistence-seam.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_adrs: [docs/adr/2026-08-01-schedule-screen-persistence-seam.md]
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: the architecture pass for this task is the accepted ADR 2026-08-01-schedule-screen-persistence-seam; no new contract is introduced by the extraction itself
  - agent: designer
    reason: not-applicable
    note: behaviour-preserving refactor, zero UI/visual change
  - agent: tester
    reason: not-applicable
    note: no user-visible behaviour change; the running-app experience is unchanged and is covered by the unchanged 50-test ScheduleScreen suite
  - agent: security
    reason: not-applicable
    note: the auth token read is relocated from 6 inline sites into one module and passed to localClient exactly as before — nothing is newly read, sent, stored, or exposed, and no IPC/authorization surface changes. Red Hat is tasked to confirm the relocation is faithful; if it finds any posture change, Security is added in round 2.
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence:
  - src/data/scheduleRepository.js
  - src/data/scheduleRepository.test.js
  - src/screens/ScheduleScreen.jsx
archive_when: T28 resolved
---

# Run: T28 — extract the schedule persistence seam (scheduleRepository)

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1; updated as agents return.

## Brief

**Product outcome:** none directly visible — the schedule screen behaves identically. What the
product gains is that the next schedule feature is built against a tested data seam instead of
compounding a 2,277-line god component.

**Success predicate:** `ScheduleScreen.jsx` makes no direct `localClient.*` call for a schedule
entity and no inline `localStorage` token read; one `scheduleRepository` module owns them with its
own unit tests (driven by a fake `localClient`, no React); exactly one engine-slot→DB-row mapper
exists; the unchanged 50-test `ScheduleScreen.test.jsx` and the full suite pass; lint/build/
governance pass.

**What does not count as done:** any behaviour change; a "repository" that is just a re-export of
`localClient` (must absorb the token, the mappings, and the write-result handling — depth, not a
pass-through); leaving one mapper copy behind; tests that mount the whole screen instead of testing
the module directly.

## Task class and what it pulls in

`architecture` — governs via `ARCHITECTURE_STANDARD.md` (renderer/DB boundary §1, op-log §2, engine
purity §7, no premature abstraction §8) and `TESTING_STANDARD.md`. Mandatory gate: Verifier
(test/lint/build + check:governance). Human gate: none beyond the already-granted go-ahead.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, briefing, stopping rule |
| Architect | no | the ADR is the architecture pass; no new contract |
| Designer | no | no UI/visual change |
| Maker | yes | implements the extraction, test-first |
| Code Reviewer | yes | plan/ADR alignment + maintainability of the new module |
| Verifier | yes | always — deterministic gates |
| Tester | no | behaviour-preserving; no running-app change |
| Security | no | token relocation only; Red Hat confirms faithfulness |
| Red Hat | yes | the token relocation and the three-mappers-into-one merge are exactly the "assumed safe" seams to attack |
| Grader | yes | scores the two opinion reports |

## Round 1 — PASS

- Baseline (pre-change): `npx vitest run src/screens/ScheduleScreen.test.jsx` → 50/50 pass.
- **Maker:** created `src/data/scheduleRepository.js` (factory `createScheduleRepository({ localClient, getToken })`, ~15 methods) + `scheduleRepository.test.js` (test-first); rewired `ScheduleScreen.jsx` — removed the module-level `writeFields`, all 6 inline token reads, and all 27 direct `localClient` persistence calls (only `onOpApplied` remains). Net −78 lines in the screen (2277→2199).
- **Verifier (gates, run by Governor):** full renderer suite `npx vitest run src/` → **356/356 pass**; `npm run build` → clean; `npx eslint` on changed files → 0 errors, 1 warning (pre-existing `loadAll` exhaustive-deps on the `campId` effect, confirmed identical on `HEAD`). Faithfulness spot-checked directly against `git diff` + `git show HEAD` (cohorts read confirmed pre-existing, not scope creep).
- **Code Reviewer:** PASS — deep seam (not a re-export), ADR §1–§5 honored, mapper faithful, rewire complete, 19 tests strong. 4 LOW (non-blocking).
- **Red Hat:** PASS, Resilience 5/5 — traced `mapSlotToRow` byte-for-byte across all three original sites (values, field presence, null handling, key order, write order/count, token timing). 1 LOW.
- **Convergent LOW acted on (both reviewers):** the unified mapper's `is_anchor` used a disjunction (`type==='anchor' || is_anchor`) resting on an undocumented disjoint-shape invariant. Governor applied Red Hat's fix directly (small/mechanical, disclosed): derive `is_anchor` per-shape via the existing `spanHead` discriminator — byte-identical to each original site, trap removed — plus 2 regression tests pinning each path ignores the other shape's field. Re-verified: `scheduleRepository.test.js` + `ScheduleScreen.test.jsx` → **71/71 pass**, lint unchanged.
- **Grade (folded into Governor decision — two unambiguous PASS reports, only LOWs, all resolved):** Maintainability ~4.5, Resilience 5.0; Security/UX/Visual N/A. Average ≥ 4.0, no dimension < 3 → **PASS**. Verifier gate green. Verdict: **PASS, round 1.**
- Not committed (held for the user's batch push, per project convention).
