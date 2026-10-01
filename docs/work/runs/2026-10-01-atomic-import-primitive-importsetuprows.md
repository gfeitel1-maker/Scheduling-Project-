---
task: Atomic setup-import primitive — importSetupRows wraps one runAtomic, all-rows-or-none (board q-atomic-import-primitive)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: [docs/adr/2026-09-30-format-agnostic-setup-import.md]
selected_agents: [governor, maker, verifier, red-hat, code-reviewer]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: zero UI surface — a backend electron/ops transaction primitive; the director-facing doors are the follow-on part-2 swap on another worker's seam.
  - agent: tester
    reason: not-applicable
    note: no screen or running-app UX in this slice.
  - agent: architect
    reason: not-applicable
    note: within accepted ADR 2026-09-30 §4.9; no new architectural decision — the primitive's shape is prescribed by the amendment and the existing runAtomic callers.
  - agent: security
    reason: not-applicable
    note: no auth/secret/PIN/IPC surface changed; Red Hat reviewed the write path per §8.
  - agent: grader
    reason: human-waived
    note: organizer (owner authority) standing rule — when a Governor loop parks, push and open the PR; CI is the gate of record. The loop parked pre-grading; primary re-ran focused tests + lint (all green). Deterministic evidence + CI stand in place of a Grader score.
deterministic_checks: [electron/ops/importSetupRows.test.js, electron/ops/operations.test.js, electron/ops/operations.flushFailure.test.js, electron/ops/operations.loneWriteFailure.test.js, npm run lint, CI gate.yml]
human_gates: []
archive_when: superseded when the §4.9 part-2 door-swap (the seven setup doors onto importSetupRows) lands, after T322 S3b
---

# Run record — atomic setup-import primitive (`importSetupRows`)

- **Date:** 2026-10-01
- **Board item:** `q-atomic-import-primitive` (part 1 — the primitive; part 2 door-swap is the third worker's, after T322 S3b)
- **ADR:** `docs/adr/2026-09-30-format-agnostic-setup-import.md` §4.9 + 2026-10-01 amendment (no new ADR)
- **Branch:** `claude/board-import-setup-rows` (off `main`, base S3a #711 `536d3fa8`)
- **Schema change:** none

## What landed
`electron/ops/importSetupRows.js`: applies a confirmed set of create/update row operations inside a
single `runAtomic` frame (`electron/ops/operations.js:230`), so an unexpected mid-set throw unwinds
every op of the import. Matches the `commitElectiveRun.js` / `finalizeElectiveRun.js` runAtomic shape
so the eventual door-swap is mechanical. Validates `row.action` inside the frame (throws, naming the
row, on anything but `create`/`update`). Opens exactly one runAtomic frame — never nests one
(`i-nested-discard-leaks-queued-doc-writes` latent leak).

## Evidence (deterministic)
- `electron/ops/importSetupRows.test.js` — 7/7 pass, incl. the §4.9 acceptance test (injected throw on
  row N → DB byte-identical to pre-import snapshot) and a non-atomic contrast test proving the guard is
  real (red-before-green).
- `electron/ops/operations.test.js` + `operations.flushFailure.test.js` +
  `operations.loneWriteFailure.test.js` — 68/68 pass.
- ESLint on both new files — exit 0.
- CI (`.github/workflows/gate.yml`) is the gate of record.

## Review
- Verifier (round 1): PASS, 132/132 focused, lint clean, red-before-green confirmed.
- Code Reviewer: in-scope, 1 MEDIUM + 3 LOW — all fixed in round 2 (throw-path test, +2 rollback tests,
  comment corrections, door-swap pointer comment).
- Red Hat (write path, §8): 2 HIGH. In-scope — unvalidated `row.action` bypassing the ordering guard —
  FIXED (validation + test). Out-of-scope/pre-existing — `appendOp` silent `camp_id` rejection — routed
  to the board (`i-appendop-silent-camp-id-rejection`), not a blocker.
- Deferred/held: stable `client_write_id` retry idempotency
  (`i-importsetuprows-stable-client-write-id-idempotency`) — unreachable while rollback is full.

## Provenance note
The Governor loop parked after the round-2 Maker fixes (lost the thread on a skill-doc tangent) without
re-running the Verifier or grading. Per the organizer's standing authorization to push when a loop
parks, the primary session independently re-ran the focused tests + lint (all green, above) and opened
the PR; CI is the gate of record. No Grader score was produced this run; the deterministic evidence and
CI stand in its place.
