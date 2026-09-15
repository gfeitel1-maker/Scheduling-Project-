---
task: harness reliability — classify non-retryable nightly failures, make the morning check ask whether the pass succeeded, protect application-leased worktrees from pruning, and pin the loop-roster/Article VI partition
document_type: run
date: 2026-09-14
round: 2
escalated: true
status: escalated
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: [maker, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: governor
    reason: human-waived
    note: "The owner took the routing decision directly and instructed a single session to execute it: \"ok. you are getting your turn. the review window is at a pausing point. the floor is all yours. wrok through this until you are done\". No Governor dispatch occurred."
  - agent: architect
    reason: not-applicable
    note: no new module boundary, schema, wire shape, or data flow. Four localized edits to existing unattended scripts plus one test; no structure is introduced.
  - agent: designer
    reason: not-applicable
    note: no rendered surface. Nothing in src/ is touched.
  - agent: tester
    reason: not-applicable
    note: no director-facing behavior. The changed surfaces are a launchd-scheduled shell script, a governance enum, and a test file; none is reachable from the app.
  - agent: verifier
    reason: no-predicate
    note: NOT RUN by an independent agent. The gate was executed by the same session that wrote the code, which is not Verifier's role. Round 2 adds scripts/verifierReport.js so the Verifier PerGateReport is now DERIVED from the gate's own results file rather than asserted — the artifact is deterministic even when the runner is not independent.
  - agent: security
    reason: not-applicable
    note: no auth, secret, PIN, LAN-protocol, IPC, or packaging surface is touched. The one new external read (Claude Desktop's worktree ledger) is read-only, parsed in a subprocess that exits 0 on any malformed input, and grants only the ability to SKIP a deletion.
deterministic_checks: [lint, test, test:integration, security, check:governance]
human_gates:
  - "Owner directed this work in-session and authorized proceeding without the loop: \"you can do this and do it safely and correctly\" and \"the floor is all yours. wrok through this until you are done\". That authorizes execution; it does not retroactively supply independent review, which is recorded above as a gap rather than a waiver."
verdict: blocked
completion_evidence:
  - "Final gate 13/13 rc=0 on 55c3782 (clean tree): 5434 tests passed + 1 skipped, integration 20/20, security 0 findings, check:governance no findings. Evidence stamped with the SHA the run started against; stamp verified matching HEAD. docs/work/runs/evidence/2026-09-14-harness-gate.txt"
  - "GateReport docs/work/runs/gate-reports/harness-reliability-r2.json — verifier_pass true, blocking_findings none, malformed none, gap none, incomplete false; overall_score 3.5, lowest_dimension 3, decision_eligibility BLOCK."
  - "Three review rounds: Code Reviewer (5 findings, all fixed), Red Hat round 1 (Resilience 2, 7 findings, all fixed), Red Hat round 2 (Resilience 3, 5 findings — 4 fixed in 55c3782, 1 ticketed as T169)." 
archive_when: "Code Reviewer, Red Hat, and an independent Verifier have each reported on this diff; Grader has reduced those reports through scripts/gateReportCli.js producing a gate report under docs/work/runs/gate-reports/; the full gate is green on this branch; and the branch is merged."
---

## Why this record exists at all

The defect that prompted this work is that **283 commits landed on `main` between 2026-08-25 and
2026-09-14 without a single run record**, while session transcripts show review agents genuinely
being dispatched (code-reviewer 23, verifier 21, red-hat 16, security 9, tester 6 — against
grader 3). Judgement was happening; the record of it was not. Writing this record is the first
instance of the discipline the work is meant to restore, which is also why its gaps are recorded
honestly instead of being papered over.

## Independence gap — read this before merging

This change was implemented and gate-run by **one session**. That session is not Verifier and is
not Code Reviewer. A deterministic gate executed by the author is evidence that the code runs; it
is not independent review, and the two must not be allowed to collapse into each other
(`CONSTITUTION.md` Article VI, "Distinctions that must not collapse").

`verdict` is therefore `in-progress`, not `pass`, and `completion_evidence` is empty. The change
touches two unattended jobs — one that **deletes directories** and one that **writes memory
proposals** — which is precisely the surface Red Hat exists for. It should not merge on the
author's own say-so.

## What changed, and what each change is guarding against

| Change | Failure it prevents |
|---|---|
| `run.sh` — halt on non-retryable failure classes, matched on message text | 8 nights (2026-09-06..13) each burned 3 retries against an expired login that could not heal in 20s. Matching on text, never on size or exit code, keeps the 5 genuinely transient classes retrying as before. |
| `mineFromPacket.sh` (new) | The obvious recovery — `run.sh <old-day>` — re-invokes `gather.sh`, which selects transcripts by **mtime** and writes the packet with `>`. Mtimes have drifted, so that would have silently destroyed all 8 preserved evidence packets. This path never invokes `gather.sh` and never writes `evidence-*.md`. |
| `integration.sh` — four-outcome success predicate | The old check was `grep "=== run $YDAY " run.log`, and `run.sh` writes that header as its first action. The header is present on a night that started and failed, so eight consecutive failures produced no morning signal. |
| `integration.sh` — backlog surfacing | A failed night is now reported every morning until cleared, with the correct (non-destructive) recovery command. |
| `integration.sh` — worktree lease-awareness | The prune rule targets `ephemeral && clean && 0-ahead && idle` — bit-for-bit the shape of a **pooled** Claude Desktop worktree (`leasedBy: null` + `pooledAt`). `open-tickets-audit-2266c0` currently matches. The ledger is read, never written. |
| `check-governance.js` — corrected comment + `INDEPENDENT_AGENTS` | The comment claimed `AGENTS` was Article VI's roster. It is Article VII's **loop** roster. Acting on the comment — adding the 3 independent agents — would have emitted `agent-unaccounted` against all 35 existing run records. |
| `test/governance.test.js` — partition test | Pins `AGENTS ∪ INDEPENDENT_AGENTS == Article VI roster`, disjoint. A new agent now fails the suite until it is consciously placed on one side. Verified adversarially: moving `security-assessment` into `AGENTS` turns the test red. |

## Deterministic evidence

- `test/governance.test.js`: 19 passed (was 18; +1 partition test).
- Adversarial check: simulating the exact mistake (`security-assessment` added to `AGENTS`) →
  `1 failed | 18 passed`. Restored → `19 passed`.
- `mineFromPacket.sh` run for real against 2026-09-10 while unauthenticated: exited 2, wrote
  nothing, and all 8 evidence packets verified **byte-identical by checksum** afterwards
  (`_pending` file count 65 → 65, no proposal created).
- Failure classifier: 7/7 — halts on both non-retryable bodies, retries all 5 transient classes.
- Ledger parser: 7 leased paths found; `open-tickets-audit-2266c0` now PROTECTED; malformed and
  absent ledgers both exit 0 with empty output, so behaviour is unchanged rather than aborted.
- `integration.sh` shell-syntax clean under `zsh -n`; `(N)` glob qualifier confirmed working in a
  clean non-interactive zsh, matching `gather.sh`'s proven nightly usage.
- `npm run check:governance`: **no findings** — the new run record and four tickets validate clean.
- `npm run security` (security-gate): **0 findings** (deps + secrets + dangerous patterns).
- `npm run index:work`: `docs/work/INDEX.md` regenerated for the 5 new documents (+6/-1).

### The one gate failure, and why it is not attributed to this diff

First full-gate run exited 1 at `npm run test`:
`electron/sync/automerge/syncProtocol.test.js > converges reliably across repeated connect cycles
(not timing-dependent)` — `Test timed out in 30000ms`. `1 failed | 400 passed (401)`.

Not claimed as a flake on vibes; three independent lines of evidence:

1. **Re-run in isolation on this branch: 5 passed / 5.**
2. **No causal path.** This diff touches `scripts/check-governance.js`, `scripts/integration.sh`,
   `test/governance.test.js`. `grep -rn "check-governance\|governance.test" electron/ src/` returns
   nothing — no import path from the diff to that test.
3. **The test documents this exact failure mode in its own comment**: the scenario *"failed roughly
   1 run in 3 (timing-dependent delivery, not a logic bug)"*, which is why it runs 10 iterations
   against a 30s budget. Load average at the time of failure was **20.5 / 116 / 143** — the machine
   was saturated by concurrent agent sessions.

This is a load-triggered timeout in a deliberately timing-sensitive test, not a regression. It
remains a real fragility of the suite and is why T168 exists.

## Round 2 — independent review, and what it caught

Code Reviewer and Red Hat both ran against `44b49c6`. Red Hat scored **Resilience: 2** and
blocked. Between them they found seven issues; all seven are addressed, none deferred.

Red Hat's three that mattered most — none of which I had found:

1. **`run.sh` wrote straight to `$PROPOSAL` with no guard.** `mineFromPacket.sh` refused to
   overwrite an existing proposal; `run.sh` did not. A manual re-run silently replaced a good
   analysis with a fresh one, with no log line distinguishing "created" from "replaced". Now
   mines to a temp file, `mv`s on outcome, refuses to clobber, cleans up on `trap`.
2. **Ledger schema drift degraded silently.** `d.get("worktrees") or {}` returns `{}` on a
   renamed key with no exception, logging a line byte-identical to a healthy empty ledger. That
   reinstates the exact silent failure the guard exists to prevent, and nothing would notice.
   Exit codes are now the contract: 0 healthy / 3 unreadable / 4 schema moved / `*` anything
   else — and 4 writes a 🔴 section into the morning report.
3. **`awk '/^worktree /{wt=$2}'` truncated paths at the first space.** Pre-existing, but it
   would have silently defeated the new exact-match protection for exactly the path class the
   brief named as real. Now `substr($0, 10)`.

Plus: a TOCTOU race in recovery (atomic `mkdir` lock), a brittle roster regex whose failure read
as "constitution and code disagree" rather than naming the stray row, and the stale-marker
cry-wolf both reviewers found independently. `run.sh`'s own failure message was also still
advertising `run.sh <day>` — the destructive recovery path this change exists to warn about.

**Two slices of the harness itself**, rather than only repairs:

- `scripts/verifierReport.js` + 9 tests (**T167**) — the Verifier `PerGateReport` is a function
  of exit codes, so it needs no judgement and is now computed. That shrinks the clerical step
  Grader keeps skipping to the four opinion gates. A gate that did not finish reports
  `UNVERIFIED`, never `PASS`; an observed failure stays `FAIL` rather than being laundered into
  "unknown" by truncation; `evidence_ref` is mandatory. Every report round-trips through the real
  `validatePerGateReport`.
- `scripts/readWorktreeLeases.py` + `test/worktreeLeases.test.js`, 7 tests (**T168** first
  slice) — the ledger reader is extracted from an inline heredoc and tested against fixtures for
  healthy, empty, torn, schema-drift, ragged, and space-containing paths. It is the only guard
  between an unattended prune and a directory the application still expects.

## Round 2 outcome — BLOCKED, escalated to the human

`decision_eligibility: BLOCK`. The block is **purely on the score threshold**: overall 3.5 against
a 4.0 floor, lowest dimension 3. `verifier_pass` is true, `blocking_findings` is empty, nothing is
malformed, and no expected gate is missing.

Per `CONSTITUTION.md` Article VII — *"Maximum two rounds. Round 2 failure escalates to the user
with open findings; it does not become a third round"* — this does not become round 3. It stops
here.

**The material fact for whoever decides.** Red Hat's score of 3 assessed `76d91fb`. HEAD is
`55c3782`. All four of its round-2 findings were fixed *after* it scored — the unchecked `mv`
whose trap deleted the only copy of a mined analysis, the `case` arm for exit 4 that was
unreachable because `*)` preceded it, the `/^DONE$/m` check that a stray line could satisfy into a
false PASS, and the lock released before the `mv` it protected. The score is therefore stale.

It does not follow that the work is verified. **No reviewer has read `55c3782`.** Both statements
are true at once, and the second is why this is a human decision rather than an arithmetic one.

**Open, not fixed:** T169 — gate evidence is not bound to the commit it verifies. `55c3782` ships a
partial mitigation (the results file is stamped with the SHA the run started against, and the
stamp was verified against HEAD for this run) but nothing yet *checks* the stamp, so a stale green
results file from an unrelated commit would still validate.

## Known gaps carried forward

1. **No shell test harness.** `integration.sh` and `run.sh` are unattended and destructive; their
   logic was verified by hand here. That is weaker than a test and should become one.
2. **`npm run verify` is not extended.** `agents:check` and `gate:shadow-check` remain invoked by
   nothing. Adding them is deliberately deferred: `agents:check` hard-exits 1 when
   `~/.claude/organization` is absent, which would couple the gate to unversioned home state, and
   4 worktrees still carry a pre-#395 `security.md` that would go red on a file they never touched.
3. **The run-record production gap itself is unfixed.** Nothing yet requires a merged change to
   leave a record; this one exists because it was written by hand.
