---
task: T316 — a blank limited capacity is named, and it blocks the run
document_type: run
date: 2026-09-29
round: 1
status: escalated
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T316-a-blank-limited-capacity-is-named-and-blocks-the-run.md]
related_specs: []
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no schema change, no IPC/contract change, no new persisted shape — one new finding kind produced and consumed inside the renderer
  - agent: designer
    reason: not-applicable
    note: one plain sentence in the findings surface that already exists (AssignmentPreview's findings list). No new component, no token change, no visual change to specify
  - agent: security
    reason: not-applicable
    note: no auth, IPC, secret, or transport surface is touched; the change is renderer-side plus two comment corrections
  - agent: tester
    reason: not-applicable
    note: no running app in this session (no Electron; the :5200 dev mock is not the real stack). Consequence, stated honestly - the director's-eye judgement of this sentence's wording and of how the refusal feels is NOT evidenced by this run. The behaviour is pinned by a component test that renders the real panel and asserts commitElectiveRun is never called; the experience of it is not.
deterministic_checks: [test, lint]
human_gates:
  - "Whether a refused run should offer an on-screen way back (a control, not a sentence) — product judgement, CONSTITUTION.md Art. IV. Pre-existing, not introduced here."
  - "Whether electron/ops/setElectiveAssignment.js should stop reading a blank limited capacity as 0 and reject a manual move as OCCURRENCE_FULL — a write-path rejection-semantics change, outside T316"
  - "Whether unknownMinimum (T265's mirror of this defect) should block the same way — the owner scoped it out of T316"
verdict: pass
completion_evidence:
  - "npx vitest run src/screens/elective/assignment/{buildOfferings,AssignmentPanel,AssignmentPreview,findingLabelCoverage}.test.* src/screens/elective/run/preferenceEditToResolve.test.jsx src/localClient.mock.electives.test.js -- 6 files / 87 tests passed"
  - "npx vitest run src/engine/buildElectiveAssignments.test.js electron/ops/electiveOfferingMinimum.test.js -- 2 files / 48 tests passed"
  - "npm run lint -- 0 errors"
  - "npm run check:governance -- no findings"
  - "plant-the-defect: production revert -> 4 files / 6 tests red; restore -> green; tree byte-identical"

archive_when: T316 completed and merged
---

# Run: T316 — a blank limited capacity is named, and it blocks the run

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1.

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

| Gate | Result | Evidence |
|---|---|---|
| vitest: buildOfferings, AssignmentPanel, AssignmentPreview, findingLabelCoverage, preferenceEditToResolve, localClient.mock.electives | PASS | Test Files 6 passed (6), Tests 87 passed (87) |
| vitest: buildElectiveAssignments, electiveOfferingMinimum | PASS | Test Files 2 passed (2), Tests 48 passed (48) |
| npm run lint | PASS | 0 errors, 26 pre-existing warnings in unmodified files |
| npm run check:governance | PASS | no findings |
| Plant-the-defect non-vacuity (revert prod, confirm red, restore) | PASS | Revert: 4 failed, 6 failed; Restore: 4 passed, 72 passed |

## Verifier verdict

**PASS** — all four success-predicate clauses are mechanically verified by the gates above.

### Per-clause mapping

**Clause 1** (finding produced with kind, activity name, IDs): buildOfferings.test.js lines 107–125 + findingLabelCoverage.test.js lines 228–236, 280–317

**Clause 2** (block prevents solve/commit, sentence shown): AssignmentPanel.test.jsx T316 test + AssignmentPreview.test.jsx findings test

**Clause 3** (offering not at capacity 0): buildOfferings.test.js lines 119–124

**Clause 4** (comments accurate): Code inspection of electron/main.js and electron/ops/setElectiveAssignment.js

**Plant-the-defect**: Revert production → tests RED (6 failed); restore → tests GREEN (72 passed); tree byte-identical (git diff --stat: 11 files, 448 lines)

## Grader score

Average — 3.5, lowest dimension — 3.

**Per-dimension summary:**

**Verifier:** PASS — 6 files / 87 tests passed; 1 file / 42 tests passed; 0 lint errors; governance check passed; plant-the-defect: revert red (6 failed), restore green (72 passed), tree byte-identical.

**Code Reviewer:** score 4 — "Well-scoped, correctly tested, and honest in its comments — I would call it ready on its own merits." Confirmed panel structurally cannot reach Commit button, unknownLimit row produces no offering object at all, findings emitted per offering not per occurrence, test fixtures use `buildOfferings` from stored-row shape. Findings: (LOW) redundant generic text alongside new specific INVALID_CAPACITY finding suggests conditioning on `findings.length === 0`; (LOW) run record in-progress/null verdict at review time (expected, not a defect).

**Resilience (Red Hat):** score 3 — Pre-existing and addressed findings. (HIGH, pre-existing) regenerate() also hits refusal with no on-screen back control; dead end existed before T316 when blank capacity closed offering at 0. (HIGH, acted on round 2) setElectiveAssignment write path diverged from engine by design; comment now documents divergence and why unchanged (contract change outside scope). (MEDIUM, acted on round 2) electron/main.js comment fixed to name Automerge-merge path as third way to reach silent skip, confirmed by reading sync/automerge/syncNode.js and projector.js. (MEDIUM, out of scope) unknownMinimum mirror defect (T265) still silent, explicitly out of scope. (LOW) finding message does not say where to fix capacity; accepted tradeoff (editing on elective set screen). (LOW) offline fixture script does not cover this path (non-blocking).

**Security:** N/A — no auth, IPC, secret, or transport surface touched; change is renderer-side plus comment corrections.

**Tester:** N/A — no running app in this session (no Electron). Component test renders real panel tree via @testing-library/react pinning that commitElectiveRun is never called while finding exists. Director's-eye judgment of sentence wording and UI feel not evidenced by this run per stated limitation in frontmatter.

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
