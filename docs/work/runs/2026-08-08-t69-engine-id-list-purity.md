---
task: T69 — the engine layer still tolerates JSON-stringified id lists
document_type: run
date: 2026-08-08
round: 1
status: pass
task_class: scheduling-engine
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T69-engine-still-tolerates-json-stringified-id-lists.md, docs/work/tickets/T63-anchor-group-ids-parsing-belongs-at-the-boundary.md, docs/work/tickets/T70-dev-only-shape-assertion-at-engine-id-list-inputs.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no new data shape and no contract widening — this narrows an existing engine input contract to the shape its only callers already supply; T63 already made the architectural call
  - agent: designer
    reason: not-applicable
    note: no UI surface changes
  - agent: tester
    reason: not-applicable
    note: logic-only change with zero UI surface — no visual or UX delta to assess. The behavioural end-to-end concern was not dropped but relocated into a real integration test through the actual screen (src/screens/ScheduleScreenExclusions.test.jsx drives a JSON-string anchor row from the IPC shape through ScheduleScreen), added as scope item 6 after Red Hat's audit. Grader concurred and noted it would have flagged this omission as premature had that test not been added.
  - agent: security
    reason: not-applicable
    note: removes two JSON.parse calls on renderer-local data and adds none; no auth, IPC, sync, or untrusted-input surface is touched
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence: [docs/work/tickets/T69-engine-still-tolerates-json-stringified-id-lists.md, src/engine/buildSchedule.test.js, src/engine/weekCatalog.test.js, src/screens/ScheduleScreenExclusions.test.jsx]
archive_when: T69 resolved
---

# Run: T69 — engine id-list purity

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** No user-visible change. Schedule generation behaves identically; the engine's
input contract becomes single-shaped so a future serialized field cannot silently grow a second,
untested deserializer inside the pure core.

**Success predicate:** `grep -rn "JSON.parse" src/engine/` returns nothing; `parseIds` and
`parseIdsField` no longer exist; tests pin the array-only contract for `eligible_group_ids` (both
`scheduleCohort` and `computeFindings`) and for anchor `group_ids` in `resolveWeekCatalog`; lint,
governance, build, and the full vitest suite pass.

**What does not count as done:** Renaming or inlining the tolerance instead of deleting it.
Replacing it with a throw/assert. Weakening or deleting the boundary tests in
`useScheduleData.test.js`. Leaving `weekCatalog.test.js` fixtures as strings (that would pin the
removed shape). Any change to schedules produced from the same input.

## Task class and what it pulls in

`scheduling-engine` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | ARCHITECTURE_STANDARD.md §8–§9 (engine purity, boundary normalization); TESTING_STANDARD.md |
| Mandatory gates | test, lint, build, check:governance |
| Human gate | none |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `no-predicate` — narrows an existing contract to what callers already supply; T63 made the call |
| Designer | no | `not-applicable` — no UI surface |
| Maker | yes | the deletion + tests |
| Code Reviewer | yes | scope fidelity: deletion only, no smuggled behaviour change |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | `not-applicable` — no UI surface; end-to-end behaviour pinned by an integration test instead (see `omitted_agents`) |
| Security | no | `not-applicable` — removes parses on renderer-local data, adds no input surface |
| Red Hat | yes | the whole change rests on "the tolerance is dead"; adversarial review of that claim is the point |
| Grader | yes | scores the reports |

## Gates

All run by Governor on a quiet machine (no concurrent vitest, load average settled). Raw output,
not agent report.

| Gate | Result | Evidence |
|---|---|---|
| test | **PASS** | `npx vitest run --no-file-parallelism` → `Test Files 112 passed (112)` · `Tests 1753 passed \| 1 skipped (1754)` · `Duration 414.54s` · exit 0 |
| lint | **PASS** | `npm run lint` → exit 0; `13 problems (0 errors, 13 warnings)`, all pre-existing `react-hooks/exhaustive-deps` |
| build | **PASS** | `npm run build` → exit 0, `✓ built in 2.10s` |
| check:governance | **PASS** | `check:governance — no findings.` exit 0 |

**Pre-change baseline, same command, same machine:** `112 files / 1739 passed / 1 skipped`, exit 0.
Post-change is +14 tests and zero failures — the 14 are exactly the new coverage.

Acceptance greps (all return nothing, i.e. the condition holds):

| Grep | Result |
|---|---|
| `grep -rn "JSON.parse" src/engine/` | empty |
| `grep -rn "typeof .* === 'string'" src/engine/` | empty |
| `grep -rn "parseIds\|parseIdsField" src/` | empty |

`git diff` is empty for all four files required to stay untouched:
`src/utils/normalizeActivityEligibility.js`, `src/screens/schedule/useScheduleData.js`,
`docs/work/tickets/T63-*.md`, `docs/work/tickets/T44-*.md`.

### A note on the round-2 red runs

Round 2's suite runs showed failures in `DaysScreen`, `syncServer`, `syncClient`, and `ingest`.
Those runs were contaminated by a concurrent vitest in another worktree at load average >400. The
clean run above took **414s against 1299s** for a contaminated one and was fully green. Red Hat
additionally ruled out `syncServer.test.js` by import-graph evidence — it has no path, direct or
transitive, into `src/engine/` or `src/screens/`. Recorded as T44 evidence, not as a T69 finding.
Grader's caveat is worth repeating: a round that has to explain away its own red suite is a round
where the evidence gate is doing less work than it appears to.

## Verifier verdict

**PASS** — all four gates exit 0 on an uncontaminated full serial run; every acceptance grep holds;
no UNVERIFIED claims remain. The success predicate is mechanically checkable in full and was checked
in full.

## Grader score

**Average 4.5, lowest scored dimension 4.5 (Resilience). PASS** (≥ 4.0, nothing below 3).

Grader scored UX Friction, Security, and Visual Fidelity as **N/A rather than 5**, declining to
invent numbers for correctly-omitted agents — so the average rests on a single dimension. Read it as
"Resilience passed at 4.5", not "averaged 4.5 across a panel". Grader explicitly did not inflate for
green gates: on a dead-code deletion a green suite is the expected outcome, and the informative
signals were the mutation-testing of the new assertions and the deletion of the false one.

The half-point withheld: the deletion traded a tolerant path for a throwing one at `weekCatalog.js`,
and no runtime guard exists. Carried to **T70**.

## Findings carried forward

T63 was marked `completed` with an unmet `archive_when`. Not corrected here by instruction (another
session owns that file); recorded in T69 instead.

**`docs/work/INDEX.md` regeneration side effect (not smuggled scope).** Running `npm run index:work`
for this ticket also dropped index rows for T48, T63, T64, T65, and T67. That is a mechanical
byproduct: those tickets were flipped to `completed` in `4341664` without the index being
regenerated, so the generator removed them the first time it next ran — here. Nothing about their
content was touched. Related: this worktree's base is `4341664`, which is behind `origin/main`
(`0cb24ce`), so `npm run index:work` must be re-run after any rebase before `check:governance` is
trusted.

**Residual risk promoted to T70.** The DEV-only engine shape assertion was correctly excluded from
T69's scope (a guard is a decision, not a substitute for the deletion) but is the thing that would
convert a future normalizer regression from silent-wrong-schedule / invisible-hang into a named
error. It existed only inside T69's prose and would have been lost on archive, so it is now
`docs/work/tickets/T70-dev-only-shape-assertion-at-engine-id-list-inputs.md`.

**Suite-timing observation belongs on T44, not here.** The round-2 suite runs were executed on a
machine carrying a second concurrent vitest run (load average > 400), and load-sensitive files failed
non-deterministically: `electron/sync/syncClient.test.js`, `electron/sync/syncServer.test.js`, and
`electron/ops/ingest.test.js` in one pass (two 20 s test timeouts plus the T61 wall-clock perf gate
at 19218 ms against a 15000 ms budget), and `src/screens/DaysScreen.test.jsx` in another. **Every one
of them passed in isolation**, and none touches the engine, the anchor path, or anything this diff
changes. This diff also adds full `ScheduleScreen` renders to the serial run, which plausibly nudges
what is already the heaviest file in the suite.

All of the above is evidence for `docs/work/tickets/T44-suite-flakiness-recurred-under-load.md`, not
a T69 regression — in particular, the T61 perf gate is an absolute wall-clock budget with no
allowance for a loaded host, which is exactly the class of fragility T44 tracks. Recorded here as a
T44 evidence note only; T44 itself is untouched by this ticket.

## Decision

**PASS**, round 2. Verifier PASS with no unresolved UNVERIFIED claims, Grader 4.5 with no dimension
below 3, both reviewers' findings addressed and re-verified. Round 2 touched only tests, comments,
and ticket prose — the production engine files are byte-identical between rounds, which is the right
shape for a findings-response round.

Deliverable is a PR-ready branch, `work/t63-engine-purity`. Not merged to `main` by instruction.
