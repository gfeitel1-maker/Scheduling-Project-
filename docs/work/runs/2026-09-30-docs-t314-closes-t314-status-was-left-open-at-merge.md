---
task: docs(T314): closes T314 — status was left open at merge
document_type: run
date: 2026-09-30
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T314-the-import-panel-reads-every-tab-of-a-workbook.md]
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: no routing decision existed — the owner's ruling named the defect and this session's rule is not to dispatch subagents unless asked
  - agent: architect
    reason: not-applicable
    note: no schema version, no new entity, no protocol change. selectPreferenceSheet extends an existing pure module rather than establishing a seam, and its selection order is recorded in the ticket with why each step earns its place
  - agent: designer
    reason: not-applicable
    note: no new UI surface. Unread tabs reach the director through ParseSummary's EXISTING residue list, which is the point: the loud half was already built and the panel simply had nothing to put in it
  - agent: maker
    reason: not-applicable
    note: the implementation ran in this session directly, not dispatched
  - agent: code-reviewer
    reason: not-applicable
    note: NOT dispatched, so this change was not independently reviewed. What stands in its place is behavioural: CI verify green on the merged head, 176 tests across eight suites, the CLI's own behaviour pinned unchanged at 101, and red-then-green at both layers. That is evidence about behaviour, not maintainability, and the gap is real
  - agent: verifier
    reason: not-applicable
    note: the gates ran in-session with output quoted rather than summarised; CI is the gate of record and passed on the exact merged head (4m13s)
  - agent: tester
    reason: not-applicable
    note: not dispatched, but the director-facing path IS driven rather than mirrored: AssignmentPanel.test.jsx renders the panel, feeds real .xlsx bytes to the file input, and asserts on what reaches commitElectiveRun. That split exists because T313's lesson was that a test mirroring the code under test cannot catch the wiring
  - agent: security
    reason: not-applicable
    note: no auth/PIN/IPC/wire-protocol/packaging surface. The read caps are untouched and still enforced by readWorkbookSafely underneath readWorkbookRows
  - agent: red-hat
    reason: not-applicable
    note: NOT dispatched. The adversarial question here was 'what if the wrong tab is chosen', and it was answered by planting rather than by argument: planting sheets[0] in the panel and first-tab selection in the rule, each turning a specific named set of tests red and leaving exactly the ones that should pass
  - agent: grader
    reason: not-applicable
    note: nothing to consolidate — no agent reports were produced
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - "#655 squashed to 06b6f59e; CI verify pass 4m13s"
  - "audited BY CONTENT not ancestry: selectPreferenceSheet present on origin/main in preferenceImport.js, preferenceSheetCli.js and AssignmentPanel.jsx"
  - "176 tests green across 8 affected suites; the CLI unchanged at 101 (preferenceSheetCli, preferenceEtlResolve, callerDeclaredArrival)"
  - "red-then-green at both layers: planting sheets[0] in the panel turns 3 of 4 rendered tests red and leaves the single-tab case green; planting first-tab selection in the rule turns 8 of 10 red and leaves the tab-1 control and single-tab case"
  - "the scope this ticket got wrong is recorded in it and carried into T315: the same line sat in SIX setup importers, four with the silent-wrong-data failure"
archive_when: T314 is completed and T315 has landed the same fix for the six setup importers
---

# docs(T314): closes T314 — status was left open at merge

## What shipped

T314's closing commit, and this record.

T314 itself made the elective import panel read the tab that holds the camper preference table instead
of `sheets[0]`. Two failures, the second worse: notes on tab 1 gave `parsed: null` and told the
director the file "does not read as a camper preference sheet"; an offerings MENU on tab 1 was read as
one camper's own planner, so the import SUCCEEDED, minted a phantom unattributed camper named after
the file, and never touched the real table.

## Evidence

See `completion_evidence`. The one worth reading twice is the two-layer plant: the rule and the WIRING
are tested separately, because a test that mirrors the flow cannot catch the panel wiring it up wrongly.

## Agents

None. Reasons are in `omitted_agents`; `code-reviewer` and `red-hat` are the two worth reading.

## What this ticket got wrong

It fixed one door and recorded the rest as a non-goal. Six setup importers had the same line, four of
them with the silent-wrong-data failure. T315 exists because of that framing, and the lesson is the
owner's own: recording a class you have just proven is not the same as finishing it.
