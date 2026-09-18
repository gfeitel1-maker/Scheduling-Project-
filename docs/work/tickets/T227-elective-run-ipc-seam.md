---
title: T227-elective-run-ipc-seam
document_type: ticket
status: open
created: 2026-09-18
archive_when: the renderer can commit and read an elective assignment run over IPC, admin-only, with the mock mirroring it
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T196-assignment-engine.md, docs/work/tickets/T226-camper-preference-import.md]
---

# T227 — the IPC seam for an elective run

## Why this is its own slice, before the screen

T196 and T226 shipped the whole domain layer — parse, solve, commit — but **the renderer could not
reach any of it.** None of the seven participant entities had an IPC channel, so the feature was
usable only from Node and the MCP path. This ticket is the seam; the director-facing screen is
T229.

Splitting them is deliberate. This half carries the **security** consequence — it is the boundary
where a renderer first gets access to records about identifiable children — and it deserves to be
reviewed on its own rather than buried in a diff that is mostly layout.

## Admin-only by inheritance, not by a check written here

The seven participant entities are deliberately absent from `permissions.js` ENTITIES, so
`authorize()` default-denies them for staff, and `electron/auth/participantEntitiesAdminOnly.test.js`
holds that property. These handlers name a participant action
(`elective_assignment_runs.read` / `.write`) and inherit it.

**A hand-written role check in the handler would be a second place for the rule to drift** — the
exact shape this repo has an incident recorded against (a guard whose list had the same blind spot as
the thing it guarded). ADR D9: the participant domain is admin-only; staff consume the export.

## What crosses the boundary, and what does not

The **sheet is parsed in the renderer**, exactly as `ImportScreen` parses a schedule:
`parsePreferenceSheet` and `buildElectiveAssignments` are pure modules with no database, so only the
WRITE needs to cross. That keeps the mapping-correction loop interactive without a round trip per
keystroke, and it keeps the main process free of file parsing.

Three channels: `commit-elective-run`, `list-elective-runs`, `get-elective-run`.

## The refusal is mirrored in the mock, not stubbed

`src/localClient.mock.js` reproduces the same-name refusal faithfully. That is the behaviour a
director meets first, and the one most worth seeing while building the screen — a mock that quietly
accepts a colliding sheet would let T229 be built against a flow that cannot happen.

The op-log write is what degrades in the mock (it has no `operations` table), matching the
additive-degradation discipline of the stubs around it.
