---
task: T343: director-triggered end-of-season / by-week purge of elective choices
document_type: run
date: 2026-10-08
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T343-end-of-season-elective-purge.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, verifier, security, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: T343 is a bulk delete that reuses the already-proven deleteElectiveRun per-run cascade; no schema change, no new contract or mechanism, so no ADR/Architect pass was warranted (the shelved T342 was the architecture work; this is its right-sized replacement).
  - agent: designer
    reason: not-applicable
    note: the control reuses the existing ConfirmDangerDialog and the established week-scoped-screen pattern (App.jsx weekProps, as groups/activities/locations); no new visual-design surface.
  - agent: tester
    reason: not-applicable
    note: the UI is a confirm dialog plus a scope selector, fully covered by jsdom component tests (ElectivesScreen.test, 12/12); no director-flow UX beyond that, and the commissioning gate scope (Red Hat + Security + check:governance + Grader) did not include Tester.
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - commit 8f194cae (season purge) + commit 209ec0da (by-week scope)
  - Verifier PASS — 46/46 targeted tests (purgeElectiveSeason 15, ElectivesScreen 12, electiveRunDirectorFlow.integration 13, deleteElectiveSet 6), lint 0 errors; non-vacuity confirmed (dropping the week filter reds the by-week-isolation + NULL-week tests; restored 15/15 green); atomicity confirmed (injected RAISE(ABORT) -> byte-identical rollback)
  - Security PASS 5 (server-side admin gate = deleteElectiveRun's requireAuthorized action; weekId a camp-scoped bound-param filter; no bypass); Red Hat 4/5 (could not break any of the 7 delete/merge/week-filter axes); Code Reviewer ready; Grader PASS 4.0
  - full npm run verify is CI's job (gate of record) on PR #741 — not cited here to avoid self-invalidation
archive_when: T343 merged to main (PR #741) with CI green
---

# T343: director-triggered end-of-season / by-week purge of elective choices

## What shipped

A director-triggered bulk clear of elective choices, with a scope choice (this
week or the whole season), as the owner-approved right-sized replacement for the
shelved T342 distributed-purge-authority work.

- `electron/ops/purgeElectiveSeason.js` — `purgeElectiveSeason(db, {scope, weekId, ...})`:
  `season` deletes every elective run for the camp (including `schedule_week_id`
  NULL runs); `week` deletes only runs `WHERE schedule_week_id = weekId` (exact
  match; NULL-week runs not matched). Scope is explicit (throws on unknown scope
  or missing weekId). Both reuse the shared `cascadeDeleteElectiveRun` (extracted
  from `deleteElectiveRun`) over the in-scope runs in ONE `runAtomic` frame.
- Clears preferences + assignments + runs (+ run-scoped choices/choice_offerings/
  occurrences/snapshots/findings). Leaves untouched: the elective offerings setup
  (`elective_sets`/`set_activities`/`bundles`/`bundle_periods`/`bundle_tiers`) and
  campers/groups/tiers/activities/days/schedules/fixed_events.
- IPC handler (admin-only), preload/localClient/mock wiring; `ElectivesScreen`
  scope selector behind `ConfirmDangerDialog` with honest, scope-named copy
  (names what is removed and kept, and that it does NOT scrub op-log history,
  cannot reach exported copies, and a concurrent peer can resurface a run unnamed
  until cleared again) + non-banner success feedback. No schema change, no crypto.

## Evidence

See `completion_evidence` above. Built test-first, red-before-green, across three
Governor-run Workflow passes (season build; honest-copy correction; by-week
scope). The Red Hat agent glitched on the first season pass and was re-run (not
accepted as a stub); two Grader FAILs along the way were both the known
GateReportCli provenance-binding artifact for workflow-dispatched graders
(discounted per board precedent and the board-keeper's explicit instruction), with
no substantive blocker ever open.

## Agents

Ran: governor (this session, orchestrating via the Workflow tool), maker,
verifier, security, red-hat, code-reviewer, grader. Omitted with reasons in the
frontmatter: architect, designer, tester (all not-applicable).

## Known-acceptable residuals (Governor calls, per the owner's convergence order)

- A by-week purge that matches zero runs (e.g. a camp whose runs are all
  NULL-week/whole-camp) honestly reports "no elective runs to clear for <week>" —
  the director is not misled (Red Hat MEDIUM, mitigated by the honest feedback).
- "This week" is the ambient week context (App.jsx weekProps), changed via the
  app's normal week control, consistent with every other week-scoped screen
  (Code Reviewer MEDIUM — matches the established pattern).
