---
task: T318 — a run names the day it means, and never invents a rank
document_type: run
date: 2026-09-29
round: 1
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

Scoped rather than whole-suite deliberately: a subagent that backgrounds the 11-minute suite parks on
the wait. The named files are the ones this diff can break, plus `preferenceEditToResolve.test.jsx`
and `exportChildSchedule.test.js` as blast-radius controls on modules that were NOT supposed to
change. Verifier additionally grepped every caller of the three changed signatures — a missed
`satisfactionSummary` caller yields `rows: undefined` silently rather than crashing, so the grep is
the only thing that finds it.

## Verifier verdict

**PASS** — on the four gates above, read by exit code rather than by output tail. Every clause of the
success predicate was mapped to a specific named assertion; no clause was left UNVERIFIED.

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

## Findings carried forward

**HIGH — the pre-commit solve preview still prints a fabricated ordinal (Red Hat, round 1, not
fixed).** `src/engine/buildElectiveAssignments.js` raises `NOT_TOP_CHOICE` from `rank > 1` with no
`rank_kind` gate, and `src/screens/elective/assignment/AssignmentPreview.jsx` renders it as "Not top
choice (got #N)". `src/screens/elective/assignment/exportElectiveRun.js` holds a second copy of that
flag copy, imported by `exportChildSchedule.js` and `AssignmentPanel.jsx`. This is the same defect
class as (c) on a different seam: the engine's in-memory flags before commit, not the committed run's
stored rows. Left open deliberately — the honest fix changes which flags the solver emits, and the
solver is out of this ticket's scope by owner instruction, while suppressing only the wording would
leave the flag itself asserting an ordering ("top choice") the camper never expressed. T318's
`archive_when` was narrowed to say what it actually closes rather than overclaim. **Needs an owner
ruling and its own ticket.**

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

**PASS on T318's own scope, in one round — with one HIGH finding ESCALATED to the owner rather than
absorbed.**

The three owner-ruled defects are closed, each pinned by a test that was red on `origin/main` and is
green now, each plant-reverted to prove the test is not vacuous. Verifier PASS on exit codes. No round
2 was needed.

The escalation is deliberate and is the one thing needing a human: Red Hat found the same
fabricated-ordinal defect class alive on a **different** seam — the pre-commit solve preview, where the
engine's `NOT_TOP_CHOICE` flag is raised from `rank > 1` with no `rank_kind` gate. Closing it honestly
means changing which flags the solver emits, and the solver is excluded from this ticket by explicit
owner instruction. **An owner-set scope exclusion is not a reviewer's to widen and is not mine either**
— so rather than quietly exceed the brief or quietly leave the ticket overclaiming, T318's
`archive_when` was narrowed to the committed-run surfaces it actually closes, and the gap is written up
above for the owner to rule on (`CONSTITUTION.md` Art. IV; rule 10 — stop when human judgement is
truly required).

Tester was human-waived, so no directors-eye or visual evidence exists for this round. The copy change
is one word replacing a number inside existing rows, but "low layout risk" is an argument, not
evidence, and it is recorded as absent evidence rather than as a pass.
