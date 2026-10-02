---
task: "T326 — Governor binding: foreground gate-dispatches + 20-minute quiet-loop takeover (board follow-up to the T323/T324/T325 wedge)"
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/agent-bindings/governor.md]
related_tickets: [docs/work/tickets/T326-governor-dispatch-discipline-foreground-and-takeover.md]
related_specs: []
related_adrs: []
selected_agents: [governor]
omitted_agents:
  - agent: maker
    reason: not-applicable
    note: "doc-only governance-binding edit (one paragraph) plus a deterministic regeneration (generateAgentProfiles.js --write); no production code"
  - agent: architect
    reason: not-applicable
    note: no schema/module-boundary/contract design
  - agent: designer
    reason: not-applicable
    note: no UI surface
  - agent: tester
    reason: not-applicable
    note: nothing a camp director sees
  - agent: security
    reason: not-applicable
    note: no auth/secrets/PIN/LAN/IPC surface
  - agent: code-reviewer
    reason: human-waived
    note: "organizer directed a direct build, no loop, for this small same-seam governance edit; the content is the organizer's own worded rule"
  - agent: red-hat
    reason: human-waived
    note: "direct build per organizer; no logic/data/sync surface to attack"
  - agent: verifier
    reason: human-waived
    note: "orchestrator ran the deterministic checks directly (agents:check, check:governance, lint, governance.test) — a doc-only change with no test seam"
  - agent: grader
    reason: human-waived
    note: "no opinion-report round to consolidate on a direct doc build"
deterministic_checks: [agents:check, check:governance, lint, governance.test]
human_gates: []
verdict: pass
completion_evidence:
  - "docs/governance/agent-bindings/governor.md: new hard-rule paragraph (Maker/Verifier/Grader foreground + 20-minute quiet-loop takeover, with the 2026-10-01 three-park reason) inserted after the existing dispatch-discipline paragraph"
  - "node scripts/generateAgentProfiles.js --write regenerated .claude/agents/governor.md + manifest.json; npm run agents:check reports all 13 profiles + manifest match (byte-identical)"
  - "npm run check:governance — 0 blocking findings (1 pre-existing platform-state-stale advisory, unrelated)"
  - "npm run lint — 0 errors (pre-existing warnings only, unrelated files)"
  - "npx vitest run --root <worktree> test/governance.test.js — 42/42 green (frontmatter + link-integrity on this ticket and run record)"
archive_when: merged to main
---

# Run: T326 Governor dispatch discipline

> Direct build (no loop) per organizer sequencing — a small same-seam governance-doc edit. CI is the gate of record.

## Brief

**Product outcome:** the Governor binding stops a loop from silently parking for an hour on a
backgrounded Maker/Grader dispatch — the failure that cost ~3 hours across three loops on 2026-10-01
(T321, T322, T323).

**Success predicate:** governor.md states as a hard rule, with the reason, that Maker/Verifier/Grader
dispatches are foreground and that a loop quiet for 20 minutes (no process, no commit) is taken over
by the session; `.claude/agents/governor.md` regenerated and byte-identical; check:governance clean;
CI green.

## What shipped

- `docs/governance/agent-bindings/governor.md` — one new bolded hard-rule paragraph directly after
  the existing "Dispatch discipline (non-negotiable)" paragraph. It (a) names Maker, Verifier and
  Grader as foreground/synchronous with no exception (the general rule already covered all agents;
  these three are the round-gating ones whose backgrounding causes the park), and (b) adds the
  **20-minute quiet-loop takeover**: no running process and no new commit on the worktree for 20
  minutes → the orchestrator inspects the worktree and finishes the work itself rather than waiting
  or re-arming a notification. The reason (three ~1-hour parks on 2026-10-01) is stated inline so the
  rule is not re-litigated.
- `.claude/agents/governor.md` + `docs/governance/agent-bindings/manifest.json` regenerated via
  `node scripts/generateAgentProfiles.js --write` (not hand-edited); `npm run agents:check`
  byte-identical.
- `docs/current/PLATFORM_STATE.md` carries no governor-dispatch-discipline line, so there was none to
  update; not invented.

## Decision

**Ship.** This is the standing remedy for the wedge observed three times today (and twice more in
this very session's T323/T324-T325 work, which is why those ran as direct Maker dispatch + read-only
review instead of a Governor loop). Aligns with `CONSTITUTION.md` Art. VII (review agents run in the
foreground) — making an implication explicit, not changing a standard.
