---
task: "closes T167 part 2: a change that closes something must file a run record"
document_type: run
date: 2026-09-15
round: 1
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T167-a-merged-change-should-leave-a-run-record.md]
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: governor
    reason: human-waived
    note: "Owner routed this session directly — \"figure out who it belongs to and keep going please\" — and no Governor dispatch occurred."
  - agent: architect
    reason: not-applicable
    note: two pure predicates added to an existing script. No schema, module boundary, wire shape or data flow.
  - agent: designer
    reason: not-applicable
    note: no rendered surface; nothing under src/ is touched.
  - agent: maker
    reason: human-waived
    note: "The session wrote the code itself rather than dispatching a Maker. Recorded as waived, not selected — claiming a Maker ran would be the fabricated history this ticket exists to prevent."
  - agent: code-reviewer
    reason: human-waived
    note: "A peer session read the full diff cross-session and approved, supplying a better argument for rule 1 than the original and performing a range check this author had argued for but not run. Recorded as waived rather than selected because no Code Reviewer AGENT was dispatched — the review was a peer session, which is not the same thing and should not be dressed up as one."
  - agent: verifier
    reason: not-applicable
    note: the gate was run directly by this session and its verdict is quoted in completion_evidence.
  - agent: tester
    reason: not-applicable
    note: no director-facing behaviour — a governance check and a ticket.
  - agent: security
    reason: no-predicate
    note: no auth, secret, IPC or transport surface.
  - agent: red-hat
    reason: not-applicable
    note: no stored-data shape, op-log, sync or migration change.
  - agent: grader
    reason: no-predicate
    note: nothing to score; no opinion agents ran.
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - "checkRunRecordFiled: closure with no added record -> 1 finding; with a record -> 0"
  - "checkRunRecordsFilledIn: a record retaining NEEDS JUDGEMENT markers -> 1 finding"
  - "this record is itself the rule being satisfied — the commit closes T167 and adds it"
  - "npm run verify on 87d74cb (the merged bytes): 5679 passed, all six stages green"
  - "reviewed cross-session before merge; approval was conditional on this verdict"
archive_when: a later session closes a ticket, forgets the record, and the gate stops them — at which point the rule has proven itself in use rather than in test
---

# T167 part 2 — require a run record

## What shipped

Two rules in `scripts/check-governance.js`. The first requires a change claiming
`closes T###` to ADD a record; the second refuses a record still carrying its
`<<NEEDS JUDGEMENT>>` markers.

## Why the first is about the change and not the ticket

"Some record somewhere mentions T167" would have been satisfied by part 1's
record when part 2 landed — this very commit. That is not a hypothetical
loophole; it is the one the author would have walked through first.

## Evidence

The rule was exercised against its own branch before the closing commit existed
(silent, correctly, because the branch closed nothing), then against a simulated
closure both with and without a record.

A test also caught a gap inspection missed: `TEMPLATE.md` was filtered only in
the gatherer, so a caller could have passed the template off as a filed record —
the most obvious way to satisfy this rule while doing nothing. The predicate now
enforces its own contract.

## Agents

No review AGENTS ran. A peer session did read the whole diff before merge —
because the rule binds them as much as this session — and approved, conditional
on the gate verdict. That is recorded as `human-waived` rather than as a Code
Reviewer selection: a peer session is not a dispatched agent, and claiming
otherwise would be the fabricated history this ticket exists to prevent.

The review earned its place twice over. It replaced the original justification
for rule 1 with a better one (a record attests to a VERIFICATION event, and a
part-1 record cannot attest to part-2's gate run or review), and it performed a
range check this author had argued for and not run.

This record was also re-verified after the fact: the ticket gained the reviewer's
reasoning AFTER the first green gate, so the branch was re-gated and the evidence
above cites 87d74cb — the bytes that actually merged, not the ones that happened
to pass first.
