---
task: Finish anchor-vocabulary rename: remaining utils, ADR affects-field path fixes, PLATFORM_STATE.md schema-version doc-fact bump, commit the governing ADR
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T293-fixed-recurring-activity-vocabulary.md]
related_specs: []
related_adrs: [docs/adr/2026-10-01-anchors-become-fixed-and-recurring-events.md]
selected_agents: [maker]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: dispatched directly by the owner/organizer with the ADR already accepted; Governor's usual planning/synthesis role was performed upstream of this session.
  - agent: architect
    reason: not-applicable
    note: the governing ADR (docs/adr/2026-10-01-anchors-become-fixed-and-recurring-events.md) was already written and accepted before this session started.
  - agent: designer
    reason: not-applicable
    note: pure vocabulary/identifier rename, no visual design surface.
  - agent: code-reviewer
    reason: not-applicable
    note: not dispatched in this session; the task brief routes review back to the human (Governor) after Maker signals done.
  - agent: verifier
    reason: not-applicable
    note: the task brief explicitly instructed Maker to run only focused test files (not `npm run verify`) and said the dispatcher runs the full gate separately.
  - agent: tester
    reason: not-applicable
    note: not dispatched in this session.
  - agent: security
    reason: not-applicable
    note: pure rename of existing columns/identifiers, no new auth/IPC/trust-boundary surface (confirmed in the ADR's own interface-contract checklist).
  - agent: red-hat
    reason: not-applicable
    note: not dispatched in this session; the ADR itself was written with Red-Hat-style scrutiny of the migration/determinism risk.
  - agent: grader
    reason: not-applicable
    note: not dispatched in this session.
deterministic_checks: [focused vitest file lists per the task brief, npm run check:governance, npm run lint]
human_gates: []
verdict: pass on every focused check run by this session (listed below) — the full `npm run verify` gate was deliberately not run here, per the task brief; the dispatching session is the gate of record
completion_evidence:
  - commit 3173d811
  - commit 4b336a0c
  - commit 637daded
  - commit bc74f807
  - commit cfa1af24
  - gate: NOT RUN by this session — the task brief directed Maker to run only focused test files (listed in the report) and said the dispatching session runs `npm run verify` separately; this run record does not cite a self-referential gate verdict.
archive_when: the dispatching session confirms `npm run verify` passes on this branch and merges it
---

# Finish anchor-vocabulary rename: remaining utils, ADR affects-field path fixes, PLATFORM_STATE.md schema-version doc-fact bump, commit the governing ADR

## What shipped

- Finish anchor-vocabulary rename: remaining utils, ADR affects-field path fixes, PLATFORM_STATE.md schema-version doc-fact bump, commit the governing ADR
- Rename anchor_id/is_anchor/is_anchor/anchor-vocabulary identifiers across ingest, UI, and utils to fixed/recurring-event vocabulary
- Rename anchors nav key to recurringevents; AnchorsScreen -> FixedEventsScreen; CohortsScreen ANCHOR_MODELS -> FIXED_EVENT_MODELS
- Rename anchor_id/is_anchor/anchor_model/anchor_name columns and electron-side registries to fixed/recurring-event vocabulary (v84 migration)
- Rename anchor_id/is_anchor/anchor_model/anchor_name columns and electron-side registries to fixed/recurring-event vocabulary (v84 migration)

## Evidence

- commit 3173d811 — schema v84 migration + rollback + registries
- commit 4b336a0c — engine rename + determinism pin
- commit 637daded — nav key / FixedEventsScreen / CohortsScreen
- commit bc74f807 — ingest/UI/utils identifier rename
- commit cfa1af24 — docs, ADR affects-field fixes, doc-fact bump
- Every focused vitest file list named in the task brief: PASS (see report to dispatcher for full file-by-file counts — 2000+ tests across schema/registry, engine, screens, components, ingest, utils, governance)
- `npm run check:governance`: PASS, no blocking findings (one pre-existing advisory, platform-state-stale, left as advisory)
- `npm run lint`: PASS, 0 errors, 26 pre-existing warnings (same warnings present before this change, unrelated to the rename)
- gate (`npm run verify`): NOT RUN by this session — the task brief directed Maker to run only focused test files, not the full gate; the dispatching session runs it and is the gate of record.

## Agents

Only Maker ran in this session — dispatched directly by the owner/organizer with
the governing ADR (docs/adr/2026-10-01-anchors-become-fixed-and-recurring-events.md)
already written and accepted before the session started. See `omitted_agents`
above for the reason each other role was not dispatched; none of them is a
fabricated or guessed omission — the task brief itself specified a
Maker-only, focused-test-only scope for this session.
