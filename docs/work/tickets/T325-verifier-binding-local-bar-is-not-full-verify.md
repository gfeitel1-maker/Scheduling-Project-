---
title: "Verifier binding's default local bar stops being the full gate"
document_type: ticket
status: completed
created: 2026-10-01
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
related_tickets: []
archive_when: "docs/governance/agent-bindings/verifier.md states the default local bar is touched-file tests + conditional schema:check + check:governance/lint, with the full npm run verify run only when a Governor brief names it; .claude/agents/verifier.md is regenerated from that binding (not hand-edited) and npm run agents:check reports byte-identical"
---

# T325 — Verifier binding's default local bar stops being the full gate

Board item `q-verifier-binding-ci-is-the-gate`. `docs/governance/standards/TESTING_STANDARD.md` §1
and `CLAUDE.md` both already state that CI is the gate of record for merging and that a full local
`npm run verify` is no longer *necessary* before every push — but `docs/governance/agent-bindings/
verifier.md`'s "What to run" section never said what the Verifier's own default local bar should be,
leaving room for a subagent to run the full ~13-minute gate reflexively on every round even when
nothing asked for it. This is a gap-closure aligning the binding to standards that already say this,
not a standards change.

## What shipped

- `docs/governance/agent-bindings/verifier.md`, "What to run" section: a new paragraph stating the
  DEFAULT local bar is (a) the test file(s) for every touched file, (b) `npm run schema:check` when
  `electron/db/**` or `electron/db/schema.sql` changed, (c) `npm run check:governance` and
  `npm run lint` — and that the full local `npm run verify` is the exception, run only when the
  Governor brief explicitly names it, because CI (`.github/workflows/gate.yml`) already runs the
  identical eight steps on a clean Linux runner and is the gate of record for merging.
- `.claude/agents/verifier.md` regenerated via `node scripts/generateAgentProfiles.js --write` (never
  hand-edited) and confirmed byte-identical to the binding via `npm run agents:check`.
- No change to `docs/current/PLATFORM_STATE.md` — it does not describe a verifier-gate default to
  update.

## Why this matters tonight

Two Governor-loop stalls earlier in this session each cost a long wait because the Governor
subagent backgrounded its Maker child instead of dispatching it synchronously in the foreground —
see the batch run record's note. That is a separate, orchestration-level defect in
`docs/governance/agent-bindings/governor.md` (explicitly NOT touched by this ticket), but it is why
tonight's batch ran as direct Maker dispatch with read-only review rather than a full Governor loop.
This ticket's fix reduces a different but related waste: a Verifier that defaults to the full gate
on every round, rather than the focused bar CI already backstops.

## Evidence

`npm run agents:check` — all 13 profiles + manifest report `match`.
