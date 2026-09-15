---
title: "A merged change should leave a run record, and the gate should notice when it does not"
document_type: ticket
status: completed
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

## Slice 2 shipped (2026-09-15) — the clerical half is gone

`scripts/gateReportCli.js` now derives the Verifier `PerGateReport` itself. The input names a
gate results file and the commit under review; Grader writes only the **opinion** reports, which
is the part that genuinely needs a model.

```json
{ "gateResults": "docs/work/runs/evidence/<file>.txt", "commit": "<sha>" }
```

`commit` carries T169's binding through: a results file produced against a different tree, or a
dirty one, is refused rather than accepted. Supplying both `gateResults` and a hand-written
`verifier` report is a usage error — silently preferring either would hide which evidence was
actually used. `docs/governance/agent-bindings/grader.md` now says all of this, so the instruction
and the tool agree.

**A contract violation found while wiring this up.** The T169 binding findings were tagged
`BLOCKING`, and `gateReportSchema.js` rejects a `BLOCKING` finding unless the verdict is `FAIL`.
An `UNVERIFIED` report carrying one was therefore *malformed* — the reducer reached `BLOCK` by
accident rather than through §5.2, and threw the explanation away. The severity is now `HIGH`,
which is what a binding problem actually is: "we cannot tell whether this passed", not "it
failed". The verdict does the blocking; the finding explains it.

Because the reducer's output carries `blocking_findings` only — and that shape is deliberately
not being widened, since its unchanged semantics are the thing worth protecting — the CLI prints
a non-`PASS` derived Verifier verdict and its reason to stderr. 32 tests across
`gateReportCli.test.js` and `verifierReport.test.js`.

## Still open — part 2 of the original ticket

Requiring a run record for new completions. Untouched, deliberately: filing is now much cheaper
but not yet demonstrably cheap *in practice*, and the ordering in this ticket was "make it cheap
before making it required" for a reason. The reusable mechanism is Mobile Prototype's
`checkRunRecordNodes` (routing accounting), and the rule must apply to new completions only — 81
tickets are already closed without a run record, so applying it retroactively means either
fabricating history or a permanently red gate.

## Correction, 2026-09-15 — the dispatch number in this ticket is wrong

This ticket (and the commit messages and PR #404 body that quote it) says the reviewers run and
**"grader 3"** does not. That number came from a recursive glob over a single project slug and is
not representative. Corrected count over the full corpus — 1,936 `.jsonl` files, 335,658 records,
every shoresh-family slug:

| maker | code-reviewer | red-hat | architect | designer | tester | **grader** | verifier | security | governor |
|---|---|---|---|---|---|---|---|---|---|
| 438 | 241 | 228 | 136 | 92 | 87 | **74** | 72 | 67 | 62 |

**Grader is dispatched slightly more often than Verifier.** The story this ticket told — "the
reviewers run, nobody transcribes, so the evidence is discarded at the last step" — is an
explanation invented to fit a bad measurement, and it should not be repeated.

### What is still true, measured from git rather than transcripts

292 commits on `origin/main` since 2026-08-25 produced **1** run record and **2** gate reports.
25 gate-report artifacts exist in total. The artifact gap is real and large.

### What is now unknown

Grader is dispatched ~74 times; ~25 committed artifacts exist. **Why the remaining dispatches
leave nothing behind has not been determined.** The obvious hypothesis — reports written into
worktrees that never merge — was checked and is false: zero uncommitted gate reports across all
ten worktrees. Candidates not yet tested: dispatches that reason but never reach
`gateReportCli.js`; runs whose `runsDir` was a scratch path; multiple rounds against one task
where only the last is kept.

`scripts/observeRun.js` is the instrument that should answer this — extended to record, per
Grader dispatch, whether `gateReportCli.js` was invoked and where it wrote. Until then the honest
statement is: **the artifacts are missing and the reason is not established.**

### Does slice 2 still earn its place

Yes, but for a smaller reason than claimed. Deriving the Verifier report removes real clerical
work and carries T169's commit binding into every GateReport. It does not, on its own, close the
artifact gap — because the gap is not now known to be caused by transcription cost.

## Both parts landed, 2026-09-15

**Part 1** — `scripts/newRunRecord.js` fills everything git and the gate already
know and refuses to fill judgement, emitting `<<NEEDS JUDGEMENT>>` where a
machine must not guess. Two improvements came from *using* it: bare ticket
mentions now feed `related_tickets` (its own first commit produced an empty
list), and every roster agent is pre-listed because `check:governance` rejected
its first record for forgetting `maker` and `grader`.

**Part 2** — two rules in `scripts/check-governance.js`:

- `checkRunRecordFiled` — a change claiming `closes T###` must **add** a record.
  Deliberately about the CHANGE, not the ticket: "some record somewhere mentions
  T167" would be satisfied by the part-1 record when part 2 lands, which is this
  author's own next commit and is how the rule would first have been evaded.
- `checkRunRecordsFilledIn` — no record may keep its `<<NEEDS JUDGEMENT>>`
  markers. Without it, making filing cheap would only make producing EMPTY
  records cheap, and the artifact becomes decoration — worse than the 283 missing
  ones, because decoration looks like evidence.

New completions only. 81 tickets are already closed without a record, and
applying this retroactively would mean fabricating history or a permanently red
gate. The scope falls out for free: `origin/main..HEAD` is unmerged work by
construction.

A skip is announced rather than silent — an unreported skip would read as a pass,
which is the defect class this ticket is about.

## Why rule 1 is per-change — the better argument, from review

The original justification was "it is the loophole this author would have walked
through first." True, but incidental. The reviewing session supplied the real
reason:

> A run record attests to the VERIFICATION of one merged change — which agents
> ran, what the gate said. A part-1 record physically cannot attest to part-2's
> gate run or to part-2's review. Evidence must be per-verification-event, and
> the merge IS that event.

So a two-PR ticket filing two records is not a cost to tolerate; it is two
verifications having earned two pieces of evidence. Granularity follows from the
same point: the PR is the unit that runs the gate and gets reviewed, so it is the
unit that leaves evidence. Per-ticket under-documents a three-PR ticket;
per-commit buries a five-commit branch in noise.

## Known looseness, recorded rather than discovered later

**Rule 1 does not verify that the added record REFERENCES the ticket being
closed** — any added run record satisfies it. Deliberate: content-linkage is
brittle, and `newRunRecord.js` pre-fills `related_tickets` so in practice the
link is there. Raised in review and left in knowingly.

## Watch-item

A trivial closing change (a docs typo that happens to close a doc ticket) still
has to file a record with an honest "no agents ran because X" — rule 2 forbids
leaving the marker, so it costs one real sentence. That is the right discipline
at a fair price.

The failure mode to watch is people dropping `closes` from commit subjects to
dodge the record. That evasion is self-defeating and visible, because it breaks
the status-drift gate in the same breath — but if it starts happening, the rule
needs revisiting rather than enforcing harder.

## Verification

`npm run verify` — 5,679 passed, all steps green. Reviewed cross-session before
merge, including a range check this author had argued for but not performed:
`git log origin/main..HEAD` and `git diff --diff-filter=A origin/main..HEAD`
resolve consistently, so a record added on `main` meanwhile shows as `D` and
never as a false `A`.
