---
title: "A merged change should leave a run record, and the gate should notice when it does not"
document_type: ticket
status: in-progress
created: 2026-09-14
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: a ticket cannot move to completed without a run record that accounts for the agents the routing rules required, and the rule applies to new completions only
---

# T167 — A merged change should leave a run record

## The measurement

Creation dates on `origin/main`, by week:

| artifact | W31 | W32 | W33 | W34 | W35 | W36 | W37 | W38 |
|---|---|---|---|---|---|---|---|---|
| run records | 4 | 3 | 10 | 7 | 0 | 0 | 0 | 0 |
| gate reports | – | – | 6 | 15 | 0 | 1 | 0 | 0 |
| tickets | – | – | 8 | 17 | 2 | 5 | 9 | 1 |

**283 commits landed between 2026-08-25 and 2026-09-14 with zero run records.** 81 tickets are
`completed`; the recent ones name no run and carry no `completion_evidence`.

## This is not a judgement failure

Session transcripts for the `~/dev/shoresh` slug show the review agents genuinely being
dispatched: maker 63, code-reviewer 23, verifier 21, governor 19, architect 19, red-hat 16,
designer 11, security 9, tester 6 — and **grader 3**.

The reviewers run. The reports get written. Then nobody transcribes them, and the evidence is
discarded at the last step. Grader's job is to transcribe five prose reports into typed
`PerGateReport`s and shell out to `gateReportCli.js`; the reduction after that is already
deterministic code. So the skipped step is clerical, and it is the one that produces the durable
artifact.

`scripts/check-governance.js` validates records that **exist**. It has no rule that work must
produce one, so it cannot detect absence.

## Two parts, in order

1. **Make the filing cheap** before making it required — the step is skipped because it costs a
   dispatch at the moment work feels done. Absorbing the transcription reduces Grader to the part
   that actually needs a model.
2. **Then require it**, for *new* completions only. 81 tickets are already closed without one;
   applying the rule retroactively means either fabricating history (refused) or a permanently red
   gate.

## Reusable prior art
`~/dev/Mobile Prototype/scripts/check-governance.mjs`'s `checkRunRecordNodes` implements routing
accounting: for each routing-graph predicate that fired in a record, the reviewer it mandates must
be named, or the skip recorded with a reason. Port that mechanism only. Its `FORBIDDEN` term list
is domain-specific and **inverted** for this repo (it bans `electron`, `sqlite`, `camp director`).
Its roster and broken-link checks are **not** needed — `test/governance.test.js` already has both.

## Slice 1 shipped (2026-09-14)

`scripts/verifierReport.js` + `scripts/verifierReport.test.js` (9 tests). Verifier's half of
Grader's transcription is a function of exit codes, so it is now derived from the batched gate's
own results file instead of being typed by hand. `buildVerifierReport({text, evidenceRef})`
returns a `PerGateReport` that round-trips through the real `validatePerGateReport`.

Three behaviours are deliberate and tested, because each is the "started is not succeeded" defect
reappearing one level up, in the evidence layer:
- a gate with no `DONE` marker reports `UNVERIFIED`, never `PASS`;
- an observed failure stays `FAIL` — truncation cannot launder a red into "we don't know";
- `evidence_ref` is mandatory, and the reducer rejects the report without one.

**Still open:** the four opinion gates. Transcribing a prose review into a typed `PerGateReport`
needs a model, but it is the only part that does. Part 2 of this ticket — requiring a run record
for new completions — remains untouched and should not start until filing is demonstrably cheap.
