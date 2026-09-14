---
task: harness reliability — classify non-retryable nightly failures, make the morning check ask whether the pass succeeded, protect application-leased worktrees from pruning, and pin the loop-roster/Article VI partition
document_type: run
date: 2026-09-14
round: 1
status: in-progress
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: [maker]
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
  - agent: code-reviewer
    reason: no-predicate
    note: NOT YET RUN — this is a genuine gap, not a waiver. See "Independence gap" below. Required before merge.
  - agent: verifier
    reason: no-predicate
    note: NOT YET RUN by an independent agent. The deterministic gate was executed by the same session that wrote the code, which is not Verifier's role. See "Independence gap" below.
  - agent: security
    reason: not-applicable
    note: no auth, secret, PIN, LAN-protocol, IPC, or packaging surface is touched. The one new external read (Claude Desktop's worktree ledger) is read-only, parsed in a subprocess that exits 0 on any malformed input, and grants only the ability to SKIP a deletion.
  - agent: red-hat
    reason: no-predicate
    note: NOT YET RUN — this change alters an unattended job that deletes directories and an unattended job that writes memory proposals. Both are exactly the surface Red Hat exists for. Required before merge.
  - agent: grader
    reason: no-predicate
    note: NOT YET RUN — there are no opinion reports to reduce, because no opinion agent was dispatched.
deterministic_checks: [lint, test, test:integration, security, check:governance]
human_gates:
  - "Owner directed this work in-session and authorized proceeding without the loop: \"you can do this and do it safely and correctly\" and \"the floor is all yours. wrok through this until you are done\". That authorizes execution; it does not retroactively supply independent review, which is recorded above as a gap rather than a waiver."
verdict: in-progress
completion_evidence: []
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

## Known gaps carried forward

1. **No shell test harness.** `integration.sh` and `run.sh` are unattended and destructive; their
   logic was verified by hand here. That is weaker than a test and should become one.
2. **`npm run verify` is not extended.** `agents:check` and `gate:shadow-check` remain invoked by
   nothing. Adding them is deliberately deferred: `agents:check` hard-exits 1 when
   `~/.claude/organization` is absent, which would couple the gate to unversioned home state, and
   4 worktrees still carry a pre-#395 `security.md` that would go red on a file they never touched.
3. **The run-record production gap itself is unfixed.** Nothing yet requires a merged change to
   leave a record; this one exists because it was written by hand.
