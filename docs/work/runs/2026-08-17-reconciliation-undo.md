---
task: "Grace-window undo (add-mode) — U1 updates-only + U2 creation/deletion; U3 Replace-mode deferred"
document_type: run
date: 2026-08-17
round: 2
status: pass
task_class: database-sync
verdict: pass
selected_agents: [governor, architect, maker, code-reviewer, verifier, security, red-hat, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: backend/op-log feature; the receipt UI reuses the existing card/idiom, no design spec needed
  - agent: tester
    reason: not-applicable
    note: director-facing surface is a minimal receipt (Undo button + removed/kept report); backend behavior is covered by the op-log tests; a live director pass folds into the next UI milestone
deterministic_checks:
  - "npm run lint → 0 errors"
  - "npx vitest run --no-file-parallelism (full suite) → 202 files / 3165 passed / 1 skipped / 0 introduced failures"
  - "npm run test:integration → 25/25"
  - "npm run build → PASS"
  - "npm run check:governance → clean"
  - "undoReferences.schemaParity.test.js planted-edge proof → present + passing (registry completeness is mechanical)"
human_gates:
  - "Owner: start the undo slice, 2026-08-17"
  - "Owner: v1 = U1+U2 together (full add-mode undo incl. created records), 2026-08-17"
completion_evidence:
  - "docs/work/runs/gate-reports/shoresh-ingestion-reconciliation-undo-u1-u2a-u2b-r2.json (Grader PASS, overall 4.67, lowest 4)"
  - "3 Red Hat DESIGN passes + 1 Red Hat CODE pass (deviation verified correct) + Security 5 + Code Reviewer 4.5; full suite + integration + build green"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-17-onescreen-reconciliation-undo.md, docs/adr/2026-08-17-onescreen-reconciliation-projection.md]
related_runs: [docs/work/runs/2026-08-17-reconciliation-r1-gate-outcome.md, docs/work/runs/2026-08-17-reconciliation-onescreen-merge.md]
archive_when: "superseded by U2/U3 follow-on work or the undo mechanism is replaced"
---

# Grace-window undo (add-mode)

## What shipped
"Undo this import" for add-mode commits. `captureInverse` (add-mode only; throws on Replace)
captures `invertibleOps` (field updates) + `createdEntityIds` (creations) at commit. `ingestUndo`
(Host-only IPC, one server-side transaction) reverts updated fields — gated per-field by a fresh
`latestOp` PLAIN-seq "touched since" check (Invariant 4: device-local, never COALESCE) — and
deletes created rows — gated by a full-`PROJECTIONS[entity].fields` "edited since" check + a live
referential-integrity check (`referencesInto` over a schema-derived `UNDO_REFERENCE_CHECKS`
registry), deleted children-before-parents with an incrementally-built exclude set. Renderer-held
grace-window state (`useGraceWindowUndo`): one live window, terminal `used`, double-submit guard.
**U3 (Replace-mode) DEFERRED** — no undo affordance on a Replace commit in v1.

## The three-design-pass gate (the point of this slice)
Red Hat's original design pass (R1) found 3 HIGH gaps → owner DECOUPLED undo. This slice:
- **Pass 2 (2/5):** U1 sound; U2 registry derived-from-example (incomplete). Architect revised.
- **Pass 3 (2/5):** mechanism sound + verified; registry STILL missed 3 live convention edges by
  hand. ROOT CAUSE: hand-FK-search can't be exhaustive. FIX: a `PRAGMA table_info` NAMING-CONVENTION
  SCANNER TEST that forces every `*_id`/`*_ids` column to be registered-or-accepted, proven to catch
  a planted missing edge → registry completeness is now a MECHANICAL invariant, not diligence.
- **Code pass (4/5):** the Maker's self-authored deletion deviation (incremental-exclude in
  delete-order vs the ADR's upfront-D) VERIFIED CORRECT — safe-by-construction (only over-conservative,
  never orphans). Findings were test-hardening + a UX guard, all closed by the fix round.
- **Security 5:** ingestUndo matches the ingestCommit auth bar; re-validates all caller input
  server-side (a crafted payload can't delete arbitrary/still-referenced rows).

## Deferred follow-ons (specified in the ADR)
U3 Replace-mode undo (reuses `restoreEntity`); the `referencesInto` camp-scoping/perf index (a
comment marks it accepted); a live director-eye Tester pass on the receipt.

## Initiative status
The director-facing reconciliation experience is complete: one-screen (#88), one-workspace merge
(#94), R7 legacy (#95), and now undo. Remaining: R6′ facility honesty (needs a location-bearing
source), R9′ Roots (prototype-first), then MCP/CLI (separate project).
