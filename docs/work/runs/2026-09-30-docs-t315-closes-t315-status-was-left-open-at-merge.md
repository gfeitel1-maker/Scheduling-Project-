---
task: docs(T315): closes T315 — status was left open at merge
document_type: run
date: 2026-09-30
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T315-every-setup-importer-reads-its-own-tab.md]
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: no routing decision existed; the defect and its scope were settled by measurement, and this session's rule is not to dispatch subagents unless asked
  - agent: architect
    reason: not-applicable
    note: no schema version, no new entity, no protocol change. readEntitySheet sits one layer above readWorkbookSafely, which keeps owning the capped read, and the selection order is recorded in the ticket with why each of its three steps earns its place
  - agent: designer
    reason: not-applicable
    note: no new UI surface. The tab that was read reaches the director through ImportModal's EXISTING previewSubtitle, via one shared ImportPreviewSubtitle rather than six spellings of the same sentence
  - agent: maker
    reason: not-applicable
    note: the implementation ran in this session directly, not dispatched
  - agent: code-reviewer
    reason: not-applicable
    note: NOT dispatched, so this was not independently reviewed. What stands in its place is behavioural: 522 tests across 31 suites, CI verify green on the merged head, and a per-door plant. That is evidence about behaviour, not maintainability, and the gap is real
  - agent: verifier
    reason: not-applicable
    note: the gates ran in-session on exit codes rather than tails; CI is the gate of record and passed on the merged head
  - agent: tester
    reason: not-applicable
    note: not dispatched. The six screen suites MOCK XLSX, so they structurally cannot exercise tab selection — which is why readEntitySheet is tested against real workbook bytes and the gap is written into the ticket's non-goals rather than left to be discovered
  - agent: security
    reason: not-applicable
    note: no auth/PIN/IPC/wire-protocol/packaging surface, and the one boundary touched was TIGHTENED: six screens' hand-rolled reads now go through readWorkbookSafely's F4 caps, pinned by tests that the byte cap and the per-sheet row cap still fire through the new entry point
  - agent: red-hat
    reason: not-applicable
    note: NOT dispatched. The adversarial question — what if the wrong tab is chosen — was answered by planting rather than argument: first-sheet selection turns 10 of 15 red, one per door, leaving exactly the fallback case and the caps. The second adversarial question, whether the fix could break the existing suites, answered itself: it did, 16 tests, because the header probe threw on a sheet whose first row is not an array. That guard is in because of it
  - agent: grader
    reason: not-applicable
    note: nothing to consolidate — no agent reports were produced
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - "#656 squashed to 9e14cda5; CI verify pass"
  - "audited BY CONTENT not ancestry: readEntitySheet present on origin/main in all SIX screens (Days, Groups, Activities, Anchors, Tiers, TimeBlocks) and in src/utils/exportSanitize.js"
  - "522 tests green across 31 affected suites"
  - "red-then-green per door: planting first-sheet selection turns 10 of 15 readEntitySheet tests red and leaves exactly the 5 that should pass (the fallback case and the two caps)"
  - "the F4 caps pinned THROUGH the new boundary, because the screens hand-rolled row-count guard was removed in favour of it"
  - "the ticket was written for FOUR doors and corrected to SIX by checking a peer report rather than taking it; both extra doors were in the silent-wrong-data half"
archive_when: T315 is completed and the export-columns mismatch it deliberately left out has been decided
---

# docs(T315): closes T315 — status was left open at merge

## What shipped

T315's closing commit and this record. T315 itself made all six per-entity setup importers read the tab
that holds their entity instead of `sheets[0]`. Four of the six keyed on `name`, so they did not fail —
they SUCCEEDED, importing the camp's program from the `Programs` tab as a group, an activity, an age
division and a time block. Two (Days, Anchors) got the mild failure of importing nothing.

## Evidence

See `completion_evidence`. The two worth reading twice: the caps are pinned THROUGH the new boundary,
because six screens' hand-rolled guard was removed in favour of it; and the plant is per door, so a
regression on any one of the six is caught by name.

## Agents

None. Reasons are in `omitted_agents`; `tester` and `red-hat` are the two worth reading — the first
records that the screen suites mock `XLSX` and structurally cannot cover this, the second that the fix
broke 16 existing tests before the header probe was made to fail soft.

## What the count cost

Written for four doors from a report naming four; corrected to six by checking the claim. Both extra
doors were in the worse half. A defect class counted short is how the last doors get left.
