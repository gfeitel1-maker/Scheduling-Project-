---
task: "Board item i-write-ipc-freezes-app-after-commit-and-finalize — Commit and Finalize froze the app for minutes; plus the plain Regenerate control and the identical-bullets disclosure copy"
document_type: run
date: 2026-10-01
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T251-t199-acceptance-fixture.md, docs/work/tickets/T199-individual-electives-end-to-end.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_adrs: [docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md]
related_runs: [docs/work/runs/2026-09-30-t251-electron-dev-walk-director-flow.md]
selected_agents: [governor, architect, designer, maker, verifier, red-hat, security, code-reviewer, tester, grader]
omitted_agents: []
deterministic_checks:
  - "npm run verify (full gate, eight steps)"
  - "npx vitest run --no-file-parallelism electron/automerge electron/sync/automerge electron/ops"
  - "npx vitest run src/screens/elective"
  - "npm run test:integration"
  - "npx vitest run test/governance.test.js"
  - "npm run check:governance"
  - "npx eslint (every changed file)"
  - "node --import ./scripts/fixtures/registerElectronStub.mjs scripts/electiveFreezePerf.mjs"
human_gates:
  - "The owner's call on whether the smallCommit path's residual non-flat curve is accepted on its 15.2x ratio or needs the ADR's acceptance condition formally amended"
  - "The owner's call on whether a re-walk of the real electron:dev app is required before merge, since no Electron session was available to this session and the final UI state exists as 14 dev-mock frames plus test pins"
  - "The owner's merge decision: CI is the gate of record"
verdict: pass
completion_evidence:
  - "docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md — amendment recording the measurement, the mechanism, the decision, and the round-1 failure"
  - "docs/work/evidence/board-freeze-after-commit-and-finalize/ — PERF-RAW.md plus the raw interleaved arm logs and 26 renderer frames (12 round-1, 14 round-2, all distinct hashes)"
  - "scripts/electiveFreezePerf.mjs — the measurement harness, runnable standalone, excluded from the default suite"
  - "commits ea216d44, d2a579c9, b3f6d942, 0617d0c0, 6ab12497, bd5dc6e2, 1a127b36, e7661d07"
  - "gate: see Verification below for the verbatim verdict line"
archive_when: the owner rules on the smallCommit residual and on whether a real-app re-walk is required, and the PR is merged
---

# The Commit/Finalize freeze — diagnosed, measured, and fixed at the choke point

## What the defect was

The 2026-09-30 director walk of the real `electron:dev` app
([run record](2026-09-30-t251-electron-dev-walk-director-flow.md)) found that Finalize of a
78-placement run wrote `status='final'` and 312 snapshot rows to SQLite within ~3 s and then left
the UI on "Finalizing…" for **5–6 minutes** with every click dead, `operations` row count frozen,
and the main process CPU-bound in a pure-JS stack. Commit of a 47-placement run sat on
"Committing…" for over 60 s. The cost was therefore **after** the op-log write.

## What it actually was

`finalizeElectiveRun` writes ~15 fields × N snapshot rows through `appendOp` inside one `runAtomic`.
Each write is deferred and then replayed **one at a time** by `commitDeferredDocWrites` →
`applyLocalWriteNow` → `applyWrite` — **one `A.change` per field**. Each `A.change` re-materialises
the patched collections, and `applyWrite` touches the entity collection plus a provenance key and an
author key, so one 15-field row is 45 keys across three growing collections.

Measured, document-flush CPU (user+sys µs), the op-log arm subtracted to isolate the document write:

| n | ops | flush CPU | cpu/op | growth |
|---|-----|-----------|--------|--------|
| 40 | 565 | 1,675,538 | 2,966 | — |
| 80 | 1125 | 5,453,835 | 4,848 | ×1.63 |
| 160 | 2245 | 21,426,318 | 9,544 | ×1.97 |
| 312 | 4373 | 81,320,640 | 18,595 | ×1.95 |

cpu-per-op doubled when n doubled: **O(n²)**. The SQLite + op-log + `applyProjection` half was flat
(87.9 → 55.6 µs/op) and totalled 0.24 s — the document flush was **99.7%** of Finalize.

**The existing acceptance suite could not have caught this**: it never calls
`setUserDataDirGetter`, so `applyLocalWriteNow` returns inert and the whole Automerge dual-write path
does not execute in those files. That is why the gate was green while the app froze for six minutes.

## Round 1 failed its own acceptance condition, and said so

Round 1 batched each contiguous run of queued writes into ONE `A.change`. It bought a 2.6× constant
factor and **did not remove the quadratic** — cpu/op still doubled per doubling. Worse, it
**regressed the `commit` phase by 1.16–1.35×** versus `origin/main`. Maker self-reported the
acceptance failure; Verifier independently reproduced both the failure and the unreported regression.
Neither was discovered later by someone else, and the ADR amendment records the failure under its own
heading rather than burying it.

`--cpu-prof` found the real axis, and it was not the one anyone predicted: 80.9% of one n=312 cell
sat in `automerge_wasm`'s `exid_to_obj`. Inside an **open transaction**, every collection-proxy
access re-resolves against that transaction's own pending ops — so one `A.change` of n writes is
O(n²) in pending-op count. Same curve, smaller constant. The axis is **run length**, which is why
batching helped Finalize (a huge run on a small document) and hurt Commit (a bigger run still).

## Round 2: bound the batch instead of unbounding it

`DOC_CHANGE_CHUNK = 250`, chosen off a measured sweep (50 was worst at every size; 250 and 500 were
indistinguishable at scale and 250 was at or near the optimum in both regimes). Verifier's own
three-arm interleaved run — `origin/main` / round-1 / HEAD, real reverted files, `process.cpuUsage()`
deltas, median of 3, 48 cells — gives document-flush-only cpu µs/op:

| phase | arm | n=40 | n=80 | n=160 | n=312 | growth/doubling |
|---|---|---|---|---|---|---|
| commit | main | 3448 | 3822 | 5184 | 9138 | ×1.11 ×1.36 ×1.76 |
| commit | round 1 | 3465 | 4427 | 7039 | 12328 | ×1.28 ×1.59 ×1.75 |
| commit | **HEAD** | **2162** | **1703** | **1392** | **1058** | **×0.79 ×0.82 ×0.76** |
| finalize | main | 4282 | 7062 | 14055 | 28267 | ×1.65 ×1.99 ×2.01 |
| finalize | round 1 | 1763 | 2826 | 4869 | 8880 | ×1.60 ×1.72 ×1.82 |
| finalize | **HEAD** | **1128** | **1049** | **1115** | **1101** | **×0.93 ×1.06 ×0.99** |
| smallCommit | main | 4467 | 8190 | 15552 | 30564 | ×1.83 ×1.90 ×1.97 |
| smallCommit | **HEAD** | **990** | **1007** | **1212** | **2007** | **×1.02 ×1.20 ×1.66** |

**HEAD versus `origin/main`: Finalize 25.7× cheaper at n=312, Commit 8.64× cheaper**, and the
acceptance condition (cpu/op flat across the four sizes) is met — Commit better than flat, Finalize
indistinguishable from flat at this sample size.

**Measurement discipline, because wall clock lies on this 4-core machine** (memory, T309): every
number is a `process.cpuUsage()` delta, arms are interleaved with rotating order, spreads are
printed, and the raw logs are committed to `docs/work/evidence/board-freeze-after-commit-and-finalize/`
so the table can be re-derived. Red Hat's caution is carried into the ADR: the headline ratios are
far outside the noise floor and robust; individual growth factors are **not** distinguishable from
each other at three repeats, so "flatter than round 1, which was flatter than per-write" is
supported and nothing finer is.

## Semantics kept identical — this is the sync seam

`applyWrites` reuses `applyWrite`'s per-field body **verbatim** via a shared `applyOneWriteInto`;
Code Reviewer proved it byte-identical modulo indentation by a whitespace-stripped diff, and
`applyWrite` is now `applyWrites(doc, [write])`. `applyLocalWriteNow` is a one-line alias for
`applyLocalWritesNow`, so there is one implementation at both layers. Pinned by a
document-equality test whose fixture walks every branch of that body, compares the entity **and**
provenance **and** author collections, deliberately does not compare saved bytes, and carries a
reversed-order mutation check that must fail; plus a concurrent-merge test asserting the same winner
and the same `A.getConflicts` set in both arms. Red Hat verified at the line that nothing downstream
reasons about change boundaries (`synthesizeOpEvents`' only non-test call site is the remote-merge
**receive** path), that `@automerge/automerge` **3.4.1**'s `rollback()`-and-rethrow makes the
per-item fallback safe, and that batching **narrows** the crash window.

## Defect B: the commit that appeared not to resolve

There is **no navigation-gated transition in the renderer** — a test using the mock client shows
resolution of the awaited IPC alone moves the panel out of "Committing…", with no navigation and no
remount. The symptom was a consequence of defect A: per-op document cost tracked **document size,
not write size**, so a 58-op commit cost 665 ms of main-thread work purely because the document was
large. That path is now 15.2× cheaper. A `withWriteTimeout` was **considered and rejected** — it
would convert a legitimately long commit into a false failure, and the right bound is a product
decision the owner has not made.

## Fold-ins

A plain **Regenerate** control on a cold-opened draft run (previously reachable only via the stale
offer, the edit offer, or a finalize refusal), in its own slot in a restructured actions band where
each control sits above its own explanatory sentence. And the **identical-bullets** disclosure: the
repeated bullets were all `UNKNOWN_CAMPER_LABEL`, so option (a) from the brief — give each bullet a
distinguishing fact — was impossible, because an unresolvable camper has no distinguishing fact by
construction and exposing one would mean a raw id. Resolvable campers are now named, all
unresolvable ones fold into one counted line, and when nothing resolves the disclosure is dropped
for an inline sentence.

## Verification

```
<<GATE_VERDICT>>
```

Round-2 focused gates: `Test Files 7 passed (7) / Tests 254 passed (254)` on every changed-file
suite; `npm run test:integration` 27/27; `npm run build` exit 0; `npx eslint` on all 15 changed
files exit 0; `npm run check:governance` no blocking findings; `npx vitest run test/governance.test.js`
40/40 **after** the ticket flip.

This record is doc-only and is committed after the gate above ran against the code it describes; no
code changed between that run and this record, so the record does not claim a verdict for a tree the
gate did not see.

Grader: **PASS**, average **4.5** — Correctness/Verification 5, Security 5, Resilience 4,
Maintainability/Spec fidelity 5, UX 4, Performance 4. No dimension below 4.

Grader did **not** invoke `scripts/gateReportCli.js`, because that writes a file and Grader was
dispatched read-only; there is therefore **no `gate_report_ref` for this round** and the scores are
Grader's transcription rather than reducer output. Recorded rather than papered over.

## Honest gaps

- **`smallCommit` is 15.2× better but not flat** (×1.66 at the last doubling, outside noise). It is
  the path the director actually complained about, so the reported symptom is resolved at today's
  roster sizes — but the defect **class** is reduced, not structurally eliminated, and it returns at
  larger n. Grader scored Performance 4 for exactly this and named the hazard: accepting a *ratio*
  where the project wrote its acceptance condition in terms of *flatness* is the substitution by
  which round 1 passed its headline while regressing underneath.
- **The UI is UNVERIFIED at the `electron:dev` layer.** No Electron session was available to this
  session. The 14 round-2 frames are the real mounted renderer driven through the dev mock, which is
  this project's documented substitute, and the final two fixes (`e7661d07`) exist as test pins
  confirmed red-on-revert — but no director has looked at the result.
- **Red Hat L1 remains SUSPECTED and unverifiable read-only**: a throw from Automerge's
  `commit`/`integrate` *after* the change callback returns. Idempotent in materialised state; would
  duplicate change history.
- **Two regenerate controls can still co-occur.** The unenforceable "exactly one control" comment was
  withdrawn rather than asserted; every control now shares one guarded handler and one input set, so
  whichever a director picks, the same thing is solved. Tester could not reach the both-offers state
  through the mock.
- **`docs/current/PLATFORM_STATE.md` is stale** (the advisory `platform-state-stale` finding, which
  does not fail the gate). T199's own `archive_when` names folding the behaviour into PLATFORM_STATE;
  `archive_when` governs archiving rather than completion and no gate enforces it, so the flip is not
  blocked, but the condition is not literally satisfied by this work.
- **Spec §6 condition 4 (eligibility) and the reduced-motion claim close as asserted gaps, not as
  met** — stated in both ticket close-outs so the status flip does not imply otherwise. The round-2
  UI adds no new animation (the one motion is the existing `press-97`, already reduced-motion-gated),
  so it neither closes nor widens the reduced-motion gap.
- **Graphify was unavailable all session** (MCP `CONNECTION_CLOSED`, and the graph is stale for this
  module family), so every blast-radius check here is a grep sweep. Per `CLAUDE.md`'s own warning
  that leaves two blind spots — string-referenced files and object-literal methods — which the gate,
  not the sweep, is what covers.
