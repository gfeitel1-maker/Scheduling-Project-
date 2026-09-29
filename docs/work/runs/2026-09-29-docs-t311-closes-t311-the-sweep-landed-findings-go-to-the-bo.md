---
task: "docs(T311): closes T311 — the sweep landed; findings go to the board, not to tickets"
document_type: run
date: 2026-09-29
round: 1
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T311-retired-ws-host-comment-sweep.md]
related_specs: []
related_adrs: []
selected_agents: none — this session performed the sweep directly, with no subagents dispatched
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: one session, one specified sweep; there was nothing to orchestrate or route.
  - agent: architect
    reason: no-predicate
    note: no design decision and no structural change — the change is comment text only. The architecture it DESCRIBES was settled at the Stage 6c cutover.
  - agent: designer
    reason: not-applicable
    note: no UI surface touched.
  - agent: maker
    reason: not-applicable
    note: this session made the edits itself.
  - agent: code-reviewer
    reason: no-predicate
    note: no code changed. The four non-comment changes are two import-time drift-diagnostic strings and two test titles, enumerated in the PR. A peer session ("Fix super-linear op-log import write cost") independently re-derived findings 1 and 2 and corrected two of my counts, which is the review this work actually received.
  - agent: verifier
    reason: not-applicable
    note: the deterministic gate ran in CI rather than through a Verifier agent; the verdict line is quoted below.
  - agent: tester
    reason: no-predicate
    note: no director-facing behaviour changed, so there is nothing a director's-eye pass could observe.
  - agent: security
    reason: no-predicate
    note: the change alters no security behaviour. It SURFACED a security-relevant gap (MAX_FIELD_VALUE_LENGTH unenforced on the document-replay path) which is recorded owner-gated on the board as h-t311-followups, not fixed here. A security review belongs to whatever work the owner selects from that item, not to this sweep.
  - agent: red-hat
    reason: no-predicate
    note: no change to stored data shape, the op log, sync, replay or migrations. The sweep edits comments ON those seams without altering them; the non-comment audit in the PR body enumerates every changed line that is not a comment.
  - agent: grader
    reason: not-applicable
    note: no agent reports to consolidate.
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - commit b7236c28 — the sweep (PR #639), 35 files, comment- and doc-only
  - commit d03d4c92 — this close-out (ticket status + archive_when)
  - "gate: ✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green (CI on PR #639; Test Files 594 passed (594), Tests 7911 passed | 6 skipped (7917))"
archive_when: the T311 ticket is archived with the rest of its cohort; nothing further is pending on this record.
---

# docs(T311): closes T311 — the sweep landed; findings go to the board, not to tickets

## What shipped

- **b7236c28 (#639)** — the sweep itself. 35 files, comment- and doc-only. Comments across the
  op-log, auth, db and sync layers described the WebSocket Host transport deleted at the Stage 6c
  cutover as if it were current; nine sat on `appendOp`'s own doc comments, asserting a second
  top-level caller that does not exist. Each site was re-described rather than deleted, per
  CLAUDE.md's convention: `_Prior:` for a retired mechanism whose reasoning still holds, an explicit
  statement of voidness where the reasoning went with the mechanism.
- **d03d4c92** — this close-out: `status: completed`, and `archive_when` amended so it no longer
  requires the findings to be ticketed.

## Evidence

- CI verdict line, quoted from run 36159894162's own log rather than from an exit code:
  `✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green`
- `Test Files 594 passed (594)`, `Tests 7911 passed | 6 skipped (7917)`.
- Merge verified by CONTENT, not by the merge command's exit code: `operations.js` on `main` carries
  the canonical retired-mechanism note, and `PLATFORM_STATE.md`'s `source_aliases` row now names
  `electron/automerge/campDocument.js` in place of the deleted `syncServer.js`.
- A programmatic framing audit (whole file, ±14-line window, full retired vocabulary) reports zero
  unframed mentions across the 32 changed code files.

## Two failures worth recording, because both were mine

**A local gate verdict that lied, and I built the lie.** The run was wrapped as
`npm run verify > log 2>&1; echo "VERIFY_EXIT=$?" | tee exit.txt`. The task notification reported
"exit code 0" — the trailing `echo | tee` — while the log's last line was
`❌ VERIFY FAILED at step: check:governance` and the captured file held `1`. This is documented
behaviour that I re-created anyway. The rule is mechanical, not remembered: run the gate as the sole
command in the call, and read the verdict line regardless of any exit code.

**An audit that reported a confident zero while being narrower than the census I had already
written.** The framing audit's vocabulary omitted `submit_op`, `op_applied` and `full_sync` — terms
already listed in this ticket's own Scope section — and one of its markers (`Stage 6c`) occurs in
live prose, silently suppressing real hits. It returned "0 unframed" over 31 files and I believed it.
Fixing both axes surfaced 21 further sites, including six copies of one phrase in `localDb.js` that
would have left that file contradicting a note corrected by hand a few edits earlier. A peer session
measuring the same repo from a different baseline is what exposed the marker defect; neither of us
found our own.

## Agents

None dispatched — see `omitted_agents` above for the per-agent reason. The substantive independent
check came from a concurrent peer session rather than from a dispatched reviewer: it re-derived
findings 1 and 2 from the code, corrected two of my caller counts (`latestScopeOpSeq`'s only caller
is the dead `detectBulkReplaceConflict`; `based_on_seq` appears only in that function's own
signature and comments), and found the audit defect above.
