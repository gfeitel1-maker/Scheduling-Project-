---
ticket: T343
document_type: ticket
title: Director-triggered end-of-season purge of elective choices (bulk clear, confirm step)
status: open
created: 2026-10-07
archive_when: "a director can, from the Electives UI, trigger a confirmed bulk clear that deletes EVERY elective run for the camp with the full run-scoped cascade (preferences, assignments, choices, choice_offerings, occurrences, run snapshots, run findings, the run rows) and NOTHING else — campers, groups, tiers, activities, days, schedules, fixed_events and the elective OFFERINGS setup (elective_sets/set_activities/bundles/bundle_periods/bundle_tiers) are untouched — through the normal op-log/document write path in one runAtomic frame, resurrection-safe under a concurrent peer write, convergent, with honest confirm copy; built test-first and merged through the full gate (Red Hat on the delete/merge path + Security + check:governance + Grader)"
task_class: database-sync
parent: ""
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: []
---

# T343 — End-of-season purge of elective choices

## Context

Owner-approved 2026-10-07 (via the board-keeper), the right-sized replacement for the shelved T342
distributed-purge-authority work. A camp reuses its elective OFFERINGS structure season to season but
needs a clean slate for the season's actual camper CHOICES and results. This is a deliberate,
director-run bulk clear — **plain deterministic deletes through the normal op-log/document write path,
no signatures, no quorum, no ancestry/crypto** (explicitly out of scope — that was T342, shelved).

## Scope (owner-confirmed exactly — do NOT widen, Karpathy)

**CLEAR, for the camp — every `elective_assignment_run` with the full run-scoped cascade**, exactly the
cascade `electron/ops/deleteElectiveRun.js` already performs per run (reuse it; do not reimplement the
order or the tombstone-guard):

1. `elective_run_findings` (run_id)
2. `elective_run_outer_snapshots` (run_id)
3. `elective_assignments` (run_id)
4. `elective_preferences` (run_id)
5. `elective_choice_offerings` (via `elective_choices`)
6. `elective_choices` (run_id)
7. `elective_occurrences` (run_id)
8. `elective_assignment_runs` (the parent row, last)

This clears **elective_preferences + elective_assignments + elective runs** (the owner's three named
targets) because all three — and choices/offerings/occurrences — are `run_id`-scoped.

**LEAVE UNTOUCHED (clearing any of these is widening):** campers, groups, tiers, activities,
days_of_operation, schedules/schedule_templates/slots, fixed_events; and the elective OFFERINGS setup —
`elective_sets`, `elective_set_activities`, `elective_bundles`, `elective_bundle_periods`,
`elective_bundle_tiers`. The director keeps what electives are offered; only the season's choices and
results are cleared.

## Shape

- A new op (e.g. `electron/ops/purgeElectiveSeason.js`) that enumerates every `elective_assignment_run`
  for the camp and deletes each with `deleteElectiveRun`'s cascade, in **one `runAtomic` frame** (all or
  none). Reuse the shared cascade so it inherits the resurrection-safety (`elective_assignment_runs` ∈
  `TOMBSTONE_GUARDED_STUB_PARENTS`, T320 part 2) and the op-log representation.
- IPC handler + preload + `localClient` exposure; match `deleteElectiveRun`'s exact auth posture
  (Security confirms).
- A director control on the Electives screen with a **confirm step** (`ConfirmDangerDialog`) whose copy
  honestly names what is removed (all elective choices/assignments/runs for the season) and what is kept
  (the elective offerings setup, campers, schedules). No banners (repo rule); it is an explicit action.

## Gate

Test-first, red-before-green, Karpathy scope discipline. Bulk DELETE touching stored data shape +
op-log/document + projection → **Red Hat REQUIRED on the delete/merge path** (concurrent peer write
cannot resurrect a cleared run; the clear converges; cascade orphans nothing; clean single `runAtomic`
frame). **Security** on the auth posture. `check:governance`, full gate, **Grader**. A Grader FAIL is a
STOP → escalate to the board-keeper, not a third round. No schema change (deletes only). Confirm the
merge by content.
