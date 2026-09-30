---
task: docs(T317): closes T317 — status was left open at merge
document_type: run
date: 2026-09-30
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T317-the-seventh-import-door-shares-the-tab-rule.md]
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: no routing decision; the defect was found by auditing main and its fix was a two-line move onto an existing tested rule
  - agent: architect
    reason: not-applicable
    note: no new mechanism at all — readEntitySheet and its three-step order already existed and were already tested. This door stopped keeping its own version
  - agent: designer
    reason: not-applicable
    note: no new UI surface; the tab that was read reaches the director through the shared ImportPreviewSubtitle the other six already use
  - agent: maker
    reason: not-applicable
    note: the implementation ran in this session directly, not dispatched
  - agent: code-reviewer
    reason: not-applicable
    note: NOT dispatched, so not independently reviewed. In its place: 334 tests across 25 suites, CI verify green, and each of the two gaps planted separately
  - agent: verifier
    reason: not-applicable
    note: both halves of the governance gate run locally on exit codes — check:governance (0) AND vitest test/governance.test.js (39/39) — which is the half skipped on T314's close, at the cost of a red CI cycle
  - agent: tester
    reason: not-applicable
    note: not dispatched. LocationsScreen.test.jsx mocks XLSX like the other six suites and so cannot exercise tab selection; coverage stays in readEntitySheet.test.js against real workbook bytes, and the gap is in the non-goals
  - agent: security
    reason: not-applicable
    note: no auth/PIN/IPC/wire-protocol/packaging surface. The read caps are unchanged and still enforced by readWorkbookSafely underneath readEntitySheet
  - agent: red-hat
    reason: not-applicable
    note: NOT dispatched, but the adversarial pass is what produced the ticket: re-auditing main for SheetNames[0] after T315 was declared done found this door, and re-checking the proposed proof found that the UNSCOPED grep does not return nothing. Publishing the unscoped form would have been a false proof
  - agent: grader
    reason: not-applicable
    note: nothing to consolidate — no agent reports were produced
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - "#659 squashed to 8f9ac3f9; CI verify pass"
  - "all SEVEN doors name readEntitySheet on origin/main: Activities, Anchors, Days, Groups, Locations, Tiers, TimeBlocks"
  - "git grep SheetNames[0] origin/main -- src/screens returns nothing; the UNSCOPED grep does not, so the scoped form is the honest claim"
  - "334 tests green across 25 affected suites"
  - "each gap red-then-green separately: case-sensitive name match turns 1 red, removing the column fallback turns 4"
  - "the two selection steps back each other up — under a case-sensitive match the lowercase case still passes via the column fallback, so neither is redundant"
archive_when: the first-sheet class stays closed and the mirroring-test pattern has a structural check
---

# docs(T317): closes T317 — status was left open at merge

## What shipped

T317's closing commit and this record. T317 moved the seventh and last import door,
`LocationsScreen`, onto the shared tab-selection rule. It had survived T315's sweep by being the one
door that was NOT simply taking tab 1 — T121 had already taught it to prefer a sheet named
`Locations` — and it left two gaps: no column fallback, and a case-SENSITIVE name match, so
`locations` fell through to tab 1 where the rows belong to another entity.

## Evidence

See `completion_evidence`. The one to read twice is the scope of the proof: the class-closed grep is
true for `src/screens` and NOT true unscoped, and saying so is the difference between a proof and a
slogan.

## Agents

None. Reasons are in `omitted_agents`; `red-hat` and `verifier` are the two worth reading — the first
because the adversarial pass IS what produced this ticket, the second because it names the gate half
skipped one ticket earlier and what that cost.

## The finding that outlives this ticket

Third occurrence in this sequence of a test mirroring the code under test and hiding something: T313's
panel reader, T315's screen suites mocking `XLSX`, and `exportWorkbook.test.js` re-implementing
LocationsScreen's fallback. Each found by re-auditing, not by a failing test. Three is enough to want a
structural check rather than a fourth discovery; recorded rather than created, because what it should
check is a judgement about this repo's test conventions.
