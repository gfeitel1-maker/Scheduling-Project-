---
task: Typed run records and a compiled work index — tasks 1-6
document_type: run
date: 2026-07-30
round: 1
status: in-progress
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: []
related_specs: [docs/work/specs/2026-07-30-typed-run-records-and-compiled-work-index-design.md]
related_adrs: []
selected_agents: [governor, maker, verifier]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no schema, module boundary, or IPC shape; two pure scripts over frontmatter
  - agent: designer
    reason: not-applicable
    note: no UI surface
  - agent: security
    reason: not-applicable
    note: no auth, trust boundary, or data surface; adds no dependency and ships nothing to the renderer
  - agent: tester
    reason: not-applicable
    note: nothing runs in the app
  - agent: code-reviewer
    reason: human-waived
    note: "start task 1 and work through all of the tasks until you are done"
  - agent: red-hat
    reason: human-waived
    note: "start task 1 and work through all of the tasks until you are done"
  - agent: grader
    reason: human-waived
    note: "start task 1 and work through all of the tasks until you are done"
deterministic_checks: [test, lint]
round_2_note: base branch corrected mid-run; see 'Correction' below
human_gates: [approve WORK_RECORD_STANDARD.md as a standard]
verdict: null
completion_evidence: []
archive_when: the human gate on WORK_RECORD_STANDARD.md is closed
---

# Run: typed run records and a compiled work index

**This record is the first artefact produced under the standard it delivers.** Written after the
fact rather than before dispatch — a deviation from §5.1 of that standard, recorded here rather
than hidden, because the standard did not exist when the work started.

## Brief

**Product outcome:** decisions made in this repository stay findable after the session that made
them ends.

**Success predicate:** all six tasks of the design record — the standard, the template, the index
builder, the checker, `npm run verify`, and the corpus backfill — with `check:governance` blocking.

**What does not count as done:** a green checker obtained by widening an enum until the findings
stop.

## Deviation — no independent review ran

Code Reviewer, Red Hat and Grader were waived by direct instruction, quoted verbatim above. **This
run therefore carries no independent opinion on its own work.** It should not be read as having
passed review, and the human gate on `WORK_RECORD_STANDARD.md` — a new standard, per
`CONSTITUTION.md` Article IV — is still open.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `lint` | PASS | 0 errors, 11 pre-existing warnings, none in `scripts/` |
| `test` (new) | PASS | 64 passed across `frontmatter`, `build-work-index`, `check-governance` |
| `test` (full suite) | **UNVERIFIED** | 9 failures — see below |
| `check:governance` | PASS | no findings; blocking (`CHECK_GOVERNANCE_WARN=1` to downgrade) |

### The full suite is UNVERIFIED, not PASS

First run: 395 failures. Cause was the documented `better-sqlite3` ABI mismatch — `npm rebuild
better-sqlite3` (per `CLAUDE.md`) took it to 9. **Running that rebuild left the native module built
for Node; `npx electron-rebuild -f -w better-sqlite3` is required before `npm run electron:dev`.**

The remaining 9 are all `src/screens/ScheduleScreen.test.jsx` 5000ms timeouts under full-suite
parallel load. That file passes **50/50 in isolation**. This change adds no application code and
cannot affect it, but "cannot have caused it" is not the same as "verified green", so this is
recorded as UNVERIFIED rather than waved through.

**Carried forward:** the suite is load-flaky at 948 tests. That is a real finding with no ticket.

## Correction: this run was on the wrong base for most of its length

The branch `docs/work-record-standard` was created off `main`, but HEAD was switched back to
`feat/delete-used-records` immediately afterwards by a rebase finishing in another worktree. Work
proceeded there unnoticed until the branch state was re-examined at the user's prompting. Nothing
was committed to that branch, and the staged changes carried across cleanly — but every
`check:governance` result before the switch back was computed against the wrong tree. The T21
finding that appeared and then vanished is the visible trace of it.

**`git branch --show-current` belongs at the top of a run, not at the end.**

## The deferral in §5.1 of the spec was wrong

It claimed five branches held open `docs/` edits. Three do, and none of them contained the files
the backfill needed to touch. The claim came from reading `git diff main..branch` — a tree
comparison — as a statement about pending work. Corrected in the spec, with the reasoning kept
rather than deleted.

## Findings the checker surfaced on its first real run

It found 49. Sorting them mattered more than fixing them:

| Finding | Disposition |
|---|---|
| 18 tickets `status: completed`, 7 specs `status: active` | **The enum was wrong, not the corpus.** The first draft invented `resolved` and `approved`. Corrected in the standard |
| 3 × `resolved_by: <commit sha>` read as a missing file | **Checker bug.** `resolved_by` is not a doc-to-doc edge; given its own rule |
| `TEMPLATE.md` reported a dozen violations | **Checker bug.** A form is not a record; excluded |
| `document_type: reference` unknown | Type added |
| `T19 → T12-drag-and-drop-dead.md` | **Real defect**, fixed — T12 is `T12-schedule-grid-dnd-degraded.md` |
| spec `approved-with-open-gate` | **Real defect**, fixed → `approved`. Its `requires_adr` field already reads *satisfied*, so the gate it named is closed |
| `designer-output` `parent_spec` bare string | **Real defect**, fixed to a list |
| `T21 status: resolved` | **Not on main.** It exists only on `feat/delete-used-records` and will fail the checker when that branch merges. One word, in that branch |

The distinction is the point: a value the corpus expresses in different words changes the enum; a
value that is simply wrong stays a finding.

## Also found, and not fixed

`docs/work/runs/2026-07-26-manual-grid-editing.md` contradicts itself: frontmatter lists `grader`
in `selected_agents`, the prose routing table marks Grader **skipped**. Frontmatter and prose
disagreeing is exactly what no checker can catch. Left as-is — resolving it would mean deciding
what happened in a session nobody can now reconstruct.

## Decision

All six tasks complete; `check:governance` reports no findings and is blocking. **The human gate on
`WORK_RECORD_STANDARD.md` is open** — it is a new standard, and `CONSTITUTION.md` Article IV
reserves that to the user.

Carried forward, neither fixed nor ticketed:

- The unit suite is load-flaky at 948 tests (9 timeouts under full-suite load, 50/50 in isolation).
- `feat/delete-used-records` will fail the checker on merge until T21's status word changes.
- The other two unmerged branches' documents have never been validated.
