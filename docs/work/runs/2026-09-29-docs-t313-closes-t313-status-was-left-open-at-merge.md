---
task: docs(T313): closes T313 — status was left open at merge
document_type: run
date: 2026-09-29
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T313-one-spelling-for-a-provisional-subject.md]
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: no routing decision existed to make — the owner stated the task, the two invariants that must not move, the regression set and the shape of the new assertion in one instruction; this session's operating rule is not to dispatch subagents unless asked, and it was not asked
  - agent: architect
    reason: not-applicable
    note: no schema version, no new entity, no module boundary moved, no protocol change. The one design decision — readPreferenceSheet taking camperId/externalId for a camper the caller has already LOCATED — is recorded in the ticket's amended success predicate, with the rejected alternative and why, rather than in an ADR: it adds a parameter to an existing seam instead of establishing one
  - agent: designer
    reason: not-applicable
    note: no UI surface changes; the one director-visible effect is the REMOVAL of a false 'N row(s) skipped' count, which is a defect fix rather than a design
  - agent: maker
    reason: not-applicable
    note: the implementation ran in this session directly, not dispatched
  - agent: code-reviewer
    reason: not-applicable
    note: NOT dispatched, and stated plainly rather than dressed up: this change was not independently reviewed. What stands in its place is deterministic — CI verify green on the merged head, 197 tests across eight affected suites, and each of the three fixes shown red-then-green by reverting it. That is evidence about behaviour, not about maintainability, and the gap is real
  - agent: verifier
    reason: not-applicable
    note: the gates ran in-session and their output is quoted rather than summarised; CI is this repo's gate of record and passed on the exact merged head
  - agent: tester
    reason: not-applicable
    note: no screen to drive — the director-facing half is asserted at the DATABASE instead, in test/bothDoorsOneSubject.test.js, which commits through both doors and counts camper rows
  - agent: security
    reason: not-applicable
    note: no auth/PIN/IPC/wire-protocol/packaging surface. The one boundary touched is the import read cap and it was TIGHTENED, not relaxed: the panel's hand-rolled row-count guard was replaced by readWorkbookSafely's, and src/utils/exportSanitize.test.js now pins that both the byte cap and the per-sheet row cap still fire through the new entry point
  - agent: red-hat
    reason: not-applicable
    note: NOT dispatched, and the omission most deserving of naming, because the adversarial case here was real and was caught by merge discipline rather than by a reviewer: #644 added ~130 lines INSIDE the function this change deletes, and resolving that conflict 'in favour of mine' would have silently reverted a shipped fix for one child appearing as two camper rows. What caught it was taking #644's file as the merge BASE and then running #644's own 35 tests, three of which fail if camperId/externalId are threaded wrong
  - agent: grader
    reason: not-applicable
    note: nothing to consolidate — no agent reports were produced
deterministic_checks: [check:governance, npm run verify (CI, gate of record)]
human_gates: []
verdict: pass
completion_evidence:
  - "#651 squashed to 3f438f1c; CI verify pass 5m43s on head fcac13c4"
  - "merge audited BY CONTENT not ancestry (a squash defeats --is-ancestor): readWorkbookRows present on origin/main in exportSanitize.js, preferenceSheetCli.js and AssignmentPanel.jsx; locateNamedCamper and camperId present; #644 SUBMISSION_ALREADY_NAMED survives at 4 occurrences"
  - "197 tests green across 8 affected suites; test/callerDeclaredArrival.test.js at 35 tests (grown from 18 on main mid-flight by #644), all passing through the delegation"
  - "each of the three fixes shown red-then-green by reverting it"
  - "status-drift proven to FIRE: with status left open it named T313; green once flipped. CI cannot check this — actions/checkout@v4 at depth 1 leaves no origin/main, so check-governance skips status-drift (line 942)"
archive_when: T313 is completed and this record is no longer the newest word on the preference-import doors
---

# docs(T313): closes T313 — status was left open at merge

## What shipped

The closing commit for T313: `status: open` -> `completed`, the close recorded in the ticket, and
this record.

T313 itself collapsed provisional camper-subject identity into one place. `resolveSubject` in
`scripts/preferenceSheetCli.js` is gone and the CLI calls `readPreferenceSheet` the way the import
panel does. Two things deliberately did NOT move into the shared module: the content-derived arrival
default (`declaredArrival ?? importedRunId`), which is path policy only a door holding file bytes can
state, and the boundary refusal of a malformed `arrival_id`, because `runPreferenceSheetCli`'s
contract is that it never throws past it.

Two defects the unification exposed, neither in the original request:

- **The two doors did not read the same bytes.** The CLI used `readWorkbookSafely`; the panel
  hand-split CSV on `/\t|,/`. Seven of the 32 corpus probes read differently. The packed cell
  `"Archery, Ceramics"` that P09 and P10 exist to exercise became two cells at two different
  COORDINATES, shifting the rest of the row one column right so the activity in the Tuesday column
  fell off the end, and the `split_packed` decision was never offered. It forked identity too: one
  quoted CSV produced two camper rows for one child's one file.
- **A false residue.** `readPreferenceSheet` passed a whole-sheet planner's rows positionally beside
  an empty mapping, so every grid row was reported `skippedRows: 'no camper name'` and `ParseSummary`
  told the director "N row(s) skipped" on an import where all N landed.

## Evidence

See `completion_evidence`. The three that matter most:

1. The merge was audited by CONTENT because a squash merge defeats `--is-ancestor`, and the check
   that mattered was whether #644's work survived deleting the function it had extended. It did.
2. Each fix is red-then-green. Reverting the positional-rows fix turns the skipped-rows assertion red
   on BOTH doors at once, which is itself the evidence the fix now lives in one place.
3. The structural guard forbidding a hand-split was confirmed to FIRE on the deleted line, and not on
   a legitimate newline split, before being trusted green.

## Agents

None. Every omission reason is in `omitted_agents` above with a note; `code-reviewer` and `red-hat`
are the two worth reading, because the first records that this change was not independently reviewed
and the second records that the adversarial case was real and was caught by merge discipline rather
than by a reviewer.

## What this cost

Five rebases. `main` gained eight commits during the work, four inside this change's own files
(#644, #646, #648, #652). A refactor that spans files other sessions are actively editing pays that
toll, and the near-miss above is the reason to record it rather than round it off.
