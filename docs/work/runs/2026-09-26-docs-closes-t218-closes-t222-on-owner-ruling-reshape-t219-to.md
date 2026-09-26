---
task: Docs: closes T218 closes T222 on owner ruling; reshape T219 to the ingest gap
document_type: run
date: 2026-09-26
round: 1
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T218-elective-export-third-party-adapter.md, docs/work/tickets/T222-update-on-open.md, docs/work/tickets/T219-multi-day-catalog-linkage.md]
related_specs: []
related_adrs: []
selected_agents: [explore]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: The decision was made by the owner directly and handed down as three verbatim rulings. There was no spec to clarify, no options to converge, and no implementation to route.
  - agent: architect
    reason: not-applicable
    note: No schema, contract, or persistent data shape changes. Docs only.
  - agent: designer
    reason: not-applicable
    note: No UI surface touched.
  - agent: maker
    reason: not-applicable
    note: Explicitly a docs-only change. The owner's brief required stopping and reporting rather than building if verification contradicted a ruling; it did not, and nothing was built.
  - agent: code-reviewer
    reason: not-applicable
    note: No code diff to review for plan alignment or maintainability. The prose was written against the owner's verbatim words and each factual claim carries a file:line citation verified in this run.
  - agent: verifier
    reason: not-applicable
    note: The relevant deterministic gate for a ticket-status change is checkStatusDrift plus the index/reference checks, all inside `node scripts/check-governance.js`, which was run directly. The full `npm run verify` was deliberately not run — three sessions are active and the gate lock is machine-wide; CI is the gate of record for this branch.
  - agent: tester
    reason: not-applicable
    note: Nothing observable in the app changed.
  - agent: security
    reason: not-applicable
    note: No auth, IPC, transport, or packaging surface changed. The one security-adjacent finding surfaced (an absent schema-version check at the sync handshake) was handed to the owner as a finding rather than acted on.
  - agent: red-hat
    reason: not-applicable
    note: No stored data shape, op-log, sync, or migration change.
  - agent: grader
    reason: no-predicate
    note: There is no reviewer report set to consolidate — no reviewing agent ran, because none had a predicate on a docs-only closure.
deterministic_checks: [node scripts/check-governance.js]
human_gates: [owner ruling on T218, T219, T222 — quoted verbatim in each ticket's close section]
verdict: pass
completion_evidence:
  - "commit: the single commit on branch `worktree-agent-ac7af850764b5e31a` above `origin/main` — SHA deliberately not pinned, since amending the record changes it"
  - "gate: `node scripts/check-governance.js` — `check:governance — no findings.` (run locally after `npm run index:work`; the full `npm run verify` was not run, see the verifier omission note)"
archive_when: T219's reshaped exit condition is met or T219 is itself closed — at which point all three tickets in this run are terminal
---

# Docs: closes T218 closes T222 on owner ruling; reshape T219 to the ingest gap

## What shipped

Three ticket closures-by-decision, no code.

- `docs/work/tickets/T218-elective-export-third-party-adapter.md` → `closed`.
- `docs/work/tickets/T222-update-on-open.md` → `closed`.
- `docs/work/tickets/T219-multi-day-catalog-linkage.md` → stays `open`, reshaped to the one
  half of it that is a real gap.
- `docs/work/INDEX.md` regenerated (`npm run index:work`).

`closed`, not `completed`, on both closures: neither ticket's `archive_when` was discharged by work
shipping, and `completed` would assert a mechanism exists. The distinction is stated inside each
close section so a reader cannot mistake it.

## The standing rule these rulings establish

The source format is the camp's, not ours — not the tool, not the delimiter, not the sheet layout.
We read what arrives and normalize it. A ticket that asks the owner to *choose* a format a third
party produces is a mis-typed question, not an open decision. T218 and half of T219 were that
question.

## What was verified before writing (the part that mattered)

The brief required that each close cite the code that overtakes it, and stop rather than close if
the code contradicted the ruling. Findings:

- **T218 — overtaken, with one gap named.** The preference-sheet ingest path is genuinely
  mapping-driven: `src/ingest/preferenceSheet.js:38` proposes a column mapping from whatever header
  arrived, `:77` parses *under* that mapping, and the director corrects it at
  `src/screens/elective/assignment/MappingCorrector.jsx:41`. That is the tool-agnostic adapter
  boundary T218 asked for, already built. The **offering-grid** path is not: axis labels match
  existing entities by name with no remap seam (`src/ingest/electiveSetPopulate.js:140-161`) and
  orientation is heuristic with a refuse-whole-sheet outcome (`src/ingest/parseGridSchedule.js:196-197`,
  `:344`). That gap is recorded in the close and handed to the owner rather than papered over.
- **T219 — rendering exists, ingest does not.** Spans render end to end
  (`src/engine/buildSchedule.js:270`, `src/screens/schedule/gridGeometry.js:49-57`,
  `src/screens/schedule/gridPlacement.js:9`, `src/components/schedule/ManualBuildView.jsx:174-178`,
  pinned by `ManualBuildView.test.jsx:102` asserting `'1 / span 2'`). `linkageMarkers` is produced
  at `src/ingest/parseGridSchedule.js:349` and **has no consumer** —
  `src/ingest/electiveSetPopulate.js:119-122` says so in the code itself. The anchor/event importer
  already does the whole job (`src/ingest/multiBlockCandidates.js:60-96`, director confirmation at
  `src/screens/ImportScreen.jsx:1367-1381`); the elective grid has no equivalent.
- **T222 — the correctness concern is not in the ticket.** T222's scope list is entirely admission
  policy. The distinct hazard — a genesis-matching peer on a different schema merging a
  differently-shaped document — is real and absent from the code
  (`electron/sync/automerge/mutualAuth.js:33` carries no version field;
  `electron/sync/automerge/syncNode.js:187` checks genesis then merges unconditionally at `:196`),
  but it is not what T222 asked for. Handed up as a one-line finding; the ticket was not kept alive
  to carry it.

## Open items handed to the owner, not resolved here

1. The offering-grid ingest has no director-facing layout remap (T218's close, recorded against
   T219).
2. `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` needs the amendment T222's own
   "before you close" section demands. Another session holds that ADR in this window; it was
   deliberately not touched.
3. No schema/app-version field exists in the sync handshake
   (`electron/sync/automerge/mutualAuth.js:33`).

## Agents

Only the read-only `explore` agent ran, to gather the file:line evidence above. Every other agent
is omitted with a reason in the frontmatter. The short version: this change contains no code, so
the agents whose predicates are code (maker, code-reviewer, tester, security, red-hat, architect,
designer) had nothing to act on, and grader had no reports to consolidate. Verifier is the one
omission worth reading closely — the gate that actually polices this change (`checkStatusDrift`,
reference resolution, index staleness) was run directly and locally, because CI's shallow clone
skips status-drift.
