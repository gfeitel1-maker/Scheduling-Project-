---
task: "T180 — a Recurring Event stores its age DIVISIONS, not a snapshot of their groups"
document_type: run
date: 2026-09-16
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T180-recurring-event-division-scope-is-snapshotted.md]
related_specs: []
related_adrs: [docs/adr/2026-08-28-fixed-vs-recurring-events.md]
selected_agents: []
omitted_agents:
  - agent: governor
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: architect
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: designer
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: maker
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: code-reviewer
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: verifier
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: tester
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: security
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: red-hat
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
  - agent: grader
    reason: human-waived
    note: "Do not call the AgentTool unless the user requested it"
deterministic_checks: [npm run verify]
human_gates:
  - "owner chose option 1b (store divisions as a LIST) over the ticket's own recommendation"
  - "owner approved the commit"
  - "owner approved push/merge, conditional on a green gate on the rebased tree"
verdict: pass
completion_evidence:
  - "commit 29ff4b7 (pre-rename); gate run against exactly this tree content"
  - "gate: ✅ VERIFY PASSED — lint + agents:check + test + test:integration + security + check:governance all green; GATE_EXIT=0; 435 test files, 5823 passed / 5 skipped"
archive_when: superseded by T183 (anchor-scope consolidation), which routes the remaining consumers through resolveAnchorGroupIds and fixes the importer write side
---

# T180 — a Recurring Event stores its age DIVISIONS, not a snapshot of their groups

## What shipped

Schema **v65** adds `anchor_activities.unit_ids` (JSON array of tier ids) and
scope resolution moves into one shared function,
`src/engine/anchorScope.js#resolveAnchorGroupIds`, used by `buildSchedule.js`,
`weekCatalog.js` and T182's `anchorCoveredGroupIds` seam. `AnchorsScreen`
writes the divisions the director picked instead of expanding them to a group
list at save time; its Excel import does the same.

## What was actually wrong

Three things, only the first of which the ticket named:

1. Division scope was snapshotted at save, so a group added to a division later
   was silently excluded — while the UI kept displaying the division's name,
   reverse-derived from the stored groups.
2. **The ticket's own recommendation was wrong.** It proposed reviving the
   singular `unit_id`; the division picker is multi-select, so that would have
   fixed one-division events and left multi-division ones broken. Put to the
   owner as 1a-vs-1b; they chose the list. The ticket's author retracted the
   recommendation in writing.
3. **A second live defect, not in the ticket.** `weekCatalog`'s suppression path
   read `anchor.group_ids` raw. A division-scoped event carries an empty
   `group_ids` by design, so closing every group in a division for a week could
   never suppress its event. Found while extracting the resolver; three tests
   pin it.

## Evidence

- commit 29ff4b7 (pre-rename); the gate ran against exactly this tree content
- gate: `✅ VERIFY PASSED` — `GATE_EXIT=0`; 435 test files, 5823 passed / 5 skipped
- four gate runs total; **three were red, every red on a real defect, zero flakes**:
  - #1 red — a rebase conflict resolution had truncated one of #443's tests
    (lost an assertion and two braces). Caught as a parse error, which was luck:
    a truncation that stayed parseable would have shipped silently.
  - #2 red — six failures, all from the new column: three column-order
    tripwires, one FK-ordering fixture, v65 unclassified in
    `migrationDomainState`, and `unit_ids` unregistered in `undoReferences`.
    The last two asked real questions rather than demanding boilerplate.
  - #3 red — governance only: an invented ticket status, a stale work index,
    and `PLATFORM_STATE.md` behind the structural change.
  - #4 green.

## Agents

None ran. All ten omitted as `human-waived` on the owner's standing instruction,
quoted verbatim in the frontmatter: *"Do not call the AgentTool unless the user
requested it"* (with *"Do not use workflows or deep-research unless the user
requested it"*). The work was done directly in the main session, which is why
the gate is the only independent check in this record — worth knowing when
weighing it.

## Known-open at landing

`electron/ops/ingest.js` cannot write `unit_ids`, and `replaceScope` deletes
every camp anchor before rebuilding — so a **Replace-mode re-import silently
flattens division scope back to a group list**. The feature is destroyable by a
normal admin workflow until T183's importer write side ships. Add mode is
unaffected. The same file's drift check also reports a false "scope changed" for
division-scoped rows (report-only). Both assigned to T183; both recorded in the
ticket.

## Note on this record

Written before the final commit message and this file were added. The gate
verdict above describes the tree content, which those two additions do not
change — a record that cites a gate run of itself is self-invalidating, so the
SHA named is the gated one, not this commit's.
