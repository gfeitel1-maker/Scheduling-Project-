---
task: manual-grid-editing
document_type: run
date: 2026-07-26
round: 1
status: in-progress
risk: high
task_class: ui-ux-design
created: 2026-07-26
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T1-persistent-sidebar.md, docs/work/tickets/T2-group-view-drop-targets.md, docs/work/tickets/T3-copy-paste-selection.md, docs/work/tickets/T4-merge-split.md, docs/work/tickets/T5-undo-redo.md]
related_specs: [docs/work/specs/2026-07-26-manual-grid-editing.md]
related_adrs: []
selected_agents: [governor, designer, maker, verifier, code-reviewer, tester, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no new data model; existing template_slots op-log path
  - agent: security
    reason: not-applicable
    note: no auth/trust-boundary change
  - agent: red-hat
    reason: not-applicable
    note: no persistence/sync model change
deterministic_checks: [test, lint, build]
human_gates: [approve revised information architecture]
verdict: null
completion_evidence: []
archive_when: all tickets closed and Verifier PASS recorded
---

# Run — Manual Grid Editing

> **Migrated 2026-07-30** from `docs/work/task-state/` to conform to
> [`WORK_RECORD_STANDARD.md`](../../governance/standards/WORK_RECORD_STANDARD.md). Four changes
> to the frontmatter, each recorded here rather than made silently:
>
> 1. `task_class: navigation-ia` → **`ui-ux-design`**. `navigation-ia` is not a row in
>    `GOVERNANCE_INDEX.md` §3–8 and never was. `ui-ux-design` is the nearest true class and pulls
>    in the same `DESIGN_STANDARD.md`, so no governance changed — but the original value routed
>    against a class that did not exist. **This is a finding, not a cleanup.**
> 2. `omitted_agents` map → list of `{agent, reason, note}`. The prose became `note`; each gained
>    a `reason` from the enum. No wording was dropped.
> 3. `deterministic_checks` full commands → the short names owned by `TESTING_STANDARD.md` §1.
> 4. `verdict` and `completion_evidence` **left empty on purpose.** The original claimed
>    `[verifier_pass, grader_pass, screenshots_compared]` while `status: active` — a pass asserted
>    with no evidence path attached to it. Under §5.2 `completion_evidence` must be non-empty when
>    `verdict: pass`, so inventing paths here would manufacture the exact provenance the standard
>    exists to prevent. `status` is `in-progress` and `verdict` is `null` until Verifier actually
>    runs.
>
> `document_type` changed `task-state` → `run`, and `risk: high` is retained though the schema does
> not require it — it is true and worth keeping.

**Created:** 2026-07-26  
**Governor:** Claude (Sonnet 4.6)  
**Status:** Phase 7 — Bug fixes D1/D2/D3 complete (linted clean, browser verified)

---

## Product outcome

Enable camp directors to place activities onto the schedule grid manually — like Excel — with a persistent activity sidebar, copy/paste (single and multi-cell), merge/split of adjacent time blocks, and all existing flags and locks preserved.

## Success predicate

1. ActivityPalette sidebar is visible whenever groups + days + timeBlocks + activities are all defined, on any schedule state (empty, generated, manual).
2. Dragging an activity from the sidebar to any open slot places it, evaluates flags, and persists via the op-log.
3. Single click selects a slot; Ctrl+click adds to the selection (multi-cell, Excel-style).
4. Ctrl+C copies selected cells' activity assignments to an in-memory clipboard; Ctrl+V pastes to the next clicked slot(s), re-evaluating flags at the new location.
5. "Merge down" on a filled slot merges it with the slot below in the same column (existing expandSlot mechanism, now accessible from the grid).
6. "Split" on a merged slot restores both slots independently.
7. Anchor slots remain non-editable throughout.
8. All writes go through localClient.write / writeFields → op-log.

## Non-goals

- Horizontal merge (across groups) — not in scope.
- Keyboard-only grid navigation.
- Changing the Activity view or Day view slot-editing behaviour.
- New DB tables or columns.
- Cross-view drag (palette drag only works in Group/Manual view, not Day/Activity view).

## Classification

| Dimension | Value |
|---|---|
| Work type | UI/interaction change + data flow restructuring |
| Risk | HIGH — touches ScheduleScreen (most complex file), op-log write path, DnD system, flag evaluation, locking |

## Routing decision

| Agent | Selected | Reason |
|---|---|---|
| Designer | ✅ | Layout restructuring, multi-cell selection UX, merge/split affordances, clipboard feedback all need explicit design states |
| Architect | ❌ | No new data model needed; all writes use existing template_slots op-log path. Skip unless Designer surfaces a data question. |
| Maker | ✅ | 4 tickets (see below) |
| Verifier | ✅ | Mandatory |
| Code Reviewer | ✅ | Complex file, multiple interaction paths |
| Tester | ✅ | Camp-director UX validation required |
| Security | ❌ | No auth/trust-boundary change. Skip unless Maker surfaces an issue. |
| Red Hat | ❌ | No persistence/sync model change. Skip unless Verifier or Tester surfaces an edge case. |
| Grader | ❌ | Skip unless Code Reviewer + Tester reports conflict. |

**Routing challenge trigger:** invoke Architect if Designer reveals the sidebar-in-all-views layout requires a shared DndContext that changes how op-log writes are batched or ordered.

## Agents skipped

Architect, Security, Red Hat, Grader — see routing table above.

## Tickets

| # | File | Status | Depends on |
|---|---|---|---|
| T1 | `tickets/T1-persistent-sidebar.md` | **Done** | — |
| T2 | `tickets/T2-group-view-drop-targets.md` | **Done** | T1 |
| T3 | `tickets/T3-copy-paste-selection.md` | **Done** | T2 |
| T4 | `tickets/T4-merge-split.md` | **Done** | T1, T2 |
| T5 | `tickets/T5-undo-redo.md` | **Done** | T3, T4 |

**Ticket T3 and T4 can be implemented in parallel** once T1 and T2 are complete.  
T5 must follow both T3 and T4.

Designer spec: `specs/designer-output-2026-07-26.md`  
Full spec (including undo/redo): `specs/2026-07-26-manual-grid-editing.md`

## Uncertainties

- Does the persistent sidebar need to coexist with the existing DisplacedPalette (floating, top-right)? Answer needed from Designer.
- Exact interaction for "paste to multiple targets" — does pasting a multi-cell clipboard require selecting N target cells first, or does it paste sequentially? Designer to decide.
- How does the lock state from the `locks` table (concurrent field-level locks) interact with the paste path? Maker to audit; flagged for Code Reviewer.

## Evidence

_(To be filled by Verifier)_

## Outcome

_(To be filled post-review)_
