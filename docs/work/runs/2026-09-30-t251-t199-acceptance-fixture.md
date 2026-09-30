---
task: "T251 — the T199 spec §6 acceptance fixture, built through the real ingest and IPC path"
document_type: run
date: 2026-09-30
round: 2
status: escalated
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T251-t199-acceptance-fixture.md, docs/work/tickets/T199-individual-electives-end-to-end.md, docs/work/tickets/T301-linked-elective-choices-never-reach-the-solver.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md, docs/adr/2026-09-26-per-cell-elective-preferences.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md, docs/adr/2026-09-29-linked-elective-bundles.md]
selected_agents: [governor, architect, maker, code-reviewer, red-hat, security, tester, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: No new visual design. T250 shipped the Draft and Final screens; this ticket adds no component and changes no production file. Tester carried the director's-eye pass against DESIGN_STANDARD instead.
  - agent: design-auditor
    reason: no-predicate
    note: Invoked only by the /design-audit skill, and only for a UI sweep. No UI changed.
  - agent: architecture-auditor
    reason: not-applicable
    note: Periodic depth audit, explicitly outside the Governor/Maker/Verifier loop.
  - agent: security-assessment
    reason: not-applicable
    note: Periodic and not per-diff. It may reopen accepted tradeoffs; nothing here proposes changing one. Security (per-diff) ran instead.
deterministic_checks: [npm run lint, npm run security, npm run check:governance, npm run agents:check, npm run build, npm run test:integration, "npx vitest run --no-file-parallelism electron/electiveAcceptance*"]
human_gates: [owner decision on whether T199 ships without a Finalize control, a regenerate control, a visible same-name refusal, and a Delete control]
verdict: escalate
completion_evidence:
  - commit 32ac185b
  - commit d5134cd5
  - commit 06440d5c
  - commit 6e2eaf1a
  - commit 8d69bb7b
  - commit 74bf1191
  - commit a3305b1e
  - commit f2e192e4
  - commit 3024f228
  - commit 5e8952b0
  - commit 3dfe4ae4
  - commit 66459a02
  - commit 0f027dec
  - commit 840008f5
  - commit d3b49808
  - commit 50a168d3
  - commit 9f8ecf96
  - "evidence: docs/work/evidence/T251/ — 14 screenshots from the real Electron app, DEV badge visible; 13 distinct (see the reduced-motion note below)"
  - "gate: npm run verify NOT run locally; CI (.github/workflows/gate.yml) is the gate of record for this branch and had not run at the time this record was written"
archive_when: the owner rules on the four director-flow gaps below, and T199's exit condition is either met or formally narrowed
---

# T251 — the T199 §6 acceptance fixture

## What shipped

The spec §6 acceptance fixture, built through the real ingest and IPC path against a real
`better-sqlite3` database through the full migration chain, plus the assertions for §6's twelve
pass conditions. **No production file was changed and no schema version was touched.**

- `electron/fixtures/electiveAcceptanceCamp.js` — the builder, behind one interface, with three
  adapters (six vitest integration files, one Automerge scenario, one dev-database materializer).
  Catalogue entities come from `test/fixtures/elective-acceptance/camp-grid.txt` through the real
  ingest chain; campers, choices and preferences through `runPreferenceSheetCli` → `commitElectiveRun`;
  the elective set, offerings and bundles through the real generic `write` IPC handler.
- The solve is driven by **rendering the real `AssignmentPanel` in jsdom** over
  `makeHandlers(db, deviceId, {})`, because the whole solve composition exists only inside a React
  callback. Re-implementing it in the test was refused: that is the defect shape this module family
  has already shipped once (`src/screens/elective/assignment/buildAttendance.js:16-27`).
- Three bootstrap writes (`camps`, `devices`, `cohorts`) are direct, each with an asserted
  precondition and a comment naming what production emits. Condition (12) enforces that allowlist by
  scanning the fixture's own source.

## Why this is `escalated` and not `pass`

**The fixture is sound. The feature it is the acceptance test for is not finishable.** Tester drove
the real Electron app against this fixture's own camp and found the director flow incomplete in four
ways, each confirmed against `src/`:

1. There is **no Finalize control anywhere in the app.** `finalizeElectiveRun` is exposed at
   `src/localClient.js` and called from nothing under `src/`. `FinalRunView` renders only when
   `run.status === 'final'`, and nothing can set that — so the Final screen, the
   `OUTER_RESOURCE_CONFLICT` refusal and the linked-bundle rendering are all unreachable by a director.
2. There is **no reachable regenerate control**, so locking a seat has no observable consequence.
3. The same-name refusal is **invisible**. With two candidate schedules the route chooser renders
   instead of the refusal card, leaving only a 1×1px screen-reader announcement; the sheet then
   solves and offers "Commit Assignments" — 26 campers in, 25 out.
4. There is **no Delete control** for an elective run, so T199's ADR D10 honest-cost copy has nothing
   to sit on.

T199's exit condition requires the fixture to pass **under `electron:dev`** with the director flow
working, and its release preconditions require the D10 copy. T251's own `archive_when` requires
T199's exit condition satisfied. Neither can close truthfully today, so neither status was flipped
and no commit on this branch says `closes`. The D8 at-rest-encryption disclosure (the other release
precondition) **passes** on both entries tested.

**One evidence defect, recorded rather than quietly dropped.** Verifier checksummed the screenshots
and found two of the fourteen byte-identical: the reduced-motion capture was the same frame as the
D8 entry-2 capture. The file is renamed to say so. The reduced-motion verdict is therefore
**UNVERIFIED** — it rests only on a DOM measurement reported by Tester, with no distinguishing frame
behind it, and must be re-captured before it is cited. Everything else in the directory is distinct.

Per `CONSTITUTION.md` Article IV this is a product-judgement question — what "done" means to a
director — and it belongs to the owner, not to this loop.

## §6 pass conditions

Ten are asserted and passing. Condition (4) is narrowed to what the solver actually implements
(`attends()`; there is no eligibility rule engine) and says so in its own title. Condition (11) is
asserted for the surfaces that exist, with the absence of an elective-run MCP/CLI read path pinned as
an enumeration so a new tool cannot land without the condition growing a row. Four further gaps —
tier-blind per-cell preference binding, the un-clustered linked choice, the hardcoded
`eligibility: []`/`resource: []` in the exceptions export, and the missing MCP surface — are held
open by **inverted** assertions that go red the day each is closed.

## Agents

Governor routed; Architect designed the harness (`adhd` for four genuinely different shapes,
converged on builder-plus-three-adapters); Maker built test-first over two rounds; Code Reviewer,
Red Hat, Security and Tester reviewed in parallel; Verifier ran the gates; Grader scored.

Round 1 was green and still wrong in five places, which is the result worth recording: three
assertions could pass for the wrong reason (a gap guard naming a string no future fix would produce,
a refusal check that could not detect a refusal, a roster check that a permutation defect satisfies),
and condition (8) was **confirmed vacuous** by planting the mutation Red Hat named — short-circuiting
`runLinkedChoiceTier` left it green. Round 2 rebuilt each until the mutation reds it. A suite whose
whole argument is "these cannot pass for the wrong reason" earns no credit for being green.

## Gate

`npm run verify` was **not** run locally for this record. Per `TESTING_STANDARD.md` §1 CI is the gate
of record for merging, and a local green cannot distinguish correct code from a machine configured
like the author's. The checks listed in `deterministic_checks` were run individually by Verifier;
**that is not a verify verdict and must not be read as one.**
