---
task: T319 — an elective run is named after the import event, never after one file
document_type: run
date: 2026-09-29
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T319-a-run-is-named-after-the-import-event.md, docs/work/tickets/T303-caller-declared-arrival-on-the-machine-path.md]
related_specs: []
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no schema change, no new contract — one dependency-free pure naming function plus a guard on two fields already written by an existing call
  - agent: designer
    reason: not-applicable
    note: no visual change; RunList.jsx renders run.name and run.source_filename unchanged, only the stored strings become truthful
  - agent: security
    reason: not-applicable
    note: no auth, secret, PIN, IPC-surface or packaging change; `name` is an already-stored free-text field and this narrows, not widens, what may write it
  - agent: tester
    reason: human-waived
    note: owner-ruled scope, relayed verbatim in the dispatch brief — "Omit Designer, Security, Tester; record each omission and why." The observable change is one label string, pinned by a component-level assertion on the panel's commit payload and by end-to-end CLI/MCP assertions on the stored row.
deterministic_checks: [npx-vitest-8-focused-files, npm-run-lint, check-governance, schema-diff-empty]
human_gates: []
verdict: PASS
completion_evidence: [docs/work/runs/gate-reports/T319-r1.json]
archive_when: "T319 is closed and its assertions have survived one full CI gate on main"
---

# Run: T319 — a run is named after the import event

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** a director reading the saved-runs list sees what the run *is* — an import, when
it happened, how much it read — instead of the name of whichever file happened to arrive last.

**Success predicate:** a run's `name` is `Import <local YYYY-MM-DD HH:MM>, <N> sheet(s)`, produced by
one shared dependency-free pure function used by the CLI/MCP door, the director's panel and the dev
mock; an explicit `--name`/`run_name` still wins; a second byte-identical arrival onto an existing run
leaves `name` and `source_filename` untouched; each asserted by a test that goes red when the
production change is reverted.

**What does not count as done:** a filename anywhere in a run's name; a per-caller copy of the format;
a joined filename list in `source_filename`; a schema or column change; a fix that also rewrites the
run id; a test that would still pass with the production change reverted.

## Task class and what it pulls in

`ui-ux-design` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | DESIGN_STANDARD.md (copy in a director-facing label), TESTING_STANDARD.md |
| Mandatory gates | lint, focused vitest files, check:governance; full `npm run verify` deferred to CI |
| Human gate | none — owner ruling already given (2026-09-29) and the fix pre-accepted |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | no schema/contract change — see `omitted_agents` |
| Designer | no | no visual change — see `omitted_agents` |
| Maker | yes | the change |
| Code Reviewer | yes | spec fidelity + maintainability of the shared function's seam |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | owner-waived, quoted in `omitted_agents` |
| Security | no | no security surface — see `omitted_agents` |
| Red Hat | yes | re-commit semantics across every caller, and what `sheetCount` means in each path |
| Grader | yes | calibrated read |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| focused vitest — 8 files | PASS | 133 tests, 0 failures: `src/ingest/importEventRunName.test.js` (7), `test/callerDeclaredArrival.test.js` (38), `src/screens/elective/assignment/AssignmentPanel.test.jsx` (37), `scripts/preferenceSheetCli.test.js` (9), `electron/ops/commitElectiveRun.test.js` (30), `…identicalSubmissions.test.js` (6), `…preferenceProvenance.test.js` (4), `src/localClient.mock.electiveParity.test.js` (2) |
| `npm run lint` | PASS | exit 0; 26 pre-existing warnings, none introduced |
| `node scripts/check-governance.js` | PASS | exit 0, "no findings" — re-run after commit, because this gate reads COMMITTED history and could not speak to the then-untracked ticket and run record |
| no schema change | PASS | `git diff e6a38ecf -- electron/db/schema.sql electron/db/localDb.js` empty |
| full `npm run verify` | DEFERRED | 11+ min, exceeds the foreground ceiling for a dispatched loop; CI is the gate of record (`TESTING_STANDARD.md` §1) |
| plant-revert non-vacuity | PASS | guard reverted → `source_filename` `noa.csv` where `ari.csv` expected; `runName ??` reverted → both CLI and MCP override tests red; panel name reverted → regex assertion red |

## Verifier verdict

PASS — every clause of the success predicate traced to raw command output. One scoping caveat carried
forward and closed by the post-commit re-run: `check:governance` reads committed history, so its green
during review did not cover the ticket and run record, which were untracked at that moment.

## Grader score

Average — 4.5, lowest dimension — 4 (resilience). Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

Both are Red Hat MEDIUMs, recorded as stated limits in T319's "Known limit at close" rather than
claimed prevented. Neither is introduced by this change and neither blocks the predicate; Grader
called documenting them proportionate for an owner-ruled cosmetic defect.

- **The panel's re-commit safety rests on an unpinned invariant.** `regenerate()` is the only path that
  re-commits onto an existing `runId`, and it reuses the same `parsed` — so the suppressed name would
  have been identical. A future "swap the source file, keep the template" affordance would break that
  and leave a permanently stale name and sheet count. Named at the `commit()` call site in
  `AssignmentPanel.jsx`; whoever builds that affordance must pin it with a test first.
- **Two devices importing identical bytes before syncing both believe they are creating the run.**
  `existingRun` is a purely local sqlite read and the run id is content-derived, so per-field LWW can
  land one device's `name` beside the other's `source_filename`. Pre-existing for `status`; T319 extends
  it to two more fields and says so in the comment above `existingRun`. Closing it means deriving the
  run id from the declared arrival — T303's declined non-goal.

LOWs, all recorded in the ticket: a wrong system clock writes a permanently uncorrectable label; the
panel's old name used a UTC date and the new one uses local, so a near-midnight commit can show a
different calendar date; "sheets" is this app's word for a child's form and could read as a file count
in the runs list (owner accepted the format); the panel never sends `sourceFilename`, so every
panel-originated run stores `source_filename: null` (pre-existing).

## Decision

PASS — round 1. Verifier PASS with no unresolved UNVERIFIED claim, Grader 4.5 with no dimension below
3, and the two MEDIUMs are documented pre-existing or latent risks rather than defects in this diff.
