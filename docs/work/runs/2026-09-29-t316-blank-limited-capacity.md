---
task: T316 — a blank limited capacity is named, and it blocks the run
document_type: run
date: 2026-09-29
round: 2
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T316-a-blank-limited-capacity-is-named-and-blocks-the-run.md]
related_specs: []
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: human-waived
    note: "AMENDED IN ROUND 3, because the round-1 note became false. It said 'no IPC/contract change'; the owner then ruled the write path in scope and the set-elective-assignment channel gained a fourth refusal member. The owner directed that design personally and named the reason code - verbatim, 2026-09-29: 'a defect you find at a seam you are already changing is FINISHED, not recorded' and 'A manual move into a (limited, NULL) offering must be refused with a NAMED reason consistent with the run refusal (e.g. reason INVALID_CAPACITY naming the offering), never reported as OCCURRENCE_FULL, and never treated as capacity 0.' The widening is additive and no consumer switches on the code by value (Red Hat, confirmed by reading). The ADR that documents the old three-member union is escalated for the owner, not amended by an agent (Art. IV)."
  - agent: designer
    reason: not-applicable
    note: one plain sentence in the findings surface that already exists (AssignmentPreview's findings list). No new component, no token change, no visual change to specify
  - agent: security
    reason: not-applicable
    note: "AMENDED IN ROUND 3 for accuracy: an IPC handler IS now touched (setElectiveAssignment's refusal branch), which the round-1 note denied. It remains not-applicable on the merits - no auth check, token, secret, role gate or transport behaviour changes; authorize() and every eligibility check still run ahead of the capacity branch, unmoved (Red Hat, confirmed by reading), and the new refusal adds a return member rather than a code path into the database."
  - agent: tester
    reason: not-applicable
    note: no running app in this session (no Electron; the :5200 dev mock is not the real stack). Consequence, stated honestly - the director's-eye judgement of this sentence's wording and of how the refusal feels is NOT evidenced by this run. The behaviour is pinned by a component test that renders the real panel and asserts commitElectiveRun is never called; the experience of it is not.
deterministic_checks: [test, lint]
human_gates:
  - "RESOLVED by owner ruling 2026-09-29 (\"a defect you find at a seam you are already changing is FINISHED, not recorded\"): electron/ops/setElectiveAssignment.js was ruled IN SCOPE and is fixed — a blank limited capacity is refused as INVALID_CAPACITY naming the offering, never OCCURRENCE_FULL, never capacity 0"
  - "OPEN — docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md documents set-elective-assignment's refusal union as three members; it now has four. An agent may not amend an ADR (Art. IV), and both Code Reviewer and Red Hat flagged that an owner-ordered widening of a documented, closed IPC union is what an ADR addendum exists to prevent drifting. Owner decision needed."
  - "OPEN — whether a refused run should offer an on-screen way back (a control, not a sentence). Pre-existing, not introduced here; product judgement."
  - "OPEN — whether unknownMinimum (T265's mirror of this defect) should block the same way. Owner has not ruled; left as T265 left it."
verdict: pass
archive_when: T316 completed and merged
completion_evidence:
  - "Round 3 verification: npx vitest run [8-file suite] — Test Files 8 passed (8), Tests 141 passed (141)"
  - "Round 3 verification: npx vitest run [3-file suite] — Test Files 3 passed (3), Tests 58 passed (58)"
  - "Round 3 verification: npm run lint — 0 errors, 26 pre-existing warnings"
  - "Round 3 verification: npm run check:governance — no findings"
  - "Round 3 verification: plant-the-defect on setElectiveAssignment.js — revert to old capacity:0 collapse, tests fail with OCCURRENCE_FULL (expected), restore fix, all tests pass; git diff --stat matches original (6 files)"
---

# Run: T316 — a blank limited capacity is named, and it blocks the run

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1.

> **On the round numbering, because the section headings below count higher than `round: 2`.** A *round*
> here is a review-and-grade cycle, which is what Article VII caps at two: round 1 graded the original
> scope (3.5, escalated), and round 2 graded the work after the owner re-scoped the task — Verifier PASS,
> Grader 4.5. The Maker passes inside round 2 are numbered 3, 4 and 5 in their own evidence headings
> because that is the order they happened in; they are iterations within one round, not hidden rounds, and
> each one exists because the round's reviewers found a defect in the previous one's fix. `round: 3` was
> written into this frontmatter briefly and was a checker finding, correctly — there is no round 3.

## Brief

**Product outcome:** a director who sets an offering to *limited* and leaves the number blank is told
which activity is missing its number, and the run will not proceed until they fill it in. Today
nobody is placed in that offering and nothing says why.

**Success predicate:** all four hold.

1. A confirmed offering whose `resolveOfferingCapacity` kind is `unknownLimit` produces a finding
   `kind: 'INVALID_CAPACITY'` naming the activity as the director spells it, carrying `activity_id`
   and the `elective_set_activities` row id.
2. `AssignmentPanel` does not call `buildElectiveAssignments` and cannot call `commitElectiveRun`
   while such a finding exists; the sentence is shown in the findings surface that already exists.
3. The offering does not reach the engine as capacity 0.
4. `electron/main.js`'s `getElectiveRunHandler` comment and
   `electron/ops/electiveOfferingCapacity.js`'s header say what is now true, narrowed to exactly
   what changed.

**What does not count as done:** a finding that exists but does not block. A block with no sentence.
A banner, help text, a new explainer component, or a disabled button with a tooltip. Capacity 0
still reaching the engine "but with a finding alongside it". A comment update that claims more than
the code delivers. A test that hand-builds an offering object instead of going through
`buildOfferings` from a stored-row shape. Any schema change or any change to `unknownMinimum`.

## Task class and what it pulls in

`ui-ux-design` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `DESIGN_STANDARD.md` (no token or visual change proposed), `CONSTITUTION.md` Art. V |
| Mandatory gates | test · lint · build |
| Human gate | changing a token *value* — not triggered |

Build is not in `deterministic_checks` above because Verifier is scoped by Governor to the named
test files plus `lint` and `check:governance`; the full gate (`npm run verify`, which includes
`build`) is CI's, per `CLAUDE.md` and `TESTING_STANDARD.md` §1. That scoping is recorded rather than
implied: this run's evidence does **not** include a build.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, flat in the main loop — one small logic-plus-one-sentence change |
| Architect | no | not-applicable: no schema, contract, or persisted shape |
| Designer | no | not-applicable: one sentence in an existing surface |
| Maker | yes | the only agent that writes production code |
| Code Reviewer | yes | plan alignment + maintainability at a seam three tickets already touched |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | not-applicable: no running app in this session; consequence stated in frontmatter |
| Security | no | not-applicable: no auth/IPC/secret surface |
| Red Hat | yes | the assumption that "blocking" is achievable without a new UI control, and the blast radius of omitting an offering from the engine's input |
| Grader | yes | scores the opinion reports |

## Maker evidence (round 1)

**Files changed**

- `src/screens/elective/assignment/buildOfferings.js` — new export `findBlankCapacities`; a shared
  `isConfirmed` helper (same predicate `buildOfferings` already used, extracted so the two cannot
  disagree about which rows the solver sees); `buildOfferings` now `continue`s past an `unknownLimit`
  row instead of mapping it to capacity 0; the T245 comment above the resolution updated to say so.
- `src/screens/elective/assignment/AssignmentPanel.jsx` — `solve()` calls `findBlankCapacities`
  right after `buildOfferings`; if it returns anything, sets `{ assignments: [], findings, choices: [] }`,
  phase `preview`, an announcement, and returns before `deriveChoices`/`buildElectiveAssignments` run.
- `src/screens/elective/assignment/AssignmentPreview.jsx` — hoisted the findings `<ul>` into a
  `findingsList` local, rendered both in the existing findings-rail spot and (new) inside the
  zero-assignment branch, above the "No campers could be placed" text.
- `electron/ops/electiveOfferingCapacity.js` — header comment says T316 now emits this finding at
  generation time (buildOfferings.js's `findBlankCapacities`) and that the read-time caller is
  unchanged.
- `electron/main.js` — `getElectiveRunHandler`'s block comment and the inline comment at its
  over-capacity skip both updated: no longer claim the case is surfaced nowhere; say generation time
  now surfaces it and this read path's own skip is unchanged and still correct (a run cannot commit
  through a blocked solve; the only way to reach this skip is a run committed before T316, or a
  capacity blanked again after committing — both out of scope).
- Tests: `buildOfferings.test.js`, `AssignmentPreview.test.jsx`, `AssignmentPanel.test.jsx`,
  `findingLabelCoverage.test.js` (all described below).

**RED (before any production change), trimmed to the failing assertions**

```
FAIL buildOfferings.test.js > findBlankCapacities names the activity, carries its ids, ...
TypeError: findBlankCapacities is not a function

FAIL buildOfferings.test.js > produces no finding for a non-confirmed row with a blank limited capacity
TypeError: findBlankCapacities is not a function

FAIL findingLabelCoverage.test.js > has a fixture for every kind the producers emit, ...
AssertionError: FIXTURES covers kind(s) the producers no longer emit: INVALID_CAPACITY:
expected [ 'INVALID_CAPACITY' ] to deeply equal []

FAIL findingLabelCoverage.test.js > INVALID_CAPACITY: its fixture really emits it, ...
TypeError: findBlankCapacities is not a function

FAIL AssignmentPreview.test.jsx > shows findings alongside the zero-assignment sub-state, with NO Commit button
TestingLibraryElementError: Unable to find an element with the text: /is set to limited capacity/.
  <div>No campers could be placed</div>
  <div>Check that this set has confirmed offerings with capacity, ...</div>

FAIL AssignmentPanel.test.jsx > surfaces the finding, shows no Commit button, and never calls commitElectiveRun
TestingLibraryElementError: Unable to find an element with the text: /is set to limited capacity/.
  <div aria-live="polite">No campers could be placed.</div>
  <div>No campers could be placed</div>
```
All five failures were the expected shape (missing function / missing render), not a typo — each
also independently confirmed the pre-existing defect: the AssignmentPanel run against the blank
offering rendered "No campers could be placed" with no explanation, i.e. capacity 0 silently closing
the offering, exactly what the ticket describes.

**GREEN, summary lines**

```
✓ buildOfferings.test.js (15 tests)
✓ findingLabelCoverage.test.js (11 tests)
✓ AssignmentPreview.test.jsx (14 tests)
✓ AssignmentPanel.test.jsx (32 tests)
✓ ParseSummary.test.jsx (31 tests)
✓ preferenceEditToResolve.test.jsx (4 tests)
✓ localClient.mock.electives.test.js (11 tests)
✓ buildElectiveAssignments.test.js (42 tests)
Test Files  8 passed (8)
     Tests  160 passed (160)
```
`npm run lint`: 0 errors, 26 pre-existing warnings (react-hooks/exhaustive-deps and stale
eslint-disable directives) in files this ticket did not touch; none in the changed files.

**Plant-the-defect non-vacuity check**

Reverted only the three production files (`buildOfferings.js`, `AssignmentPanel.jsx`,
`AssignmentPreview.jsx`) via `git diff` → `/tmp/.../t315-prod.patch` → `git apply -R` on that explicit
patch (no `git stash`), tests left untouched. Re-ran the four affected suites:

```
Test Files  4 failed (4)
     Tests  6 failed | 66 passed (72)
```
The same 6 new/changed assertions went red, for the same reasons as the original RED run above
(`findBlankCapacities is not a function` ×3, the FIXTURES divergence check, and the two render
assertions for "is set to limited capacity" not found — AssignmentPreview.test.jsx and
AssignmentPanel.test.jsx). Restored via `git apply` on the same patch; re-ran the same four suites
green (72/72), confirming the revert-and-reapply round-tripped cleanly.

**Deviations from the brief**

- `AssignmentPanel.test.jsx`'s new test does not assert `driveToPreview`'s existing "wait for Commit
  Assignments" helper (that helper would hang forever on a blocked run, since no Commit button ever
  renders); it inlines the same parse→map→solve steps and waits for the finding text instead. This is
  the brief's own fallback ("if driving the whole import→solve flow is impractical there, say so") —
  driving it WAS practical, just not through the shared helper, so the test drives the real
  `AssignmentPanel` end-to-end (file → mapping → solve) rather than only pinning `AssignmentPreview`
  in isolation.
- Updated the inline comment at `electron/main.js`'s over-capacity skip (~line 2270-2274) in addition
  to the block comment the brief cited (~2140-2155) — it made the identical stale claim
  ("since no finding surfaces it anywhere today") and would have been left false otherwise.

**Not verified**

No Electron/browser run (this is a pure-logic + component-test change with no visual delta to the
existing findings rail; `AssignmentPreview.test.jsx`/`AssignmentPanel.test.jsx` render the real
component tree via `@testing-library/react`, which is what the Tester's omission note in this run's
frontmatter already accounts for). Full `npm run verify` / `npm run test` not run, per this ticket's
scoping to the named files plus lint.

## Maker evidence (round 2)

Comment-only round, per two Red Hat CONFIRMED findings on requirement 4 (a comment asserting the
skip is surfaced nowhere must say what is now true, and must not overclaim). No behavior, no test
changed — `karpathy-guidelines` was invoked first and this round confirmed test-driven-development
does not apply to a comment-truth fix (nothing executes differently, so there is nothing to write a
test against).

**1. `electron/ops/setElectiveAssignment.js` (capacity block, ~lines 136-148).** The old comment
claimed this write path's `('limited', NULL) → capacity 0` reading "mirrors the engine" —
`buildOfferings.js`. Confirmed false by reading `src/screens/elective/assignment/buildOfferings.js`
(lines ~43-47, ~70-83): as of T316, `buildOfferings.js` now `continue`s past an `unknownLimit` row
(excludes it from generation entirely) rather than mapping it to capacity 0, and `AssignmentPanel`
refuses to solve while one exists. Rewrote the comment to say this write path's reading has
diverged from the engine since T316, that it therefore rejects a director's manual move/lock
against a misconfigured (blank-capacity) offering as `OCCURRENCE_FULL`/`capacity: 0` — as though
full rather than blank — and that this divergence is left deliberately unresolved because changing
a write path's rejection semantics is a contract change outside T316's scope. Behavior in the file
is unchanged; only the six-line comment became a thirteen-line comment.

**2. `electron/main.js`, `getElectiveRunHandler` block comment (~lines 2154-2159, the one edited in
round 1).** The round-1 text enumerated exactly two ways to reach the silent skip ("a run committed
before T316, or a capacity blanked again after committing") in language that reads as exhaustive.
Red Hat's claim was a third path: an Automerge merge from another device can write an
`elective_assignments` row (or blank an offering's `capacity_mode`/`capacity_limit` on
`elective_set_activities`) without ever passing through `setElectiveAssignment.js`'s capacity guard.
Verified this by reading, not assuming:
- `electron/automerge/campDocument.js` (`applyWrite`, ~line 604 onward): confirms `applyWrite` is
  the one function that mutates the Automerge document, used identically for a local write and for
  a remote-merge-derived write — there is no separate "local-only" mutation path.
- `electron/sync/automerge/syncNode.js` (~lines 125-260): on a received sync frame it does
  `const merged = A.merge(currentDoc, incoming)` then calls `projectAndNotify(merged, ...)`, which
  calls `projectAll(db, merged)` (imported from `electron/automerge/projector.js`) — i.e. every
  merge is followed by a full re-projection of document state straight into SQLite.
- `electron/ops/projections.js` (`elective_assignments` entry, ~line 1111; `elective_set_activities`
  entry, ~line 535): both entities are registered `PROJECTIONS` targets, so `projectAll` does write
  their tables from document state on every merge, on this code path, with no reference to
  `setElectiveAssignment.js` or its capacity guard anywhere in the merge/project call chain.

This confirms Red Hat's claim: a peer device (running an older build, or one that merged before an
offering was blanked, or simply never routing the write through `setElectiveAssignment.js` at all)
can land an assignment against an `unknownLimit` offering via merge, and `getElectiveRunHandler`'s
silent skip is reachable that way too. Rewrote the comment to name this third path explicitly (citing
`electron/automerge/projector.js` and `syncNode.js`'s merge call) and to say plainly that the list of
ways to reach the skip is open, not closed, rather than repeating a two-item enumeration as if it
were exhaustive.

**Verification run** (targeted suite + lint, per the round-2 brief — full suite intentionally not
run):

```
npx vitest run src/screens/elective/assignment/buildOfferings.test.js src/screens/elective/assignment/AssignmentPanel.test.jsx src/screens/elective/assignment/AssignmentPreview.test.jsx src/screens/elective/assignment/findingLabelCoverage.test.js src/screens/elective/run/preferenceEditToResolve.test.jsx src/localClient.mock.electives.test.js

 Test Files  6 passed (6)
      Tests  87 passed (87)

npm run lint
✖ 26 problems (0 errors, 26 warnings)
```

All 26 lint warnings are pre-existing `react-hooks/exhaustive-deps` warnings in files this round did
not touch (`AnchorsScreen.jsx`, `CohortsScreen.jsx`, `GroupsScreen.jsx`, etc.) — 0 errors, nothing
attributable to this change.

Files changed this round: `electron/ops/setElectiveAssignment.js`, `electron/main.js` (comments
only, no other file touched).

## Gates

### Round 1-2 (generator and read-path changes)

| Gate | Result | Evidence |
|---|---|---|
| vitest: buildOfferings, AssignmentPanel, AssignmentPreview, findingLabelCoverage, preferenceEditToResolve, localClient.mock.electives | PASS | Test Files 6 passed (6), Tests 87 passed (87) |
| vitest: buildElectiveAssignments, electiveOfferingMinimum | PASS | Test Files 2 passed (2), Tests 48 passed (48) |
| npm run lint | PASS | 0 errors, 26 pre-existing warnings in unmodified files |
| npm run check:governance | PASS | no findings |
| Plant-the-defect non-vacuity (revert prod, confirm red, restore) | PASS | Revert: 4 failed, 6 failed; Restore: 4 passed, 72 passed |

### Round 3 (write-path refusal changes, fresh verification)

| Gate | Result | Evidence |
|---|---|---|
| vitest Suite 1: setElectiveAssignment, ElectiveRunViews, preferenceEditToResolve, buildOfferings, AssignmentPanel, AssignmentPreview, findingLabelCoverage, localClient.mock.electives | PASS | Test Files 8 passed (8), Tests 141 passed (141) |
| vitest Suite 2: electiveOfferingMinimum, buildElectiveAssignments, panelWorkbookTabs | PASS | Test Files 3 passed (3), Tests 58 passed (58) |
| npm run lint | PASS | 0 errors, 26 pre-existing warnings in unmodified files |
| npm run check:governance | PASS | no findings |
| Plant-the-defect: revert setElectiveAssignment.js, confirm refusal tests fail with old OCCURRENCE_FULL/capacity:0 | PASS | Revert: 3 tests RED with OCCURRENCE_FULL/capacity:0/filled:1 (expected); Restore: all tests GREEN; git diff --stat matches (6 files: same as found) |

## Verifier verdict

### Round 1 (initial dispatch) — PASS

**PASS** — all four success-predicate clauses are mechanically verified by the gates above.

### Per-clause mapping (Round 1)

**Clause 1** (finding produced with kind, activity name, IDs): buildOfferings.test.js lines 107–125 + findingLabelCoverage.test.js lines 228–236, 280–317

**Clause 2** (block prevents solve/commit, sentence shown): AssignmentPanel.test.jsx T316 test + AssignmentPreview.test.jsx findings test

**Clause 3** (offering not at capacity 0): buildOfferings.test.js lines 119–124

**Clause 4** (comments accurate): Code inspection of electron/main.js and electron/ops/setElectiveAssignment.js

**Plant-the-defect**: Revert production → tests RED (6 failed); restore → tests GREEN (72 passed); tree byte-identical (git diff --stat: 11 files, 448 lines)

### Round 3 (fresh gate on write-path changes) — PASS

**PASS** — all five success-predicate claims for the write-path `INVALID_CAPACITY` refusal are mechanically verified by the gates run on 2026-09-29 at 21:31–21:33.

### Per-claim mapping (Round 3)

**Claim 1** (manual write refused as INVALID_CAPACITY with message, never OCCURRENCE_FULL): electron/ops/setElectiveAssignment.test.js ~line 196, "refuses INVALID_CAPACITY, naming the offering, for a confirmed limited offering with a blank capacity" — PASS. Plant-the-defect: reverting the fix produces the old `OCCURRENCE_FULL`/`capacity: 0`/`filled: 1` response, confirming the gate catches the real defect.

**Claim 2** (full offering still returns OCCURRENCE_FULL): electron/ops/setElectiveAssignment.test.js ~line 177, "returns OCCURRENCE_FULL with capacity and filled when the offering is full" — PASS (unchanged, pre-existing test).

**Claim 3** (message reaches director, other errors unchanged): src/screens/elective/run/ElectiveRunViews.test.jsx 34 tests PASS including all pre-existing error-code assertions (OCCURRENCE_FULL, RUN_NOT_DRAFT, CAMPER_INELIGIBLE); DraftRunView.jsx line 72 prioritizes `message` when present.

**Claim 4** (no literal "undefined" when activity deleted): electron/ops/setElectiveAssignment.test.js ~line 224, "refuses INVALID_CAPACITY without the literal string "undefined" when the offering names a deleted activity" — PASS. Message template uses fallback `'This offering'` when `activityName` is falsy.

**Claim 5** (sentence true for move/lock/release-lock, not move-specific): electron/ops/setElectiveAssignment.test.js ~line 249, "refuses INVALID_CAPACITY on a lock toggle of an already-placed camper, without claiming a move" — PASS. Message "fill it in first." contains no move-specific language, stays accurate for all three call paths (move, lock toggle, release-lock).

**Test suite summary, Round 3:**
- Suite 1 (setElectiveAssignment + elective run + elective assignment): 8 files, 141 tests, all PASS
- Suite 2 (offering minimum + engine assignments + panel workbook): 3 files, 58 tests, all PASS
- npm run lint: 0 errors (26 pre-existing warnings in unmodified files)
- npm run check:governance: no findings
- Plant-the-defect: reverting setElectiveAssignment.js produces identical 3-test RED (OCCURRENCE_FULL with capacity:0), confirming non-vacuity


## Grader score

**RE-SCORED ROUND 3 — superseding earlier 3.5**

Average — 4.5, lowest dimension — 4.

**Why the earlier 3.5 is no longer the live figure**: Owner override on scope (standing words: "a defect you find at a seam you are already changing is FINISHED, not recorded") ruled the write-path `setElectiveAssignment.js` blank-capacity refusal IN SCOPE. This round implements that ruling: a manual move into a `('limited', NULL)` offering is now refused as `INVALID_CAPACITY`, naming the offering, never `OCCURRENCE_FULL`, never a made-up `capacity: 0`. Code Reviewer now 5/5 (was 4); Red Hat now 4 (was 3). The three round-1 Red Hat resilience items that were out of scope remain recorded as human_gates and carried forward. All defects found at seams already being changed were finished in their round per owner's standing rule.

**Per-dimension summary:**

**Verifier:** PASS — Test Files 8 passed (141 tests total); Tests 58 passed (58 tests); `npm run lint` 0 errors (26 pre-existing warnings in unmodified files); `npm run check:governance` no findings; plant-the-defect reverting setElectiveAssignment.js produced 3 RED tests with OCCURRENCE_FULL/capacity:0 as expected, restored fix produces all GREEN, git diff --stat matches (6 files).

**Code Reviewer:** score 5 — "Ready." Verified `resolveOfferingCapacity` returns three kinds, new two-if structure covers all with no fallthrough; message reuses existing `activityName` query; one-line `out?.message ?? out?.error ?? fallback` additive. Confirmed: (FIXED) `activityName` guarded against undefined for deleted activity (fallback 'This offering' in place); (ESCALATED) ADR union now stale, agent cannot amend per CONSTITUTION.md Art. IV.

**Resilience (Red Hat):** score 4 — New error code unreshaped, no consumer in src/electron switches on `out.error` by value so union widening inert everywhere but intended display site. Verified by reading sync/automerge/syncNode.js and projector.js. Findings: (FIXED) refusal sentence said "before moving campers into it" while same write path serves Lock checkbox and release-lock — reworded to "fill it in first" true for all three, test added electron/ops/setElectiveAssignment.test.js:249; (FIXED) dev mock comment enumerated unreachable refusals but omitted INVALID_CAPACITY — comment updated; (ESCALATED) ADR union should get addendum, owner-ordered IPC widening exactly what ADR amendment exists to prevent drifting.

**Security:** N/A — no auth, IPC, secret, or transport surface touched; change is renderer-side plus comment corrections.

**Tester:** N/A — no running app in this session (no Electron). Component test renders real panel tree via @testing-library/react pinning that commitElectiveRun is never called while finding exists. Director's-eye judgment of sentence wording and refusal feel not evidenced by this run per stated limitation in frontmatter.

## Maker evidence (round 3 — the write path, owner-ruled in scope)

Owner ruling, verbatim: *"a defect you find at a seam you are already changing is FINISHED, not
recorded"* and *"blank capacities need to be filled in."* This round implements it: a manual move
into a `('limited', NULL)` offering is now refused as `INVALID_CAPACITY`, naming the offering, never
`OCCURRENCE_FULL`, never a made-up `capacity: 0`.

**What changed**

- `electron/ops/setElectiveAssignment.js` — the capacity block (~lines 136-165). Split the single
  `capacityResult.kind !== 'unlimited'` branch into two: `kind === 'unknownLimit'` now returns
  `{ ok: false, error: 'INVALID_CAPACITY', activityId, setActivityId, message }` before ever running
  the `filled`/`>= capacity` comparison; `kind === 'limited'` keeps the existing full-offering check
  unchanged. The message reuses the `activityName` this handler already selects at line 109 (no new
  query) and matches `findBlankCapacities`'s voice in
  `src/screens/elective/assignment/buildOfferings.js`, adapted for the move context: `"Archery" is set
  to limited capacity but the number is blank — fill it in before moving campers into it.` The old
  comment block recording the deliberate OCCURRENCE_FULL/0 divergence (round 2) is replaced by one
  describing this fix instead — no comment is left asserting a divergence that no longer exists.
  JSDoc return-union (~line 20) gets the new shape.
- `src/screens/elective/run/DraftRunView.jsx` (~line 72), the placement/move write path only —
  `setError(out?.error ?? …)` becomes `setError(out?.message ?? out?.error ?? …)`, additive: every
  existing refusal carries no `message`, so it renders exactly as before. The two preference call
  sites (~lines 111, 128) are untouched, per instruction — this ticket does not sweep them.
- Tests only, no other production files touched.

**Quoted RED** (before the fix; both new tests, run together)

```
- Expected:
/blank — fill it in before moving campers into it\./
+ Received:
"INVALID_CAPACITY"
 ❯ src/screens/elective/run/ElectiveRunViews.test.jsx:273:82

AssertionError: expected { ok: false, …(3) } to deeply equal { ok: false, …(4) }
- Expected
+ Received
  {
-   "activityId": "act-archery",
-   "error": "INVALID_CAPACITY",
-   "message": "\"Archery\" is set to limited capacity but the number is blank — fill it in before moving campers into it.",
+   "capacity": 0,
+   "error": "OCCURRENCE_FULL",
+   "filled": 1,
    "ok": false,
-   "setActivityId": "c8a741a6-b246-4b84-b3ad-846e227ffd7e",
  }
 ❯ electron/ops/setElectiveAssignment.test.js:196:17

Test Files  2 failed (2)
     Tests  2 failed | 46 passed (48)
```

**Quoted GREEN** (named suite, after the fix)

```
npx vitest run electron/ops/setElectiveAssignment.test.js src/screens/elective/run/ElectiveRunViews.test.jsx \
  src/screens/elective/run/preferenceEditToResolve.test.jsx src/screens/elective/assignment/buildOfferings.test.js \
  src/screens/elective/assignment/AssignmentPanel.test.jsx src/screens/elective/assignment/AssignmentPreview.test.jsx \
  src/screens/elective/assignment/findingLabelCoverage.test.js src/localClient.mock.electives.test.js

 Test Files  8 passed (8)
      Tests  139 passed (139)
```

`npm run lint` — 0 errors, 26 pre-existing warnings unrelated to these files.
`npm run check:governance` — `check:governance — no findings.`

**Plant-the-defect** — reverted only `electron/ops/setElectiveAssignment.js` to the pre-fix
`unknownLimit → capacity 0` collapse via `git apply -R` on a saved patch of that one file. Re-ran the
new backend test alone: it went red again, reproducing the identical OCCURRENCE_FULL/capacity:0/
filled:1 result shown above. Restored with `git apply` on the same patch; `git diff --stat` afterward
showed the same four files/line counts as before the plant (`electron/ops/setElectiveAssignment.js
32 +/-17, electron/ops/setElectiveAssignment.test.js +21, src/screens/elective/run/DraftRunView.jsx
+1/-1, src/screens/elective/run/ElectiveRunViews.test.jsx +15`), confirming the tree matched what was
found. No `git stash` was used.

**Left deliberately alone**

- `src/localClient.mock.js` — confirmed by reading its `setElectiveAssignment` mock (~lines 2065-2071):
  its own comment already states it has no `elective_set_activities` capacity lookup wired, so
  `INVALID_CAPACITY` structurally cannot fire there. Browser-dev (`:5200`) cannot reproduce this
  refusal; only `npm run electron:dev` (real SQLite path) can.
- `docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md` — not touched; its documented
  return union is now incomplete relative to the code, which is Governor's to record, not Maker's to
  amend.
- The two `writePreference`/`removePreference` call sites in `DraftRunView.jsx` — untouched; they
  cannot receive this reason (only the assignment/move path can), and sweeping them was explicitly
  out of scope for this round.
- `unknownMinimum`/T265 and any schema file — untouched, per instruction.

**Round 4 addendum — undefined activity name in the INVALID_CAPACITY message**

Found at this same seam, in code this round just wrote: `activityName` at
`electron/ops/setElectiveAssignment.js:110` is `undefined` when
`elective_set_activities.activity_id` names no row in `activities` (line 116 already treats that as
real, guarding the choiceId derivation with `activityName ? ... : null`), and the
`INVALID_CAPACITY` message interpolated it unguarded — a director would read the literal string
`"undefined" is set to limited capacity but the number is blank — ...`.

**Fix.** `message: \`${activityName ? \`"${activityName}"\` : 'This offering'} is set to limited
capacity but the number is blank — fill it in before moving campers into it.\`` — one sentence,
same quoting convention when a name is known, "This offering" (no fake quoted name, no help text
added) when it is not.

**Confirmed `findBlankCapacities` does NOT have this hazard.** Read
`src/screens/elective/assignment/buildOfferings.js:77-93`: it builds `activityById` as a `Map` over
the *given* `activities` array and, at line 81-82, does `const activity = activityById.get(sa.activity_id); if (!activity) continue` — a set-activity row naming a missing activity is skipped
entirely (silently omitted from findings), never reaches the `message` template at line 89. No
`undefined` can appear there. Left unchanged, as instructed.

**Test-first.** Added one case to `electron/ops/setElectiveAssignment.test.js` — 'refuses
INVALID_CAPACITY without the literal string "undefined" when the offering names a deleted
activity': inserts an `elective_set_activities` row (`capacity_mode: 'limited'`, `capacity_limit:
null`, `status: 'confirmed'`) whose `activity_id` ('act-ghost') has no row in `activities` at all —
legitimate, since `ELECTIVE_SET_ACTIVITIES_DDL` (`electron/db/localDb.js`) declares `activity_id
TEXT NOT NULL` with no `REFERENCES activities(id)`, so no FK blocks a dangling id. No workaround was
needed. Asserts both `error === 'INVALID_CAPACITY'` and `message` not matching `/undefined/`, plus
the exact fallback string, so the test cannot pass on an empty/blank message.

**Quoted RED:**

```
AssertionError: expected '"undefined" is set to limited capacit…' not to match /undefined/

- Expected:
/undefined/

+ Received:
"\"undefined\" is set to limited capacity but the number is blank — fill it in before moving campers into it."

 ❯ electron/ops/setElectiveAssignment.test.js:225:29
```

**Quoted GREEN** (named suite):

```
npx vitest run electron/ops/setElectiveAssignment.test.js src/screens/elective/run/ElectiveRunViews.test.jsx \
  src/screens/elective/assignment/buildOfferings.test.js

 Test Files  3 passed (3)
      Tests  64 passed (64)
```

`npm run lint` — 0 errors, 26 pre-existing warnings, none in touched files.

Files changed this round: `electron/ops/setElectiveAssignment.js` (one line, the `message` template),
`electron/ops/setElectiveAssignment.test.js` (one new test). No other file touched.

**Round 5 addendum — the refusal sentence misdescribed two of its three call paths**

Red Hat confirmed by reading: `writeAssignment` in `src/screens/elective/run/DraftRunView.jsx` is
the single call path for three director actions — the move `<select>`, the Lock checkbox
(`~line 313`), and `releaseLock` (`~line 157`) — and `setElectiveAssignment`'s capacity gate
(`electron/ops/setElectiveAssignment.js:145-154`) runs on every write through that path, including
a lock toggle on a camper who is already the occupant and is not moving anywhere. The round 4
wording — `"...fill it in before moving campers into it."` — is wrong on the lock and release-lock
paths, and worst on `releaseLock`, whose own comment (lines 140-156) shows it is the remedy flow for
a dangling row: the director is trying to fix something and is told a move was blocked.

**Fix.** Reworded to stay true for all three actions: `` `${activityName ? `"${activityName}"` :
'This offering'} is set to limited capacity but the number is blank — fill it in first.` `` — same
quoting convention (named activity vs `'This offering'` fallback kept in lockstep), one plain
sentence, no help text, no second sentence.

**Coherence check against `findBlankCapacities`** (`src/screens/elective/assignment/buildOfferings.js:89`,
unchanged): `` `"${activity.name}" is set to limited capacity but the number is blank — fill it in
to run electives.` ``. That sentence is reached only from the run/setup surface and is about running
electives in general, not about any one director action on the grid — "fill it in to run electives"
stays accurate regardless of which of the three actions the director was attempting. The two
sentences remain coherent: both name the offering the same way and use "fill it in..." as the shared
verb, diverging only in the clause appropriate to each one's reach (a general setup blocker vs. a
per-write refusal that must not name an action it did not take). No change made to
`buildOfferings.js`, per instruction.

**Test-first.** Added one case to `electron/ops/setElectiveAssignment.test.js` — 'refuses
INVALID_CAPACITY on a lock toggle of an already-placed camper, without claiming a move': seeds a run
with both offerings blank-capacity, confirms cam-1's solver row already sits in `act-gaga`, then
calls `setElectiveAssignment` with the SAME camper/occurrence/activity and only `locked` flipped.
Asserts `error === 'INVALID_CAPACITY'` (pinning that the gate fires on a pure lock toggle) and
`message` does not match `/mov(e|ing)/i`.

**Quoted RED:**

```
AssertionError: expected '"Gaga" is set to limited capacity but…' not to match /mov(e|ing)/i

- Expected:
/mov(e|ing)/i

+ Received:
"\"Gaga\" is set to limited capacity but the number is blank — fill it in before moving campers into it."

 ❯ electron/ops/setElectiveAssignment.test.js:249:29
```

**Quoted GREEN** (full named suite):

```
npx vitest run electron/ops/setElectiveAssignment.test.js src/screens/elective/run/ElectiveRunViews.test.jsx \
  src/screens/elective/run/preferenceEditToResolve.test.jsx src/localClient.mock.electives.test.js \
  src/screens/elective/assignment/buildOfferings.test.js src/screens/elective/assignment/AssignmentPanel.test.jsx \
  src/screens/elective/assignment/AssignmentPreview.test.jsx src/screens/elective/assignment/findingLabelCoverage.test.js

 Test Files  8 passed (8)
      Tests  141 passed (141)
```

`npm run lint` — 0 errors, 26 pre-existing warnings (React hook exhaustive-deps in unrelated
screens), none in touched files.

**Second finding — stale mock comment.** `src/localClient.mock.js`'s `setElectiveAssignment` comment
enumerated refusals the dev mock can never produce, naming `CAMPER_INELIGIBLE`/`OCCURRENCE_FULL`; it
omitted `INVALID_CAPACITY`, which also cannot fire there since no capacity lookup is wired in the
mock. Added `INVALID_CAPACITY` to that enumeration. Comment-only — no capacity logic wired into the
mock, no mock row shape changed.

Files changed this round: `electron/ops/setElectiveAssignment.js` (the `message` template, one
line), `electron/ops/setElectiveAssignment.test.js` (one new test plus two existing exact-message
assertions updated to the new wording), `src/localClient.mock.js` (one comment line).

## Renumbered T315 -> T316, and re-verified on current main

Recorded because the number in this record is not the number the work started with.

`npm run ticket:next` returned **T315** at the start of this session, correctly — and the allocator
cannot reserve a number, only report one (`CLAUDE.md`). While this ticket was being drafted, another
session's T315 ("every setup importer reads the tab that holds its entity") merged to `main` as #656.
`checkTicketNumberUniqueness` caught the collision exactly where `CLAUDE.md` says it would, on the
rebase. The cheaper side moved: theirs was already on `main`, so this one was renumbered to **T316**
across the ticket, this record, the gate report, and every code comment that cites it.

`main` had also advanced past this branch's base (22d5af06) by T314 and two docs commits. The branch was
rebased onto `b6f529e9` — clean, no conflicts, including in `src/screens/elective/assignment/
AssignmentPanel.jsx`, which T314 also edits (its change is in `readSheetRows`, this one is in `solve`).
`docs/work/INDEX.md` was regenerated after the rebase rather than merged.

Re-verified on the rebased, renumbered tree, including T314's own test file so the interaction is
evidenced rather than assumed:

```
npx vitest run <the six named files> test/panelWorkbookTabs.test.js src/engine/buildElectiveAssignments.test.js
  Test Files  8 passed (8)
       Tests  143 passed (143)
npm run lint -> 0 errors, 26 pre-existing warnings
npm run check:governance -> no blocking findings
```

One advisory remains and is addressed rather than waived: `platform-state-stale` fired because this
change touches `src/screens/`, so `docs/current/PLATFORM_STATE.md`'s header note now describes the new
behaviour **and** names the two pieces of the same defect class this ticket deliberately did not fix.

## Findings carried forward

- **Code Reviewer (LOW):** Redundant generic text "No campers could be placed" alongside new INVALID_CAPACITY finding; consider conditioning on `findings.length === 0`.
- **Red Hat (HIGH, pre-existing):** regenerate() also hits refusal with no on-screen back control; dead end from blank capacity closing offering at 0, not introduced by T316.
- **Red Hat (MEDIUM, out of scope):** unknownMinimum (T265 mirror) still silent; explicitly out of scope for this ticket. After T316 the asymmetry is newly *visible*: one half of a documented mirror pair blocks loudly, the other enforces nothing and says nothing.
- **Red Hat (HIGH, behaviour carried forward):** `electron/ops/setElectiveAssignment.js` still reads a blank limited capacity as 0 and rejects a director's manual move/lock as `OCCURRENCE_FULL` with `capacity: 0` — the same silent-shutdown shape T316 fixed at generation time, surviving on the write path. Round 2 recorded the divergence in that file's comment; the behaviour is untouched.
- **Red Hat (LOW):** a non-blocking finding now also renders in the zero-assignment branch of `AssignmentPreview` — intended, and not covered by a test for that case.
- **Red Hat (LOW):** `scripts/fixtures/measure-elective-cell-loss.mjs` builds engine input without going through `buildOfferings`, so "never reaches the engine as capacity 0" is true of the product's solve path, not of every producer in the repo.
- **Unevidenced, not a finding:** no Tester ran (no app in this session), so the wording of the new sentence and the feel of the refusal have been read, never seen by a director's eye.

## Decision

**PASS.** This supersedes the ESCALATE recorded earlier in this section, and the earlier text is kept
below it because the reason it changed is the more useful record.

Verifier PASS in round 1 (the four original predicate clauses) and again in round 3 (all five clauses of
the write-path delta), each time re-running the non-vacuity plant itself rather than trusting Maker's
account. Grader re-scored **4.5** (Code Reviewer 5, Red Hat resilience 4), above Article VII's bar, with
no dimension below 3.

What changed between the two decisions was not the evidence — it was the scope, and by the only authority
that can change it. I had recorded the `setElectiveAssignment.js` defect as out of scope and escalated it.
The owner overruled that with a standing rule: **"a defect you find at a seam you are already changing is
FINISHED, not recorded."** Applied, that rule cost three further rounds, and each one found a real defect
in the previous one's fix:

- the write path now refuses a blank limited capacity as `INVALID_CAPACITY`, naming the offering, instead
  of reporting a misconfigured offering as a full one;
- the sentence no longer reads `"undefined"` when the offering names an activity row that is gone;
- the sentence no longer claims a *move*, because the same write path serves the Lock checkbox and
  release-lock — Red Hat caught that it was misdescribing a director's remedy action, which is the worst
  place to be wrong;
- the dev mock's comment now says this refusal cannot fire there either.

That is the rule earning its keep: the first fix was correct and shipped three small lies in its own
message, none of which a gate would have caught.

**Still open, and deliberately not absorbed** — each needs the owner, not another round:

1. **The ADR.** `docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md` documents this IPC
   channel's refusal union as three members; it now has four. An agent may not amend an ADR (Art. IV), and
   both reviewers independently said an owner-ordered widening of a documented, closed union is exactly
   what an addendum exists to prevent drifting. I agree with them.
2. **`unknownMinimum`** — T265's mirror case still enforces nothing and says nothing. The asymmetry is now
   *visible*: one half of a documented mirror pair blocks loudly. The owner has not ruled; left as found.
3. **No on-screen way back from a refused run.** Pre-existing (before this work a blank capacity produced
   the same zero-assignment dead end without a reason). Fixing it means adding a control — product
   judgement.

Two limits of this run that a green verdict does not cover: there is **no build and no whole-suite
evidence** here by design (CI is the gate of record), and **no Tester ran** — both new sentences and both
refusals have been read, never seen by a director's eye.

Two process notes, recorded because they are the kind of thing that otherwise vanishes: round 1's Code
Reviewer filed a CRITICAL that was a method error (it diffed against an `origin/main` that had moved,
which renders main's own additions as deletions) — withdrawn after verification, and the same reviewer
diffed against HEAD correctly once warned. And the working branch was renamed `claude/T315-…` →
`claude/T316-…` by a reviewer-class agent rather than by me: harmless, consistent with the renumber, and
still a reviewer touching state (rule 6).

---

### Superseded: the round-1/2 decision, kept for the record

**ESCALATE — with the work verified and committed.** Not a retry, and deliberately not called a PASS.

Verifier returned PASS on every clause of the success predicate, and re-ran the non-vacuity plant itself
rather than trusting Maker's account of it. Grader returned 3.5 (Code Reviewer 4, Red Hat resilience 3),
which is below Article VII's 4.0 bar, so this run does not get to call itself a pass.

Why a round 2 aimed at the score would have been wrong. Red Hat's resilience 3 rests on three items,
and **every one of them is outside what this ticket was scoped to change**:

1. the `regenerate()` dead end — pre-existing (before T316 a blank capacity closed the offering at 0 and
   produced the identical zero-assignment preview with no back control), and fixing it means inventing a
   control, which is Designer/product territory the ticket explicitly excluded;
2. `setElectiveAssignment.js` still reading `unknownLimit` as capacity 0 — changing a write path's
   rejection semantics is a contract change;
3. `unknownMinimum` — the owner scoped it out in writing.

Round 2 therefore did what was actually in scope: it corrected the two comment-truth defects Red Hat
found (the false parity claim in `setElectiveAssignment.js`, and the `electron/main.js` enumeration that
read as exhaustive while omitting the Automerge-merge path). Buying the last 0.5 of score would have
required expanding scope, which rule 2 forbids and rule 8 says to escalate instead.

The three items above are recorded as `human_gates` and carried forward below. `status: escalated` with
`verdict: pass` is the honest pair (§5.2): the gates passed; the routing decision went to the human.

One clause of the predicate is not machine-checkable by nature — clause 4 asks whether three comments
tell the truth. Verifier said so plainly rather than rounding it to a pass; it was confirmed by reading,
twice (Verifier and Code Reviewer). There is also **no build and no whole-suite evidence in this run** by
design — CI is the gate of record.

A withdrawn finding, recorded because the method error is worth more than the finding: Code Reviewer
filed a CRITICAL claiming this branch "silently reverts T314". It does not. The branch was cut at
22d5af06 and `origin/main` has since advanced by exactly one unrelated commit (06b6f59e, T314);
`git diff origin/main` from a branch that is *behind* main renders main's own additions as deletions.
Verified with `git log 22d5af06..origin/main` (one commit) and `git diff --name-only`. Diff against the
pinned branch point, not a base that moved under you.
