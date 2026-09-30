---
task: T318 — a run names the day it means, and never invents a rank
document_type: run
date: 2026-09-29
round: 2
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T318-a-run-names-the-day-and-never-invents-a-rank.md, docs/work/tickets/T296-per-camper-elective-schedule-view.md]
related_specs: []
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
selected_agents: [governor, architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: copy-only change inside existing surfaces; no new component, layout, token or motion
  - agent: security
    reason: no-predicate
    note: no auth, IPC, schema or wire-shape change; Route 1 adds no IPC field
  - agent: tester
    reason: human-waived
    note: "owner brief, 2026-09-29: \"no running UI in this session; record the omission honestly\""
deterministic_checks: [test (10 scoped files, 88 passed, exit 0), lint (exit 0), "check:governance (exit 0)"]
human_gates: []
verdict: PASS
completion_evidence: ["red-on-main then green quoted per defect in this file", "plant-revert reproduced the red for each of the three fixes", "git diff 06239007 -- electron/ empty"]
archive_when: "T318 is closed and its evidence is quoted here"
---

# Run: T318 — a run names the day it means, and never invents a rank

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** A director reading an elective run is told which day an over-capacity period is
on — including on a run reopened cold from the run list — and is never told that a camper ranked
something second when that camper's sheet was read as an unordered set.

**Success predicate:**
1. `occurrenceLabel` resolves a day row shaped `{ id, label: 'Monday' }`, yielding
   "… — Monday, Period 2".
2. Both run screens label their over-capacity rows from the run's persisted occurrences, so the
   day/period is present with `templateOccurrences` empty.
3. No surface a director or counsellor reads — camper week, run summary, exported workbook — states an
   ordinal for a placement whose joined preference is `'unordered-set'`, null, or unjoinable; an
   ordered placement still states its ordinal.
4. Each of the three has a test that FAILS on `origin/main`, quoted in this file.

**What does not count as done:** narrowing the claim in a comment instead of making it true; a
`rank_kind` check on one of the three surfaces while another still prints the ordinal; a test that
passes on main; suppressing the ordinal for everyone (an ordered camper's ordinal is real and must
survive); fixing (a) by renaming the column.

## Task class and what it pulls in

`ui-ux-design` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `DESIGN_STANDARD.md`; `TESTING_STANDARD.md` for the gate list |
| Mandatory gates | test · lint · build (`check:governance` added by the new work records) |
| Human gate | none — no token *value* changes; copy is director vocabulary inside existing rows |

Not `database-sync`: Architect chose Route 1, which changes no schema and no stored shape.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | (c) had two routes, one of them a schema bump; needed deciding on evidence |
| Designer | no | not-applicable — copy inside existing rows, no component/layout/token/motion |
| Maker | yes | three code seams |
| Code Reviewer | yes | plan alignment; a signature change on `satisfactionSummary` and an exported join |
| Verifier | yes | always |
| Tester | no | human-waived — owner brief: no running UI in this session |
| Security | no | no-predicate — no auth, IPC, schema or wire-shape change |
| Red Hat | yes | (c) reinterprets stored data; the join runs against a union-of-generations list |
| Grader | yes | always |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| test (scoped: 10 named files) | PASS | 88 passed, 0 failed, exit 0 |
| lint | PASS | 0 errors, 26 pre-existing warnings, exit 0 |
| check:governance | PASS | no findings, exit 0 |
| `git diff 06239007 -- electron/` | EMPTY | confirms Route 1 — no schema, no IPC, no stored-shape change |
| test:integration · migration tests | not run — correctly out of scope | mandatory only for sync/auth/schema changes; the empty `electron/` diff is the predicate's negation |
| full suite (`npm run test`) | deferred to CI | ~11 min, past the foreground ceiling; CI is the gate of record for merging (`TESTING_STANDARD.md` §1) |

**Round 2 gates** (the delta gating `NOT_TOP_CHOICE` and consolidating the predicate):

| Gate | Result | Evidence |
|---|---|---|
| test (scoped: 23 files incl. the engine, the ETL, the T302 guard) | PASS | 431 passed, exit 0 |
| lint | PASS | 0 errors, 26 pre-existing warnings, exit 0 |
| check:governance | PASS (1 advisory) | exit 0; `platform-state-stale`, addressed by the PLATFORM_STATE entry landed with this work |
| `git diff bee8516c -- electron/db` | EMPTY | no schema moved; integration + migration tests correctly out of scope |
| placement identity | PASS | pinned by ONE fixture with a hand-derived unique optimum — Verifier put that limit on the record rather than implying broader coverage |

Scoped rather than whole-suite deliberately: a subagent that backgrounds the 11-minute suite parks on
the wait. The named files are the ones this diff can break, plus `preferenceEditToResolve.test.jsx`
and `exportChildSchedule.test.js` as blast-radius controls on modules that were NOT supposed to
change. Verifier additionally grepped every caller of the three changed signatures — a missed
`satisfactionSummary` caller yields `rows: undefined` silently rather than crashing, so the grep is
the only thing that finds it.

## Verifier verdict

**Round 1: PASS.** Four gates, read by exit code rather than output tail; every predicate clause mapped
to a named assertion, none left UNVERIFIED.

**Round 2: PASS.** 431 tests over 23 files (exit 0), lint and governance clean, `electron/db` diff
empty. All seven clauses of the ticket's (d) traced to specific assertions that were read, not inferred
from test names — including both engine emission sites as separate paths, the safe default, the
ordered-vs-ordered tie, the ordered-vs-unordered tie, placement identity, the null-rank crash, and the
single-source-of-truth for the constants. Nothing UNVERIFIED.

## Grader score

Average **4.4**, lowest dimension **4** (maintainability, UX/copy, operational risk). Pass is ≥ 4.0
with no dimension below 3. Spec fidelity 5, security 5.

**A calibration note the owner should have, not a finding against the work:** Grader's FIRST pass
returned FAIL at 3.5. That verdict was malformed in two ways — it averaged over two *agents* rather
than the five *dimensions* asked for, silently dropping three, and it failed the work on "3/5 falls
below the passing threshold of 3.0", where the rule is *below* 3. Re-asked with both defects named and
nothing about the work changed, it returned 4.4/PASS. A grader that moves a verdict two thirds of a
point and flips it on a re-ask is a weak instrument; the deterministic gates above, not the score, are
what this run's PASS rests on (`CONSTITUTION.md` Art. VII — a reviewer score is never proof).

**Round 2 Grader: average 4.4, lowest 3** (maintainability). Spec fidelity 5, UX/copy 5, security 5,
operational risk 4. Pass is ≥ 4.0 with no dimension below 3; 3 is not below 3.

Maintainability took the 3 for the right reason: the refactor introduced a crash before review caught
it, and two LOWs remain (a comment stating the allow-list as prose without pointing at
`rankKind.js`; the `DraftRunView` ADD-path write having no direct test — a pre-existing gap). The two
named residual risks are on the record rather than smoothed over: **placement identity rests on one
fixture** plus Red Hat's algebraic comparison of all five branches of `better` against the pre-delta
reducer, and **the consolidation concentrates a silent failure** — one typo in `rankKind.js` now
reaches six consumers and fails safe, which is why `rankKind.test.js` pins the three exact strings and
not only the predicate's behaviour.

One correction to Grader's own output, recorded because it would mislead the next reader: its closing
"Scope note" says the pre-commit fabrication was escalated rather than absorbed and that the solver is
out of scope by owner instruction. That was round 1's state. The coordinator reversed it, round 2
closed it, and this record's first finding says so. Grader's five dimension scores are unaffected.

## Findings carried forward

**CLOSED IN ROUND 2 (was HIGH, carried forward from round 1) — the pre-commit solve preview
fabricated the same ordinal.** The coordinator ruled that the solver exclusion was its own scoping and
not the owner's, and that the owner's rules override it: "a defect you find at a seam you are already
changing is FINISHED, not recorded" and "staff must not see a fabricated rank." So round 2 gated the
engine's `NOT_TOP_CHOICE` emission at both sites. Governor's deferral in round 1 was wrong on the
scoping question and is recorded as such rather than quietly overwritten.

**Two real defects were found IN round 2's own work, both by review, neither by the author.**

1. *Code Reviewer, HIGH — a crash introduced by the refactor.* `choiceBestOverMembers` dereferenced
   `held.rank` with no null guard, unlike its sibling `bestAt`. `elective_preferences.rank` is a
   nullable INTEGER, so a linked choice with a null-rank preference on one member occurrence threw
   `Cannot read properties of null (reading 'rank')`. Worse than the bug being fixed: before the
   refactor the same input degraded silently to a wrong value; after it, the whole solve aborted for
   every camper. Fixed, pinned by a regression test, and confirmed by the reviewer re-running its own
   reproduction rather than re-reading the diff.
2. *Red Hat, MEDIUM-HIGH — a defect in Governor's specification, not the implementation.* The tie rule
   as first specified collapsed ordered-vs-ordered ties to no-evidence, suppressing a real ordinal —
   the opposite failure direction from the one this ticket closes. See the ticket's (d) for the
   corrected rule and the reachability evidence.

**MEDIUM — deviation from the ticket text, disclosed.** Maker added `preferences={state.preferences}`
to `FinalRunView`'s `CamperWeekPanel` call. Not named in the ticket, and necessary: without it the
Final screen's `rank_kind` join is always empty, so every ranked entry there would read "One of their
choices" whatever the data said — the safe default failing safe in the wrong direction, by hiding real
ordinals rather than by fabricating them. Confirmed correct by Code Reviewer against
`CamperWeekPanel.jsx`'s `buildCamperElectiveWeek` call, and exercised by
`src/screens/elective/run/camperWeekFromDatabase.test.jsx`.

**LOW — `counts_by_rank` + `unordered_count` + `unassigned_count` is not a partition** and never was
(Red Hat): the first two count assignments, the third counts campers, and an assignment with a null
`preference_rank` is in none of them. Pre-existing, unchanged by this run, recorded so nobody later
"fixes" the arithmetic under the belief T318 broke it.

**LOW — `resolvePreferenceCoordinates`'s `occurrenceAtCell` map keys on day+time_block and omits
`tier_id`** (Red Hat), while one run's occurrences can legitimately span tiers at the same cell. Real,
pre-existing, documented by that file's own comments. Red Hat could not construct an input where it
produces a WRONG ordinal through `buildPreferenceLookup` — `camper_id` is part of every key, so a
mis-binding can only miss, and a miss collapses to the safe non-ordinal word. Recorded as narrow, not
clean.

## Decision

**PASS, in two rounds.** Round 1 closed (a)-(c) on the committed-run surfaces. Round 2 closed (d), the
same fabricated ordinal on the pre-commit preview, after the coordinator ruled that the solver
exclusion was its own scoping rather than the owner's and that the owner's rules override it.

Verifier PASS both rounds, on exit codes. Round 2: 431 tests over 23 files, lint and governance clean,
`electron/db` diff empty — no schema moved, so Route 1 held end to end.

**What this run should be remembered for is that review found two real defects in round 2's own work,
and neither was found by the author.** Code Reviewer found a crash the refactor introduced — strictly
worse than the bug being fixed, because it aborted the whole solve where the old code degraded
silently — and confirmed the fix by re-running its own reproduction rather than re-reading the diff.
Red Hat found an error in *Governor's specification*: the tie rule as first written suppressed a real
ordinal for a camper who had ordered their sheet twice over, the opposite failure direction from the
one this ticket exists to close. Both are fixed and pinned. That pattern reads as the loop working, not
as unsound work — but it is also the argument against grading the author's own confidence.

Governor's round-1 scoping error is recorded above rather than overwritten, and the ticket's
`archive_when` was restored to the full claim — before commit and after — only once that claim became
true.

Still absent, and not claimed as present: Tester was human-waived, so there is **no visual or
directors-eye evidence** in either round. The copy is one word inside existing rows and round 2 changed
no copy at all, but "low layout risk" is an argument, not evidence.