---
task: T197: elective run projection and export, schema v76 — closes T197
document_type: run
date: 2026-09-26
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T197-projection-and-export.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_adrs: [docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
selected_agents: [governor, architect, maker, code-reviewer, tester, security, red-hat]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: the only UI added is one "Export Full Report" control in FinalRunView, placed beside the existing child-schedule export and reusing its pattern. No new screen, layout, visual language or motion.
  - agent: verifier
    reason: not-applicable
    note: the whole-suite gate was escalated to CI rather than run by a subagent, per CLAUDE.md ("CI is the gate of record") and the standing rule that a subagent must not park on the ~11-minute suite. CI is the deterministic evidence; no agent adjudicated exit codes on its behalf.
  - agent: grader
    reason: no-predicate
    note: not dispatched, and recorded as a gap rather than dressed up. Round 1 failed on two independent HIGH findings from code-reviewer and red-hat that agreed on one root cause, so no score was needed to decide RETRY; round 2 was not re-scored. A Grader pass would have added an independent read on whether round 2's fixes were sufficient.
deterministic_checks: [npm run verify, npm run check:governance]
human_gates:
  - owner ruled option (a) — build group-template inheritance and linked-choice-as-one-span together with the schema bump, 2026-09-26
  - owner renumbered the bump v75 to v76 so T266 could land first without a gap in the migration sequence
  - owner retracted an instruction to widen the migration guard; the one-wide form was kept
verdict: pass
completion_evidence:
  - commit 71de2399
  - PR https://github.com/gfeitel1-maker/Scheduling-Project-/pull/552
  - gate: <<GATE VERDICT>>
archive_when: superseded by a later record for the elective export contract, or when the eligibility/resource exception categories gain a real detection source
---

# T197: elective run projection and export, schema v76

## What shipped

Group-template inheritance in the per-camper outer schedule, linked-choice
rendering as one unit, activity rosters, exceptions, summary, a combined
`format_version: 1` JSON document, and an XLSX workbook — all from one
assignment run.

Schema v76, additive: `cell_kind`, `choice_id`, `is_linked_choice`,
`choice_label` on `elective_run_outer_snapshots`.

## The deviation this resolves

ADR 2026-09-23 decision (d) reads "for the non-elective cells the run's campers
occupy". T248 shipped only resolved elective placements and recorded the
deviation in its own module header. That deviation was correct at the time:
building the draft path to the ADR's reading while finalize snapshotted only
elective cells would have made the two disagree for the same run. Both sides
are now built, so `deriveElectiveRunOuterRows` remains the single function both
paths call and the finalize-symmetry integration test is unmodified.

## What round 1 got wrong

The four export builders were written against the shape the ADR described and
fixtured to match that same imagined shape, so every test was green while the
real IPC handler produced blank camper names, blank groups, null linked-choice
labels, and a permanently-empty capacity bucket. Code-reviewer and red-hat found
this independently with file:line evidence. Round 2 rebuilt the builders and
their fixtures against the actual producers.

Red-hat additionally found a snapshot-id collision: `deriveElectiveRunOuterSnapshotId`
excludes `cell_kind`, so a camper holding both an elective and an inherited cell
at one (day, block) produced two rows with one id, and last-write-wins silently
dropped one. Fixed semantically — an elective placement replaces the inherited
template cell at that block — rather than by widening the id.

## Not discharged

The `eligibility` and `resource` exception categories ship as explicitly-named
empty buckets carrying a machine-readable `not_computed` marker. Both are
generation/finalize-time findings that are never persisted, so there is no
stored source to read. No detector was fabricated and no key was silently
omitted. T197's `archive_when` was left as written rather than rewritten to
match what shipped.

## Evidence

- commit 71de2399
- PR https://github.com/gfeitel1-maker/Scheduling-Project-/pull/552
- gate: <<GATE VERDICT>>
- migration chain verified stepping 74 -> 75 -> 76 on a fresh database and on
  one rolled back to 74 and reopened
- all six new guards independently reproduced as non-vacuous by tester
  (defect planted, red observed, restored, green), including two defects the
  guards' own descriptions would not suggest

## Agents

Ran: governor, architect, maker (two rounds), code-reviewer, tester, security,
red-hat. Omitted with reasons above: designer, verifier, grader.
