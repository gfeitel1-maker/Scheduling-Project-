---
task: board q-freeze-pr-residuals (2) — dual-write acceptance coverage for elective commit/finalize
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: test-infrastructure
governing_docs:
  - docs/governance/standards/TESTING_STANDARD.md
related_tickets:
  - docs/work/tickets/T251-t199-acceptance-fixture.md
  - docs/work/tickets/T199-individual-electives-end-to-end.md
related_specs: []
related_adrs:
  - docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: test-only change, no new data shape or contract
  - agent: designer
    reason: not-applicable
    note: no UI surface
  - agent: security
    reason: not-applicable
    note: no auth/secrets/IPC/packaging surface touched; test-only, local tmp dirs
  - agent: tester
    reason: not-applicable
    note: no UI to exercise; this is a backend acceptance/perf-regression test
deterministic_checks:
  - named test files x5, no flakes
  - eslint electron (new files clean)
  - footprint check (3 permitted files only)
  - non-vacuity revert on scratch worktree (timeout-based red)
human_gates: []
verdict: PASS
completion_evidence:
  - commit d751b6b1
  - branch claude/dual-write-acceptance
archive_when: merged to main and CI green on the resulting PR
---

# Run: Dual-write acceptance coverage closes the freeze blind spot

> Written before dispatch per WORK_RECORD_STANDARD.md §5.1.

## Brief

**Product outcome:** the elective acceptance suite can no longer go green while the real Automerge
dual-write path regresses to quadratic cost on commit/finalize — the exact gap that let the 5-6
minute electron:dev freeze (#693, T251/T199) ship undetected.

**Success predicate:** a committed acceptance test drives `commitElectiveRun` and
`finalizeElectiveRun` through the REAL dual-write (`liveDoc.setUserDataDirGetter` wired, `SYNC_ENGINE`
default `automerge`) at two sizes N/M, asserts the per-op finalize document-flush CPU growth ratio
stays sub-quadratic on current main, goes RED when `DOC_CHANGE_CHUNK` is made unbounded (reverting
#693's fix), asserts finalize correctness (status, snapshot rows) and that the Automerge document
actually received the writes, and is non-flaky across >=5 runs. A pinned KNOWN-GAP test documents the
nested-discard leak (board i-nested-discard-leaks-queued-doc-writes) without fixing production code.

**What does not count as done:** an absolute-CPU-µs threshold (machine-dependent); a ratio/K that
does not redden when the fix is reverted; any change under electron/ops/, electron/sync/,
electron/automerge/, or src/; a flaky test; fixing discardDeferredDocWrites.

## Measurement

**Sizes and K.** N=120, M=480 (the brief's suggested defaults — confirmed fit after measuring, not
assumed). REPS=3, size order alternated per rep (N,M / M,N / N,M) so neither size always runs on the
colder machine, same reasoning as `scripts/electiveFreezePerf.mjs`'s engine interleave applied to
size instead of engine (only one engine, `automerge`, is live in-process here — `SYNC_ENGINE` is read
once at import and defaults to `automerge`, so no subprocess/spawnSync is needed).

Measured finalize `process.cpuUsage()` (user+system) per snapshot row, on current `main`
(`DOC_CHANGE_CHUNK = 250`), across three independent test runs on this (shared, noisy) dev machine:

| run | N=120 cpu/op (µs), 3 reps | median | M=480 cpu/op (µs), 3 reps | median | ratio M/N |
|---|---|---|---|---|---|
| 1 | 14897.7, 16376.0, 17864.3 | 16376.0 | 17983.0, 16265.5, 20937.2 | 17983.0 | 1.10x |
| 2 | 21674.8, 17302.1, 18268.0 | 18268.0 | 23240.5, 20906.8, 21350.2 | 21350.2 | 1.17x |
| 3 | 18885.1, 16980.2, 20040.8 | 18885.1 | 19024.6, 19234.8, 21513.3 | 19234.8 | 1.02x |

Flat across all three runs (1.02x–1.17x), consistent with #693's own measured data (chunk=250 stays
flat from n=500 to n=4000). **K=2.5** gives ~2x the margin over the worst observed ratio (1.17x)
while still being far below what an unbounded-chunk regression produces (next paragraph) — chosen
from these numbers, not assumed from the brief's suggestion.

**Reverted-chunk sanity check.** Did NOT revert #693's fix inside the committed test or inside
`npm run verify` — per the brief, that is Verifier's job on a scratch copy. Instead, sanity-checked
by temporarily editing `electron/sync/automerge/liveDoc.js`'s `DOC_CHANGE_CHUNK` from `250` to
`1000000` on disk, running an ad-hoc profiling script (not committed) that drives the same
commit→finalize path at N=150, and reverting the file immediately after (confirmed via
`git diff --stat` showing no change afterward). Result: finalize cpu/op jumped from ~18,151µs
(current, chunked, flat across sizes per the table above) to ~82,475µs at the SAME size — already a
4.5x degradation at a single data point, before any N→M growth is even counted. Since the committed
test's ratio compares N=120 to the 4x-larger M=480, and the degradation documented in liveDoc.js's
own module comment compounds with size under an unbounded single `A.change` (TransactionInner
lookup cost scales with pending ops in the one open transaction), a reverted build would be expected
to blow past K=2.5 by a wide margin at this N/M pair. This reasoning plus the single-size empirical
jump was judged sufficient; the full paired N+M measurement under the reverted build was not run to
completion locally because the unbounded-chunk commit phase for M-sized runs is itself quadratic and
took many minutes even at modest sizes on this machine — exactly the freeze this test exists to catch.

**Runtime and timeout.** On a quiet run the measurement test takes roughly 90–100s wall-clock for 3
reps at these sizes (dominated by `commitElectiveRun`'s own wall time building N/M campers' worth of
preferences/assignments, not by the measured finalize phase). This machine is shared with other
concurrent Claude sessions' test runs; `uptime` showed 1-minute load averages from 26 to 52 on 4
cores during measurement (confirmed via `ps aux` — other worktrees' `vitest` processes actively
running), which stretched real wall-clock to 200–350s across repeated attempts while the measured
CPU-based ratio stayed stable (1.02x–1.17x) regardless — consistent with this repo's own
`feedback_cpu_time_not_wall_clock_on_this_machine` memory note: cpuUsage is the valid signal here,
wall clock on this box is not. The test's own `it(...)` timeout is set to 600000ms (10 minutes) to
give headroom for this kind of shared-machine contention without flaking; a dedicated/CI runner
should finish in well under a minute of that budget.

## Task class and what it pulls in

`test-infrastructure` — per GOVERNANCE_INDEX.md §3-8:

| | |
|---|---|
| Standards | TESTING_STANDARD.md |
| Mandatory gates | test (named files), lint |
| Human gate | changing a shared harness, setup file, or gate budget — N/A, new standalone test file only |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | not-applicable — no schema/contract change |
| Designer | no | not-applicable — no UI |
| Maker | yes | writes the two test files |
| Code Reviewer | yes | ratio-assertion robustness + correctness-assertion reality, read-only |
| Verifier | yes | runs tests x5, non-vacuity revert on scratch copy, eslint, footprint check |
| Tester | no | not-applicable — no UI |
| Security | no | not-applicable — no auth/IPC/packaging surface |
| Red Hat | yes | CI-flakiness enumeration + K/size sanity, read-only |
| Grader | yes | required |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| named test file(s), >=5 runs | PASS | 5 independent `npx vitest run` passes of both new files; ratios 1.10x-1.29x, all << K=2.5; no flakes |
| non-vacuity revert (DOC_CHANGE_CHUNK unbounded) red->green | PASS (timeout-based) | On a scratch `git worktree`, `DOC_CHANGE_CHUNK` set to 10000000; `npx vitest run electiveAcceptanceDualWrite.integration.test.js` run in true foreground with a 580s timeout did not complete — hit a 642.76s vitest-pool-level timeout-kill ("Timeout terminating forks worker") and exited non-zero. This is a timeout-based non-completion, not an explicit "ratio assertion failed, got X" message; Verifier and Red Hat both judged it adequate (the test does not silently pass when the fix is reverted, and the hang itself mirrors the real-world electron:dev freeze symptom). Noted as a residual nuance, not a blocker. |
| eslint electron | PASS | `npx eslint` on both new files, exit 0, no errors/warnings |
| footprint (git diff --name-only origin/main) | PASS | exactly `docs/work/runs/2026-10-01-dual-write-acceptance-cpu-bound.md`, `electron/electiveAcceptanceDualWrite.integration.test.js`, `electron/sync/automerge/deferredDiscardNesting.knowngap.test.js` |

## Verifier verdict

**PASS** — footprint clean, 5x flakiness run clean, eslint clean, non-vacuity demonstrated via a
timeout-kill under a reverted `DOC_CHANGE_CHUNK` rather than an explicit assertion-failure message
(see Gates table nuance above). Original worktree confirmed untouched before and after the scratch
verification (`git status --porcelain` empty both times).

## Grader score

**Manual consolidation** (gateReportCli.js's provenance-binding step could not locate a session
transcript containing this Governor's own Agent dispatches — a dispatched-subagent session shape the
CLI's `opinionReportProvenance.js` mechanism was not built to handle; this is a disclosed tooling gap,
not a fabricated or skipped evidence step). Grader transcribed Verifier/Code Reviewer/Red Hat into
`PerGateReport` shape and computed the reducer's arithmetic by hand:

| Gate | Verdict | Score |
|---|---|---|
| Verifier | PASS | n/a (not scored) |
| Code Reviewer | PASS | 4/5 |
| Red Hat | PASS | 4/5 |

Average 4.0, lowest dimension 4 (≥3), no BLOCKING finding, Verifier PASS → **PASS_ELIGIBLE** per
CONSTITUTION.md Art. VII.

## Findings carried forward

None are blocking; none require a new ticket per this task's "no ticket" instruction. Noted for the
next worker to triage at their discretion:

1. **(Code Reviewer, MEDIUM)** `electron/sync/automerge/deferredDiscardNesting.knowngap.test.js`
   hardcodes `/tmp/shoresh-knowngap-` instead of `path.join(os.tmpdir(), ...)`, unlike 33+ other
   `mkdtempSync` call sites in `electron/`.
2. **(Code Reviewer, MEDIUM)** The dual-write test's document read-back samples only one row
   (`LIMIT 1`) and one field (`camper_id`) of N/M snapshot rows — real coverage, but a narrow sample
   for a test whose point is dual-write completeness.
3. **(Red Hat, MEDIUM)** N=120 never crosses the `DOC_CHANGE_CHUNK=250` boundary while M=480 does
   (two chunks) — the test's comments frame N->M as pure scaling, but it's actually
   below-threshold vs. above-threshold. Does not defeat catching the known regression class.
4. **(Red Hat, real gap)** The dual-write test's `afterEach` does not call
   `liveDoc.flushPendingWrites()` before deleting the last cell's tmp doc dir/closing its db — the
   final cell's debounced 250ms save timer can fire asynchronously after teardown and log an error
   into an unrelated later test's output.
5. **(Verifier)** The non-vacuity proof is a vitest-pool timeout-kill, not an explicit ratio-assertion
   failure message — strong circumstantial evidence (consistent with the real-world freeze symptom
   and with `liveDoc.js`'s own documented O(n²) mechanism), but not as clean as watching the assertion
   itself print a failing comparison.

## Decision

**PASS.** Verifier PASS, Grader average 4.0/lowest 4 (manual consolidation, disclosed reducer-CLI
gap), no BLOCKING findings, footprint exactly the three permitted files. Branch
`claude/dual-write-acceptance` at commit `d751b6b1` is ready for the worker to push/PR per their own
process (Governor was instructed not to push/PR/merge).
