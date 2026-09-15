---
title: "Put agents:check in the gate once green is reachable everywhere"
document_type: ticket
status: open
created: 2026-09-14
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md]
archive_when: npm run verify runs agents:check, a hand-edited agent profile fails the gate, and every active worktree is green on it
---

# T166 — Put `agents:check` in the gate once green is reachable everywhere

`npm run agents:check` exists, works, and is invoked by nothing. Its absence from the gate is
the direct cause of a real defect: commits `40aba6c`/`e403913` carried an
`.claude/agents/security.md` of 11,751 bytes that no binding + fragment pair in the tree could
produce. It reached `main` unnoticed and was served to Desktop sessions via the
`~/dev/shoresh-config` symlink. PR #395 repaired it upstream.

## Why this is deliberately not done yet

Two preconditions, both measured 2026-09-14:

1. **T165 must land first.** `agents:check` hard-exits when `~/.claude/organization` is absent,
   so adding it now couples the entire gate to untracked home state.
2. **Four worktrees still carry the pre-#395 orphan** and would go red on a file they never
   touched: `decisions-slice2` (3 commits ahead), `app-icon-audit-a9a598` (1),
   `relaxed-albattani-000799` (1), `agent-ab0c74bc99c0d41a7` (1, locked). Each resolves itself by
   rebasing past #395; none needs intervention. `camp-schedule-ingestion-3a679b` (13 ahead) is
   already based past #395 and is unaffected.

## Also note
`VERIFY_STEPS` is pinned exactly by `scripts/verify.test.js`, and it moves — #395 added a
`security` step. Re-read it at the current `origin/main` rather than from memory before editing.
