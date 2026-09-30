---
task: "T198: CLI and MCP adapters for an elective assignment run, over one shared application service"
document_type: run
date: 2026-09-30
round: 2
status: pass
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_tickets: [docs/work/tickets/T198-machine-access-adapters.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md, docs/adr/2026-08-21-mcp-ingestion-server.md, docs/adr/2026-09-17-individual-elective-scheduling.md]
selected_agents: [governor, architect, maker, code-reviewer, security, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: No director-visible surface changes. Every changed line is a machine surface (MCP tools, a CLI, extracted ops modules) or a test; the two renderer files that own elective export and solving were explicitly out of bounds and are untouched.
  - agent: tester
    reason: not-applicable
    note: Tester judges the running app through a director's eyes. Nothing a director sees changed — the IPC handlers keep their channel names, argument shapes and return shapes, which Verifier confirmed mechanically (empty diff on electron/db/, existing handler tests passing unmodified). There was no director-visible artifact to evaluate.
deterministic_checks:
  - "npx vitest run (22 named files across three batches) — 458 tests"
  - "npx eslint ."
  - "npm run check:governance"
  - "npm run agents:check"
  - "npm run licenses:check"
  - "npm run build"
  - "planted-divergence non-vacuity drills on both parity tests, re-run independently by Verifier"
human_gates: []
verdict: pass
completion_evidence:
  - commit 55225aef
  - commit 6212b1a2
  - commit 6b3e0534
  - commit 23470bfe
  - commit 1e689a87
  - commit 8f6047cc
  - "gate: 458 tests passed across gates 1-3 (292 + 110 + 56), eslint exit 0, build exit 0, agents:check exit 0, licenses:check exit 0, check:governance no findings"
archive_when: T198 is archived, or the elective-run machine surface is superseded by a solver-composition service that makes `generate` reachable
---

# T198 — CLI and MCP adapters over one shared application service

## Success predicate

MCP, CLI and the UI's own read return equivalent run identity, assignments and findings for the
same elective assignment run; mutations stay gated and attributed; validation errors are
structured rather than prose; `schedule_state` is overlay-aware. No schema change.

## What shipped

The read logic of `getElectiveRunHandler` and `getElectiveRunOuterScheduleHandler` was a closure
inside `electron/main.js`. It is now `electron/ops/getElectiveRun.js` and
`electron/ops/getElectiveRunOuterSchedule.js`, moved verbatim — same SQL, same shared generation
predicate (ADR 2026-09-23 decision (a)), same capacity resolution, same returned shape — with the
handlers reduced to validate → `requireAuthorized` → forward. `electron/ops/electiveRunProjectionInput.js`
is the single assembly of the export document's input, and every machine surface funnels through
it, so the third assembly site ADR 2026-09-23's MEDIUM-4 finding warned about does not exist.

Surfaces: MCP `get_elective_assignment_run` and `export_elective_assignments` (read-only,
camp-scoped, purpose-built); CLI `scripts/electivesCli.js` core plus `scripts/electives.js` argv
wrapper, with `preview`/`commit` a literal passthrough to `runPreferenceSheetCli` and
`export --run --format json|xlsx` routed through `src/utils/exportSanitize.js`.

Confirmed rather than rebuilt: `ENTITY_MAP` is clean and already guarded by
`scripts/mcp/entityMapExclusion.test.js` (T194); `schedule_state` was already overlay-aware (T193).

## Agents

**Architect** ran first because the read logic's home was a genuine design question with more than
one defensible answer, and the wrong answer (re-querying per adapter) is the exact drift ADR
2026-09-23 records. It produced the ops-extraction design, rejected adapter-local re-query on
sight, and settled `generate` as an asserted gap on the evidence quoted below. No ADR: no new
persistent data shape, no changed contract, nothing irreversible.

**Maker** ran two rounds. Round 1 built the extraction, the shared assembly, both MCP tools, the
CLI, and grew T251's GAP-5 test into a three-way parity assertion. Round 2 closed the three
findings the panel raised.

**Code Reviewer, Security and Red Hat** ran in parallel after round 1. Security found no
vulnerabilities and cleared eight named threat questions, including the one that mattered most:
the extraction did not move anything out from behind `requireAuthorized`, and the new tools are
not a back door around the `ENTITY_MAP` exclusion. Code Reviewer confirmed the extraction is
verbatim by diffing it against the pre-change file rather than trusting the commit message, and
raised one MEDIUM. Red Hat scored Resilience 3 and found the gap that justified round 2.

**Verifier** ran the gate stack and, rather than accepting Maker's word, independently re-planted
both divergences and observed RED itself before restoring and observing GREEN.

## Round 2 — what the panel changed

- **Red Hat, HIGH.** `getElectiveRunOuterSchedule`'s `status === 'final'` branch — the immutable
  snapshot read that is the entire reason T248 wrote `elective_run_outer_snapshots` — was
  exercised by no test through any of the new surfaces. A director's real workflow ends in
  finalize → export, so the first real use of these adapters would have been the first execution
  of that path outside a test. `electron/electiveRunFinalizedProjectionParity.integration.test.jsx`
  now asserts the three-way equality on a finalized run and renames the underlying activity
  afterwards to prove all three surfaces still report the pre-rename name.
- **Code Reviewer, MEDIUM.** The ticket's `--week --route --tier` flags were dropped without a
  word, while the `generate` omission had been disclosed in three files. The asymmetry is what
  made it a finding: a future reader could not tell "known and accepted" from "forgotten." A
  disclosure comment now records that `runPreferenceSheetCli` takes no such parameters.
- **Red Hat, MEDIUM.** Non-interactive XLSX export is newly machine-reachable, so a
  formula-injection-prefixed camper name now travels a path no test covered. The sanitizer held;
  a test through the CLI now proves it, and was seen red with the sanitizer stubbed out.

## Non-vacuity

Neither parity assertion was accepted on a green run alone. Both were observed red under a planted
divergence, by Maker and then independently by Verifier:

- Remove the `days` label→name fold in `electiveRunProjectionInput.js` → the surfaces disagree on
  every day label.
- Bypass the finalized-run snapshot branch in `getElectiveRunOuterSchedule.js` and rename the
  activity → the export reports the post-rename name, which is precisely what the snapshot exists
  to prevent.

## Known limits

- **No `generate` verb, and no refusing stub either.** No production module composes solver inputs
  from a database; the composition exists only inside `solve()` in
  `src/screens/elective/assignment/AssignmentPanel.jsx`, which is why the T251 suite drives a
  rendered React component to reach a solve at all. Building the verb today would mean duplicating
  that composition — the drift this ticket closes — or spawning a renderer from a CLI. Extracting
  it is its own architecturally significant work.
- **`FinalRunView.jsx` still assembles its own export input**, passing a `templateOccurrences`
  prop where the shared assembly passes the run's own occurrence rows. Pre-dates T198, left alone.
  The parity claim is therefore about MCP, CLI and the UI-equivalent *handler read*.
- **`scripts/mcp/server.js` has no top-level try/catch** around tool dispatch, so an uncaught
  exception in any tool can take the stdio session down. Pre-existing for every tool in that file;
  both Security and Red Hat named it as pre-existing, and it was left out of scope.
